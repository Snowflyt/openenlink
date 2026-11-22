import type { Readable, Writable } from "node:stream";

export class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.iterator = stream.iterator({ destroyOnReturn: false });
  }

  async chunk(): Promise<Buffer | undefined> {
    if (this.pending.length) {
      const chunk = this.pending;
      this.pending = Buffer.alloc(0);
      return chunk;
    }

    const next = await this.iterator.next();
    return next.done ? undefined : next.value;
  }

  // Returns undefined when the stream ends before its first byte.
  async peek(): Promise<number | undefined> {
    if (!this.pending.length) {
      const chunk = await this.chunk();
      if (!chunk) return undefined;
      this.pending = chunk;
    }
    return this.pending[0];
  }

  // Returns the bytes before the delimiter and consumes the delimiter too.
  async until(delimiter: string, limit: number): Promise<Buffer> {
    let data = this.pending;
    this.pending = Buffer.alloc(0);
    let end: number;
    while ((end = data.indexOf(delimiter)) < 0) {
      if (data.length > limit) throw new Error(`No ${JSON.stringify(delimiter)} in ${limit} bytes`);
      const chunk = await this.chunk();
      if (!chunk) throw new Error("Connection ended before the complete packet arrived");
      data = Buffer.concat([data, chunk]);
    }
    this.pending = data.subarray(end + delimiter.length);
    return data.subarray(0, end);
  }

  async read(length: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(length);
    let offset = 0;

    while (offset < length) {
      const chunk = await this.chunk();
      if (!chunk) throw new Error("Connection ended before the complete packet arrived");

      const count = Math.min(chunk.length, length - offset);
      chunk.copy(result, offset, 0, count);
      offset += count;
      this.pending = chunk.subarray(count);
    }

    return result;
  }
}

// Errors from a socket whose peer reset or abandoned the connection. Reading from or writing to the
// socket once it is destroyed fails with the last two.
const LEFT = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
]);

export function peerLeft(error: unknown): boolean {
  return error instanceof Error && "code" in error && LEFT.has(String(error.code));
}

export function write(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });
}
