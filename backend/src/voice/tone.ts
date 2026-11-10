/**
 * Reply tone tags (expressive voice): the LLM begins every reply with a hidden
 * `[tone: <name>]` tag chosen from the caller's words and situation. The tag is
 * parsed and stripped from the stream BEFORE chunking, TTS, `agent.text`,
 * history and storage, so it is never spoken, shown or stored. The tone maps
 * to one Cartesia `generation_config.emotion` for the whole reply context.
 */

/** Session tone names. The allow-list is enforced here, not in the prompt. */
export type ToneName =
  | "neutral"
  | "warm"
  | "empathetic"
  | "upbeat"
  | "calm-firm"
  | "apologetic"
  | "reverent";

/**
 * Allow-list: session tone to Cartesia emotion. `neutral` maps to null (omit
 * `generation_config.emotion` so the model reads the subtext). Anything else
 * the LLM writes (angry, sarcastic, threatening, ...) resolves to neutral.
 */
export const TONE_TO_EMOTION: Record<ToneName, string | null> = {
  neutral: null,
  warm: "content",
  empathetic: "sympathetic",
  upbeat: "happy",
  "calm-firm": "calm",
  apologetic: "apologetic",
  reverent: "peaceful",
};

/**
 * Complete Cartesia emotion list, copied from the volume-speed-emotion guide
 * (the WebSocket API reference enum is a subset). Used to validate values
 * before they reach `generation_config.emotion`.
 */
export const CARTESIA_EMOTIONS: ReadonlySet<string> = new Set([
  "neutral", "happy", "excited", "enthusiastic", "elated", "euphoric", "triumphant",
  "amazed", "surprised", "flirtatious", "curious", "content", "peaceful", "serene",
  "calm", "grateful", "affectionate", "trust", "sympathetic", "anticipation",
  "mysterious", "angry", "mad", "outraged", "frustrated", "agitated", "threatened",
  "disgusted", "contempt", "envious", "sarcastic", "ironic", "sad", "dejected",
  "melancholic", "disappointed", "hurt", "guilty", "bored", "tired", "rejected",
  "nostalgic", "wistful", "apologetic", "hesitant", "insecure", "confused",
  "resigned", "anxious", "panicked", "alarmed", "scared", "proud", "confident",
  "distant", "skeptical", "contemplative", "determined",
]);

