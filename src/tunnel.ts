import { once } from "node:events";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { connect } from "node:tls";

import { createStack } from "tcpip";
import type { NetworkStack, TunInterface } from "tcpip";

import { rewriteAddress } from "./packet.ts";
import {
  ByteReader,
  authentication,
  frame,
  readAuthentication,
  readPacket,
  write,
} from "./protocol.ts";
import type { Addresses } from "./protocol.ts";

export type Gateway = { host: string; port: number; serverName?: string };

// RFC 2544 address used inside the virtual stack for campus loopback DNS.
// eslint-disable-next-line sonarjs/no-hardcoded-ip
const DNS_ALIAS = "198.18.0.53";

export class Tunnel {
  done: Promise<void> = Promise.resolve();
  readonly addresses: Addresses;
  readonly stack: NetworkStack;
  private readonly socket: TLSSocket;
  private readonly controller = new AbortController();
  private readonly dnsAlias: string;

  private constructor(socket: TLSSocket, addresses: Addresses, stack: NetworkStack) {
    this.socket = socket;
    this.addresses = addresses;
    this.stack = stack;
    this.dnsAlias = addresses.dns.startsWith("127.") ? DNS_ALIAS : addresses.dns;
  }

  static async connect(
    gateway: Gateway,
    user: string,
    token: string,
    tls: Pick<ConnectionOptions, "ca"> = {},
  ): Promise<Tunnel> {
    const socket = connect({
      ...tls,
      host: gateway.host,
      minVersion: "TLSv1.2",
      port: gateway.port,
      rejectUnauthorized: true,
      servername: gateway.serverName ?? gateway.host,
    });
    socket.on("error", () => {});
    socket.setTimeout(15_000, () => socket.destroy(new Error("Campus gateway timed out")));

    try {
      await once(socket, "secureConnect");
      const reader = new ByteReader(socket);
      await write(socket, authentication(user, token));
      const addresses = await readAuthentication(reader);
      const stack = await createStack({
        initializeLoopback: false,
        // lwIP routes 127/8 locally. An alias keeps campus loopback DNS on the tunnel.
        nameServer: {
          ip: addresses.dns.startsWith("127.") ? DNS_ALIAS : addresses.dns,
          port: 53,
        },
      });
      const nic = await stack.interfaces.createTun({ ip: `${addresses.ipv4}/0` });
      socket.setTimeout(30_000);
      const tunnel = new Tunnel(socket, addresses, stack);
      tunnel.done = tunnel.run(nic, reader);
      return tunnel;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async run(nic: TunInterface, reader: ByteReader): Promise<void> {
    const { signal } = this.controller;
    const writer = nic.writable.getWriter();
    const outgoing = nic.readable.getReader();
    let counter = 0;
    let heartbeatPending = false;

    const heartbeat = setInterval(() => {
      if (heartbeatPending || signal.aborted) return;
      const body = Buffer.alloc(4);
      body.writeUInt32LE(counter++ >>> 0);
      heartbeatPending = true;
      void write(this.socket, frame(1, 3, body))
        .catch((error: unknown) => this.close(error))
        .finally(() => {
          heartbeatPending = false;
        });
    }, 500);

    const send = async () => {
      while (!signal.aborted) {
        const packet = await outgoing.read();
        if (packet.done) return;
        const data = rewriteAddress(packet.value, 16, this.dnsAlias, this.addresses.dns);
        await write(this.socket, frame(4, 0x29000000, data));
      }
    };
    const receive = async () => {
      while (!signal.aborted) {
        const packet = await readPacket(reader);
        if (packet.kind === 4) {
          await writer.write(rewriteAddress(packet.body, 12, this.addresses.dns, this.dnsAlias));
        }
      }
    };

    try {
      await Promise.race([send(), receive()]);
    } finally {
      this.close();
      clearInterval(heartbeat);
      await outgoing.cancel();
      writer.releaseLock();
      await this.stack.interfaces.remove(nic);
    }
  }

  close(reason?: unknown): void {
    this.controller.abort(reason);
    this.socket.destroy(reason instanceof Error ? reason : undefined);
  }
}
