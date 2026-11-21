import { once } from "node:events";
import { connect } from "node:net";

import { ByteReader, write } from "./stream.ts";

// Joins standard input and output to host:port through the proxy port of a running `serve`.
export async function nc(host: string, port: number, proxyPort: number): Promise<void> {
  const socket = connect({ allowHalfOpen: true, host: "127.0.0.1", port: proxyPort });
  try {
    await once(socket, "connect");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ECONNREFUSED") throw error;
    throw new Error(`Nothing listens on 127.0.0.1:${proxyPort}; start openenlink serve first`, {
      cause: error,
    });
  }

  const reader = new ByteReader(socket);
  await write(socket, Buffer.from([5, 1, 0]));
  if ((await reader.read(2))[1] !== 0)
    throw new Error(`127.0.0.1:${proxyPort} needs a proxy password, which nc does not send`);
  const name = Buffer.from(host);
  const request = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.alloc(2)]);
  request.writeUInt16BE(port, request.length - 2);
  await write(socket, request);
  if ((await reader.read(10))[1] !== 0) throw new Error(`Connection to ${host}:${port} failed`);

  process.stdin.pipe(socket);
  let chunk: Buffer | undefined;
  while ((chunk = await reader.chunk())) await write(process.stdout, chunk);
  socket.destroy();
  process.stdin.destroy();
}
