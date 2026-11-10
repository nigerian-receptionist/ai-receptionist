"use client";

import { MicVAD } from "@ricky0123/vad-web";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentAudioPlayer, decodePcmBase64 } from "./audio-player";
import type { ClientMessage, ServerMessage } from "./protocol";
import { VOICE_PROTOCOL_VERSION, type AgentState, type TurnTimingsMs } from "./protocol";
import { shouldSendMicFrame } from "./send-gate";
import {
  IDLE_MIN_SPEECH_MS,
  IDLE_POSITIVE_THRESHOLD,
  PLAYING_MIN_SPEECH_MS,
  PLAYING_POSITIVE_THRESHOLD,
  SpeechGate,
} from "./speech-gate";
import { UtteranceTracker } from "./utterance-tracker";

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
/** How often to warn about mic backpressure drops (every Nth drop). */
const MIC_DROP_WARN_EVERY = 100;
/** Delay before closing the socket after `session.end` so it can flush. */
const SESSION_END_CLOSE_DELAY_MS = 300;

export function useTalkSession(options: TalkSessionOptions) {
  const [status, setStatus] = useState<TalkStatus>("idle");
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [latencies, setLatencies] = useState<TurnLatency[]>([]);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const resumeListenerRef = useRef<(() => void) | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const playerRef = useRef<AgentAudioPlayer | null>(null);
  const trackerRef = useRef<UtteranceTracker>(new UtteranceTracker());
  const gateRef = useRef<SpeechGate>(new SpeechGate());
  const agentTextRef = useRef<Map<string, { text: string; blockId?: string }>>(new Map());
  const readyRef = useRef(false);
  /** Last VAD sensitivity mode applied; null when never synced. */
  const vadPlayingRef = useRef<boolean | null>(null);
  const micDroppedRef = useRef(0);
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
    const audioContext = audioContextRef.current;
    const resumeListener = resumeListenerRef.current;
    audioContextRef.current = null;
    resumeListenerRef.current = null;
    if (audioContext && resumeListener) audioContext.removeEventListener("statechange", resumeListener);
    audioContext?.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    playerRef.current?.dispose();
    playerRef.current = null;
    trackerRef.current = new UtteranceTracker();
    gateRef.current = new SpeechGate();
    agentTextRef.current.clear();
    readyRef.current = false;
    vadPlayingRef.current = null;
    micDroppedRef.current = 0;
  }, []);

  const fail = useCallback(
    (message: string): void => {
      setError(message);
      setStatus("error");
      teardown();
      socketRef.current?.close();
      socketRef.current = null;
    },
    [teardown],
  );

  /**
   * M14: raise the VAD bar while agent audio plays (higher positive
   * threshold + longer confirmation, AGENTS.md 10.3) so the speaker does not
   * barge the agent in; restore idle sensitivity when playback stops. The
   * mic stream's `echoCancellation` remains the primary defence.
   */
  const syncVadSensitivity = useCallback((): void => {
    const vad = vadRef.current;
    if (!vad) return;
    const playing = playerRef.current?.isPlaying ?? false;
    if (vadPlayingRef.current === playing) return;
    vadPlayingRef.current = playing;
    try {
      vad.setOptions(
        playing
          ? { positiveSpeechThreshold: PLAYING_POSITIVE_THRESHOLD, minSpeechMs: PLAYING_MIN_SPEECH_MS }
          : { positiveSpeechThreshold: IDLE_POSITIVE_THRESHOLD, minSpeechMs: IDLE_MIN_SPEECH_MS },
      );
    } catch (error) {
      console.warn("talk: VAD sensitivity switch failed", error);
    }
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerMessage): void => {
      switch (message.type) {
        case "session.ready": {
          if (message.protocolVersion !== VOICE_PROTOCOL_VERSION) {
            fail(`Unsupported voice protocol version ${message.protocolVersion}.`);
            break;
          }
          if (!Number.isFinite(message.outputSampleRate) || message.outputSampleRate <= 0) {
            fail(`Invalid output sample rate ${message.outputSampleRate}.`);
            break;
          }
          const audioContext = audioContextRef.current;
          if (!audioContext) {
            fail("Audio initialisation failed before the session started.");
            break;
          }
          playerRef.current?.dispose();
          playerRef.current = new AgentAudioPlayer(audioContext, message.outputSampleRate, {
            onProgress: (utteranceId, playedMs) =>
              send({ type: "playback.progress", utteranceId, playedMs }),
            onDone: (utteranceId) => send({ type: "playback.done", utteranceId }),
            onInterrupted: (utteranceId, playedMs) =>
              send({ type: "playback.interrupted", utteranceId, playedMs }),
            onPlayingChange: () => syncVadSensitivity(),
          });
          readyRef.current = true;
          setStatus("live");
          break;
        }
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
          const entry = agentTextRef.current.get(message.utteranceId) ?? {
            text: "",
            blockId: message.blockId,
          };
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
        case "agent.audio": {
          const decision = trackerRef.current.check(message.utteranceId, message.seq);
          if (decision.verdict !== "play") break;
          if (decision.gap !== null) {
            // No re-request exists in the protocol: flag the turn and resync.
            const detail =
              `chunks ${decision.gap.missingFrom}..${decision.gap.missingTo} ` +
              `of ${message.utteranceId} missing`;
            console.warn(`talk: audio gap (${detail})`);
            setError(`Audio gap detected: ${detail}.`);
          }
          try {
            playerRef.current?.pushChunk(message.utteranceId, decodePcmBase64(message.pcmBase64));
          } catch (error) {
            console.warn("talk: corrupt audio chunk skipped", error);
          }
          break;
        }
        case "agent.audio.end":
          trackerRef.current.markEnded(message.utteranceId);
          playerRef.current?.markEnded(message.utteranceId);
          agentTextRef.current.delete(message.utteranceId);
          setLines((prev) =>
            prev.map((l) => (l.key === `agent-${message.utteranceId}` ? { ...l, final: true } : l)),
          );
          break;
        case "agent.cancelled":
          trackerRef.current.markCancelled(message.utteranceId);
          playerRef.current?.cancel(message.utteranceId);
          agentTextRef.current.delete(message.utteranceId);
          setLines((prev) =>
            prev.map((l) => (l.key === `agent-${message.utteranceId}` ? { ...l, final: true } : l)),
          );
          break;
        case "turn.metrics":
          setLatencies((prev) => [...prev.slice(-19), { turnId: message.turnId, timings: message.timingsMs }]);
          break;
        case "error":
          if (message.fatal) {
            fail(message.message);
          } else {
            setError(message.message);
          }
          break;
      }
    },
    [fail, send, syncVadSensitivity, upsertLine],
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
      // M13: a suspended context freezes currentTime, stalling playback and
      // completion. Resume on this user gesture and on every later suspend.
      const resumeListener = (): void => {
        if (audioContext.state === "suspended") {
          audioContext.resume().catch(() => undefined);
        }
      };
      resumeListenerRef.current = resumeListener;
      audioContext.addEventListener("statechange", resumeListener);
      try {
        await audioContext.resume();
      } catch (error) {
        console.warn("talk: AudioContext resume failed; retrying on statechange", error);
      }
      await audioContext.audioWorklet.addModule("/worklets/pcm-capture.js");
      const source = audioContext.createMediaStreamSource(stream);
      const captureNode = new AudioWorkletNode(audioContext, "pcm-capture");
      captureNodeRef.current = captureNode;
      captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN || !readyRef.current) return;
        // M8: drop mic frames under backpressure instead of buffering stale audio.
        if (!shouldSendMicFrame(socket.bufferedAmount)) {
          micDroppedRef.current += 1;
          if (micDroppedRef.current % MIC_DROP_WARN_EVERY === 1) {
            console.warn(
              `talk: dropping mic frames (socket buffer ${socket.bufferedAmount} bytes, ` +
                `${micDroppedRef.current} dropped so far)`,
            );
          }
          return;
        }
        socket.send(event.data);
      };
      source.connect(captureNode);

      const vad = await MicVAD.new({
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        model: "v5",
        redemptionMs: options.endpointingSilenceMs,
        minSpeechMs: IDLE_MIN_SPEECH_MS,
        positiveSpeechThreshold: IDLE_POSITIVE_THRESHOLD,
        getStream: async () => stream,
        // M10: only VAD-confirmed speech opens a turn; misfires stay silent.
        onSpeechRealStart: () => {
          for (const action of gateRef.current.handle("real-start")) {
            if (action !== "started") continue;
            // B3: local barge-in stops the active utterance AND every queued
            // one permanently; their late chunks are dropped by the tracker.
            const { stopped, droppedQueued } = playerRef.current?.interrupt() ?? {
              stopped: null,
              droppedQueued: [],
            };
            if (stopped) trackerRef.current.markInterrupted(stopped.utteranceId);
            for (const id of droppedQueued) trackerRef.current.markInterrupted(id);
            send({ type: "input.speech_started", atMs: Date.now() });
            if (stopped) {
              send({
                type: "playback.interrupted",
                utteranceId: stopped.utteranceId,
                playedMs: stopped.playedMs,
              });
            }
            for (const id of droppedQueued) {
              send({ type: "playback.interrupted", utteranceId: id, playedMs: 0 });
            }
          }
        },
        onSpeechEnd: () => {
          for (const action of gateRef.current.handle("end")) {
            if (action === "ended") send({ type: "input.speech_ended", atMs: Date.now() });
          }
        },
        onVADMisfire: () => {
          for (const action of gateRef.current.handle("misfire")) {
            if (action === "ended") send({ type: "input.speech_ended", atMs: Date.now() });
          }
        },
      });
      vadRef.current = vad;

      // NOTE: local-dev auth only. The token rides in the WS query string and
      // is baked into the client bundle (F6); the fixed protocol offers no
      // ticket/header alternative yet, so this stays until the backend adds
      // server-minted voice tickets. Never deploy beyond localhost as is.
      const socket = new WebSocket(`${options.wsUrl}?token=${encodeURIComponent(options.token)}`);
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "session.start",
            protocolVersion: VOICE_PROTOCOL_VERSION,
            inputSampleRate: 16000,
          }),
        );
        vad.start().catch((error: unknown) => {
          fail(error instanceof Error ? error.message : "VAD failed to start.");
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
        // M12: a dead socket must not leave the mic, VAD and context running
        // with the status stuck live; closing drives the full teardown above.
        setError("Connection to the voice server failed.");
        setStatus("error");
        try {
          socket.close();
        } catch {
          // onclose still runs the teardown.
        }
      };
    } catch (error) {
      teardown();
      socketRef.current = null;
      setError(error instanceof Error ? error.message : "Failed to start.");
      setStatus("error");
    } finally {
      startingRef.current = false;
    }
  }, [fail, handleServerMessage, options.endpointingSilenceMs, options.token, options.wsUrl, send, teardown]);

  const stop = useCallback((): void => {
    send({ type: "session.end" });
    const socket = socketRef.current;
    socketRef.current = null;
    teardown();
    setStatus("ended");
    // Let session.end flush so the server records a clean end, not an abrupt
    // close; the socket is already detached from the session.
    if (socket) {
      window.setTimeout(() => {
        try {
          socket.close(1000, "session end");
        } catch {
          // Already closed.
        }
      }, SESSION_END_CLOSE_DELAY_MS);
    }
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
