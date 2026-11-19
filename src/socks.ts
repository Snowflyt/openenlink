import { createSocket } from "node:dgram";
import { once } from "node:events";
import { isIPv4 } from "node:net";
import type { Socket } from "node:net";

import type { NetworkStack, UdpSocket } from "#tcpip";

import type { Resolver } from "./dns.ts";
import type { ByteReader } from "./protocol.ts";
import { write } from "./protocol.ts";
import { relay } from "./relay.ts";

type Target = { host: string; port: number };

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

export async function serveSocks(
  socket: Socket,
  reader: ByteReader,
  stack: NetworkStack,
  resolver: Resolver,
  signal: AbortSignal,
  authorize?: (username: Buffer, password: Buffer) => boolean,
): Promise<void> {
  const greeting = await reader.read(2);
  const methods = await reader.read(greeting[1]);
  // Method 2 is RFC 1929 username/password, method 0 is no authentication.
  const method = authorize ? 2 : 0;
  if (!methods.includes(method)) {
    await write(socket, Buffer.from([5, 255]));
    socket.end();
    return;
  }

  await write(socket, Buffer.from([5, method]));
  if (authorize && !(await authenticate(socket, reader, authorize))) {
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
    await associate(socket, reader, stack, resolver, signal, destination);
    return;
  }
  if (request[1] !== 1) {
    await write(socket, reply(7));
    socket.end();
    return;
  }

  let connection;
  try {
    const host = await resolver.lookup(destination.host, signal);
    connection = await stack.tcp.connect({ host, port: destination.port });
  } catch (error) {
    // Reply 1 is a general SOCKS server failure.
    await write(socket, reply(1));
    throw error;
  }
  await relay(socket, reader, connection, { reply: reply(0) });
}

async function authenticate(
  socket: Socket,
  reader: ByteReader,
  authorize: (username: Buffer, password: Buffer) => boolean,
): Promise<boolean> {
  const version = (await reader.read(1))[0];
  const username = await reader.read((await reader.read(1))[0]);
  const password = await reader.read((await reader.read(1))[0]);
  const accepted = version === 1 && authorize(username, password);
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
