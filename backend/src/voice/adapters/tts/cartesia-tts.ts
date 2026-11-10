import WebSocket from "ws";

import { TONE_TO_EMOTION } from "../../tone";
import type {
  AudioChunk,
  TextToSpeech,
  TtsReplyStream,
  TtsResult,
  TtsStreamEvent,
  TtsStreamSession,
  VoiceInfo,
  WordTiming,
} from "../types";

/**
 * Cartesia Sonic TTS. Streaming synthesis goes over one warm WebSocket per
 * voice session (`wss://api.cartesia.ai/tts/websocket`) with one context per
 * agent reply: sentences stream in as continuations (`continue: true`) and the
 * reply ends with an empty `continue: false`, so prosody stays seamless.
 * One-shot synthesis (pre-rendered blocks) uses REST `POST /tts/bytes`.
 * See https://docs.cartesia.ai/api-reference/tts/websocket
 */
export class CartesiaTts implements TextToSpeech {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly version: string;
  private readonly model: string;
  private readonly defaultVoiceId: string;
  private readonly connectTimeoutMs: number;
  private readonly firstAudioTimeoutMs: number;
  private readonly restTimeoutMs: number;
  private readonly maxBufferDelayMs: number;

  constructor(opts: {
    apiKey: string;
    version: string;
    model: string;
    defaultVoiceId: string;
    connectTimeoutMs?: number;
    firstAudioTimeoutMs?: number;
    restTimeoutMs?: number;
    /**
     * Server-side input buffer per request. We already buffer client-side per
     * sentence, for which the docs recommend 0 (the default); token-by-token
     * streaming would want the 3000 ms default instead.
     */
    maxBufferDelayMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.version = opts.version;
    this.model = opts.model;
    this.defaultVoiceId = opts.defaultVoiceId;
    this.modelId = `tts_cartesia@${opts.model}`;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.firstAudioTimeoutMs = opts.firstAudioTimeoutMs ?? 20_000;
    this.restTimeoutMs = opts.restTimeoutMs ?? 30_000;
    this.maxBufferDelayMs = opts.maxBufferDelayMs ?? 0;
  }

  voices(): VoiceInfo[] {
    return [
      {
        voiceId: this.defaultVoiceId,
        language: "en",
        gender: "unspecified",
        tones: Object.keys(TONE_TO_EMOTION),
      },
    ];
  }

  async synthesize(
    text: string,
    opts: {
      voiceId: string;
      language: string;
      tone?: string;
      speed?: number;
      sampleRate?: number;
      signal?: AbortSignal;
    },
  ): Promise<TtsResult> {
    const startedAt = performance.now();
    const sampleRate = opts.sampleRate ?? 24000;
    const timeout = AbortSignal.timeout(this.restTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const request = (): Promise<Response> =>
      fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.version,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: this.model,
          transcript: text,
          voice: { id: opts.voiceId },
          output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: sampleRate },
          language: opts.language,
          generation_config: generationConfig(opts.tone, opts.speed),
        }),
        signal,
      });
    let response: Response;
    try {
      response = await request();
      if (response.status === 429) {
        // One retry: throttling is usually a brief concurrency burst.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        response = await request();
      }
    } catch (error) {
      throw ttsError("rest request failed", error);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "<unreadable>");
      throw new Error(`tts rest http ${response.status}: ${detail.slice(0, 300)}`);
    }
    const pcm = Buffer.from(await response.arrayBuffer());
    if (pcm.length % 2 !== 0) throw new Error("tts rest returned odd-length pcm");
    const totalS = (performance.now() - startedAt) / 1000;
    return {
      pcmS16le: pcm,
      sampleRate,
      durationS: pcm.length / 2 / sampleRate,
      timeToFirstAudioS: totalS,
      totalLatencyS: totalS,
      voiceId: opts.voiceId,
      modelId: this.modelId,
      textSpoken: text,
      words: [],
    };
  }

  async startSession(opts: { sampleRate: number }): Promise<TtsStreamSession> {
    const params = new URLSearchParams({ cartesia_version: this.version });
    const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?${params.toString()}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const session = new CartesiaTtsSession(ws, {
      model: this.model,
      modelId: this.modelId,
      sampleRate: opts.sampleRate,
      firstAudioTimeoutMs: this.firstAudioTimeoutMs,
      maxBufferDelayMs: this.maxBufferDelayMs,
    });
    await session.waitForOpen(this.connectTimeoutMs);
    return session;
  }
}

