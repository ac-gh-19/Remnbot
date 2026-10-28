// Groups messages (fed in oldest-first) into conversation chunks.
// - A silence longer than gapMinutes ends the conversation; the next chunk starts fresh.
// - A chunk that reaches messageLimit is closed, and the next chunk starts with its last
//   `overlap` messages so a moment that spans the split appears whole in one of them.
// onChunk is called with each finished chunk.
export interface ChunkingOptions {
  messageLimit: number;
  overlap: number;
  gapMinutes: number;
  minMessages: number;
}

export interface Chunk<T> {
  index: number;
  overlap: number;
  startedAt: string;
  endedAt: string;
  messages: T[];
}

export class ConversationChunker<T extends { createdAt: string }> {
  readonly messageLimit: number;
  readonly overlap: number;
  readonly gapMs: number;
  readonly minMessages: number;
  readonly onChunk: (chunk: Chunk<T>) => Promise<void>;

  #messages: T[] = [];
  #carried = 0; // how many messages at the start of #messages came from the previous chunk
  #continued = false; // true once the current conversation has split across chunks
  #count = 0;

  constructor(
    { messageLimit, overlap, gapMinutes, minMessages }: ChunkingOptions,
    onChunk: (chunk: Chunk<T>) => Promise<void>,
  ) {
    this.messageLimit = messageLimit;
    this.overlap = overlap;
    this.gapMs = gapMinutes * 60_000;
    this.minMessages = minMessages;
    this.onChunk = onChunk;
  }

  async add(message: T): Promise<void> {
    const last = this.#messages.at(-1);

    if (last && Date.parse(message.createdAt) - Date.parse(last.createdAt) > this.gapMs) {
      await this.flush();
    } else if (this.#messages.length >= this.messageLimit) {
      await this.#emit();
      this.#messages = this.overlap ? this.#messages.slice(-this.overlap) : [];
      this.#carried = this.#messages.length;
      this.#continued = true;
    }

    this.#messages.push(message);
  }

  // Ends the current conversation, dropping it if it was too short to be worth keeping.
  // Call once after the last message.
  async flush(): Promise<void> {
    if (this.#continued || this.#messages.length >= this.minMessages) {
      await this.#emit();
    }
    this.#messages = [];
    this.#carried = 0;
    this.#continued = false;
  }

  // Number of chunks emitted so far
  get count(): number {
    return this.#count;
  }

  async #emit(): Promise<void> {
    const first = this.#messages[0];
    const last = this.#messages.at(-1);
    if (!first || !last) return;

    this.#count++;
    await this.onChunk({
      index: this.#count,
      overlap: this.#carried,
      startedAt: first.createdAt,
      endedAt: last.createdAt,
      messages: this.#messages,
    });
  }
}

// GIF hosts, plus any link straight to an image/video file (e.g. Discord attachment URLs)
const MEDIA_LINK =
  /https?:\/\/(?:(?:[\w-]+\.)*(?:tenor|giphy|klipy)\.com\/\S*|[^\s?#]+\.(?:gif|gifv|png|jpe?g|webp|mp4|mov)(?:[?#]\S*)?)/gi;

// The text with GIF/image links removed; empty if nothing informative is left, in which case
// the message isn't worth chunking (GIF-only, image-only or attachment-only)
export function textContent(content: string): string {
  return content.replace(MEDIA_LINK, '').trim();
}
