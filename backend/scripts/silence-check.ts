/**
 * Live check for the heard-anchored silence window (`pnpm voice:silence-check`).
 *
 * Behaves like the real browser client in frontend/src/features/talk/:
 *  - plays the disclosure + recording-notice blocks for their real duration
 *    (acks `playback.done` only after the audio could actually have played),
 *  - speaks one caller utterance (synthesised, streamed as realtime 20 ms frames),
 *  - simulates REAL playback timing of the agent reply at real-time speed:
 *    tracks received audio duration per utterance, sends `playback.progress`
 *    every ~250 ms and `playback.done` only once the audio would actually have
 *    finished playing (mirrors AgentAudioPlayer: 20 ms start delay, 100 ms
 *    check timer, 5 ms done epsilon),
 *  - then stays silent (no mic audio, no speech events) until 40 s AFTER the
 *    caller has actually heard the end of the reply (or the server ends the
 *    session first), so the silence prompt + session timeout are observable.
 *
 * Modes:
 *  - realistic (default): faithful browser playback timing described above.
 *    Asserts audible end -> prompt first audio >= 7500 ms (AGENTS.md 10.3).
 *  - naive: notices are still acked after real playout (otherwise the handshake
 *    fails closed and there is no session), but every later utterance is acked
 *    with `playback.done` immediately on `agent.audio.end` and sends no
 *    `playback.progress` — what a naive client does. Audible end is still
 *    computed for reporting; no assertion (an early ack correctly starts the
 *    window early, proving the server follows the ack).
 *
 * Run (backend must already listen on --port):
 *   cd backend && PORT=8500 node --env-file=.env dist/main.js >>/tmp/voice-8500.log 2>&1
 *   cd backend && pnpm voice:silence-check --port 8500 --mode realistic --run 1
 *
 * Never prints secrets: only message types, timings and transcript text that
 * this script itself generated.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import WebSocket from "ws";

import { loadEnv } from "../src/config/env";
import { CartesiaTts } from "../src/voice/adapters/tts/cartesia-tts";
import { resamplePcmS16le } from "../src/voice/audio/pcm";
import type { ServerMessage } from "../src/voice/protocol";

const CALLER_TEXT = "Good afternoon, I want to know my loan balance.";
const FRAME_BYTES_20MS = 640; // 16 kHz s16 mono
const ORIGIN = "http://127.0.0.1:3000";

// Mirrors frontend/src/features/talk/audio-player.ts
const PROGRESS_INTERVAL_MS = 250;
const CHECK_TIMER_MS = 100;
const START_DELAY_MS = 20;
const SCHEDULE_GAP_MS = 10;
const DONE_EPSILON_MS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? String(process.argv[idx + 1]) : fallback;
}

interface LoggedEvent {
  tAbsMs: number;
  iso: string;
  dir: "srv" | "cli" | "note";
  kind: string;
  detail: string;
}

interface UtteranceStats {
  id: string;
  firstTextAt: number | null;
  firstAudioAt: number | null;
  lastAudioAt: number | null;
  chunks: number;
  bytes: number;
  audioEndAt: number | null;
  cancelledAt: number | null;
  /** Total audio ms received (bytes -> duration at output rate). */
  audioMs: number;
  /** Wall time at which the last sample would actually be heard. */
  audibleEndAt: number | null;
  doneSentAt: number | null;
  progressSent: number;
  text: string;
}

interface ActivePlayback {
  utteranceId: string;
  startTime: number;
  scheduledEnd: number;
  ended: boolean;
  doneSent: boolean;
}

interface QueuedPlayback {
  utteranceId: string;
  bytes: number;
  ended: boolean;
}

/** Real-time playback simulation with the browser player's timing constants. */
class SimulatedPlayer {
  private active: ActivePlayback | null = null;
  private readonly queue: QueuedPlayback[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastProgressSent = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly cbs: {
      onProgress: (utteranceId: string, playedMs: number) => void;
      onDone: (utteranceId: string, audibleEndAt: number, totalMs: number) => void;
    },
  ) {}

