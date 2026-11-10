// A session's scrollback: whole chunks of output kept in order, addressed by the byte offset of the stream.

interface Chunk {
  seq: number;
  bytes: Buffer;
  lines: number;
}

function newlines(bytes: Buffer): number {
  let count = 0;
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count += 1;
  return count;
}

export class OutputRing {
  private chunks: Chunk[] = [];
  private size = 0;
  private lines = 0;
  private next = 0;
  private readonly maxBytes: number;
  private readonly maxLines: number;

  constructor(maxBytes: number, maxLines: number) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }

  /** The offset the next byte will have. */
  get end(): number {
    return this.next;
  }

  /** The offset of the oldest byte still held. */
  get base(): number {
    return this.chunks[0]?.seq ?? this.next;
  }

  /** Stores `data` and returns the offset of its first byte. Oldest chunks go first once either limit is passed. */
  append(data: string): number {
    const bytes = Buffer.from(data, "utf8");
    const seq = this.next;
    if (bytes.length === 0) return seq;
    const lines = newlines(bytes);
    this.chunks.push({ seq, bytes, lines });
    this.next += bytes.length;
    this.size += bytes.length;
    this.lines += lines;
    while (this.chunks.length > 1 && (this.size > this.maxBytes || this.lines > this.maxLines)) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.bytes.length;
      this.lines -= dropped.lines;
    }
    return seq;
  }

  /** The bytes from `from` (clamped to what is held) up to the end. */
  slice(from: number): Buffer {
    const start = Math.max(from, this.base);
    if (start >= this.next) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.seq + chunk.bytes.length;
      if (chunkEnd <= start) continue;
      parts.push(start > chunk.seq ? chunk.bytes.subarray(start - chunk.seq) : chunk.bytes);
    }
    return Buffer.concat(parts);
  }

  /** The newest bytes, at most `maxBytes`, starting on a character boundary. */
  tail(maxBytes: number): { seq: number; bytes: Buffer } {
    let from = Math.max(this.base, this.next - maxBytes);
    let bytes = this.slice(from);
    let skip = 0;
    while (skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip += 1;
    if (skip > 0) {
      bytes = bytes.subarray(skip);
      from += skip;
    }
    return { seq: from, bytes };
  }
}
