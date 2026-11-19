import { createHash, timingSafeEqual } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createServer, isIPv4 } from "node:net";
import type { Server, Socket } from "node:net";

import type { NetworkStack, UdpSocket } from "tcpip";

import { Resolver } from "./dns.ts";
import { ByteReader, write } from "./protocol.ts";

type Target = { host: string; port: number };
export type SocksAuth = { username: string; password: string };

async function target(reader: ByteReader, kind: number): Promise<Target> {
  let host: string;
  if (kind === 1) host = Array.from(await reader.read(4)).join(".");
  else if (kind === 3) {
    const size = (await reader.read(1))[0];
    if (size === 0) throw new Error("SOCKS destination is empty");
    host = (await reader.read(size)).toString();
  } else {
    throw new Error("SOCKS supports IPv4 addresses and domain names");
  }

  return { host, port: (await reader.read(2)).readUInt16BE() };
}

function reply(status: number, port = 0): Buffer {
  const packet = Buffer.from([5, status, 0, 1, 127, 0, 0, 1, 0, 0]);
  packet.writeUInt16BE(port, 8);
  return packet;
}

export class SocksServer {
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
    auth?: SocksAuth,
  ): Promise<SocksServer> {
    const clients = new Set<Socket>();
    const resolver = new Resolver(stack, dns);
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      clients.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => clients.delete(socket));
      socket.setTimeout(15_000, () => socket.destroy());
      void serve(socket, stack, resolver, auth).catch((error: unknown) => {
        console.error(
          "Campus SOCKS connection failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
        socket.destroy();
      });
    });

    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("SOCKS listener has no address");
    return new SocksServer(server, clients, address.port);
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
  auth?: SocksAuth,
): Promise<void> {
  const controller = new AbortController();
  socket.once("close", () => controller.abort());
  const reader = new ByteReader(socket);
  const greeting = await reader.read(2);
  if (greeting[0] !== 5) {
    socket.destroy();
    return;
  }
  const methods = await reader.read(greeting[1]);
  // Method 2 is RFC 1929 username/password, method 0 is no authentication.
  const method = auth ? 2 : 0;
  if (!methods.includes(method)) {
    await write(socket, Buffer.from([5, 255]));
    socket.end();
    return;
  }

  await write(socket, Buffer.from([5, method]));
  if (auth && !(await authenticate(socket, reader, auth))) {
    socket.end();
    return;
  }

  const request = await reader.read(4);
  if (request[0] !== 5 || request[2] !== 0) throw new Error("Invalid SOCKS request");
  if (request[3] === 4) {
    await write(socket, reply(8));
    socket.end();
    return;
  }

  const destination = await target(reader, request[3]);
  if (request[1] === 3) {
    await associate(socket, reader, stack, resolver, controller.signal, destination);
    return;
  }
  if (request[1] !== 1) {
    await write(socket, reply(7));
    socket.end();
    return;
  }

  const host = await resolver.lookup(destination.host, controller.signal);
  const connection = await stack.tcp.connect({ host, port: destination.port });
  if (socket.destroyed) {
    await connection.close();
    return;
  }

  socket.setTimeout(0);
  await write(socket, reply(0));
  const writer = connection.writable.getWriter();
  const receive = async () => {
    for await (const chunk of connection) await write(socket, chunk);
    socket.end();
  };
  const send = async () => {
    let chunk: Buffer | undefined;
    while ((chunk = await reader.chunk())) await writer.write(chunk);
    await writer.close();
  };

  try {
    await Promise.all([send(), receive()]);
  } finally {
    socket.destroy();
    writer.releaseLock();
    await connection.close();
  }
}

async function authenticate(socket: Socket, reader: ByteReader, auth: SocksAuth): Promise<boolean> {
  const version = (await reader.read(1))[0];
  const username = await reader.read((await reader.read(1))[0]);
  const password = await reader.read((await reader.read(1))[0]);
  // Comparing digests keeps the time independent of where the inputs differ.
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest();
  const accepted =
    version === 1 &&
    timingSafeEqual(digest(username), digest(auth.username)) &&
    timingSafeEqual(digest(password), digest(auth.password));
  await write(socket, Buffer.from([1, accepted ? 0 : 1]));
  return accepted;
}

async function associate(
  control: Socket,
  reader: ByteReader,
  stack: NetworkStack,
  resolver: Resolver,
  signal: AbortSignal,
  destination: Target,
): Promise<void> {
  const local = createSocket("udp4");
  const remote = await stack.udp.open();
  const writer = remote.writable.getWriter();
  let clientPort = destination.port;
  let sendQueue = Promise.resolve();

  local.on("error", () => control.destroy());
  local.on("message", (packet, source) => {
    if (source.address !== "127.0.0.1" || (clientPort !== 0 && source.port !== clientPort)) return;
    if (packet.length < 4 || packet.readUInt16BE() !== 0 || packet[2] !== 0) return;

    let offset: number;
    let host: string;
    if (packet[3] === 1 && packet.length >= 10) {
      host = Array.from(packet.subarray(4, 8)).join(".");
      offset = 8;
    } else if (packet[3] === 3 && packet.length >= 5 + packet[4] + 2) {
      host = packet.subarray(5, 5 + packet[4]).toString();
      offset = 5 + packet[4];
    } else return;

    if (clientPort === 0) clientPort = source.port;
    const port = packet.readUInt16BE(offset);
    const data = packet.subarray(offset + 2);
    sendQueue = sendQueue.then(async () =>
      writer.write({ data, host: await resolver.lookup(host, signal), port }),
    );
    void sendQueue.catch(() => control.destroy());
  });

  local.bind(0, "127.0.0.1");
  await once(local, "listening");
  control.setTimeout(0);
  await write(control, reply(0, local.address().port));

  try {
    await Promise.race([
      relayDatagrams(remote, (packet) => {
        if (clientPort) local.send(packet, clientPort, "127.0.0.1");
      }),
      reader.chunk(),
    ]);
  } finally {
    control.destroy();
    local.close();
    writer.releaseLock();
    await remote.close();
  }
}

async function relayDatagrams(remote: UdpSocket, send: (packet: Buffer) => void): Promise<void> {
  for await (const packet of remote) {
    if (!isIPv4(packet.host)) continue;
    const header = Buffer.from([0, 0, 0, 1, ...packet.host.split(".").map(Number), 0, 0]);
    header.writeUInt16BE(packet.port, 8);
    send(Buffer.concat([header, packet.data]));
  }
}
