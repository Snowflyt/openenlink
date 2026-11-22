import assert from "node:assert/strict";
import { test } from "node:test";

import * as log from "../src/log.ts";

await test("Stamp log lines with the local time", () => {
  assert.equal(log.timestamp(new Date(2026, 10, 21, 9, 3, 2, 5)), "2026-11-21 09:03:02.005");
  assert.equal(log.timestamp(new Date(2026, 0, 1, 23, 59, 59, 999)), "2026-01-01 23:59:59.999");
});

await test("Drop lines below the chosen level", (t) => {
  const out = t.mock.method(console, "log", () => {});
  const err = t.mock.method(console, "error", () => {});
  try {
    log.setLevel("warn");
    log.info("dropped");
    log.warn("kept");
    log.setLevel("debug");
    log.debug("shown");
  } finally {
    log.setLevel("info");
  }
  log.debug("dropped again");
  const lines = (calls: { arguments: unknown[] }[]) =>
    calls.map((call) => String(call.arguments[0]));
  assert.deepEqual(
    lines(out.mock.calls).map((line) => line.replace(/^\[[^\]]+\] /, "")),
    ["[debug] shown"],
  );
  assert.deepEqual(
    lines(err.mock.calls).map((line) => line.replace(/^\[[^\]]+\] /, "")),
    ["[warn] kept"],
  );
});
