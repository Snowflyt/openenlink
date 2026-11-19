import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { decodeJpeg } from "../src/jpeg.ts";

// The fixtures come from libjpeg's cjpeg; each .pnm is djpeg's float IDCT output without
// fancy upsampling, which the decoder should match up to rounding.
const fixture = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url));

async function reference(name: string) {
  const bytes = await fixture(`${name}.pnm`);
  const header = /^P([56])\s+(\d+)\s+(\d+)\s+255\s/.exec(bytes.toString("latin1", 0, 32));
  assert(header);
  const [whole, kind, width, height] = header;
  const pixels = bytes.subarray(whole.length);
  return {
    width: Number(width),
    height: Number(height),
    rgb:
      kind === "6" ? pixels : (
        Uint8Array.from({ length: pixels.length * 3 }, (_, index) => pixels[Math.floor(index / 3)])
      ),
  };
}

for (const name of ["gray", "yuv444", "yuv420-restart", "yuv422", "captcha"]) {
  await test(`Decode ${name}.jpg like libjpeg`, async () => {
    const bitmap = decodeJpeg(await fixture(`${name}.jpg`));
    const expected = await reference(name);
    assert.equal(bitmap.width, expected.width);
    assert.equal(bitmap.height, expected.height);
    assert.equal(bitmap.rgb.length, expected.rgb.length);
    let worst = 0;
    for (let index = 0; index < bitmap.rgb.length; index++)
      worst = Math.max(worst, Math.abs(bitmap.rgb[index] - expected.rgb[index]));
    assert(worst <= 2, `differs from libjpeg by ${String(worst)}`);
  });
}

await test("Reject what a baseline decoder cannot read", async () => {
  assert.throws(() => decodeJpeg(Uint8Array.of(0x89, 0x50)), /JPEG/);
  assert.throws(() => decodeJpeg(new Uint8Array(0)), /JPEG/);
  const progressive = await fixture("progressive.jpg");
  assert.throws(() => decodeJpeg(progressive), /Only baseline JPEG images are supported/);
  const captcha = await fixture("captcha.jpg");
  assert.throws(() => decodeJpeg(captcha.subarray(0, 100)), /Damaged JPEG image/);
});
