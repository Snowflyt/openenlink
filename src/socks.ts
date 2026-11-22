import { createSocket } from "node:dgram";
import { once } from "node:events";
import { isIPv4, isIPv6 } from "node:net";
import type { Socket } from "node:net";

import type { NetworkStack, UdpSocket } from "#tcpip";

import type { Resolver } from "./dns.ts";
import type { Flow } from "./flow.ts";
import { relay } from "./relay.ts";
import type { ByteReader } from "./stream.ts";
import { write } from "./stream.ts";

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

// A SOCKS address: type 1 and four bytes for IPv4, type 4 and sixteen bytes for IPv6, then the port.
function address(host: string, port: number): Buffer {
  const groups = (part: string) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  let bytes: number[];
  if (isIPv4(host)) bytes = [1, ...host.split(".").map(Number)];
  else {
    // "::" stands for the zero groups between head and tail.
    const [head, tail = []] = host.split("::").map(groups);
    const zeros = Array<number>(8 - head.length - tail.length).fill(0);
    bytes = [4, ...[...head, ...zeros, ...tail].flatMap((word) => [word >> 8, word & 255])];
  }
  const field = Buffer.from([...bytes, 0, 0]);
  field.writeUInt16BE(port, field.length - 2);
  return field;
}

function reply(status: number, host = "127.0.0.1", port = 0): Buffer {
  return Buffer.concat([Buffer.from([5, status, 0]), address(host, port)]);
}

export async function serveSocks(
  socket: Socket,
  reader: ByteReader,
  flow: Flow,
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
    flow.warn(authorize ? "sent no proxy password" : "offered only password authentication");
    await write(socket, Buffer.from([5, 255]));
    socket.end();
    return;
  }

  await write(socket, Buffer.from([5, method]));
  if (authorize && !(await authenticate(socket, reader, authorize))) {
    flow.warn("proxy password rejected");
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
    await associate(socket, reader, flow, stack, resolver, signal, destination);
    return;
  }
  flow.to(destination.host, destination.port);
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
  await relay(socket, reader, connection, flow, { reply: reply(0) });
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
  flow: Flow,
  stack: NetworkStack,
  resolver: Resolver,
  signal: AbortSignal,
  destination: Target,
): Promise<void> {
  // The relay listens on the address the client reached and takes datagrams from the client's
  // address. Node.js reports IPv4 clients of an IPv6 listener as ::ffff:a.b.c.d.
  const unmap = (host = "") => host.replace(/^::ffff:(?=[\d.]+$)/, "");
  const relayHost = unmap(control.localAddress);
  const clientHost = unmap(control.remoteAddress);
  const local = createSocket(isIPv6(relayHost) ? "udp6" : "udp4");
  const remote = await stack.udp.open();
  const writer = remote.writable.getWriter();
  let clientPort = destination.port;
  let sendQueue = Promise.resolve();
  const failed = Promise.withResolvers<never>();

  local.on("error", () => control.destroy());
  local.on("message", (packet, source) => {
    if (source.address !== clientHost || (clientPort !== 0 && source.port !== clientPort)) return;
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
    flow.sent += data.length;
    sendQueue = sendQueue.then(async () =>
      writer.write({ data, host: await resolver.lookup(host, signal), port }),
    );
    void sendQueue.catch(failed.reject);
  });

  local.bind(0, relayHost);
  await once(local, "listening");
  control.setTimeout(0);
  await write(control, reply(0, relayHost, local.address().port));
  flow.protocol = "UDP";
  flow.open("associated");

  try {
    await Promise.race([
      relayDatagrams(remote, (packet, size) => {
        if (!clientPort) return;
        flow.received += size;
        local.send(packet, clientPort, clientHost);
      }),
      reader.chunk(),
      failed.promise,
    ]);
  } finally {
    control.destroy();
    local.close();
    writer.releaseLock();
    await remote.close();
  }
}

async function relayDatagrams(
  remote: UdpSocket,
  send: (packet: Buffer, size: number) => void,
): Promise<void> {
  for await (const packet of remote) {
    const header = Buffer.concat([Buffer.from([0, 0, 0]), address(packet.host, packet.port)]);
    send(Buffer.concat([header, packet.data]), packet.data.length);
  }
}
