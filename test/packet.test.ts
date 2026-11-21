import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { parseIPv4Packet, serializeIPv4Packet } from "@tcpip/wire";

import { rewriteAddress } from "../src/packet.ts";
import { authentication, readAuthentication } from "../src/protocol.ts";
import { ByteReader } from "../src/stream.ts";

await test("DNS address translation preserves IPv4 and UDP checksums", () => {
  const packet = serializeIPv4Packet({
    destinationIP: "198.18.0.53",
    dscp: 0,
    ecn: 0,
    flags: 0,
    fragmentOffset: 0,
    identification: 12,
    payload: { destinationPort: 53, payload: new TextEncoder().encode("query"), sourcePort: 3000 },
    protocol: "udp",
    sourceIP: "10.88.0.2",
    ttl: 64,
    version: 4,
  });
  const translated = rewriteAddress(packet, 16, "198.18.0.53", "127.0.0.1");
  const parsed = parseIPv4Packet(translated);
  assert.equal(parsed.destinationIP, "127.0.0.1");
  assert.deepEqual(rewriteAddress(translated, 16, "127.0.0.1", "198.18.0.53"), Buffer.from(packet));
  assert.equal(rewriteAddress(packet, 16, "10.1.1.1", "127.0.0.1"), packet);
});

await test("Frame reader handles split input and rejects truncated address fields", async () => {
  const expected = Buffer.from(
    "01010026000000000100000001000773747564656e74020006736563726574ff",
    "hex",
  );
  const auth = authentication("student", "secret");
  assert.equal(auth.readUInt16BE(2), auth.length);
  assert.deepEqual(auth.subarray(12), expected.subarray(12));
  assert.throws(() => authentication("student", ""), /1–255/);

  const invalid = Buffer.from("0101001000000000010000000b000401", "hex");
  const reader = new ByteReader(Readable.from([invalid.subarray(0, 5), invalid.subarray(5)]));
  await assert.rejects(readAuthentication(reader), /Truncated/);
});
