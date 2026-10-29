import { isIPv4 } from "node:net";

export function rewriteAddress(
  packet: Uint8Array,
  offset: 12 | 16,
  from: string,
  to: string,
): Uint8Array {
  if (from === to) return packet;
  if (packet.length < 20 || packet[0] >>> 4 !== 4 || !isIPv4(from) || !isIPv4(to)) return packet;
  const oldAddress = from.split(".").map(Number);
  const newAddress = to.split(".").map(Number);
  if (!oldAddress.every((byte, i) => packet[offset + i] === byte)) return packet;

  const result = Buffer.from(packet);
  result.set(newAddress, offset);
  updateChecksum(result, 10, oldAddress, newAddress);

  const headerLength = (result[0] & 15) * 4;
  const fragmented = (result.readUInt16BE(6) & 0x1fff) !== 0;
  if (!fragmented) {
    const transportChecksum =
      result[9] === 17 ? headerLength + 6
      : result[9] === 6 ? headerLength + 16
      : undefined;
    if (transportChecksum !== undefined && transportChecksum + 2 <= result.length) {
      if (result[9] !== 17 || result.readUInt16BE(transportChecksum) !== 0) {
        updateChecksum(result, transportChecksum, oldAddress, newAddress);
        if (result[9] === 17 && result.readUInt16BE(transportChecksum) === 0)
          result.writeUInt16BE(0xffff, transportChecksum);
      }
    }
  }
  return result;
}

function updateChecksum(packet: Buffer, offset: number, from: number[], to: number[]): void {
  let sum = ~packet.readUInt16BE(offset) & 0xffff;
  for (let i = 0; i < 4; i += 2) {
    sum += (~((from[i] << 8) | from[i + 1]) & 0xffff) + ((to[i] << 8) | to[i + 1]);
  }
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  packet.writeUInt16BE(~sum & 0xffff, offset);
}
