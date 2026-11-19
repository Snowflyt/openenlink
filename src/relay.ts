import type { Socket } from "node:net";

import type { TcpConnection } from "tcpip";

import type { ByteReader } from "./protocol.ts";
import { write } from "./protocol.ts";

// Copies bytes both ways until each side ends its stream, then closes both sides. `reply` goes to
// the client and `request` to the campus host before the copying starts.
export async function relay(
  socket: Socket,
  reader: ByteReader,
  connection: TcpConnection,
  { reply, request }: { reply?: Buffer; request?: Buffer },
): Promise<void> {
  const writer = connection.writable.getWriter();
  const receive = async () => {
    for await (const chunk of connection) await write(socket, chunk);
    socket.end();
  };
  const send = async () => {
    if (request) await writer.write(request);
    let chunk: Buffer | undefined;
    while ((chunk = await reader.chunk())) await writer.write(chunk);
    await writer.close();
  };

  try {
    if (socket.destroyed) return;
    socket.setTimeout(0);
    if (reply) await write(socket, reply);
    await Promise.all([send(), receive()]);
  } finally {
    socket.destroy();
    writer.releaseLock();
    await connection.close();
  }
}
