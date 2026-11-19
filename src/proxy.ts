import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import type { NetworkStack } from "tcpip";

import { Resolver } from "./dns.ts";
import { serveHttp } from "./http.ts";
import { ByteReader } from "./protocol.ts";
import { serveSocks } from "./socks.ts";

export type ProxyAuth = { username: string; password: string };

type Authorize = (username: Buffer, password: Buffer) => boolean;

export class ProxyServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  readonly port: number;

  private constructor(server: Server, clients: Set<Socket>, port: number) {
    this.server = server;
    this.clients = clients;
    this.port = port;
  }

  static async listen(
    stack: NetworkStack,
    dns: string,
    port = 1088,
    auth?: ProxyAuth,
  ): Promise<ProxyServer> {
    const clients = new Set<Socket>();
    const resolver = new Resolver(stack, dns);
    // Comparing digests keeps the time independent of where the inputs differ.
    const digest = (value: Buffer | string) => createHash("sha256").update(value).digest();
    const authorize =
      auth &&
      ((username: Buffer, password: Buffer) =>
        timingSafeEqual(digest(username), digest(auth.username)) &&
        timingSafeEqual(digest(password), digest(auth.password)));
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      clients.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => clients.delete(socket));
      socket.setTimeout(15_000, () => socket.destroy());
      void serve(socket, stack, resolver, authorize).catch((error: unknown) => {
        console.error(
          "Campus proxy connection failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
        socket.destroy();
      });
    });

    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("Proxy listener has no address");
    return new ProxyServer(server, clients, address.port);
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function serve(
  socket: Socket,
  stack: NetworkStack,
  resolver: Resolver,
  authorize?: Authorize,
): Promise<void> {
  const controller = new AbortController();
  socket.once("close", () => controller.abort());
  const reader = new ByteReader(socket);
  // A SOCKS5 greeting starts with version byte 5, an HTTP request with a method name.
  const session = (await reader.peek()) === 5 ? serveSocks : serveHttp;
  await session(socket, reader, stack, resolver, controller.signal, authorize);
}