/**
 * Map a session tone name to a Cartesia emotion, or omit it (the model reads
 * the subtext). Strict: only allow-listed tone names map — anything else
 * (angry, sarcastic, threatening, ...) omits, even when Cartesia documents
 * the value. An unmapped value must never reach the vendor.
 */
export function toCartesiaEmotion(tone: string | undefined): string | undefined {
  if (tone === undefined) return undefined;
  const mapped: string | null | undefined = (TONE_TO_EMOTION as Record<string, string | null>)[tone];
  return mapped ?? undefined;
}

function generationConfig(
  tone: string | undefined,
  speed: number | undefined,
): { emotion?: string; speed?: number } | undefined {
  const config: { emotion?: string; speed?: number } = {};
  const emotion = toCartesiaEmotion(tone);
  if (emotion) config.emotion = emotion;
  if (speed !== undefined) config.speed = Math.min(1.5, Math.max(0.6, speed));
  return Object.keys(config).length > 0 ? config : undefined;
}

interface ContextState {
  queue: TtsStreamEvent[];
  waiter: (() => void) | null;
  error: Error | null;
  finished: boolean;
  audioBytes: number;
  words: WordTiming[];
  firstAudioAt: number | null;
  startedAt: number;
}

export class CartesiaTtsSession implements TtsStreamSession {
  private readonly ws: WebSocket;
  private readonly model: string;
  private readonly modelId: string;
  private readonly sampleRate: number;
  private readonly firstAudioTimeoutMs: number;
  private readonly maxBufferDelayMs: number;
  private readonly contexts = new Map<string, ContextState>();
  private failed: Error | null = null;
  private closed = false;

  constructor(
    ws: WebSocket,
    opts: {
      model: string;
      modelId: string;
      sampleRate: number;
      firstAudioTimeoutMs: number;
      maxBufferDelayMs?: number;
    },
  ) {
    this.ws = ws;
    this.model = opts.model;
    this.modelId = opts.modelId;
    this.sampleRate = opts.sampleRate;
    this.firstAudioTimeoutMs = opts.firstAudioTimeoutMs;
    this.maxBufferDelayMs = opts.maxBufferDelayMs ?? 0;
    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("error", (error) => this.fail(error));
    ws.on("close", () => this.fail(new Error("tts websocket closed unexpectedly")));
  }

