import type { Socket } from "node:net";

import type { NetworkStack } from "#tcpip";

import type { Resolver } from "./dns.ts";
import { relay } from "./relay.ts";
import type { ByteReader } from "./stream.ts";
import { write } from "./stream.ts";

// Headers that describe the client's connection to this proxy.
const PROXY_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
]);

const name = (field: string) => field.slice(0, field.indexOf(":")).trim().toLowerCase();

export async function serveHttp(
  socket: Socket,
  reader: ByteReader,
  stack: NetworkStack,
  resolver: Resolver,
  signal: AbortSignal,
  authorize?: (username: Buffer, password: Buffer) => boolean,
): Promise<void> {
  const head = await reader.until("\r\n\r\n", 65_536);
  const [line = "", ...fields] = head.toString("latin1").split("\r\n");
  const [method, target = "", version = ""] = line.split(" ");
  // CONNECT names host:port; other requests carry an absolute http:// URL.
  const url = URL.parse(method === "CONNECT" ? `http://${target}` : target);
  if (!/^HTTP\/1\.[01]$/.test(version) || url?.protocol !== "http:") {
    await respond(socket, "400 Bad Request");
    return;
  }
  if (authorize && !authorized(fields, authorize)) {
    await respond(socket, "407 Proxy Authentication Required", [
      `Proxy-Authenticate: Basic realm="openenlink"`,
    ]);
    return;
  }

  let connection;
  try {
    const host = await resolver.lookup(url.hostname, signal);
    connection = await stack.tcp.connect({ host, port: Number(url.port || 80) });
  } catch (error) {
    await respond(socket, "502 Bad Gateway");
    throw error;
  }

  if (method === "CONNECT") {
    const reply = Buffer.from(`${version} 200 Connection Established\r\n\r\n`);
    await relay(socket, reader, connection, { reply });
    return;
  }

  // The internal host's connection closes after one response, so the next request opens a new one and
  // may go to another host.
  const request = [
    `${method} ${url.pathname}${url.search} ${version}`,
    ...fields.filter((field) => !PROXY_HEADERS.has(name(field))),
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  await relay(socket, reader, connection, { request: Buffer.from(request, "latin1") });
}

function authorized(
  fields: string[],
  authorize: (username: Buffer, password: Buffer) => boolean,
): boolean {
  const field = fields.find((field) => name(field) === "proxy-authorization") ?? "";
  const [scheme = "", token = ""] = field
    .slice(field.indexOf(":") + 1)
    .trim()
    .split(" ");
  const credentials = Buffer.from(token, "base64");
  const colon = credentials.indexOf(":");
  return (
    scheme.toLowerCase() === "basic" &&
    colon >= 0 &&
    authorize(credentials.subarray(0, colon), credentials.subarray(colon + 1))
  );
}

async function respond(socket: Socket, status: string, headers: string[] = []): Promise<void> {
  const response = [`HTTP/1.1 ${status}`, ...headers, "Content-Length: 0", "Connection: close"];
  await write(socket, Buffer.from(`${response.join("\r\n")}\r\n\r\n`));
  socket.end();
}
