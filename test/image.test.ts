import assert from "node:assert/strict";
import { test } from "node:test";

import {
  colors256,
  envProtocol,
  halfBlocks,
  multiplexed,
  replyProtocol,
  sixel,
} from "../src/image.ts";
import type { Bitmap } from "../src/jpeg.ts";

await test("Find the image protocol a terminal speaks", () => {
  assert.equal(envProtocol({ TERM_PROGRAM: "iTerm.app" }), "iterm");
  assert.equal(envProtocol({ TERM_PROGRAM: "WezTerm" }), "iterm");
  assert.equal(envProtocol({ LC_TERMINAL: "iTerm2" }), "iterm");
  assert.equal(envProtocol({ KONSOLE_VERSION: "250800" }), "iterm");
  assert.equal(
    envProtocol({ TERM_PROGRAM: "iTerm.app", TMUX: "tmux-501/default,4242,0" }),
    undefined,
  );
  assert.equal(envProtocol({ LC_TERMINAL: "iTerm2", TERM: "tmux-256color" }), undefined);
  assert.equal(envProtocol({ TERM_PROGRAM: "Apple_Terminal" }), undefined);
  assert.equal(multiplexed({ TERM: "screen-256color" }), true);
  assert.equal(multiplexed({ TERM: "xterm-256color" }), false);

  assert.equal(replyProtocol("\x1b_Gi=31;OK\x1b\\\x1b[?62;22c"), "kitty");
  assert.equal(replyProtocol("\x1b_Gi=31;ENOTSUPPORTED\x1b\\\x1b[?62;4;22c"), "sixel");
  assert.equal(replyProtocol("\x1b[?62;22;4c"), "sixel");
  assert.equal(replyProtocol("\x1b[?62;14;22c"), undefined);
  assert.equal(replyProtocol("\x1b[?61;4c"), undefined);
  assert.equal(replyProtocol("\x1b_Gi=31;OK\x1b\\\x1b[?61;4c"), "kitty");
  assert.equal(replyProtocol(""), undefined);
});

// A 2 by 3 image: red, green / blue, white / black, black.
const bitmap: Bitmap = {
  width: 2,
  height: 3,
  rgb: Uint8ClampedArray.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0),
};

await test("Draw an image with half blocks", () => {
  assert.equal(
    halfBlocks(bitmap, 80),
    "\x1b[38;5;196m\x1b[48;5;21m▀\x1b[38;5;46m\x1b[48;5;231m▀\x1b[0m\n" +
      "\x1b[38;5;16m\x1b[49m▀\x1b[38;5;16m\x1b[49m▀\x1b[0m\n",
  );
  // Two columns leave room for one: the upper pixel averages the first two rows to the gray
  // 128, the lower one is the black row.
  assert.equal(halfBlocks(bitmap, 2), "\x1b[38;5;244m\x1b[48;5;16m▀\x1b[0m\n");
  assert.equal(colors256({ TERM: "xterm-256color" }), true);
  assert.equal(colors256({ TERM: "xterm", COLORTERM: "truecolor" }), true);
  assert.equal(colors256({ TERM: "xterm" }), false);
});

await test("Draw an image with sixel", () => {
  const out = sixel(bitmap);
  assert(out.startsWith('\x1bP0;1q"1;1;4;6#0;2;0;0;0#1;2;0;0;20#2;2;0;0;40'));
  // Doubled, the image is 4 by 6, one band of six rows. Each color draws the rows it covers
  // as bits: red the top two rows of the left half (3, "B"), black the bottom two everywhere
  // (48, "o", four times).
  assert(out.endsWith("#180BB??$#30??BB$#5KK??$#215??KK$#0!4o-\x1b\\"));
});
