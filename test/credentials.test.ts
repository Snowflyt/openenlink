import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CredentialStore } from "../src/credentials.ts";

await test("Keep credentials for each origin in a private file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openenlink-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, "openenlink", "credentials.json");
  const first = new CredentialStore("https://vpn.one.edu", file);
  const second = new CredentialStore("https://vpn.two.edu", file);
  const password = {
    origin: "https://sso.one.edu",
    username: "student",
    password: "secret",
    lastAttemptAt: 1,
    cookies: [{ name: "CASTGC", value: "TGT-1", host: "sso.one.edu", path: "/cas/", expires: 2 }],
  };

  assert.equal(await first.load(), undefined);
  await first.save({ accessToken: "one", refreshToken: "refresh" });
  await first.savePassword(password);
  await second.save({ accessToken: "two" });

  assert.deepEqual(await first.load(), { accessToken: "one", refreshToken: "refresh" });
  assert.deepEqual(await first.loadPassword(), password);
  assert.deepEqual(await second.load(), { accessToken: "two" });
  assert.equal(await second.loadPassword(), undefined);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "openenlink"))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readdir(join(directory, "openenlink")), ["credentials.json"]);

  await first.clear();
  assert.equal(await first.load(), undefined);
  assert.equal(await first.loadPassword(), undefined);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))), ["https://vpn.two.edu"]);
  await second.clear();
  await assert.rejects(stat(file), { code: "ENOENT" });

  await writeFile(file, "{");
  await assert.rejects(first.load(), /damaged/);
});
