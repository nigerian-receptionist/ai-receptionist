/**
 * Per-utterance receive state for `agent.audio` chunks.
 *
 * One place decides whether an incoming chunk plays or is dropped:
 * - B3: chunks for a locally interrupted utterance are dropped permanently,
 *   until the utterance lifecycle closes and a replay (seq restarts at 0)
 *   opens a new one. Stale in-flight chunks can never restart playback.
 * - M15: per-utterance seq ordering is validated; stale/duplicate chunks are
 *   dropped and forward gaps are reported so the caller can log them.
 * - Server `agent.cancelled` / `agent.audio.end` close the lifecycle; block
 *   ids (`hold`, `silence-prompt`) are reused across lifecycles, so a closed
 *   utterance reopens only on a seq restart.
 *
 * Pure logic (no DOM, no audio); the hook wires it to the player and socket.
 */

export type ChunkVerdict =
  | { verdict: "play"; gap: null }
  /** Forward seq jump: the chunk still plays (there is no re-request in the
   * protocol), but the caller must log `gap` for the turn record. */
  | { verdict: "play"; gap: { missingFrom: number; missingTo: number } }
  | { verdict: "drop-stale" }
  | { verdict: "drop-interrupted" }
  | { verdict: "drop-closed" };

type Lifecycle = "open" | "ended" | "cancelled" | "interrupted";

interface UtteranceRecord {
  lifecycle: Lifecycle;
  /** Highest seq accepted in the current lifecycle (-1 when none seen). */
  lastSeq: number;
}

/** Cap on tracked utterance ids; oldest entries evict first (LRU). */
export const MAX_TRACKED_UTTERANCES = 64;

export class UtteranceTracker {
  private readonly records = new Map<string, UtteranceRecord>();

  /**
   * Decide what to do with chunk `seq` of `utteranceId`.
   * First chunk observed for an id sets the baseline (the server numbers
   * each utterance from 0, but the tracker does not assume that).
   */
  check(utteranceId: string, seq: number): ChunkVerdict {
    const existing = this.touch(utteranceId);
    if (!existing) {
      this.store(utteranceId, { lifecycle: "open", lastSeq: seq });
      return { verdict: "play", gap: null };
    }
    if (existing.lifecycle === "interrupted") return { verdict: "drop-interrupted" };
    if (existing.lifecycle !== "open") {
      // Ended/cancelled lifecycle: only a seq restart (replayed block id,
      // or the first chunk of an utterance whose end arrived first) reopens
      // it. A restart is indistinguishable from a duplicate of chunk 0 for
      // single-chunk utterances; replays win so a missed hold block can
      // never wedge the session.
      if (seq === 0) {
        this.store(utteranceId, { lifecycle: "open", lastSeq: 0 });
        return { verdict: "play", gap: null };
      }
      return { verdict: "drop-closed" };
    }
    if (seq <= existing.lastSeq) return { verdict: "drop-stale" };
    if (seq > existing.lastSeq + 1) {
      const gap = { missingFrom: existing.lastSeq + 1, missingTo: seq - 1 };
      existing.lastSeq = seq;
      return { verdict: "play", gap };
    }
    existing.lastSeq = seq;
    return { verdict: "play", gap: null };
  }

  /** The server finished sending this utterance. */
  markEnded(utteranceId: string): void {
    this.transition(utteranceId, "ended");
  }

  /** The server cancelled this utterance (barge-in acknowledged). */
  markCancelled(utteranceId: string): void {
    this.transition(utteranceId, "cancelled");
  }

  /** Local barge-in: drop everything further for this utterance. */
  markInterrupted(utteranceId: string): void {
    const record = this.touch(utteranceId);
    if (record && record.lifecycle === "open") record.lifecycle = "interrupted";
    else if (!record) this.store(utteranceId, { lifecycle: "interrupted", lastSeq: -1 });
  }

  get size(): number {
    return this.records.size;
  }

  private transition(utteranceId: string, lifecycle: Lifecycle): void {
    const record = this.touch(utteranceId);
    if (record) record.lifecycle = lifecycle;
    else this.store(utteranceId, { lifecycle, lastSeq: -1 });
  }

  /** LRU touch: returns the record, refreshing its eviction order. */
  private touch(utteranceId: string): UtteranceRecord | undefined {
    const record = this.records.get(utteranceId);
    if (record) {
      this.records.delete(utteranceId);
      this.records.set(utteranceId, record);
    }
    return record;
  }

  private store(utteranceId: string, record: UtteranceRecord): void {
    this.records.delete(utteranceId);
    this.records.set(utteranceId, record);
    while (this.records.size > MAX_TRACKED_UTTERANCES) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.records.delete(oldest.value);
    }
  }
}
