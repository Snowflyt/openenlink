import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

import { createStack } from "tcpip";
import type { TcpConnection, TunInterface } from "tcpip";

if (isMainThread) {
  await test(
    "TCP survives packet loss and reordering without losing data",
    { timeout: 60_000 },
    async (t) => {
      // A worker owns both WASM stacks and their timers.
      const worker = new Worker(new URL(import.meta.url));
      try {
        const [result] = await once(worker, "message", { signal: t.signal });
        assert.deepEqual(result, { download: true, upload: true });
      } finally {
        await worker.terminate();
      }
    },
  );
} else {
  parentPort?.postMessage(await exchange());
}

/**
 * Sends random data both ways between two stacks joined by a lossy link.
 * @returns Whether each direction arrived intact.
 */
async function exchange(): Promise<{ download: boolean; upload: boolean }> {
  const client = await createStack({ initializeLoopback: false });
  const server = await createStack({ initializeLoopback: false });
  const clientNic = await client.interfaces.createTun({ ip: "10.0.0.1/24" });
  const serverNic = await server.interfaces.createTun({ ip: "10.0.0.2/24" });
  // Out-of-order data reaches lwIP callbacks as pbuf chains, which 0.4.0 truncated.
  const random = seeded(7);
  void link(clientNic, serverNic, random);
  void link(serverNic, clientNic, random);

  const download = randomBytes(1024 * 1024);
  const upload = randomBytes(256 * 1024);
  const listener = await server.tcp.listen({ port: 5000 });
  const served = (async () => {
    for await (const connection of listener) {
      const [received] = await Promise.all([drain(connection), pump(connection, download)]);
      return received;
    }
    throw new Error("listener closed");
  })();
  const connection = await client.tcp.connect({ host: "10.0.0.2", port: 5000 });
  const [downloaded, , uploaded] = await Promise.all([
    drain(connection),
    pump(connection, upload),
    served,
  ]);
  return { download: downloaded === digest(download), upload: uploaded === digest(upload) };
}

/**
 * Forwards packets, dropping 1% and swapping another 1% with the next packet.
 * @param from - Interface whose outgoing packets are read.
 * @param to - Interface that receives them.
 * @param random - Source of values in [0, 1).
 */
async function link(from: TunInterface, to: TunInterface, random: () => number): Promise<void> {
  const writer = to.writable.getWriter();
  let held: Uint8Array | undefined;
  for await (const packet of from) {
    const roll = random();
    if (roll < 0.01) continue;
    if (!held && roll < 0.02) {
      held = packet;
      continue;
    }
    await writer.write(packet);
    if (held) await writer.write(held);
    held = undefined;
  }
}

/**
 * Writes data in 64 KiB chunks, then half-closes.
 * @param connection - Connection to write to.
 * @param data - Bytes to send.
 */
async function pump(connection: TcpConnection, data: Uint8Array): Promise<void> {
  const writer = connection.writable.getWriter();
  for (let offset = 0; offset < data.length; offset += 65_536)
    await writer.write(data.subarray(offset, offset + 65_536));
  await writer.close();
}

/**
 * Reads until the peer half-closes.
 * @param connection - Connection to read from.
 * @returns The SHA-256 of everything received.
 */
async function drain(connection: TcpConnection): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of connection) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Hashes a byte array.
 * @param data - Bytes to hash.
 * @returns The hex SHA-256.
 */
function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Returns a deterministic pseudo-random generator.
 * @param seed - Initial state.
 * @returns A function yielding values in [0, 1).
 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}
