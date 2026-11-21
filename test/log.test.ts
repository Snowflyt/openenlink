import assert from "node:assert/strict";
import { test } from "node:test";

import { timestamp } from "../src/log.ts";

await test("Stamp log lines with the local time", () => {
  assert.equal(timestamp(new Date(2026, 10, 21, 9, 3, 2, 5)), "2026-11-21 09:03:02.005");
  assert.equal(timestamp(new Date(2026, 0, 1, 23, 59, 59, 999)), "2026-01-01 23:59:59.999");
});