  pushChunk(utteranceId: string, byteLen: number): void {
    const durationMs = (byteLen / 2 / this.sampleRate) * 1000;
    const now = performance.now();
    if (this.active && this.active.utteranceId === utteranceId) {
      const when = Math.max(this.active.scheduledEnd, now + SCHEDULE_GAP_MS);
      this.active.scheduledEnd = when + durationMs;
      return;
    }
    if (!this.active) {
      this.startUtterance(utteranceId, durationMs);
      return;
    }
    const queued = this.queue.find((q) => q.utteranceId === utteranceId);
    if (queued) queued.bytes += byteLen;
    else this.queue.push({ utteranceId, bytes: byteLen, ended: false });
  }

  markEnded(utteranceId: string): void {
    if (this.active?.utteranceId === utteranceId) {
      this.active.ended = true;
      this.checkDone();
      return;
    }
    const queued = this.queue.find((q) => q.utteranceId === utteranceId);
    if (queued) queued.ended = true;
  }

  cancel(utteranceId: string): void {
    if (this.active?.utteranceId === utteranceId) {
      this.active = null;
      this.promoteNext();
      return;
    }
    const idx = this.queue.findIndex((q) => q.utteranceId === utteranceId);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  get playingUtteranceId(): string | null {
    return this.active?.utteranceId ?? null;
  }

  playedMs(): number {
    if (!this.active) return 0;
    const elapsed = performance.now() - this.active.startTime;
    const total = this.active.scheduledEnd - this.active.startTime;
    return Math.max(0, Math.min(Math.round(elapsed), Math.round(total)));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startUtterance(utteranceId: string, firstChunkMs: number): void {
    const startTime = performance.now() + START_DELAY_MS;
    this.active = {
      utteranceId,
      startTime,
      scheduledEnd: startTime + firstChunkMs,
      ended: false,
      doneSent: false,
    };
    this.lastProgressSent = 0;
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.active) {
        if (this.queue.length === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }
      const now = Date.now();
      if (now - this.lastProgressSent >= PROGRESS_INTERVAL_MS) {
        this.lastProgressSent = now;
        this.cbs.onProgress(this.active.utteranceId, this.playedMs());
      }
      this.checkDone();
    }, CHECK_TIMER_MS);
  }

  private promoteNext(): void {
    const next = this.queue.shift();
    if (next) {
      const durationMs = (next.bytes / 2 / this.sampleRate) * 1000;
      this.startUtterance(next.utteranceId, durationMs);
      if (next.ended && this.active) {
        this.active.ended = true;
        this.checkDone();
      }
    }
  }

  private checkDone(): void {
    const active = this.active;
    if (!active || !active.ended || active.doneSent) return;
    if (performance.now() < active.scheduledEnd - DONE_EPSILON_MS) return;
    active.doneSent = true;
    const utteranceId = active.utteranceId;
    const audibleEndAt = active.scheduledEnd;
    const totalMs = Math.round(active.scheduledEnd - active.startTime);
    // Final progress at 100% first, like the browser player.
    this.cbs.onProgress(utteranceId, totalMs);
    this.active = null;
    this.cbs.onDone(utteranceId, audibleEndAt, totalMs);
    this.promoteNext();
  }
}

