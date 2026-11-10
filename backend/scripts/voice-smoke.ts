/**
 * Headless end-to-end smoke test for the realtime voice loop (`pnpm voice:smoke`).
 *
 * Requires a running backend (`pnpm dev`) with CARTESIA_API_KEY, MUSE_API_KEY
 * and DEV_ACCESS_TOKEN in backend/.env. It synthesises one caller utterance
 * with the TTS adapter, resamples 24 kHz -> 16 kHz, plays the notice handshake,
 * streams the speech as realtime 20 ms frames, and asserts the server returns
 * `transcript.final`, `agent.audio` and `turn.metrics`.
 *
 * Never prints secrets: only message types, timings and transcript text that
 * this script itself generated.
 */
import { performance } from "node:perf_hooks";

import WebSocket from "ws";

import { loadEnv } from "../src/config/env";
import { CartesiaTts } from "../src/voice/adapters/tts/cartesia-tts";
import { resamplePcmS16le } from "../src/voice/audio/pcm";
import type { ServerMessage, TurnTimingsMs } from "../src/voice/protocol";

const CALLER_TEXT = "Good afternoon, I want to know my loan balance.";
const FRAME_BYTES_20MS = 640; // 16 kHz s16 mono

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  if (!env.DEV_ACCESS_TOKEN) throw new Error("DEV_ACCESS_TOKEN is required in backend/.env");
  const tts = new CartesiaTts({
    apiKey: env.CARTESIA_API_KEY,
    version: env.CARTESIA_VERSION,
    model: env.TTS_MODEL,
    defaultVoiceId: env.TTS_VOICE,
  });

  console.log(`[smoke] synthesising caller utterance with ${env.TTS_MODEL} ...`);
  const synth = await tts.synthesize(CALLER_TEXT, { voiceId: env.TTS_VOICE, language: "en" });
  const callerPcm16k = resamplePcmS16le(synth.pcmS16le, synth.sampleRate, 16000);
  console.log(`[smoke] caller audio: ${(callerPcm16k.length / 2 / 16000).toFixed(2)}s at 16 kHz`);

  const token = env.DEV_ACCESS_TOKEN;
  const url = `ws://127.0.0.1:${env.PORT}/v1/voice?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url, { headers: { Origin: "http://127.0.0.1:3000" } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let seenFinal = "";
  let audioChunks = 0;
  let audioBytes = 0;
  let metrics: TurnTimingsMs | null = null;
  let agentText = "";
  let outputSampleRate = 24000;
  // Notice-block playout tracking: ack only after the block could have played (F2).
  const noticeAudio = new Map<string, { firstAt: number; bytes: number }>();
  // Client-measured turn latency (AGENTS.md 10.4 budget, speech end -> agent speech).
  // Opener audio and reply audio are stamped separately (opener utterance ids
  // are learned from their agent.text); the headline stamp is the first of either.
  let tSpeechEndedSend = 0;
  let tFirstAgentAudio = 0;
  let tFirstOpenerAudio = 0;
  let tFirstReplyAudio = 0;
  const openerUtterances = new Set<string>();
  const failures: string[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("smoke timed out waiting for turn.metrics")), 120_000);
    ws.on("message", (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      switch (message.type) {
        case "session.ready":
          outputSampleRate = message.outputSampleRate;
          console.log(
            `[smoke] ready: stt=${message.sttModelId} tts=${message.ttsModelId} llm=${message.llmModel} out=${message.outputSampleRate}Hz`,
          );
          break;
        case "state":
          console.log(`[smoke] state -> ${message.state}`);
          if (message.state === "listening") void runTurn();
          break;
        case "agent.text":
          if (message.kind === "speech") agentText += message.delta;
          else if (message.blockId?.startsWith("opener_")) openerUtterances.add(message.utteranceId);
          break;
        case "agent.audio": {
          const bytes = Buffer.from(message.pcmBase64, "base64").length;
          if (message.utteranceId.startsWith("notice-")) {
            const tracked = noticeAudio.get(message.utteranceId);
            if (tracked) tracked.bytes += bytes;
            else noticeAudio.set(message.utteranceId, { firstAt: performance.now(), bytes });
          } else {
            audioChunks += 1;
            audioBytes += bytes;
            const now = performance.now();
            if (tFirstAgentAudio === 0) tFirstAgentAudio = now;
            if (openerUtterances.has(message.utteranceId)) {
              if (tFirstOpenerAudio === 0) tFirstOpenerAudio = now;
            } else if (tFirstReplyAudio === 0) {
              tFirstReplyAudio = now;
            }
          }
          break;
        }
        case "agent.audio.end":
          if (message.utteranceId.startsWith("notice-")) {
            void ackAfterPlayout(message.utteranceId);
          }
          break;
        case "transcript.final":
          seenFinal = message.text;
          console.log(`[smoke] transcript.final: ${JSON.stringify(message.text)}`);
          break;
        case "turn.metrics":
          metrics = message.timingsMs;
          clearTimeout(timer);
          resolve();
          break;
        case "error":
          console.log(`[smoke] server error: ${message.code} ${message.message} fatal=${message.fatal}`);
          if (message.fatal) {
            clearTimeout(timer);
            reject(new Error(`fatal server error: ${message.code}`));
          }
          break;
        default:
          break;
      }
    });
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      reject(new Error(`socket closed early: ${code} ${reason.toString()}`));
    });
    ws.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  async function ackAfterPlayout(utteranceId: string): Promise<void> {
    const tracked = noticeAudio.get(utteranceId);
    const durationMs = tracked ? (tracked.bytes / 2 / outputSampleRate) * 1000 : 0;
    const firstAt = tracked?.firstAt ?? performance.now();
    const waitMs = firstAt + durationMs - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    console.log(
      `[smoke] ack ${utteranceId} after ${Math.round(durationMs)} ms playout (${tracked?.bytes ?? 0} bytes)`,
    );
    ws.send(JSON.stringify({ type: "playback.done", utteranceId }));
  }

  let turnStarted = false;
  async function runTurn(): Promise<void> {
    if (turnStarted) return;
    turnStarted = true;
    console.log("[smoke] streaming caller audio in realtime 20 ms frames ...");
    ws.send(JSON.stringify({ type: "input.speech_started", atMs: Date.now() }));
    for (let offset = 0; offset < callerPcm16k.length; offset += FRAME_BYTES_20MS) {
      ws.send(callerPcm16k.subarray(offset, offset + FRAME_BYTES_20MS));
      await sleep(20);
    }
    tSpeechEndedSend = performance.now();
    ws.send(JSON.stringify({ type: "input.speech_ended", atMs: Date.now() }));
  }

  ws.send(JSON.stringify({ type: "session.start", protocolVersion: 1, inputSampleRate: 16000 }));
  await done;

  if (seenFinal.trim() === "") failures.push("empty transcript.final");
  if (audioChunks === 0) failures.push("no agent.audio received");
  if (!metrics) failures.push("no turn.metrics received");
  const clientEndToFirstAudioMs =
    tSpeechEndedSend === 0 || tFirstAgentAudio === 0
      ? null
      : Math.round(tFirstAgentAudio - tSpeechEndedSend);
  const clientOpenerFirstAudioMs =
    tSpeechEndedSend === 0 || tFirstOpenerAudio === 0
      ? null
      : Math.round(tFirstOpenerAudio - tSpeechEndedSend);
  const clientReplyFirstAudioMs =
    tSpeechEndedSend === 0 || tFirstReplyAudio === 0
      ? null
      : Math.round(tFirstReplyAudio - tSpeechEndedSend);
  console.log(`[smoke] agent text: ${JSON.stringify(agentText.trim())}`);
  console.log(`[smoke] agent audio: ${audioChunks} chunks, ${(audioBytes / 2 / 24000).toFixed(2)}s`);
  console.log(`[smoke] timings ms (server): ${JSON.stringify(metrics)}`);
  console.log(
    `[smoke] client opener_first_audio ms: ${clientOpenerFirstAudioMs} (null when no opener played)`,
  );
  console.log(`[smoke] client reply_first_audio ms: ${clientReplyFirstAudioMs}`);
  console.log(
    `[smoke] client end_to_first_audio ms: ${clientEndToFirstAudioMs} (AGENTS.md 10.4 target 1000-1500)`,
  );
  // Generous sanity bound (vendor latency varies); the 10.4 target is reported, not gated.
  if (clientEndToFirstAudioMs === null) failures.push("no client first-audio stamp");
  else if (clientEndToFirstAudioMs > 30000) failures.push("client end_to_first_audio over 30 s");
  ws.send(JSON.stringify({ type: "session.end" }));
  ws.close();
  if (failures.length > 0) {
    console.error(`[smoke] FAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("[smoke] PASS");
}

main().catch((error: unknown) => {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
