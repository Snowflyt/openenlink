import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { DnsServer } from "@tcpip/dns";
import { parseIPv4Packet, serializeIPv4Packet } from "@tcpip/wire";
import { generate } from "selfsigned";

import { createStack } from "#tcpip";

import { Resolver } from "../src/dns.ts";
import { markTunnelClosed } from "../src/flow.ts";
import { forward } from "../src/forward.ts";
import * as log from "../src/log.ts";
import { ProxyServer } from "../src/proxy.ts";
import type { ProxyAuth } from "../src/proxy.ts";
import { ByteReader, write } from "../src/stream.ts";
import { Tunnel } from "../src/tunnel.ts";

if (isMainThread) {
  const cases = [
    { dns: "10.88.0.1", compressed: false },
    { dns: "127.0.0.1", compressed: false },
    { dns: "10.88.0.1", compressed: true },
    { dns: "10.88.0.1", compressed: false, auth: { username: "student", password: "proxy" } },
    // An IPv6 listener sees the IPv4 clients below as ::ffff:127.0.0.1.
    { dns: "10.88.0.1", compressed: false, bind: "::" },
  ];
  for (const scenario of cases)
    await test(
      `Proxy TCP and UDP with DNS ${JSON.stringify(scenario)}`,
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
  // Log lines without their time, in the order the worker wrote them.
  const lines: string[] = [];
  const capture = (line: string) => {
    lines.push(stripVTControlCharacters(line).replace(/^\[[^\]]*\] (?=\[)/, ""));
  };
  console.log = capture;
  console.error = capture;
  log.setLevel("debug");
  // Each pattern is matched against whole lines, after "[level] [TCP] 127.0.0.1:port".
  const logged = async (level: string, protocol: string, rest: string) => {
    const pattern = new RegExp(String.raw`^\[${level}\] \[${protocol}\] 127\.0\.0\.1:\d+ ${rest}$`);
    while (!lines.some((line) => pattern.test(line))) await sleep(10);
    return pattern;
  };

  const {
    auth,
    bind = "127.0.0.1",
    compressed,
    dns: peerAddress,
  } = workerData as {
    compressed: boolean;
    dns: `${number}.${number}.${number}.${number}`;
    auth?: ProxyAuth;
    bind?: string;
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
          // The answer name points to the question, as in a live gateway's reply.
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
        assert.equal(query.name, "intranet.test");
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
  const resolver = new Resolver(
    tunnel.stack,
    tunnel.dnsServer,
    new Map([["fixed.test", "10.88.0.1"]]),
  );
  const proxy = await ProxyServer.listen(tunnel.stack, resolver, { host: bind, port: 0 }, auth);
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
    const anonymous = connect(proxy.port, "127.0.0.1");
    const anonymousReader = new ByteReader(anonymous);
    await write(anonymous, Buffer.from([5, 1, 0]));
    assert.deepEqual(await anonymousReader.read(2), Buffer.from([5, 255]));
    anonymous.destroy();

    const guess = connect(proxy.port, "127.0.0.1");
    const guessReader = new ByteReader(guess);
    await write(guess, Buffer.from([5, 1, 2]));
    assert.deepEqual(await guessReader.read(2), Buffer.from([5, 2]));
    await write(guess, credentials("wrong"));
    assert.deepEqual(await guessReader.read(2), Buffer.from([1, 1]));
    assert.equal(await guessReader.chunk(), undefined);
    guess.destroy();

    const stranger = connect(proxy.port, "127.0.0.1");
    const strangerReader = new ByteReader(stranger);
    await write(stranger, Buffer.from("CONNECT intranet.test:8080 HTTP/1.1\r\n\r\n"));
    assert.match((await strangerReader.until("\r\n\r\n", 1024)).toString(), /^HTTP\/1\.1 407 /);
    stranger.destroy();

    await logged("warn", "TCP", "sent no proxy password");
    await logged("warn", "TCP", "proxy password rejected");
  }

  // A port check closes before its first byte and leaves no line.
  const probe = connect(proxy.port, "127.0.0.1");
  await once(probe, "connect");
  probe.end();
  await once(probe, "close");

  const tcp = connect(proxy.port, "127.0.0.1");
  const reader = new ByteReader(tcp);
  await handshake(tcp, reader);
  const host = Buffer.from("intranet.test");
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

  // Nothing listens on port 8079, so the internal host resets the connection. The line names the
  // host the resolver looked up.
  const refused = connect(proxy.port, "127.0.0.1");
  const refusedReader = new ByteReader(refused);
  await handshake(refused, refusedReader);
  const spelled = Buffer.from("Intra\nnet.Test");
  await write(
    refused,
    Buffer.concat([Buffer.from([5, 1, 0, 3, spelled.length]), spelled, Buffer.from([31, 143])]),
  );
  assert.equal((await refusedReader.read(10))[1], 1);
  await logged("error", "TCP", String.raw`--> intranet\.test:8079 failed: .+`);
  assert(!lines.some((line) => /^\[error\] \[TCP\] \S+ failed/.test(line)));
  refused.destroy();

  // A name the resolver rejects shows its printable characters.
  const invalid = connect(proxy.port, "127.0.0.1");
  const invalidReader = new ByteReader(invalid);
  await handshake(invalid, invalidReader);
  const escaped = Buffer.from("a\u001b[2Jb.test");
  await write(
    invalid,
    Buffer.concat([Buffer.from([5, 1, 0, 3, escaped.length]), escaped, Buffer.from([31, 144])]),
  );
  assert.notEqual((await invalidReader.read(10))[1], 0);
  await logged("error", "TCP", String.raw`--> a\[2Jb\.test:8080 failed: Invalid hostname`);
  invalid.destroy();

  const basic = auth && Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  const authorization = basic ? ["Proxy-Authorization: Basic " + basic] : [];
  const tunneled = connect(proxy.port, "127.0.0.1");
  const tunneledReader = new ByteReader(tunneled);
  await write(
    tunneled,
    Buffer.from(["CONNECT intranet.test:8080 HTTP/1.1", ...authorization, "", ""].join("\r\n")),
  );
  assert.equal(
    (await tunneledReader.until("\r\n\r\n", 1024)).toString(),
    "HTTP/1.1 200 Connection Established",
  );
  await write(tunneled, payload);
  assert.deepEqual(await tunneledReader.read(payload.length), payload);
  tunneled.end();
  assert.equal(await tunneledReader.chunk(), undefined);

  // A fixed entry answers without a query, which the DNS server above would reject.
  const fixed = connect(proxy.port, "127.0.0.1");
  const fixedReader = new ByteReader(fixed);
  await write(
    fixed,
    Buffer.from(["CONNECT Fixed.Test.:8080 HTTP/1.1", ...authorization, "", ""].join("\r\n")),
  );
  assert.equal(
    (await fixedReader.until("\r\n\r\n", 1024)).toString(),
    "HTTP/1.1 200 Connection Established",
  );
  fixed.resetAndDestroy();
  await logged(
    "info",
    "TCP",
    String.raw`--> fixed\.test:8080 closed after \d+s \(client reset\), .+`,
  );

  // The echo server returns the request exactly as the proxy forwarded it.
  const forwarded = connect(proxy.port, "127.0.0.1");
  const forwardedReader = new ByteReader(forwarded);
  const request = [
    "GET http://intranet.test:8080/echo?x=1 HTTP/1.1",
    "Host: intranet.test:8080",
    ...authorization,
    "Proxy-Connection: keep-alive",
    "",
    "",
  ];
  await write(forwarded, Buffer.from(request.join("\r\n")));
  assert.equal(
    (await forwardedReader.until("\r\n\r\n", 1024)).toString(),
    "GET /echo?x=1 HTTP/1.1\r\nHost: intranet.test:8080\r\nConnection: close",
  );
  forwarded.end();
  assert.equal(await forwardedReader.chunk(), undefined);

  if (!auth) {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [cli, "nc", "intranet.test", "8080", "--port", String(proxy.port)],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const exited = once(child, "exit");
    child.stdin.end(payload);
    assert.deepEqual(Buffer.concat(await child.stdout.toArray()), payload);
    assert.deepEqual(await exited, [0, null]);
  }

  const control = connect(proxy.port, "127.0.0.1");
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
  await logged("info", "UDP", "associated");
  await logged("info", "UDP", String.raw`closed after \d+s, sent 3 B, received 3 B`);

  // A forwarded port joins its clients to one address in the tunnel, over TCP or UDP.
  const tcpForward = await forward(tunnel.stack, resolver, bind, {
    host: "intranet.test",
    hostPort: 8080,
    port: 0,
    udp: false,
  });
  const piped = connect(tcpForward.port, "127.0.0.1");
  const pipedReader = new ByteReader(piped);
  await write(piped, payload);
  assert.deepEqual(await pipedReader.read(payload.length), payload);
  piped.end();
  assert.equal(await pipedReader.chunk(), undefined);
  await tcpForward.close();

  const udpForward = await forward(tunnel.stack, resolver, bind, {
    host: "10.88.0.1",
    hostPort: 8081,
    port: 0,
    udp: true,
  });
  const client = createSocket("udp4");
  client.bind(0, "127.0.0.1");
  await once(client, "listening");
  const echoed = once(client, "message");
  client.send(Buffer.from("ping"), udpForward.port, "127.0.0.1");
  assert.deepEqual((await echoed)[0], Buffer.from("ping"));
  client.close();
  await udpForward.close();
  await logged(
    "info",
    "UDP",
    String.raw`--> 10\.88\.0\.1:8081 closed after \d+s, sent 4 B, received 4 B`,
  );

  // SOCKS CONNECT, HTTP CONNECT, the TCP forward and nc each carried the payload both ways, and
  // the plain GET carried its request.
  const carried = await logged(
    "info",
    "TCP",
    String.raw`--> intranet\.test:8080 closed after \d+s, sent 165\.0 kB, received 165\.0 kB`,
  );
  assert.equal(lines.filter((line) => carried.test(line)).length, auth ? 3 : 4);
  await logged(
    "info",
    "TCP",
    String.raw`--> intranet\.test:8080 closed after \d+s, sent \d+ B, .+`,
  );
  assert.equal(lines.filter((line) => line.includes("password rejected")).length, auth ? 1 : 0);

  // The resolver asks the gateway once and answers again from its cache.
  assert(lines.includes("[debug] [DNS] intranet.test --> 10.88.0.1"));
  assert(lines.includes("[debug] [DNS] intranet.test --> 10.88.0.1 (cached)"));
  assert(lines.includes("[debug] [DNS] fixed.test --> 10.88.0.1 (fixed)"));

  // Connections still open when the tunnel ends say so.
  const held = connect(proxy.port, "127.0.0.1");
  const heldReader = new ByteReader(held);
  await handshake(held, heldReader);
  await write(
    held,
    Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([31, 144])]),
  );
  assert.equal((await heldReader.read(10))[1], 0);
  markTunnelClosed();
  await proxy.close();
  await logged(
    "info",
    "TCP",
    String.raw`--> intranet\.test:8080 closed after \d+s \(tunnel closed\), .+`,
  );
  tunnel.close();
  parentPort!.postMessage({ dns: true, tcp: true, udp: true });
}
