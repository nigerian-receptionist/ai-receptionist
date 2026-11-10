/**
 * Streaming sentence splitter for LLM output. Splits on `.` `?` `!` (and long
 * commas) but never mid-number ("N45,000", "2.30") and never after common
 * abbreviations ("Mr.", "Dr.").
 *
 * Sentences are normalised with {@link normaliseForSpeech} from `./normalise`
 * before synthesis; the chunker works on the raw LLM text so punctuation
 * survives for boundary detection.
 */

/** Abbreviations (lowercase, without periods) that never end a sentence. */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "st", "ave", "blvd", "no", "vs", "etc", "eg", "ie",
  "ltd", "sr", "jr",
]);

/** A comma becomes a boundary once the current segment exceeds this length. */
export const LONG_COMMA_CHARS = 60;
/** M28: the FIRST clause may split at a comma once it reaches this many words. */
export const FIRST_CLAUSE_WORDS = 6;

export class SentenceChunker {
  private buffer = "";
  private firstEmissionDone = false;

  /** Feed an LLM delta; returns newly completed sentences (trimmed, non-empty). */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** Emit whatever remains, even without terminal punctuation. */
  flush(): string[] {
    return this.drain(true);
  }

  /**
   * M28: emit the pending tail when it is terminal-complete ("Hello there."
   * with no lookahead yet), so an LLM stall does not delay TTS. Holds
   * abbreviation, initial and mid-number tails conservatively.
   */
  flushIfTerminal(): string[] {
    const trimmed = this.buffer.trim();
    if (trimmed === "") return [];
    const match = /[.!?]+["')\]]*\s*$/.exec(trimmed);
    if (!match || match.index === 0) return [];
    const punctAt = match.index;
    const punct = trimmed[punctAt] as string;
    const before = punctAt > 0 ? (trimmed[punctAt - 1] as string) : "";
    // Mid-number ("2." + "30" still coming): wait.
    if (punct === "." && isDigit(before)) return [];
    if (punct === ".") {
      const { token, raw } = tokenBefore(trimmed, punctAt);
      if (ABBREVIATIONS.has(token)) return [];
      if (/^[A-Z]$/.test(raw)) return [];
    }
    this.buffer = "";
    this.firstEmissionDone = true;
    return [trimmed];
  }

  /** What is still buffered (useful for debugging, not for display). */
  get pending(): string {
    return this.buffer;
  }

  private drain(final: boolean): string[] {
    const sentences: string[] = [];
    let start = 0;
    let i = 0;
    while (i < this.buffer.length) {
      const char = this.buffer[i] as string;
      if (char === "\n") {
        const sentence = this.buffer.slice(start, i).trim();
        if (sentence !== "") {
          sentences.push(sentence);
          this.firstEmissionDone = true;
        }
        start = i + 1;
        i += 1;
        continue;
      }
      if (char === ",") {
        const longEnough = i - start >= LONG_COMMA_CHARS;
        // M28: start TTS on the first clause early (still needs lookahead).
        const firstClause =
          !this.firstEmissionDone && countWords(this.buffer, start, i) >= FIRST_CLAUSE_WORDS;
        if (
          (longEnough || firstClause) &&
          !isDigitRun(this.buffer, i) &&
          isCommaBoundaryAfter(this.buffer, i + 1)
        ) {
          sentences.push(this.buffer.slice(start, i + 1).trim());
          this.firstEmissionDone = true;
          start = i + 1;
        }
        i += 1;
        continue;
      }
      if (char === "." || char === "?" || char === "!") {
        const runEnd = consumeRun(this.buffer, i);
        if (isSentenceEnd(this.buffer, i, runEnd)) {
          const end = consumeClosers(this.buffer, runEnd);
          sentences.push(this.buffer.slice(start, end).trim());
          this.firstEmissionDone = true;
          start = end;
          i = end;
          continue;
        }
        i = runEnd;
        continue;
      }
      i += 1;
    }
    if (final) {
      const rest = this.buffer.slice(start).trim();
      this.buffer = "";
      if (rest !== "") sentences.push(rest);
    } else {
      this.buffer = this.buffer.slice(start);
    }
    return sentences;
  }
}

function countWords(text: string, start: number, end: number): number {
  const segment = text.slice(start, end).trim();
  if (segment === "") return 0;
  return segment.split(/\s+/).length;
}

function consumeRun(text: string, i: number): number {
  let j = i;
  while (j < text.length && (text[j] === "." || text[j] === "?" || text[j] === "!")) j += 1;
  return j;
}

/** A comma boundary only needs whitespace after it; the next clause may start lowercase. */
function isCommaBoundaryAfter(text: string, i: number): boolean {
  // No lookahead yet (comma at buffer end): wait for the next delta instead
  // of risking a mid-number split ("thousand," + "000").
  if (i >= text.length) return false;
  const next = text[i] as string;
  if (next !== " " && next !== "\t" && next !== "\n") return false;
  let j = i;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
  return j >= text.length || /[A-Za-z0-9"'(]/.test(text[j] as string);
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** True when `text[i]` sits between two digits ("45,000", "2.30"). */
function isDigitRun(text: string, i: number): boolean {
  const before = i > 0 ? (text[i - 1] as string) : "";
  const after = i + 1 < text.length ? (text[i + 1] as string) : "";
  return isDigit(before) && isDigit(after);
}

/** Include closing quotes/brackets that directly follow terminal punctuation. */
function consumeClosers(text: string, i: number): number {
  let j = i;
  while (j < text.length && (text[j] === '"' || text[j] === "'" || text[j] === ")" || text[j] === "]")) j += 1;
  return j;
}

function isSentenceEnd(text: string, punctAt: number, runEnd: number): boolean {
  // Never split inside a number: digit . digit ("2.30"), digit , digit ("45,000" handled by comma rule).
  const before = punctAt > 0 ? (text[punctAt - 1] as string) : "";
  let after = runEnd;
  while (after < text.length && (text[after] === " " || text[after] === "\t")) after += 1;
  const afterChar = after < text.length ? (text[after] as string) : "";
  if (text[punctAt] === "." && isDigit(before) && isDigit(afterChar)) return false;
  // A period directly glued to a letter is never a boundary ("e.g.", "U.S.A").
  const nextRaw = runEnd < text.length ? (text[runEnd] as string) : "";
  if (text[punctAt] === "." && nextRaw !== "" && /[A-Za-z]/.test(nextRaw)) return false;
  // Abbreviations never end a sentence ("Mr. Smith").
  if (text[punctAt] === ".") {
    const { token, raw } = tokenBefore(text, punctAt);
    if (ABBREVIATIONS.has(token)) return false;
    // Initials ("J. K. Rowling"): single capital letter followed by period.
    if (/^[A-Z]$/.test(raw) && afterChar !== "" && afterChar === afterChar.toUpperCase()) return false;
  }
  // A boundary needs a following space/end; without lookahead yet, wait for more text.
  if (after >= text.length) return false;
  return true;
}

function tokenBefore(text: string, punctAt: number): { token: string; raw: string } {
  let start = punctAt - 1;
  while (start >= 0 && /[A-Za-z.]/.test(text[start] as string)) start -= 1;
  const raw = text.slice(start + 1, punctAt);
  return { token: raw.replace(/\./g, "").toLowerCase(), raw };
}

/** Split a complete string (convenience wrapper for tests and one-shot use). */
export function splitSentences(text: string): string[] {
  const chunker = new SentenceChunker();
  const sentences = chunker.push(text);
  return [...sentences, ...chunker.flush()];
}