  waitForOpen(timeoutMs: number): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.removeAllListeners("open");
        this.ws.close();
        reject(new Error("tts connect timed out"));
      }, timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  speakReply(opts: {
    voiceId: string;
    language: string;
    tone?: string;
    speed?: number;
    contextId: string;
    signal?: AbortSignal;
  }): TtsReplyStream {
    if (this.failed) throw this.failed;
    if (this.closed) throw new Error("tts session closed");
    if (this.contexts.has(opts.contextId)) throw new Error("duplicate tts context id");
    const state: ContextState = {
      queue: [],
      waiter: null,
      error: null,
      finished: false,
      audioBytes: 0,
      words: [],
      firstAudioAt: null,
      startedAt: performance.now(),
    };
    this.contexts.set(opts.contextId, state);
    // Fields shared by every input on the context (docs: only transcript and
    // continue may vary). The emotion is one per reply.
    const shared = {
      model_id: this.model,
      voice: { id: opts.voiceId },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: this.sampleRate },
      language: opts.language,
      context_id: opts.contextId,
      add_timestamps: true,
      max_buffer_delay_ms: this.maxBufferDelayMs,
      generation_config: generationConfig(opts.tone, opts.speed),
    };
    let pushes = 0;
    let replyFinished = false;
    let eventsConsumed = false;
    const onAbort = (): void => {
      this.cancelContext(opts.contextId);
      state.error = state.error ?? abortError();
      state.waiter?.();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const firstAudioTimer = setTimeout(() => {
      if (state.firstAudioAt === null && !state.finished) {
        state.error = new Error("tts first audio timed out");
        state.waiter?.();
      }
    }, this.firstAudioTimeoutMs);
    return {
      push: (text: string): void => {
        if (replyFinished) throw new Error("tts push after finish");
        // A barge-in racing the push is normal: drop it locally. The vendor
        // cancel only halts inputs not yet generating, so the local error
        // below is what keeps stale audio from leaking past the cancel.
        if (state.error) return;
        this.ws.send(JSON.stringify({ ...shared, transcript: text, continue: true }));
        pushes += 1;
      },
      finish: (): void => {
        if (replyFinished) return;
        replyFinished = true;
        if (pushes === 0) throw new Error("tts reply finished without input");
        if (state.error) return;
        this.ws.send(JSON.stringify({ ...shared, transcript: "", continue: false }));
      },
      events: (): AsyncIterable<TtsStreamEvent> => {
        if (eventsConsumed) throw new Error("tts reply events consumed twice");
        eventsConsumed = true;
        const contexts = this.contexts;
        return (async function* (): AsyncGenerator<TtsStreamEvent> {
          try {
            let isFirst = true;
            for (;;) {
              // Check errors BEFORE draining: post-abort buffered chunks are
              // stale and must never leak past a cancel.
              if (state.error) throw state.error;
              while (state.queue.length > 0) {
                const event = state.queue.shift();
                if (!event) break;
                if (event.kind === "audio") {
                  event.chunk.isFirst = isFirst;
                  isFirst = false;
                }
                yield event;
              }
              if (state.finished) return;
              await new Promise<void>((resolve) => {
                state.waiter = resolve;
              });
              state.waiter = null;
            }
          } finally {
            clearTimeout(firstAudioTimer);
            opts.signal?.removeEventListener("abort", onAbort);
            contexts.delete(opts.contextId);
          }
        })();
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.contexts.values()) {
      state.error = state.error ?? new Error("tts session closed");
      state.waiter?.();
    }
    this.ws.removeAllListeners();
    this.ws.close();
  }

  private cancelContext(contextId: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ context_id: contextId, cancel: true }));
    }
  }

  private handleMessage(raw: string): void {
    let message: {
      type?: string;
      context_id?: string;
      data?: string;
      done?: boolean;
      word_timestamps?: { words?: string[]; start?: number[]; end?: number[] };
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    const state = typeof message.context_id === "string" ? this.contexts.get(message.context_id) : null;
    if (!state || state.finished) return;
    if (message.type === "chunk" && typeof message.data === "string") {
      const pcm = Buffer.from(message.data, "base64");
      state.audioBytes += pcm.length;
      if (state.firstAudioAt === null) state.firstAudioAt = performance.now();
      const chunk: AudioChunk = {
        pcmS16le: pcm,
        sampleRate: this.sampleRate,
        isFirst: false,
        isLast: message.done === true,
      };
      state.queue.push({ kind: "audio", chunk });
      state.waiter?.();
      return;
    }
    if (message.type === "timestamps" && message.word_timestamps) {
      const { words = [], start = [], end = [] } = message.word_timestamps;
      const timings: WordTiming[] = words.map((text, i) => ({
        text,
        startS: start[i] ?? 0,
        endS: end[i] ?? 0,
        confidence: null,
      }));
      state.words.push(...timings);
      state.queue.push({ kind: "timestamps", words: timings });
      state.waiter?.();
      return;
    }
    if (message.type === "done") {
      const now = performance.now();
      const firstAudioS =
        state.firstAudioAt !== null ? (state.firstAudioAt - state.startedAt) / 1000 : (now - state.startedAt) / 1000;
      state.queue.push({
        kind: "done",
        result: {
          pcmS16le: Buffer.alloc(0),
          sampleRate: this.sampleRate,
          durationS: state.audioBytes / 2 / this.sampleRate,
          timeToFirstAudioS: firstAudioS,
          totalLatencyS: (now - state.startedAt) / 1000,
          voiceId: "",
          modelId: this.modelId,
          textSpoken: "",
          words: state.words,
        },
      });
      state.finished = true;
      state.waiter?.();
      return;
    }
    if (message.type === "flush_done") {
      // We never send flush (per-sentence mapping comes from ordered audio +
      // absolute word timestamps instead), but tolerate the ack if one ever
      // arrives.
      return;
    }
    if (message.type === "error") {
      state.error = new Error(`tts error: ${raw.slice(0, 300)}`);
      state.waiter?.();
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.closed) return;
    this.failed = error;
    for (const state of this.contexts.values()) {
      state.error = state.error ?? error;
      state.waiter?.();
    }
  }
}

function abortError(): Error {
  const error = new Error("tts cancelled");
  error.name = "AbortError";
  return error;
}

function ttsError(what: string, cause: unknown): Error {
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  return new Error(`tts ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
}
