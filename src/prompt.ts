import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

function stty(mode: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- stty lives in different directories across systems
  if (spawnSync("stty", [mode], { stdio: "inherit" }).status !== 0)
    throw new Error(`stty ${mode} failed`);
}

// A prompt ended by a signal, such as Ctrl+C. The terminal is restored by then, and the command
// ends with the same signal.
export class Interrupted extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Interrupted by ${signal}`);
    this.signal = signal;
  }
}

const ENDED = "Standard input ended before an answer";

// The signals that end a prompt. Handling them keeps Node from exiting before the terminal
// gets its echo or line mode back.
const SIGNALS: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function onSignals(stop: (signal: NodeJS.Signals) => void): () => void {
  const handlers = SIGNALS.map((signal) => {
    const handler = () => stop(signal);
    process.once(signal, handler);
    return { handler, signal };
  });
  return () => {
    for (const { handler, signal } of handlers) process.off(signal, handler);
  };
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
  let reason: NodeJS.Signals | "end" | undefined;
  const stop = (why: NodeJS.Signals | "end") => {
    reason ??= why;
    cancel.abort();
  };
  input.once("SIGINT", () => stop("SIGINT"));
  input.once("close", () => stop("end"));
  const release = onSignals(stop);
  if (options.lineMode) stty("-echo");
  try {
    return await input.question(options.echo ? prompt : "", { signal: cancel.signal });
  } catch (error) {
    if (reason === "end") throw new Error(ENDED, { cause: error });
    if (reason) throw new Interrupted(reason);
    throw error;
  } finally {
    if (options.lineMode) stty("echo");
    release();
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
  let reason: NodeJS.Signals | "end" | undefined;
  let release = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const stop = (why: NodeJS.Signals | "end") => {
        reason ??= why;
        finish(() => reject(why === "end" ? new Error(ENDED) : new Interrupted(why)));
      };
      const data = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === "\r" || char === "\n") return finish(() => resolve(line));
          if (char === "\x03") return stop("SIGINT");
          if (char === "\x04" && !line) return stop("end");
          if (char === "\x7f" || char === "\b") line = Array.from(line).slice(0, -1).join("");
          else if (char >= " ") line += char;
        }
      };
      const finish = (settle: () => void) => {
        stdin.off("data", data);
        settle();
      };
      stdin.on("data", data);
      release = onSignals(stop);
    });
  } finally {
    release();
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write(line && !reason ? `(${String(line.length)} characters)\n` : "\n");
  }
}
