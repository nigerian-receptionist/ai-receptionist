"use client";

import { MicVAD } from "@ricky0123/vad-web";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentAudioPlayer, decodePcmBase64 } from "./audio-player";
import type { AgentState, ClientMessage, ServerMessage, TurnTimingsMs } from "./protocol";

export type TalkStatus = "idle" | "starting" | "live" | "ended" | "error";

export interface TranscriptLine {
  key: string;
  speaker: "caller" | "agent";
  text: string;
  final: boolean;
  blockId?: string;
}

export interface TurnLatency {
  turnId: string;
  timings: TurnTimingsMs;
}

interface TalkSessionOptions {
  wsUrl: string;
  token: string;
  endpointingSilenceMs: number;
}

const CALLER_PARTIAL_KEY = "caller-partial";

export function useTalkSession(options: TalkSessionOptions) {
  const [status, setStatus] = useState<TalkStatus>("idle");
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [latencies, setLatencies] = useState<TurnLatency[]>([]);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const playerRef = useRef<AgentAudioPlayer | null>(null);
  const cancelledRef = useRef<Set<string>>(new Set());
  const agentTextRef = useRef<Map<string, { text: string; blockId?: string }>>(new Map());
  const startingRef = useRef(false);

  const send = useCallback((message: ClientMessage | { type: "session.end" }): void => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const upsertLine = useCallback((line: TranscriptLine): void => {
    setLines((prev) => {
      const index = prev.findIndex((l) => l.key === line.key);
      const next = index >= 0 ? [...prev] : [...prev, line];
      if (index >= 0) next[index] = line;
      return next.slice(-100);
    });
  }, []);

  const teardown = useCallback(() => {
    vadRef.current?.pause().catch(() => undefined);
    const vad = vadRef.current;
    vadRef.current = null;
    vad?.destroy().catch(() => undefined);
    captureNodeRef.current?.disconnect();
    captureNodeRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    playerRef.current?.dispose();
    playerRef.current = null;
    cancelledRef.current.clear();
    agentTextRef.current.clear();
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerMessage): void => {
      switch (message.type) {
        case "session.ready":
          playerRef.current = new AgentAudioPlayer(
            audioContextRef.current as AudioContext,
            message.outputSampleRate,
            {
              onProgress: (utteranceId, playedMs) => send({ type: "playback.progress", utteranceId, playedMs }),
              onDone: (utteranceId) => send({ type: "playback.done", utteranceId }),
            },
          );
          setStatus("live");
          break;
        case "state":
          setAgentState(message.state);
          break;
        case "transcript.partial":
          upsertLine({ key: CALLER_PARTIAL_KEY, speaker: "caller", text: message.text, final: false });
          break;
        case "transcript.final":
          setLines((prev) => prev.filter((l) => l.key !== CALLER_PARTIAL_KEY));
          if (message.text.trim() !== "") {
            upsertLine({ key: `caller-${message.turnId}`, speaker: "caller", text: message.text, final: true });
          }
          break;
        case "agent.text": {
          const entry = agentTextRef.current.get(message.utteranceId) ?? { text: "", blockId: message.blockId };
          entry.text += message.delta;
          if (message.blockId) entry.blockId = message.blockId;
          agentTextRef.current.set(message.utteranceId, entry);
          upsertLine({
            key: `agent-${message.utteranceId}`,
            speaker: "agent",
            text: entry.text,
            final: false,
            blockId: entry.blockId,
          });
          break;
        }
        case "agent.audio":
          if (cancelledRef.current.has(message.utteranceId)) break;
          try {
            playerRef.current?.pushChunk(message.utteranceId, decodePcmBase64(message.pcmBase64));
          } catch {
            // Corrupt chunk: skip it, the utterance still completes.
          }
          break;
        case "agent.audio.end":
          playerRef.current?.markEnded(message.utteranceId);
          setLines((prev) => prev.map((l) => (l.key === `agent-${message.utteranceId}` ? { ...l, final: true } : l)));
          break;
        case "agent.cancelled":
          cancelledRef.current.add(message.utteranceId);
          playerRef.current?.cancel(message.utteranceId);
          setLines((prev) => prev.map((l) => (l.key === `agent-${message.utteranceId}` ? { ...l, final: true } : l)));
          break;
        case "turn.metrics":
          setLatencies((prev) => [...prev.slice(-19), { turnId: message.turnId, timings: message.timingsMs }]);
          break;
        case "error":
          if (message.fatal) {
            setError(message.message);
            setStatus("error");
            teardown();
            socketRef.current?.close();
            socketRef.current = null;
          } else {
            setError(message.message);
          }
          break;
      }
    },
    [send, teardown, upsertLine],
  );

  const start = useCallback(async (): Promise<void> => {
    if (startingRef.current || socketRef.current) return;
    startingRef.current = true;
    setStatus("starting");
    setError(null);
    setLines([]);
    setLatencies([]);
    setAgentState("connecting");
    try {
      if (!options.token) throw new Error("Missing access token (NEXT_PUBLIC_DEV_ACCESS_TOKEN).");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.audioWorklet.addModule("/worklets/pcm-capture.js");
      const source = audioContext.createMediaStreamSource(stream);
      const captureNode = new AudioWorkletNode(audioContext, "pcm-capture");
      captureNodeRef.current = captureNode;
      captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(event.data);
      };
      source.connect(captureNode);

      const vad = await MicVAD.new({
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        model: "v5",
        redemptionMs: options.endpointingSilenceMs,
        getStream: async () => stream,
        onSpeechStart: () => {
          const playing = playerRef.current?.interrupt();
          send({ type: "input.speech_started", atMs: Date.now() });
          if (playing) send({ type: "playback.interrupted", utteranceId: playing.utteranceId, playedMs: playing.playedMs });
        },
        onSpeechEnd: () => {
          send({ type: "input.speech_ended", atMs: Date.now() });
        },
        onVADMisfire: () => {
          send({ type: "input.speech_ended", atMs: Date.now() });
        },
      });
      vadRef.current = vad;

      const socket = new WebSocket(`${options.wsUrl}?token=${encodeURIComponent(options.token)}`);
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "session.start", protocolVersion: 1, inputSampleRate: 16000 }));
        vad.start().catch((error: unknown) => {
          setError(error instanceof Error ? error.message : "VAD failed to start.");
          setStatus("error");
        });
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          handleServerMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onclose = () => {
        socketRef.current = null;
        teardown();
        setStatus((prev) => (prev === "error" ? prev : "ended"));
      };
      socket.onerror = () => {
        setError("Connection to the voice server failed.");
      };
    } catch (error) {
      teardown();
      socketRef.current = null;
      setError(error instanceof Error ? error.message : "Failed to start.");
      setStatus("error");
    } finally {
      startingRef.current = false;
    }
  }, [handleServerMessage, options.endpointingSilenceMs, options.token, options.wsUrl, send, teardown]);

  const stop = useCallback((): void => {
    send({ type: "session.end" });
    socketRef.current?.close();
    socketRef.current = null;
    teardown();
    setStatus("ended");
  }, [send, teardown]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
      teardown();
    };
  }, [teardown]);

  return { status, agentState, lines, latencies, error, start, stop };
}
