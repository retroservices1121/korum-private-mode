/**
 * Removes Qwen3 `<think>…</think>` blocks from streamed output.
 *
 * Thinking is disabled at request time (`enable_thinking: false`), and this is
 * the display-side backstop: hidden reasoning is never shown. Tags
 * can be split across chunks, so the filter holds back any suffix that could
 * be the start of a tag. An unterminated block is dropped entirely.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

function partialSuffix(text: string, tag: string): number {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(-len))) return len;
  }
  return 0;
}

export class ThinkFilter {
  private buffer = "";
  private inThink = false;
  /** Output so far is still only whitespace (an empty think block leaves "\n\n"). */
  private leading = true;

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    while (this.buffer.length > 0) {
      if (this.inThink) {
        const end = this.buffer.indexOf(CLOSE);
        if (end === -1) {
          const keep = partialSuffix(this.buffer, CLOSE);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          break;
        }
        this.buffer = this.buffer.slice(end + CLOSE.length);
        this.inThink = false;
        continue;
      }
      const start = this.buffer.indexOf(OPEN);
      if (start === -1) {
        const keep = partialSuffix(this.buffer, OPEN);
        out += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }
      out += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start + OPEN.length);
      this.inThink = true;
    }
    return this.trimLeading(out);
  }

  /** Flushes held-back text at end of stream. */
  flush(): string {
    const rest = this.inThink ? "" : this.buffer;
    this.buffer = "";
    return this.trimLeading(rest);
  }

  private trimLeading(text: string): string {
    if (!this.leading) return text;
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed.length > 0) this.leading = false;
    return trimmed;
  }
}

/** One-shot version for stored text. */
export function stripThinking(text: string): string {
  const filter = new ThinkFilter();
  return filter.push(text) + filter.flush();
}
