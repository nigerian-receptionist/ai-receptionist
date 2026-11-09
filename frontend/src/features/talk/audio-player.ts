/**
 * Gapless PCM playback for agent audio. Chunks arrive as base64 s16le mono at
 * the session output rate (24 kHz); they are scheduled back-to-back on one
 * AudioContext with per-utterance playout tracking for `playback.*` messages.
 */

export interface PlayerCallbacks {
  onProgress: (utteranceId: string, playedMs: number) => void;
  onDone: (utteranceId: string) => void;
}

const PROGRESS_INTERVAL_MS = 250;

export class AgentAudioPlayer {
  private readonly context: AudioContext;
  private readonly sampleRate: number;
  private readonly callbacks: PlayerCallbacks;
  private active: {
    utteranceId: string;
    startTime: number;
    scheduledEnd: number;
    sources: AudioBufferSourceNode[];
    ended: boolean;
    doneSent: boolean;
  } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastProgressSent = 0;

  constructor(context: AudioContext, sampleRate: number, callbacks: PlayerCallbacks) {
    this.context = context;
    this.sampleRate = sampleRate;
    this.callbacks = callbacks;
  }

  /** Queue one decoded chunk for `utteranceId`, starting the utterance if new. */
  pushChunk(utteranceId: string, pcmS16le: Int16Array): void {
    if (this.active && this.active.utteranceId !== utteranceId) {
      // The server never overlaps utterances; drop defensively if it happens.
      this.stopActive(false);
    }
    if (!this.active) {
      const startTime = Math.max(this.context.currentTime + 0.02, this.context.currentTime);
      this.active = {
        utteranceId,
        startTime,
        scheduledEnd: startTime,
        sources: [],
        ended: false,
        doneSent: false,
      };
      this.lastProgressSent = 0;
      this.ensureTimer();
    }
    const buffer = this.context.createBuffer(1, pcmS16le.length, this.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcmS16le.length; i += 1) data[i] = (pcmS16le[i] ?? 0) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const when = Math.max(this.active.scheduledEnd, this.context.currentTime + 0.01);
    if (this.active.sources.length === 0) this.active.startTime = when;
    source.start(when);
    this.active.scheduledEnd = when + buffer.duration;
    this.active.sources.push(source);
    source.onended = () => this.checkDone();
  }

  /** The server finished sending this utterance; `onDone` fires after drain. */
  markEnded(utteranceId: string): void {
    if (this.active?.utteranceId === utteranceId) {
      this.active.ended = true;
      this.checkDone();
    }
  }

  /** Drop a cancelled utterance; returns the ms actually played. */
  cancel(utteranceId: string): number {
    if (this.active?.utteranceId !== utteranceId) return 0;
    const playedMs = this.playedMs();
    this.stopActive(false);
    return playedMs;
  }

  /** Stop everything immediately (barge-in); returns ms played per utterance. */
  interrupt(): { utteranceId: string; playedMs: number } | null {
    if (!this.active) return null;
    const result = { utteranceId: this.active.utteranceId, playedMs: this.playedMs() };
    this.stopActive(false);
    return result;
  }

  get playingUtteranceId(): string | null {
    return this.active?.utteranceId ?? null;
  }

  playedMs(): number {
    if (!this.active) return 0;
    const elapsed = (this.context.currentTime - this.active.startTime) * 1000;
    const total = (this.active.scheduledEnd - this.active.startTime) * 1000;
    return Math.max(0, Math.min(Math.round(elapsed), Math.round(total)));
  }

  dispose(): void {
    this.stopActive(true);
  }

  private stopActive(clearTimer: boolean): void {
    if (this.active) {
      for (const source of this.active.sources) {
        try {
          source.onended = null;
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      this.active = null;
    }
    if (clearTimer && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.active) return;
      const now = Date.now();
      if (now - this.lastProgressSent >= PROGRESS_INTERVAL_MS) {
        this.lastProgressSent = now;
        this.callbacks.onProgress(this.active.utteranceId, this.playedMs());
      }
      this.checkDone();
    }, 100);
  }

  private checkDone(): void {
    const active = this.active;
    if (!active || !active.ended || active.doneSent) return;
    if (this.context.currentTime < active.scheduledEnd - 0.05) return;
    active.doneSent = true;
    const utteranceId = active.utteranceId;
    this.stopActive(false);
    this.callbacks.onDone(utteranceId);
  }
}

/** Decode a base64 s16le payload from `agent.audio` into samples. */
export function decodePcmBase64(pcmBase64: string): Int16Array {
  const binary = atob(pcmBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}
