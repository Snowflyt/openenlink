import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";
import { createServer } from "node:tls";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { DnsServer } from "@tcpip/dns";
import { parseIPv4Packet, serializeIPv4Packet } from "@tcpip/wire";
import { generate } from "selfsigned";
import { createStack } from "tcpip";

import { ByteReader, write } from "../src/protocol.ts";
import { SocksServer } from "../src/socks.ts";
import type { SocksAuth } from "../src/socks.ts";
import { Tunnel } from "../src/tunnel.ts";

if (isMainThread) {
  const cases = [
    { dns: "10.88.0.1", compressed: false },
    { dns: "127.0.0.1", compressed: false },
    { dns: "10.88.0.1", compressed: true },
    { dns: "10.88.0.1", compressed: false, socks: { username: "student", password: "proxy" } },
  ];
  for (const scenario of cases)
    await test(
      `SOCKS TCP and UDP with DNS ${JSON.stringify(scenario)}`,
      { timeout: 20_000 },
      async (t) => {
        // A worker owns the WASM stack and its timer for the lifetime of this tunnel.
        const worker = new Worker(new URL(import.meta.url), { workerData: scenario });
        try {
          const [result] = await once(worker, "message", { signal: t.signal });
          assert.deepEqual(result, { dns: true, tcp: true, udp: true });
        } finally {
          await worker.terminate();
        }
      },
    );
} else {
  await exercise();
}

