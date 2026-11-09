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

  async startSession(opts: { sampleRate: number; language?: string }): Promise<SttStreamSession> {
    const params = new URLSearchParams({
      model: this.model,
      encoding: "pcm_s16le",
      sample_rate: String(opts.sampleRate),
      cartesia_version: this.version,
    });
    const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${params.toString()}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
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
    if (this.closed || this.failed) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.pendingAudioS += pcmS16le.length / 2 / this.sampleRate;
    this.ws.send(pcmS16le);
  }

  finalize(): Promise<SttResult> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed) return Promise.reject(new Error("stt session closed"));
    if (this.finalizeWaiter) return Promise.reject(new Error("finalize already in flight"));
    const startedAt = performance.now();
    return new Promise<SttResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finalizeWaiter = null;
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
      this.ws.send("finalize");
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.finalizeWaiter?.reject(new Error("stt session closed"));
    this.finalizeWaiter = null;
    if (this.ws.readyState === WebSocket.OPEN) {
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
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
      if (!waiter) return;
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
