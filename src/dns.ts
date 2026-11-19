import { randomInt } from "node:crypto";
import { isIPv4 } from "node:net";
import { domainToASCII } from "node:url";

import packet from "dns-packet";

import type { NetworkStack } from "#tcpip";

export class Resolver {
  private readonly stack: NetworkStack;
  private readonly server: string;
  private readonly cache = new Map<string, { address: string; expires: number }>();

  constructor(stack: NetworkStack, server: string) {
    this.stack = stack;
    this.server = server;
  }

  async lookup(host: string, signal: AbortSignal): Promise<string> {
    if (isIPv4(host)) return host;
    const original = domainToASCII(host).toLowerCase().replace(/\.$/, "");
    if (!original) throw new Error("Invalid campus hostname");
    const cached = this.cache.get(original);
    if (cached && cached.expires > Date.now()) return cached.address;

    let name = original;
    let ttl = Infinity;
    const seen = new Set<string>();
    for (let query = 0; query < 8; query++) {
      if (seen.has(name)) throw new Error("Campus DNS returned a CNAME loop");
      seen.add(name);
      const response = await this.query(name, signal);
      const answers = response.answers ?? [];
      const requested = name;
      for (let hop = 0; hop < 8; hop++) {
        const record = answers.find(
          (entry) => entry.type === "A" && entry.name.toLowerCase().replace(/\.$/, "") === name,
        );
        if (record?.type === "A" && isIPv4(record.data)) {
          if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(original, {
            address: record.data,
            expires: Date.now() + Math.min(ttl, record.ttl ?? 0) * 1000,
          });
          return record.data;
        }
        const alias = answers.find(
          (entry) => entry.type === "CNAME" && entry.name.toLowerCase().replace(/\.$/, "") === name,
        );
        if (alias?.type !== "CNAME") break;
        name = alias.data.toLowerCase().replace(/\.$/, "");
        ttl = Math.min(ttl, alias.ttl ?? 0);
      }
      if (name === requested)
        throw new Error(`Campus DNS returned no IPv4 address for ${original}`);
    }
    throw new Error("Campus DNS returned too many CNAME redirects");
  }

  private async query(name: string, signal: AbortSignal): Promise<packet.DecodedPacket> {
    signal.throwIfAborted();
    const socket = await this.stack.udp.open();
    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();
    const id = randomInt(65536);
    let failure: Error | undefined;
    const cancel = () => {
      failure = new Error("Campus DNS query cancelled");
      void reader.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => {
      failure = new Error(`Campus DNS timed out for ${name}`);
      void reader.cancel();
    }, 5000);

    try {
      await writer.write({
        data: packet.encode({
          flags: packet.RECURSION_DESIRED,
          id,
          questions: [{ name, type: "A" }],
          type: "query",
        }),
        host: this.server,
        port: 53,
      });
      for (;;) {
        const datagram = await reader.read();
        if (datagram.done) throw failure ?? new Error("Campus DNS socket closed");
        const message = datagram.value;
        if (message.host !== this.server || message.port !== 53 || message.data.length < 12)
          continue;
        const data = Buffer.from(message.data);
        if (data.readUInt16BE() !== id) continue;
        const response = packet.decode(data);
        if (response.type !== "response" || response.questions?.[0]?.name.toLowerCase() !== name)
          continue;
        const rcode = data.readUInt16BE(2) & 15;
        if (rcode !== 0) throw new Error(`Campus DNS returned RCODE ${rcode} for ${name}`);
        if (response.flag_tc) throw new Error(`Campus DNS response was truncated for ${name}`);
        return response;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
      writer.releaseLock();
      await socket.close();
    }
  }
}
