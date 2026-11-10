/**
 * Gapless PCM playback for agent audio. Chunks arrive as base64 s16le mono at
 * the session output rate (24 kHz); they are scheduled back-to-back on one
 * AudioContext with per-utterance playout tracking for `playback.*` messages.
 *
 * M7: a newcomer utterance never cuts the playing one. It waits in a FIFO
 * queue, so no audio is silently discarded along with its `playedMs`
 * accounting. Barge-in clears the whole queue (queued audio is stale).
 *
 * `playback.done` timing: `onDone` fires only once the AudioContext clock has
 * reached the end of the scheduled audio, i.e. the utterance was actually
 * heard. It is never sent early: while the context is suspended (autoplay
 * policy) `currentTime` is frozen, so completion simply waits for resume.
 */

import { UtteranceQueue } from "./utterance-queue";

export interface PlayerCallbacks {
  onProgress: (utteranceId: string, playedMs: number) => void;
  onDone: (utteranceId: string) => void;
  /** A waiting utterance was evicted before playing (queue overflow). */
  onInterrupted: (utteranceId: string, playedMs: number) => void;
  /** Playing state changed (idle <-> active), for VAD sensitivity switching. */
  onPlayingChange: (playing: boolean) => void;
}

export interface InterruptResult {
  stopped: { utteranceId: string; playedMs: number } | null;
  droppedQueued: string[];
}

const PROGRESS_INTERVAL_MS = 250;
/** Render-quantum slack for the done check; small enough to never read early. */
const DONE_EPSILON_S = 0.005;

interface ActiveUtterance {
  utteranceId: string;
  startTime: number;
  scheduledEnd: number;
  sources: AudioBufferSourceNode[];
  ended: boolean;
  doneSent: boolean;
}

export class AgentAudioPlayer {
  private readonly context: AudioContext;
  private readonly sampleRate: number;
  private readonly callbacks: PlayerCallbacks;
  private active: ActiveUtterance | null = null;
  private readonly queue = new UtteranceQueue<Int16Array>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastProgressSent = 0;
  private playingNotified = false;

  constructor(context: AudioContext, sampleRate: number, callbacks: PlayerCallbacks) {
    this.context = context;
    this.sampleRate = sampleRate;
    this.callbacks = callbacks;
  }

  /** Queue one decoded chunk for `utteranceId`, starting it when idle. */
  pushChunk(utteranceId: string, pcmS16le: Int16Array): void {
    if (this.active && this.active.utteranceId === utteranceId) {
      this.scheduleChunk(this.active, pcmS16le);
      return;
    }
    if (!this.active) {
      this.startUtterance(utteranceId, [pcmS16le], false);
      return;
    }
    const evicted = this.queue.push(utteranceId, pcmS16le);
    if (evicted !== null) this.callbacks.onInterrupted(evicted, 0);
  }

  /** The server finished sending this utterance; `onDone` fires after drain. */
  markEnded(utteranceId: string): void {
    if (this.active?.utteranceId === utteranceId) {
      this.active.ended = true;
      this.checkDone();
      return;
    }
    this.queue.markEnded(utteranceId);
  }

  /** Drop a cancelled utterance; returns the ms actually played. */
  cancel(utteranceId: string): number {
    if (this.active?.utteranceId === utteranceId) {
      const playedMs = this.playedMs();
      this.stopActive();
      this.promoteNext();
      return playedMs;
    }
    this.queue.remove(utteranceId);
    return 0;
  }

  /**
   * Stop everything immediately (barge-in): the active utterance plus every
   * queued one. Returns what was stopped and the dropped queued ids so the
   * caller can mark them all interrupted.
   */
  interrupt(): InterruptResult {
    const stopped = this.active
      ? { utteranceId: this.active.utteranceId, playedMs: this.playedMs() }
      : null;
    this.stopActive();
    const droppedQueued = this.queue.clear();
    this.syncPlaying();
    return { stopped, droppedQueued };
  }

  get playingUtteranceId(): string | null {
    return this.active?.utteranceId ?? null;
  }

  get isPlaying(): boolean {
    return this.active !== null;
  }

  playedMs(): number {
    if (!this.active) return 0;
    const elapsed = (this.context.currentTime - this.active.startTime) * 1000;
    const total = (this.active.scheduledEnd - this.active.startTime) * 1000;
    return Math.max(0, Math.min(Math.round(elapsed), Math.round(total)));
  }

  dispose(): void {
    this.stopActive();
    this.queue.clear();
    this.clearTimer();
    this.syncPlaying();
  }

  private startUtterance(utteranceId: string, chunks: Int16Array[], ended: boolean): void {
    const startTime = this.context.currentTime + 0.02;
    this.active = {
      utteranceId,
      startTime,
      scheduledEnd: startTime,
      sources: [],
      ended,
      doneSent: false,
    };
    this.lastProgressSent = 0;
    for (const chunk of chunks) this.scheduleChunk(this.active, chunk);
    this.ensureTimer();
    this.syncPlaying();
  }

  private scheduleChunk(active: ActiveUtterance, pcmS16le: Int16Array): void {
    const buffer = this.context.createBuffer(1, pcmS16le.length, this.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcmS16le.length; i += 1) data[i] = (pcmS16le[i] ?? 0) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const when = Math.max(active.scheduledEnd, this.context.currentTime + 0.01);
    if (active.sources.length === 0) active.startTime = when;
    source.start(when);
    active.scheduledEnd = when + buffer.duration;
    active.sources.push(source);
    source.onended = () => this.checkDone();
  }

  private stopActive(): void {
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
  }

  private promoteNext(): void {
    const next = this.queue.shiftNext();
    if (next) {
      this.startUtterance(next.utteranceId, next.chunks, next.ended);
      this.checkDone();
    } else {
      this.syncPlaying();
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.active) {
        if (this.queue.isEmpty) this.clearTimer();
        this.syncPlaying();
        return;
      }
      const now = Date.now();
      if (now - this.lastProgressSent >= PROGRESS_INTERVAL_MS) {
        this.lastProgressSent = now;
        this.callbacks.onProgress(this.active.utteranceId, this.playedMs());
      }
      this.checkDone();
    }, 100);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private syncPlaying(): void {
    const playing = this.active !== null;
    if (playing === this.playingNotified) return;
    this.playingNotified = playing;
    this.callbacks.onPlayingChange(playing);
  }

  private checkDone(): void {
    const active = this.active;
    if (!active || !active.ended || active.doneSent) return;
    if (this.context.currentTime < active.scheduledEnd - DONE_EPSILON_S) return;
    active.doneSent = true;
    const utteranceId = active.utteranceId;
    // Final progress at 100% first, so the server proof observes full playout.
    this.callbacks.onProgress(utteranceId, Math.round((active.scheduledEnd - active.startTime) * 1000));
    this.stopActive();
    this.callbacks.onDone(utteranceId);
    this.promoteNext();
  }
}

/** Decode a base64 s16le payload from `agent.audio` into samples. */
export function decodePcmBase64(pcmBase64: string): Int16Array {
  const binary = atob(pcmBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  if (bytes.length % 2 !== 0) {
    throw new Error(`odd-length PCM payload (${bytes.length} bytes); expected s16le pairs`);
  }
  // Explicit little-endian reads: never depend on host endianness.
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}