async function exercise(): Promise<void> {
  const {
    compressed,
    dns: peerAddress,
    socks: auth,
  } = workerData as {
    compressed: boolean;
    dns: `${number}.${number}.${number}.${number}`;
    socks?: SocksAuth;
  };
  const pems = await generate([{ name: "commonName", value: "gateway.test" }], {
    extensions: [
      { cA: true, name: "basicConstraints" },
      { altNames: [{ type: 2, value: "gateway.test" }], name: "subjectAltName" },
    ],
  });
  const peer = await createStack({ initializeLoopback: false });
  const nic = await peer.interfaces.createTun({ ip: "10.88.0.1/0" });
  if (compressed) {
    const dns = await peer.udp.open({ port: 53 });
    void (async () => {
      const writer = dns.writable.getWriter();
      for await (const query of dns) {
        const response = Buffer.concat([
          query.data,
          // The answer name points to the question, as in the live campus reply.
          Buffer.from("c00c000100010000003c00040a580001", "hex"),
        ]);
        response.writeUInt16BE(0x8180, 2);
        response.writeUInt16BE(1, 6);
        await writer.write({ ...query, data: response });
      }
    })();
  } else {
    const dns = new DnsServer(peer.udp, {
      request(query) {
        assert.equal(query.name, "campus.test");
        return Promise.resolve({ ip: "10.88.0.1", ttl: 60, type: "A" as const });
      },
    });
    await dns.listen();
  }
  const echo = await peer.tcp.listen({ port: 8080 });
  const datagrams = await peer.udp.open({ port: 8081 });
  void (async () => {
    for await (const connection of echo) {
      void connection.readable.pipeTo(connection.writable).catch(() => {});
    }
  })();
  void datagrams.readable.pipeTo(datagrams.writable);

  const server = createServer({ cert: pems.cert, key: pems.private }, (socket) => {
    socket.on("error", () => {});
    void (async () => {
      const reader = new ByteReader(socket);
      const header = await reader.read(12);
      assert.equal(header.subarray(0, 2).toString("hex"), "0101");
      assert.equal(header.readUInt32LE(8), 1);
      const login = await reader.read(header.readUInt16BE(2) - 12);
      assert.equal(login.toString("hex"), "01000773747564656e74020006736563726574ff");

      const dns = Buffer.from(peerAddress);
      const addresses = Buffer.concat([
        Buffer.from([0x0b, 0, 4, 10, 88, 0, 2, 0x24, 0, dns.length]),
        dns,
        Buffer.from([255]),
      ]);
      const response = Buffer.alloc(12);
      response[0] = 1;
      response[1] = 1;
      response[8] = 1;
      response.writeUInt16BE(12 + addresses.length, 2);
      // Deliberately split the authentication header across TLS records.
      await write(socket, response.subarray(0, 5));
      await write(socket, Buffer.concat([response.subarray(5), addresses]));

      const incoming = nic.writable.getWriter();
      void (async () => {
        for await (const packet of nic) {
          const parsed = parseIPv4Packet(packet);
          const body =
            (
              parsed.protocol === "udp" &&
              parsed.payload.sourcePort === 53 &&
              peerAddress === "127.0.0.1"
            ) ?
              serializeIPv4Packet({ ...parsed, sourceIP: peerAddress })
            : packet;
          const header = Buffer.from([1, 4, 0, 0, 0, 0, 0, 0]);
          header.writeUInt16BE(8 + body.length, 2);
          await write(socket, Buffer.concat([header, body]));
        }
      })().catch(() => {});

      while (!socket.destroyed) {
        const header = await reader.read(12);
        const body = await reader.read(header.readUInt16BE(2) - 12);
        if (header[1] === 4) {
          assert.equal(header.readUInt32LE(8), 0x29000000);
          const parsed = parseIPv4Packet(body);
          await incoming.write(
            parsed.destinationIP === "127.0.0.1" ?
              serializeIPv4Packet({ ...parsed, destinationIP: "10.88.0.1" })
            : body,
          );
        } else {
          assert.equal(header.readUInt32LE(8), 3);
          assert.equal(body.length, 4);
        }
      }
    })().catch(() => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const gateway = { host: "127.0.0.1", port: address.port, serverName: "gateway.test" };
  await assert.rejects(Tunnel.connect(gateway, "student", "secret"));
  const tunnel = await Tunnel.connect(gateway, "student", "secret", { ca: pems.cert });
  const socks = await SocksServer.listen(tunnel.stack, tunnel.dnsServer, 0, auth);
  void tunnel.done.catch(() => {});

  const credentials = (password: string) => {
    const username = Buffer.from(auth!.username);
    return Buffer.concat([
      Buffer.from([1, username.length]),
      username,
      Buffer.from([Buffer.byteLength(password)]),
      Buffer.from(password),
    ]);
  };
  const handshake = async (socket: Socket, reader: ByteReader) => {
    if (!auth) {
      await write(socket, Buffer.from([5, 1, 0]));
      assert.deepEqual(await reader.read(2), Buffer.from([5, 0]));
      return;
    }
    await write(socket, Buffer.from([5, 1, 2]));
    assert.deepEqual(await reader.read(2), Buffer.from([5, 2]));
    await write(socket, credentials(auth.password));
    assert.deepEqual(await reader.read(2), Buffer.from([1, 0]));
  };

  if (auth) {
    const anonymous = connect(socks.port, "127.0.0.1");
    const anonymousReader = new ByteReader(anonymous);
    await write(anonymous, Buffer.from([5, 1, 0]));
    assert.deepEqual(await anonymousReader.read(2), Buffer.from([5, 255]));
    anonymous.destroy();

    const guess = connect(socks.port, "127.0.0.1");
    const guessReader = new ByteReader(guess);
    await write(guess, Buffer.from([5, 1, 2]));
    assert.deepEqual(await guessReader.read(2), Buffer.from([5, 2]));
    await write(guess, credentials("wrong"));
    assert.deepEqual(await guessReader.read(2), Buffer.from([1, 1]));
    assert.equal(await guessReader.chunk(), undefined);
    guess.destroy();
  }

  const tcp = connect(socks.port, "127.0.0.1");
  const reader = new ByteReader(tcp);
  await handshake(tcp, reader);
  const host = Buffer.from("campus.test");
  await write(
    tcp,
    Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([31, 144])]),
  );
  assert.equal((await reader.read(10))[1], 0);
  const payload = Buffer.from("校园网 tunnel over TypeScript ".repeat(5000));
  await write(tcp, payload);
  assert.deepEqual(await reader.read(payload.length), payload);
  tcp.end();
  assert.equal(await reader.chunk(), undefined);

  const control = connect(socks.port, "127.0.0.1");
  const udpReader = new ByteReader(control);
  await handshake(control, udpReader);
  await write(control, Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
  const udpReply = await udpReader.read(10);
  assert.equal(udpReply[1], 0);
  const udp = createSocket("udp4");
  udp.bind(0, "127.0.0.1");
  await once(udp, "listening");
  const received = once(udp, "message");
  udp.send(
    Buffer.from([0, 0, 0, 1, 10, 88, 0, 1, 31, 145, 97, 98, 99]),
    udpReply.readUInt16BE(8),
    "127.0.0.1",
  );
  const [response] = await received;
  assert.deepEqual(response, Buffer.from([0, 0, 0, 1, 10, 88, 0, 1, 31, 145, 97, 98, 99]));
  udp.close();
  control.destroy();
  await socks.close();
  tunnel.close();
  parentPort!.postMessage({ dns: true, tcp: true, udp: true });
}
