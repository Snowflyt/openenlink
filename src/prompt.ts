import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

function stty(mode: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- stty lives in different directories across systems
  if (spawnSync("stty", [mode], { stdio: "inherit" }).status !== 0)
    throw new Error(`stty ${mode} failed`);
}

export async function askSecret(question: string): Promise<string> {
  process.stderr.write(question);
  // Like getpass, keep the terminal in line mode and only turn echo off. Terminals such as
  // Ghostty and WezTerm read that state as a password prompt and enable secure keyboard input.
  // Windows consoles have no such state, so readline takes raw input there.
  const lineMode = process.stdin.isTTY && process.platform !== "win32";
  // In raw mode readline echoes typed characters to its output; discard them.
  const output = new Writable({ write: (_chunk, _encoding, done) => done() });
  const input = createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY && !lineMode,
  });
  const cancel = new AbortController();
  const interrupt = () => cancel.abort();
  input.once("SIGINT", interrupt);
  input.once("close", interrupt);
  process.once("SIGINT", interrupt);
  if (lineMode) stty("-echo");
  try {
    return await input.question("", { signal: cancel.signal });
  } finally {
    if (lineMode) stty("echo");
    process.off("SIGINT", interrupt);
    input.close();
    process.stderr.write("\n");
  }
}