/** A complete head tag: `[tone: <value>]` at the reply start. */
const HEAD_TAG_RE = /^\s*\[tone\s*:\s*([^\]\n]{0,32})\]/i;
/** Later tags anywhere in the text are stripped and ignored. */
const LATER_TAG_RE = /\[tone\s*:[^\]\n]{0,32}\]/gi;
/** A trailing `[` fragment that may complete into a tag on the next delta. */
const TRAILING_PARTIAL_RE = /\[[^\]\n]{0,24}$/;
/** The accumulated head could still become a tag: keep buffering. */
const HEAD_POSSIBLE_RE = /^\s*\[(t(o(n(e)?)?)?)?\s*:?\s*[a-zA-Z-]{0,32}$/;
/** The head looks like a broken tag attempt (strip it, never speak it). */
const HEAD_TAGLIKE_RE = /^\s*\[tone/i;
/** Strip a broken head tag through its closing bracket. */
const HEAD_MALFORMED_CLOSED_RE = /^\s*\[[^\]\n]*\]/;
/** Strip a broken head tag that never closed (bounded, prefix only). */
const HEAD_MALFORMED_OPEN_RE = /^\s*\[tone\s*:?\s*/i;

/** Upper bound on head buffering before the tag is forced to resolve. */
const HEAD_MAX_CHARS = 48;

export type TagInvalidReason = "unknown" | "malformed";

/**
 * Streaming tone-tag parser. Feed LLM deltas with `push()` and forward the
 * returned clean text to the chunker/history/store; call `flush()` at stream
 * end. `tone` resolves once the head is decided (default neutral).
 */
/** Reverse map, so a tag carrying the Cartesia value also resolves. */
const EMOTION_TO_TONE = new Map<string, ToneName>();
for (const [tone, emotion] of Object.entries(TONE_TO_EMOTION)) {
  if (emotion !== null) EMOTION_TO_TONE.set(emotion, tone as ToneName);
}

export class ToneTagStripper {
  private head = "";
  private decided = false;
  private carry = "";
  /** Trim whitespace right after a stripped head tag (may arrive later). */
  private trimLeading = false;
  private resolved: ToneName = "neutral";
  private invalid: TagInvalidReason | null = null;

  /** Resolved tone (neutral until the head decides, and for tagless replies). */
  get tone(): ToneName {
    return this.resolved;
  }

  /** Why the head tag fell back to neutral (null when clean or missing). */
  get tagInvalid(): TagInvalidReason | null {
    return this.invalid;
  }

  /** Feed one LLM delta; returns the clean text to forward (may be empty). */
  push(delta: string): string {
    if (!this.decided) {
      this.head += delta;
      const headMatch = HEAD_TAG_RE.exec(this.head);
      if (headMatch) {
        this.resolveHeadValue(headMatch[1] ?? "");
        const rest = this.head.slice(headMatch[0].length);
        this.head = "";
        this.decided = true;
        this.trimLeading = true;
        return this.pushPhase2(rest);
      }
      if (!this.forceDecide() && HEAD_POSSIBLE_RE.test(this.head) && !this.head.includes("]")) {
        return "";
      }
      return this.decideNonMatchingHead();
    }
    return this.pushPhase2(delta);
  }

  /** End of stream: emit whatever is still buffered. */
  flush(): string {
    let out = "";
    if (!this.decided) {
      const headMatch = HEAD_TAG_RE.exec(this.head);
      if (headMatch) {
        this.resolveHeadValue(headMatch[1] ?? "");
        this.trimLeading = true;
        out += this.pushPhase2(this.head.slice(headMatch[0].length));
      } else {
        out += this.decideNonMatchingHead();
      }
      this.head = "";
      this.decided = true;
    }
    out += this.carry;
    this.carry = "";
    this.trimLeading = false;
    return out;
  }

  private forceDecide(): boolean {
    return this.head.length > HEAD_MAX_CHARS;
  }

  private resolveHeadValue(raw: string): void {
    const value = raw.trim().toLowerCase().replace(/\s+/g, "-");
    const byTone = value !== "" && value in TONE_TO_EMOTION ? (value as ToneName) : null;
    // Tolerate the Cartesia value in the tag (`[tone: sympathetic]`): it
    // resolves to the tone it belongs to. Anything else falls to neutral.
    const byEmotion = value === "" ? null : (EMOTION_TO_TONE.get(value) ?? null);
    const resolved = byTone ?? byEmotion;
    if (resolved !== null) {
      this.resolved = resolved;
      this.invalid = null;
    } else {
      this.resolved = "neutral";
      this.invalid = value === "" ? "malformed" : "unknown";
    }
  }

  /** The head is not a parseable tag: malformed-strip or pass through. */
  private decideNonMatchingHead(): string {
    const head = this.head;
    this.head = "";
    this.decided = true;
    this.resolved = "neutral";
    if (HEAD_TAGLIKE_RE.test(head)) {
      this.invalid = "malformed";
      this.trimLeading = true;
      const closed = HEAD_MALFORMED_CLOSED_RE.exec(head);
      if (closed) return this.pushPhase2(head.slice(closed[0].length));
      return this.pushPhase2(head.replace(HEAD_MALFORMED_OPEN_RE, ""));
    }
    this.invalid = null;
    return this.pushPhase2(head);
  }

  /** Strip complete later tags; hold a trailing partial for the next delta. */
  private pushPhase2(text: string): string {
    const combined = this.carry + text;
    this.carry = "";
    let stripped = combined.replace(LATER_TAG_RE, "");
    if (this.trimLeading) {
      stripped = stripped.replace(/^\s+/, "");
      if (stripped !== "") this.trimLeading = false;
    }
    const partial = TRAILING_PARTIAL_RE.exec(stripped);
    if (partial) {
      this.carry = partial[0];
      return stripped.slice(0, stripped.length - this.carry.length);
    }
    return stripped;
  }
}
