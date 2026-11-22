import { once } from "node:events";
import type { Socket } from "node:net";

import type { TcpConnection } from "#tcpip";

import type { Flow } from "./flow.ts";
import type { ByteReader } from "./stream.ts";
import { write } from "./stream.ts";

// Copies bytes both ways until each side ends its stream, then closes both sides. `reply` goes to
// the client and `request` to the internal host before the copying starts. The flow opens here
// and counts the bytes; its owner ends it.
//
// A client that closes ends the relay at once, even while a write into the tunnel waits for an
// acknowledgment that a dropped tunnel never sends.
export async function relay(
  socket: Socket,
  reader: ByteReader,
  connection: TcpConnection,
  flow: Flow,
  { reply, request }: { reply?: Buffer; request?: Buffer },
): Promise<void> {
  const writer = connection.writable.getWriter();
  const receive = async () => {
    for await (const chunk of connection) {
      flow.received += chunk.length;
      await write(socket, chunk);
    }
    socket.end();
  };
  const send = async () => {
    let chunk = request ?? (await reader.chunk());
    while (chunk) {
      flow.sent += chunk.length;
      await writer.write(chunk);
      chunk = await reader.chunk();
    }
    await writer.close();
  };

  try {
    if (socket.destroyed) return;
    socket.setTimeout(0);
    flow.open();
    if (reply) await write(socket, reply);
    await Promise.race([Promise.all([send(), receive()]), once(socket, "close")]);
  } finally {
    socket.destroy();
    writer.releaseLock();
    await connection.close();
  }
}
