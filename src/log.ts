// Lines from serve, which runs for days: info goes to standard output, warnings and errors to
// standard error, each after the local time and its level.

import { fstatSync } from "node:fs";
import { isatty } from "node:tty";
import { styleText } from "node:util";

type Level = "info" | "warn" | "error";

const COLORS = { info: "green", warn: "yellow", error: "red" } as const;

export function timestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  );
}

// systemd gives the device and inode of the journal's stream in JOURNAL_STREAM, and the journal
// keeps its own time for every line.
function journal(fd: number): boolean {
  const stream = process.env.JOURNAL_STREAM;
  if (!stream) return false;
  const { dev, ino } = fstatSync(fd, { bigint: true });
  return stream === `${String(dev)}:${String(ino)}`;
}

const streams = new Map<number, { time: boolean; color: boolean }>();

function write(level: Level, message: string): void {
  const fd = level === "info" ? 1 : 2;
  let stream = streams.get(fd);
  if (!stream) {
    // A worker's process.stdout is no TTY even in a terminal, so the descriptor decides.
    stream = { time: !journal(fd), color: isatty(fd) && !process.env.NO_COLOR };
    streams.set(fd, stream);
  }
  const tag = stream.color ? styleText(COLORS[level], level, { validateStream: false }) : level;
  const time = stream.time ? `[${timestamp(new Date())}] ` : "";
  const line = `${time}[${tag}] ${message}`;
  if (fd === 1) console.log(line);
  else console.error(line);
}

export function info(message: string): void {
  write("info", message);
}

export function warn(message: string): void {
  write("warn", message);
}

export function error(message: string): void {
  write("error", message);
}
