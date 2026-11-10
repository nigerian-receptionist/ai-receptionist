/**
 * Minimal Server-Sent Events parser for OpenAI-compatible `chat/completions`
 * streams: `data: {...}` lines terminated by `data: [DONE]`.
 *
 * Pure incremental parser: feed decoded text in, pull JSON payloads out.
 * Anything that is not a `data:` line (comments, blank lines, `event:`/`id:`
 * fields) is ignored.
 */
export class SseParser {
  private buffer = "";
  private done = false;

  /** Feed a chunk of decoded text; returns the complete payloads it contains. */
  push(text: string): string[] {
    if (this.done) return [];
    this.buffer += text;
    const payloads: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const payload = parseLine(line);
      if (payload === "[DONE]") {
        this.done = true;
        break;
      }
      if (payload !== null) payloads.push(payload);
      newline = this.buffer.indexOf("\n");
    }
    return payloads;
  }

  /** True once the `[DONE]` terminator was seen. */
  get isDone(): boolean {
    return this.done;
  }

  /**
   * Flush the trailing buffer at stream end: a final `data:` line without a
   * trailing newline still carries a payload. Returns it (or nothing).
   */
  flush(): string[] {
    if (this.done || this.buffer === "") return [];
    const line = this.buffer;
    this.buffer = "";
    const payload = parseLine(line.trim());
    if (payload === "[DONE]") {
      this.done = true;
      return [];
    }
    return payload === null ? [] : [payload];
  }
}

function parseLine(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice("data:".length).trim();
  return payload === "" ? null : payload;
}
