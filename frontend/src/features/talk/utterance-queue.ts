/**
 * FIFO queue of not-yet-playing utterances for the agent audio player (M7).
 *
 * When chunks for a new utterance arrive while another is still playing
 * (possible when the server never sent `agent.cancelled` for the old tail),
 * the old audio must not be silently discarded along with its `playedMs`
 * accounting: the newcomer waits its turn instead. Barge-in clears the whole
 * queue — queued audio is stale by definition.
 *
 * Pure data structure; scheduling on the AudioContext lives in the player.
 */

export interface QueuedUtterance<T> {
  utteranceId: string;
  chunks: T[];
  ended: boolean;
}

/** Defensive cap; the server sends utterances serially, so depth > 1 is rare. */
export const MAX_QUEUED_UTTERANCES = 4;

export class UtteranceQueue<T> {
  private readonly entries: QueuedUtterance<T>[] = [];

  /**
   * Append a chunk to the tail entry for `utteranceId`, opening a new entry
   * when the id differs. Returns the evicted utterance id when the queue is
   * full and the oldest waiting utterance had to be dropped, else null.
   */
  push(utteranceId: string, chunk: T): string | null {
    const tail = this.entries[this.entries.length - 1];
    if (tail && tail.utteranceId === utteranceId) {
      tail.chunks.push(chunk);
      return null;
    }
    const existing = this.entries.find((entry) => entry.utteranceId === utteranceId);
    if (existing) {
      // Out-of-order arrival for a waiting utterance (should not happen on
      // an ordered socket, but stay lossless).
      existing.chunks.push(chunk);
      return null;
    }
    let evicted: string | null = null;
    if (this.entries.length >= MAX_QUEUED_UTTERANCES) {
      evicted = this.entries.shift()?.utteranceId ?? null;
    }
    this.entries.push({ utteranceId, chunks: [chunk], ended: false });
    return evicted;
  }

  markEnded(utteranceId: string): void {
    const entry = this.entries.find((candidate) => candidate.utteranceId === utteranceId);
    if (entry) entry.ended = true;
  }

  /** Remove one waiting utterance (server cancel). Returns it if present. */
  remove(utteranceId: string): QueuedUtterance<T> | null {
    const index = this.entries.findIndex((entry) => entry.utteranceId === utteranceId);
    if (index < 0) return null;
    const [removed] = this.entries.splice(index, 1);
    return removed ?? null;
  }

  /** Take the head entry when the player goes idle. */
  shiftNext(): QueuedUtterance<T> | null {
    return this.entries.shift() ?? null;
  }

  /** Drop everything waiting (barge-in); returns the dropped ids in order. */
  clear(): string[] {
    return this.entries.splice(0).map((entry) => entry.utteranceId);
  }

  get size(): number {
    return this.entries.length;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
