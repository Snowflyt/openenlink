import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

function stty(mode: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- stty lives in different directories across systems
  if (spawnSync("stty", [mode], { stdio: "inherit" }).status !== 0)
    throw new Error(`stty ${mode} failed`);
}

async function question(prompt: string, options: { echo: boolean; lineMode: boolean }) {
  // In raw mode readline redraws its line and echoes typed characters to its output. A hidden
  // answer discards that output, so its prompt is written here.
  if (!options.echo) process.stderr.write(prompt);
  const output =
    options.echo ? process.stderr : new Writable({ write: (_chunk, _encoding, done) => done() });
  const input = createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY && !options.lineMode,
  });
  const cancel = new AbortController();
  const interrupt = () => cancel.abort();
  input.once("SIGINT", interrupt);
  input.once("close", interrupt);
  process.once("SIGINT", interrupt);
  if (options.lineMode) stty("-echo");
  try {
    return await input.question(options.echo ? prompt : "", { signal: cancel.signal });
  } finally {
    if (options.lineMode) stty("echo");
    process.off("SIGINT", interrupt);
    input.close();
    if (!options.echo) process.stderr.write("\n");
  }
}

export async function ask(prompt: string): Promise<string> {
  return (await question(prompt, { echo: true, lineMode: false })).trim();
}

export async function askSecret(prompt: string): Promise<string> {
  // Like getpass, keep the terminal in line mode and only turn echo off. Terminals such as
  // Ghostty and WezTerm read that state as a password prompt and enable secure keyboard input.
  // Windows consoles have no such state, so readline takes raw input there.
  return question(prompt, {
    echo: false,
    lineMode: process.stdin.isTTY && process.platform !== "win32",
  });
}

// Reads one pasted line without echo. A terminal in line mode stops a line at MAX_CANON bytes
// (1024 on macOS), shorter than some tokens, so a terminal is read in raw mode.
export async function askPaste(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return askSecret(prompt);
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let line = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const data = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === "\r" || char === "\n") return finish(() => resolve(line));
          if (char === "\x03" || (char === "\x04" && !line)) {
            const cancel = new AbortController();
            cancel.abort();
            return finish(() => reject(cancel.signal.reason as Error));
          }
          if (char === "\x7f" || char === "\b") line = Array.from(line).slice(0, -1).join("");
          else if (char >= " ") line += char;
        }
      };
      const finish = (settle: () => void) => {
        stdin.off("data", data);
        settle();
      };
      stdin.on("data", data);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write(line ? `(${String(line.length)} characters)\n` : "\n");
  }
}
