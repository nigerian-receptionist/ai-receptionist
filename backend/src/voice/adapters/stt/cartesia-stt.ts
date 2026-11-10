import WebSocket from "ws";

import type { SpeechToText, SttEvent, SttResult, SttStreamSession } from "../types";

/**
 * Cartesia realtime STT (manual finalize) over `wss://api.cartesia.ai/stt/websocket`.
 * See https://docs.cartesia.ai/api-reference/stt/websocket
 *
 * The server buffers audio until it receives the text command `finalize`, then
 * emits `transcript` chunks (`is_final: true` deltas that concatenate to the
 * full transcript) followed by `flush_done`.
 */
export class CartesiaStt implements SpeechToText {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly version: string;
  private readonly model: string;
  private readonly connectTimeoutMs: number;
  private readonly finalizeTimeoutMs: number;

  constructor(opts: {
    apiKey: string;
    version: string;
    model: string;
    connectTimeoutMs?: number;
    finalizeTimeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.version = opts.version;
    this.model = opts.model;
    this.modelId = `stt_cartesia@${opts.model}`;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.finalizeTimeoutMs = opts.finalizeTimeoutMs ?? 15_000;
  }

  async startSession(opts: {
    sampleRate: number;
    language?: string;
    keyterms?: string[];
  }): Promise<SttStreamSession> {
    const ws = new WebSocket(
      buildSttUrl({
        version: this.version,
        model: this.model,
        sampleRate: opts.sampleRate,
        keyterms: opts.keyterms ?? [],
      }),
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    const session = new CartesiaSttSession(ws, {
      modelId: this.modelId,
      language: opts.language ?? "en",
      sampleRate: opts.sampleRate,
      finalizeTimeoutMs: this.finalizeTimeoutMs,
    });
    await session.waitForOpen(this.connectTimeoutMs);
    return session;
  }
}

/** Cartesia STT keyterm limits (docs: keyterm prompting). */
export const MAX_STT_KEYTERMS = 100;
export const MAX_STT_KEYTERM_CHARS = 1200;

/**
 * Built-in Nigerian bias phrases: currency, identity acronyms, cities and
 * common names. Tenant terms (org/agent names, STT_KEYTERMS) come first so
 * truncation drops these before tenant-specific ones.
 */
export const DEFAULT_STT_KEYTERMS: readonly string[] = [
  "naira",
  "kobo",
  "BVN",
  "NIN",
  "NUBAN",
  "Lagos",
  "Abuja",
  "Ikeja",
  "Lekki",
  "Ibadan",
  "Kano",
  "Enugu",
  "Port Harcourt",
  "Adaeze",
  "Chinedu",
  "Ngozi",
  "Emeka",
  "Adebayo",
  "Ibrahim",
  "Aisha",
];

/**
 * Build the keyterm list for one STT connection: org name, agent name, env
 * extras, then built-ins. Dedupes, drops empties, and enforces the vendor
 * limits (terms past the cap count as dropped so the caller can log it).
 * Never pass caller data here.
 */
export function buildSttKeyterms(input: {
  orgName?: string;
  agentName?: string;
  extra?: readonly string[];
}): { terms: string[]; dropped: number } {
  const seen = new Set<string>();
  const terms: string[] = [];
  let chars = 0;
  let dropped = 0;
  const add = (raw: string): void => {
    const term = raw.trim().replace(/\s+/g, " ");
    if (term === "" || seen.has(term.toLowerCase())) return;
    if (terms.length >= MAX_STT_KEYTERMS || chars + term.length > MAX_STT_KEYTERM_CHARS) {
      dropped += 1;
      return;
    }
    seen.add(term.toLowerCase());
    terms.push(term);
    chars += term.length;
  };
  if (input.orgName !== undefined) add(input.orgName);
  if (input.agentName !== undefined) add(input.agentName);
  for (const term of input.extra ?? []) add(term);
  for (const term of DEFAULT_STT_KEYTERMS) add(term);
  return { terms, dropped };
}

/**
 * STT WebSocket URL. Keyterms repeat the `keyterm` param with spaces encoded
 * as `%20` (URLSearchParams would emit `+`, which the docs do not use).
 */
export function buildSttUrl(input: {
  version: string;
  model: string;
  sampleRate: number;
  keyterms: readonly string[];
}): string {
  const params = new URLSearchParams({
    model: input.model,
    encoding: "pcm_s16le",
    sample_rate: String(input.sampleRate),
    cartesia_version: input.version,
  });
  let query = params.toString();
  for (const term of input.keyterms) query += `&keyterm=${encodeURIComponent(term)}`;
  return `wss://api.cartesia.ai/stt/websocket?${query}`;
}

/** Frames held while the socket is still connecting (cap ~1.3 s at 20 ms/frame). */
const MAX_CONNECTING_BUFFER_FRAMES = 64;
/** Vendor backpressure guard: drop (and count) audio above this buffered amount. */
const MAX_VENDOR_BUFFERED_BYTES = 256 * 1024;

export class CartesiaSttSession implements SttStreamSession {
  private readonly ws: WebSocket;
  private readonly modelId: string;
  private readonly language: string;
  private readonly sampleRate: number;
  private readonly finalizeTimeoutMs: number;
  private listener: ((event: SttEvent) => void) | null = null;
  /** Final deltas since the last finalize() call, in arrival order. */
  private pendingFinals: string[] = [];
  private pendingAudioS = 0;
  private finalizeWaiter: {
    resolve: (result: SttResult) => void;
    reject: (error: Error) => void;
    startedAt: number;
  } | null = null;
  private failed: Error | null = null;
  private closed = false;
  /** Audio that arrived while connecting; flushed on open, counted if dropped. */
  private connectingBuffer: Buffer[] = [];
  private droppedFrames = 0;

  constructor(
    ws: WebSocket,
    opts: { modelId: string; language: string; sampleRate: number; finalizeTimeoutMs: number },
  ) {
    this.ws = ws;
    this.modelId = opts.modelId;
    this.language = opts.language;
    this.sampleRate = opts.sampleRate;
    this.finalizeTimeoutMs = opts.finalizeTimeoutMs;
    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("error", (error) => this.fail(error));
    ws.on("close", () => this.fail(new Error("stt websocket closed unexpectedly")));
    ws.once("open", () => this.flushConnectingBuffer());
  }

  /** Audio frames dropped (connecting overflow, vendor backpressure, closed). */
  get droppedAudioFrames(): number {
    return this.droppedFrames;
  }

  waitForOpen(timeoutMs: number): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.removeAllListeners("open");
        this.ws.close();
        reject(new Error("stt connect timed out"));
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

  onEvent(listener: (event: SttEvent) => void): void {
    this.listener = listener;
  }

  sendAudio(pcmS16le: Buffer): void {
    if (this.closed || this.failed) {
      this.droppedFrames += 1;
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      // Buffer leading audio briefly instead of losing speech onset.
      if (this.connectingBuffer.length < MAX_CONNECTING_BUFFER_FRAMES) {
        this.connectingBuffer.push(pcmS16le);
      } else {
        this.droppedFrames += 1;
      }
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.droppedFrames += 1;
      return;
    }
    if (this.ws.bufferedAmount > MAX_VENDOR_BUFFERED_BYTES) {
      this.droppedFrames += 1;
      return;
    }
    this.pendingAudioS += pcmS16le.length / 2 / this.sampleRate;
    this.ws.send(pcmS16le);
  }

  private flushConnectingBuffer(): void {
    for (const frame of this.connectingBuffer) this.sendAudio(frame);
    this.connectingBuffer = [];
  }

  finalize(): Promise<SttResult> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed) return Promise.reject(new Error("stt session closed"));
    if (this.finalizeWaiter) return Promise.reject(new Error("finalize already in flight"));
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("stt finalize while socket not open"));
    }
    const startedAt = performance.now();
    return new Promise<SttResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // M2: a timed-out finalize must not poison later turns.
        this.finalizeWaiter = null;
        this.pendingFinals = [];
        this.pendingAudioS = 0;
        reject(new Error("stt finalize timed out"));
      }, this.finalizeTimeoutMs);
      this.finalizeWaiter = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        startedAt,
      };
      try {
        this.ws.send("finalize");
      } catch (error) {
        this.finalizeWaiter = null;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  reset(): void {
    this.finalizeWaiter?.reject(
      Object.assign(new Error("stt finalize abandoned"), { name: "AbortError" }),
    );
    this.finalizeWaiter = null;
    this.pendingFinals = [];
    this.pendingAudioS = 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.finalizeWaiter?.reject(new Error("stt session closed"));
    this.finalizeWaiter = null;
    if (this.ws.readyState === WebSocket.OPEN) {
      const done = new Promise<void>((resolve) => {
        // Short grace for the vendor `done` ack; never stall disconnects long.
        const timer = setTimeout(resolve, 500);
        this.ws.once("message", (raw) => {
          try {
            if ((JSON.parse(raw.toString()) as { type?: string }).type === "done") {
              clearTimeout(timer);
              resolve();
            }
          } catch {
            /* fall through to timeout */
          }
        });
      });
      this.ws.send("close");
      await done;
    }
    this.ws.removeAllListeners();
    this.ws.close();
  }

  private handleMessage(raw: string): void {
    let message: { type?: string; is_final?: boolean; text?: string };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.type === "transcript" && typeof message.text === "string") {
      if (message.is_final) {
        this.pendingFinals.push(message.text);
      } else {
        this.listener?.({ kind: "partial", text: message.text });
      }
      return;
    }
    if (message.type === "flush_done") {
      const waiter = this.finalizeWaiter;
      this.finalizeWaiter = null;
      if (!waiter) {
        // M2: late flush for an abandoned/timed-out finalize: drop the stale
        // buffers instead of prefixing the next turn with them.
        this.pendingFinals = [];
        this.pendingAudioS = 0;
        return;
      }
      const text = this.pendingFinals.join("");
      this.pendingFinals = [];
      const audioS = this.pendingAudioS;
      this.pendingAudioS = 0;
      const result: SttResult = {
        text,
        language: this.language,
        confidence: null,
        words: [],
        audioS,
        latencyS: (performance.now() - waiter.startedAt) / 1000,
        modelId: this.modelId,
      };
      waiter.resolve(result);
      this.listener?.({ kind: "final", result });
      return;
    }
    if (message.type === "error") {
      this.fail(new Error(`stt error: ${raw.slice(0, 300)}`));
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.closed) return;
    this.failed = error;
    this.finalizeWaiter?.reject(error);
    this.finalizeWaiter = null;
  }
}
