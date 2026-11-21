// Shows a JPEG in the terminal: iTerm2 inline images, the kitty graphics protocol, sixel or
// colored half blocks, in that order, and otherwise saves it to a private temporary file.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeJpeg } from "./jpeg.ts";
import type { Bitmap } from "./jpeg.ts";

const COLUMNS = 24;
const CHUNK = 4096;
const QUERY_TIMEOUT = 1000;

// tmux or screen sits between us and the terminal. Over ssh only TERM tells.
export function multiplexed(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMUX) || /^(tmux|screen)/.test(env.TERM ?? "");
}

// Terminals that announce iTerm2's inline images in the environment. Behind tmux the variables
// describe the outer terminal and the escape sequence would not reach it.
export function envProtocol(env: NodeJS.ProcessEnv): "iterm" | undefined {
  if (multiplexed(env)) return;
  const program = env.TERM_PROGRAM ?? "";
  if (
    ["iTerm", "WezTerm", "mintty", "rio", "WarpTerminal"].some((name) => program.includes(name)) ||
    env.LC_TERMINAL === "iTerm2" ||
    env.KONSOLE_VERSION
  )
    return "iterm";
}

// Reads the answers to a kitty graphics query followed by a primary device attributes query.
// Kitty answers the first with OK; a terminal that lists attribute 4 draws sixel. VS Code on
// Windows always answers 61;4, whether it draws images or not, and with images on it answers
// the kitty query.
export function replyProtocol(reply: string): "kitty" | "sixel" | undefined {
  if (reply.includes("\x1b_Gi=31;OK")) return "kitty";
  const start = reply.indexOf("\x1b[?");
  const end = reply.indexOf("c", start);
  if (start < 0 || end <= start) return;
  const attributes = reply.slice(start + 3, end);
  if (attributes !== "61;4" && attributes.split(";").includes("4")) return "sixel";
}

export function sixel(bitmap: Bitmap): string {
  // Captchas are small, so every pixel is drawn twice in both directions.
  const width = bitmap.width * 2;
  const height = bitmap.height * 2;
  const color = (x: number, y: number) => {
    const at = (Math.floor(y / 2) * bitmap.width + Math.floor(x / 2)) * 3;
    const level = (offset: number) => Math.round((bitmap.rgb[at + offset] * 5) / 255);
    return level(0) * 36 + level(1) * 6 + level(2);
  };
  const percent = (level: number) => Math.round((level * 100) / 5);
  let out = `\x1bP0;1q"1;1;${String(width)};${String(height)}`;
  for (let index = 0; index < 216; index++)
    out += `#${String(index)};2;${String(percent(Math.floor(index / 36)))};${String(percent(Math.floor(index / 6) % 6))};${String(percent(index % 6))}`;
  for (let top = 0; top < height; top += 6) {
    const rows = Math.min(6, height - top);
    const colors = new Set<number>();
    for (let y = top; y < top + rows; y++) for (let x = 0; x < width; x++) colors.add(color(x, y));
    const layers = [...colors].map((index) => {
      let layer = "";
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let row = 0; row < rows; row++) if (color(x, top + row) === index) bits |= 1 << row;
        layer += String.fromCharCode(63 + bits);
      }
      return `#${String(index)}${runLength(layer)}`;
    });
    out += layers.join("$") + "-";
  }
  return out + "\x1b\\";
}

function runLength(text: string): string {
  return text.replaceAll(/(.)\1{3,}/g, (run, char: string) => `!${String(run.length)}${char}`);
}