async function main(): Promise<void> {
  const port = Number(arg("--port", process.env["PORT"] ?? "8500"));
  const mode = arg("--mode", "realistic");
  if (mode !== "realistic" && mode !== "naive") throw new Error(`unknown --mode ${mode}`);
  const runLabel = arg("--run", "1");
  const silenceAfterHeardMs = Number(arg("--silence-after-heard-ms", "40000"));
  const serverLogPath = arg("--server-log", `/tmp/voice-${port}.log`);
  const outPath = `/tmp/silence-check-${mode}-run${runLabel}.jsonl`;
  const serverSlicePath = `/tmp/silence-check-${mode}-run${runLabel}.server.log`;
  const serverLogStartByte = (() => {
    try {
      return statSync(serverLogPath).size;
    } catch {
      return 0;
    }
  })();

  const env = loadEnv(process.env);
  if (!env.DEV_ACCESS_TOKEN) throw new Error("DEV_ACCESS_TOKEN is required in backend/.env");

  const tts = new CartesiaTts({
    apiKey: env.CARTESIA_API_KEY,
    version: env.CARTESIA_VERSION,
    model: env.TTS_MODEL,
    defaultVoiceId: env.TTS_VOICE,
  });
  console.log(`[silence-check] mode=${mode} run=${runLabel} port=${port} (synthesising caller utterance ...)`);
  const synth = await tts.synthesize(CALLER_TEXT, { voiceId: env.TTS_VOICE, language: "en" });
  const callerPcm16k = resamplePcmS16le(synth.pcmS16le, synth.sampleRate, 16000);
  const callerAudioS = callerPcm16k.length / 2 / 16000;
  console.log(`[silence-check] caller audio: ${callerAudioS.toFixed(2)}s at 16 kHz`);

  const events: LoggedEvent[] = [];
  const utterances = new Map<string, UtteranceStats>();
  const naiveDone = new Set<string>();
  let outputSampleRate = 24000;
  let player: SimulatedPlayer | null = null;
  let tSessionStart = 0;
  let tSpeechEndedSend = 0;
  let tFirstListening = 0;
  let turnStarted = false;
  let finished = false;
  let finishReason = "";

  function stat(id: string): UtteranceStats {
    let s = utterances.get(id);
    if (!s) {
      s = {
        id,
        firstTextAt: null,
        firstAudioAt: null,
        lastAudioAt: null,
        chunks: 0,
        bytes: 0,
        audioEndAt: null,
        cancelledAt: null,
        audioMs: 0,
        audibleEndAt: null,
        doneSentAt: null,
        progressSent: 0,
        text: "",
      };
      utterances.set(id, s);
    }
    return s;
  }

  function log(dir: LoggedEvent["dir"], kind: string, detail: string, live: boolean): void {
    const tAbsMs = performance.now();
    events.push({ tAbsMs, iso: new Date().toISOString(), dir, kind, detail });
    if (live) {
      const sinceStart = tSessionStart === 0 ? 0 : Math.round(tAbsMs - tSessionStart);
      console.log(`[t+${String(sinceStart).padStart(7)}] ${dir} ${kind} ${detail}`);
    }
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?token=${encodeURIComponent(env.DEV_ACCESS_TOKEN)}`, {
    headers: { Origin: ORIGIN },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  function send(type: string, extra: Record<string, unknown> = {}): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...extra }));
  }

  player = new SimulatedPlayer(outputSampleRate, {
    onProgress: (utteranceId, playedMs) => {
      if (naiveDone.has(utteranceId)) return; // naive client sends no progress
      stat(utteranceId).progressSent += 1;
      log("cli", "playback.progress", `${shortId(utteranceId)} playedMs=${playedMs}`, false);
      send("playback.progress", { utteranceId, playedMs });
    },
    onDone: (utteranceId, audibleEndAt, totalMs) => {
      const s = stat(utteranceId);
      s.audibleEndAt = audibleEndAt;
      log("note", "client.playback_end", `${shortId(utteranceId)} audible end (heard ${totalMs} ms)`, true);
      if (naiveDone.has(utteranceId)) return; // already acked early
      s.doneSentAt = performance.now();
      log("cli", "playback.done", shortId(utteranceId), true);
      send("playback.done", { utteranceId });
    },
  });
  // Sample rate arrives in session.ready; recreate then (no audio before that).
  const recreatePlayer = (): void => {
    if (!player) return;
    player.stop();
    player = new SimulatedPlayer(outputSampleRate, {
      onProgress: (utteranceId, playedMs) => {
        if (naiveDone.has(utteranceId)) return;
        stat(utteranceId).progressSent += 1;
        log("cli", "playback.progress", `${shortId(utteranceId)} playedMs=${playedMs}`, false);
        send("playback.progress", { utteranceId, playedMs });
      },
      onDone: (utteranceId, audibleEndAt, totalMs) => {
        const s = stat(utteranceId);
        s.audibleEndAt = audibleEndAt;
        log("note", "client.playback_end", `${shortId(utteranceId)} audible end (heard ${totalMs} ms)`, true);
        if (naiveDone.has(utteranceId)) return;
        s.doneSentAt = performance.now();
        log("cli", "playback.done", shortId(utteranceId), true);
        send("playback.done", { utteranceId });
      },
    });
  };

  function shortId(id: string): string {
    if (id.startsWith("notice-") || id === "hold" || id === "silence-prompt") return id;
    if (id.startsWith("opener-")) return `opener-${id.slice(7, 15)}`;
    return `reply-${id.slice(0, 8)}`;
  }

  function isReplyUtterance(id: string): boolean {
    return (
      !id.startsWith("notice-") && !id.startsWith("opener-") && id !== "hold" && id !== "silence-prompt"
    );
  }

  const done = new Promise<void>((resolve) => {
    const overallCap = setTimeout(() => {
      if (!finished) {
        finished = true;
        finishReason = "overall cap reached";
        log("note", "finish", finishReason, true);
        resolve();
      }
    }, 240_000);
    overallCap.unref?.();

    ws.on("message", (raw: object) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      switch (message.type) {
        case "session.ready":
          outputSampleRate = message.outputSampleRate;
          recreatePlayer();
          log(
            "srv",
            "session.ready",
            `out=${message.outputSampleRate}Hz stt=${message.sttModelId} tts=${message.ttsModelId} llm=${message.llmModel}`,
            true,
          );
          break;
        case "state":
          if (message.state === "listening" && tFirstListening === 0) tFirstListening = performance.now();
          log("srv", "state", `-> ${message.state}`, true);
          if (message.state === "listening") void runTurn();
          if (message.state === "ended" && !finished) {
            finished = true;
            finishReason = "server state=ended";
            log("note", "finish", finishReason, true);
            setTimeout(resolve, 500);
          }
          break;
        case "transcript.partial":
          log("srv", "transcript.partial", JSON.stringify(message.text.slice(0, 80)), false);
          break;
        case "transcript.final":
          log("srv", "transcript.final", JSON.stringify(message.text), true);
          break;
        case "agent.text": {
          const s = stat(message.utteranceId);
          if (s.firstTextAt === null) s.firstTextAt = performance.now();
          s.text += message.delta;
          const preview = message.delta.slice(0, 60).replace(/\n/g, " ");
          log("srv", "agent.text", `${shortId(message.utteranceId)} kind=${message.kind} ${JSON.stringify(preview)}`, true);
          break;
        }
        case "agent.audio": {
          const s = stat(message.utteranceId);
          const bytes = Buffer.from(message.pcmBase64, "base64").length;
          const now = performance.now();
          if (s.firstAudioAt === null) {
            s.firstAudioAt = now;
            log("srv", "agent.audio.first", `${shortId(message.utteranceId)} seq=${message.seq} bytes=${bytes}`, true);
          }
          s.lastAudioAt = now;
          s.chunks += 1;
          s.bytes += bytes;
          s.audioMs = (s.bytes / 2 / outputSampleRate) * 1000;
          player?.pushChunk(message.utteranceId, bytes);
          break;
        }
        case "agent.audio.end": {
          const s = stat(message.utteranceId);
          s.audioEndAt = performance.now();
          log(
            "srv",
            "agent.audio.end",
            `${shortId(message.utteranceId)} chunks=${s.chunks} audioMs=${Math.round(s.audioMs)}`,
            true,
          );
          player?.markEnded(message.utteranceId);
          if (mode === "naive" && !message.utteranceId.startsWith("notice-") && !naiveDone.has(message.utteranceId)) {
            naiveDone.add(message.utteranceId);
            s.doneSentAt = performance.now();
            log("cli", "playback.done", `${shortId(message.utteranceId)} (naive: immediate on audio.end)`, true);
            send("playback.done", { utteranceId: message.utteranceId });
          }
          break;
        }
        case "agent.cancelled": {
          const s = stat(message.utteranceId);
          s.cancelledAt = performance.now();
          log("srv", "agent.cancelled", shortId(message.utteranceId), true);
          player?.cancel(message.utteranceId);
          break;
        }
        case "turn.metrics":
          log("srv", "turn.metrics", `${message.turnId.slice(0, 8)} ${JSON.stringify(message.timingsMs)}`, true);
          break;
        case "error":
          log("srv", "error", `${message.code} ${message.message} fatal=${message.fatal}`, true);
          if (message.fatal && !finished) {
            finished = true;
            finishReason = `fatal server error: ${message.code}`;
            setTimeout(resolve, 500);
          }
          break;
      }
    });
    ws.once("close", (code: number, reason: Buffer) => {
      if (!finished) {
        finished = true;
        finishReason = `socket closed: ${code} ${reason.toString()}`;
      }
      log("note", "close", `${code} ${reason.toString()}`, true);
      resolve();
    });
    ws.once("error", (error: Error) => {
      if (!finished) {
        finished = true;
        finishReason = `socket error: ${error.message}`;
      }
      log("note", "socket_error", error.message, true);
      resolve();
    });
  });

  async function runTurn(): Promise<void> {
    if (turnStarted) return;
    turnStarted = true;
    log("note", "caller_stream", `streaming ${callerAudioS.toFixed(2)}s in realtime 20 ms frames`, true);
    log("cli", "input.speech_started", "", true);
    send("input.speech_started", { atMs: Date.now() });
    for (let offset = 0; offset < callerPcm16k.length; offset += FRAME_BYTES_20MS) {
      if (finished) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(callerPcm16k.subarray(offset, offset + FRAME_BYTES_20MS));
      await sleep(20);
    }
    tSpeechEndedSend = performance.now();
    log("cli", "input.speech_ended", "(silence clock baseline for this report)", true);
    send("input.speech_ended", { atMs: Date.now() });
    void silencePhase();
  }

  async function silencePhase(): Promise<void> {
    // Stay silent until 40 s after the reply was actually heard (min 75 s after
    // speech_ended so the timeout end is observable; cap 150 s).
    const t0 = performance.now();
    for (;;) {
      if (finished) return;
      const reply = [...utterances.values()].find((u) => isReplyUtterance(u.id));
      const heardEnd = reply?.audibleEndAt;
      const elapsed = performance.now() - t0;
      if (heardEnd !== null && heardEnd !== undefined) {
        if (performance.now() >= heardEnd + silenceAfterHeardMs && elapsed >= 75_000) break;
      } else if (elapsed >= 150_000) {
        break; // reply never completed; cap out
      }
      if (elapsed >= 150_000) break;
      await sleep(500);
    }
    if (!finished) {
      finished = true;
      finishReason = "silence window complete; ending session";
      log("note", "finish", finishReason, true);
      send("session.end");
      await sleep(800);
      ws.close();
    }
  }

  tSessionStart = performance.now();
  log("cli", "session.start", `protocolVersion=1 inputSampleRate=16000 caller=${callerAudioS.toFixed(2)}s`, true);
  send("session.start", { protocolVersion: 1, inputSampleRate: 16000 });
  await done;
  player?.stop();
  try {
    ws.close();
  } catch {
    // already closed
  }

  // Slice the server log for this run's window.
  try {
    const full = readFileSync(serverLogPath, "utf8");
    const sliced = full.slice(serverLogStartByte);
    writeFileSync(serverSlicePath, sliced);
    console.log(`[silence-check] server log slice: ${serverSlicePath} (${sliced.length} bytes)`);
  } catch (error) {
    console.log(
      `[silence-check] server log slice failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Full event log (JSONL) + trimmed timeline relative to input.speech_ended.
  const base = tSpeechEndedSend === 0 ? tSessionStart : tSpeechEndedSend;
  const rel = (t: number | null): string => (t === null ? "   ---" : String(Math.round(t - base)).padStart(7));
  writeFileSync(
    outPath,
    events.map((e) => JSON.stringify({ ...e, tRelMs: Math.round(e.tAbsMs - base) })).join("\n") + "\n",
  );
  console.log(`[silence-check] event log: ${outPath} (${events.length} events)`);
  console.log(`\n===== TIMELINE (ms relative to input.speech_ended) mode=${mode} run=${runLabel} =====`);
  for (const e of events) {
    if (e.dir === "cli" && e.kind === "playback.progress") continue; // too noisy; counted per utterance
    if (e.kind === "transcript.partial") continue;
    console.log(`[${rel(e.tAbsMs)}] ${e.dir} ${e.kind} ${e.detail}`);
  }
  console.log(`\n===== UTTERANCES (ms relative to input.speech_ended) =====`);
  for (const s of utterances.values()) {
    console.log(
      `${shortId(s.id)}: firstText=${rel(s.firstTextAt)} firstAudio=${rel(s.firstAudioAt)} ` +
        `audioEnd=${rel(s.audioEndAt)} audibleEnd=${rel(s.audibleEndAt)} doneSent=${rel(s.doneSentAt)} ` +
        `audioMs=${Math.round(s.audioMs)} chunks=${s.chunks} progress=${s.progressSent}` +
        (s.cancelledAt !== null ? ` CANCELLED@${rel(s.cancelledAt)}` : ""),
    );
  }
  const reply = [...utterances.values()].find((u) => isReplyUtterance(u.id));
  const prompt = utterances.get("silence-prompt");
  console.log(`\n===== KEY GAPS =====`);
  let audibleGapMs: number | null = null;
  if (reply && prompt?.firstAudioAt !== null && prompt?.firstAudioAt !== undefined) {
    const heardEnd = reply.audibleEndAt;
    audibleGapMs =
      heardEnd === null ? null : Math.round((prompt.firstAudioAt as number) - heardEnd);
    console.log(
      `reply audible end -> silence-prompt first audio: ` +
        (audibleGapMs === null ? "n/a (reply never fully heard)" : `${audibleGapMs} ms (expected ~+8000)`),
    );
  } else {
    console.log(`silence prompt ${prompt ? "seen but no audio" : "NOT observed"} in this run`);
  }
  if (reply?.audioEndAt !== null && reply?.audioEndAt !== undefined && prompt?.firstAudioAt) {
    console.log(
      `reply agent.audio.end -> silence-prompt first audio: ${Math.round(prompt.firstAudioAt - (reply.audioEndAt as number))} ms (8 s timer + block render if clock starts at send-complete)`,
    );
  }
  console.log(`finish: ${finishReason}`);

  // Heard-anchored assertion (AGENTS.md 10.3): the caller must get ~8s of real
  // silence after hearing the end before the prompt's first audio. Naive mode
  // is exempt: its early ack correctly starts the window early.
  if (mode === "realistic") {
    if (audibleGapMs === null) {
      console.error(`[silence-check] FAIL: no measurable audible gap (reply or prompt audio missing)`);
      process.exit(1);
    }
    if (audibleGapMs < 7500) {
      console.error(
        `[silence-check] FAIL: audible end -> prompt first audio was ${audibleGapMs} ms, expected >= 7500 ms`,
      );
      process.exit(1);
    }
    console.log(`[silence-check] PASS: audible gap ${audibleGapMs} ms >= 7500 ms`);
  }
}

main().catch((error: unknown) => {
  console.error(`[silence-check] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
