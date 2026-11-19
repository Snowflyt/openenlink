import assert from "node:assert/strict";
import { test } from "node:test";

import { osKeyring } from "../src/keyring.ts";

await test(
  "Store, replace and delete secrets in the OS credential store",
  {
    skip:
      !process.env.OPENENLINK_TEST_KEYRING && "set OPENENLINK_TEST_KEYRING=1 to use the OS store",
  },
  (t) => {
    const keyring = osKeyring();
    const service = "openenlink-test";
    const account = `https://test.invalid/${process.pid}`;
    t.after(() => keyring.delete(service, account));

    assert.equal(keyring.read(service, account), undefined);
    keyring.delete(service, account);
    const long = "x".repeat(1280);
    for (const secret of ["", "a", "密码 🐱 é", long, JSON.stringify({ password: "pässwörd" })]) {
      keyring.write(service, account, secret);
      assert.equal(keyring.read(service, account), secret);
    }
    if (process.platform === "win32")
      assert.throws(() => keyring.write(service, account, `${long}x`), /at most 2560 bytes/);
    else {
      keyring.write(service, account, `${long}x`.repeat(16));
      assert.equal(keyring.read(service, account), `${long}x`.repeat(16));
    }

    keyring.delete(service, account);
    assert.equal(keyring.read(service, account), undefined);
    for (let index = 0; index < 1000; index++) {
      assert.equal(keyring.read(service, `${account}/${index}`), undefined);
      keyring.delete(service, `${account}/${index}`);
    }
  },
);