// Two pixels per cell: the upper one is the ▀ glyph, the lower one its background. The image
// shrinks by averaging to fit the given number of columns.
export function halfBlocks(bitmap: Bitmap, columns: number): string {
  const width = Math.min(bitmap.width, Math.max(columns - 1, 1));
  const scale = bitmap.width / width;
  const height = Math.max(Math.round(bitmap.height / scale), 1);
  // Source pixels [from, to) covered by one output pixel along an axis of the given length.
  const span = (index: number, length: number) => {
    const from = Math.min(Math.floor(index * scale), length - 1);
    return [from, Math.min(Math.max(Math.floor((index + 1) * scale), from + 1), length)] as const;
  };
  const pixel = (x: number, y: number) => {
    const [left, right] = span(x, bitmap.width);
    const [top, bottom] = span(y, bitmap.height);
    const sum = [0, 0, 0];
    for (let sy = top; sy < bottom; sy++)
      for (let sx = left; sx < right; sx++)
        for (let channel = 0; channel < 3; channel++)
          sum[channel] += bitmap.rgb[(sy * bitmap.width + sx) * 3 + channel];
    const count = (right - left) * (bottom - top);
    return sum.map((value) => String(Math.round(value / count))).join(";");
  };
  let out = "";
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x++) {
      const lower = y + 1 < height ? `\x1b[48;2;${pixel(x, y + 1)}m` : "\x1b[49m";
      out += `\x1b[38;2;${pixel(x, y)}m${lower}▀`;
    }
    out += "\x1b[0m\n";
  }
  return out;
}

function kitty(bitmap: Bitmap): string {
  const data = Buffer.from(bitmap.rgb).toString("base64");
  let out = "";
  for (let at = 0; at < data.length; at += CHUNK) {
    const more = at + CHUNK < data.length ? 1 : 0;
    const keys =
      at === 0 ?
        `f=24,s=${String(bitmap.width)},v=${String(bitmap.height)},a=T,q=2,c=${String(COLUMNS)},m=${String(more)}`
      : `m=${String(more)}`;
    out += `\x1b_G${keys};${data.slice(at, at + CHUNK)}\x1b\\`;
  }
  return out + "\n";
}

function iterm(jpeg: Buffer): string {
  return `\x1b]1337;File=inline=1;size=${String(jpeg.length)};width=${String(COLUMNS)};preserveAspectRatio=1:${jpeg.toString("base64")}\x07\n`;
}

async function queryTerminal(): Promise<string> {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let reply = "";
  try {
    return await new Promise<string>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        stdin.off("data", data);
        resolve(reply);
      };
      const data = (chunk: Buffer) => {
        reply += chunk.toString("latin1");
        const start = reply.indexOf("\x1b[?");
        if (start >= 0 && reply.indexOf("c", start) > start) finish();
      };
      const timer = setTimeout(finish, QUERY_TIMEOUT);
      stdin.on("data", data);
      process.stderr.write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c");
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    // Terminal.app prints the kitty query as text, so the line is cleared before drawing.
    process.stderr.write("\r\x1b[2K");
  }
}

// tmux answers the query for itself and passes sixel on only when the outer terminal draws it.
function outerSixel(): boolean {
  if (!process.env.TMUX) return false;
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- the tmux running this pane is the one on PATH
    const features = execFileSync("tmux", ["display", "-p", "#{client_termfeatures}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: QUERY_TIMEOUT,
    });
    return features.trim().split(",").includes("sixel");
  } catch {
    return false;
  }
}

function truecolor(env: NodeJS.ProcessEnv): boolean {
  return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || Boolean(env.WT_SESSION);
}

// Draws the image and returns a function that removes whatever was left on disk.
export async function showImage(jpeg: Buffer): Promise<() => Promise<void>> {
  const done = () => Promise.resolve();
  if (process.stdin.isTTY && process.stderr.isTTY) {
    if (envProtocol(process.env) === "iterm") {
      process.stderr.write(iterm(jpeg));
      return done;
    }
    let bitmap: Bitmap | undefined;
    try {
      bitmap = decodeJpeg(jpeg);
    } catch {
      bitmap = undefined;
    }
    if (bitmap) {
      let protocol = replyProtocol(await queryTerminal());
      if (protocol === "sixel" && multiplexed(process.env) && !outerSixel()) protocol = undefined;
      if (protocol === "kitty") process.stderr.write(kitty(bitmap));
      else if (protocol === "sixel") process.stderr.write(sixel(bitmap) + "\n");
      else if (truecolor(process.env))
        process.stderr.write(halfBlocks(bitmap, process.stderr.columns));
      else bitmap = undefined;
      if (bitmap) return done;
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "openenlink-captcha-"));
  const file = join(directory, "captcha.jpg");
  await writeFile(file, jpeg, { mode: 0o600 });
  process.stderr.write(`Captcha image: ${file}\n`);
  return () => rm(directory, { force: true, recursive: true });
}
