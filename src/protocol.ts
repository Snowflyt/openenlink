import { isIPv4 } from "node:net";
import type { Readable, Writable } from "node:stream";

export type IPv4 = `${number}.${number}.${number}.${number}`;
export type Addresses = { ipv4: IPv4; dns: string; ipv6?: string };

export function ipv4Address(value: string): IPv4 {
  if (!isIPv4(value)) throw new Error("Invalid IPv4 address");
  return value as IPv4;
}

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

  async peek(): Promise<number> {
    if (!this.pending.length) {
      const chunk = await this.chunk();
      if (!chunk) throw new Error("Connection ended before the complete packet arrived");
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

export function write(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

export function frame(kind: number, flag: number, body: Uint8Array): Buffer {
  if (body.length > 65_523) throw new Error("Tunnel packet exceeds 65535 bytes");

  const packet = Buffer.alloc(12 + body.length);
  packet[0] = 1;
  packet[1] = kind;
  packet.writeUInt16BE(packet.length, 2);
  packet.writeUInt32LE(flag, 8);
  packet.set(body, 12);
  return packet;
}

export function authentication(user: string, token: string): Buffer {
  const account = Buffer.from(user);
  const secret = Buffer.from(token);
  if (!account.length || !secret.length || account.length > 255 || secret.length > 255) {
    throw new Error("Tunnel identity and token must contain 1–255 bytes");
  }

  return frame(
    1,
    1,
    Buffer.concat([
      Buffer.from([1, 0, account.length]),
      account,
      Buffer.from([2, 0, secret.length]),
      secret,
      Buffer.from([255]),
    ]),
  );
}

export async function readAuthentication(reader: ByteReader): Promise<Addresses> {
  const header = await reader.read(12);
  const length = header.readUInt16BE(2);
  if (header[0] !== 1 || length < 12) throw new Error("Invalid tunnel authentication header");

  const body = await reader.read(length - 12);
  const code = header.readUInt16BE(10);
  if (header[8] !== 1 || code !== 0) {
    throw new Error(`Gateway rejected authentication: ${code.toString(16).padStart(4, "0")}`);
  }

  let ipv4: IPv4 | undefined;
  let ipv6: string | undefined;
  let dns: string | undefined;
  let offset = 0;

  while (offset < body.length && body[offset] !== 255) {
    if (offset + 3 > body.length) throw new Error("Truncated tunnel address header");
    const kind = body[offset];
    const size = body.readUInt16BE(offset + 1);
    offset += 3;
    if (offset + size > body.length) throw new Error("Truncated tunnel address value");

    const value = body.subarray(offset, offset + size);
    offset += size;
    if (kind === 0x0b) {
      if (size !== 4) throw new Error("Invalid virtual IPv4 address");
      ipv4 = ipv4Address(Array.from(value).join("."));
    } else if (kind === 0x24) {
      dns = value.toString();
      if (!isIPv4(dns)) throw new Error("Gateway DNS must be an IPv4 address");
    } else if (kind === 0x35) {
      if (size !== 16) throw new Error("Invalid virtual IPv6 address");
      ipv6 = Array.from({ length: 8 }, (_, i) => value.readUInt16BE(i * 2).toString(16)).join(":");
    }
  }

  if (!ipv4 || !dns) throw new Error("Gateway did not assign an IPv4 address and DNS server");
  return { dns, ipv4, ...(ipv6 ? { ipv6 } : {}) };
}

export async function readPacket(reader: ByteReader): Promise<{ kind: number; body: Buffer }> {
  // Gateway data packets use an 8-byte header; client packets use 12 bytes.
  const header = await reader.read(8);
  const length = header.readUInt16BE(2);
  if (header[0] !== 1 || length < 8) throw new Error("Invalid tunnel data header");
  return { body: await reader.read(length - 8), kind: header[1] };
}
