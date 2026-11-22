// The log lines of one connection through the tunnel, in the form "[TCP] client --> host:port":
// one when it opens, one when it closes with its duration and byte counts, or one when it fails.

import { isIPv4 } from "node:net";
import type { Socket } from "node:net";

import { hostName } from "./dns.ts";
import * as log from "./log.ts";
import { peerLeft } from "./stream.ts";
import { printable } from "./web.ts";

let tunnelClosed = false;
const opened = new Set<Flow>();
let allEnded: (() => void) | undefined;

// Connections that end after this are closed by the tunnel, not by either side.
export function markTunnelClosed(): void {
  tunnelClosed = true;
}

// Resolves once every flow that opened has ended and logged its line.
export function flowsEnded(): Promise<void> {
  if (!opened.size) return Promise.resolve();
  return new Promise((resolve) => {
    allEnded = resolve;
  });
}

export function address(host = "", port = 0): string {
  const unmapped = host.replace(/^::ffff:(?=[\d.]+$)/, "");
  const name = unmapped.includes(":") ? `[${unmapped}]` : unmapped;
  return `${name}:${String(port)}`;
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

function size(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export class Flow {
  protocol: "TCP" | "UDP";
  sent = 0;
  received = 0;
  private readonly client: string;
  private readonly socket: Socket | undefined;
  private target = "";
  private started = 0;
  private ended = false;

  // A TCP flow reads the client from its socket, a UDP flow takes the client's address.
  constructor(protocol: "TCP" | "UDP", client: Socket | string) {
    this.protocol = protocol;
    this.socket = typeof client === "string" ? undefined : client;
    this.client =
      typeof client === "string" ? client : address(client.remoteAddress, client.remotePort);
  }

  // A SOCKS client may send any bytes as a domain name. The line shows the name the resolver
  // looks up, and the printable characters of a name it would reject.
  to(host: string, port: number): void {
    const name = isIPv4(host) ? host : hostName(host) || printable(host);
    this.target = `${name}:${String(port)}`;
  }

  private label(): string {
    const label = `[${this.protocol}] ${this.client}`;
    return this.target ? `${label} --> ${this.target}` : label;
  }

  open(note = ""): void {
    this.started = Date.now();
    opened.add(this);
    log.info(note ? `${this.label()} ${note}` : this.label());
  }

  warn(message: string): void {
    log.warn(`${this.label()} ${message}`);
  }

  // A client that left before the flow opened, or that reset it, is no failure.
  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (opened.delete(this) && !opened.size) allEnded?.();
    const left = peerLeft(error) || (!this.started && this.socket?.destroyed === true);
    if (error !== undefined && !left && !tunnelClosed) {
      log.error(
        `${this.label()} failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return;
    }
    if (!this.started) return;
    const reason =
      tunnelClosed ? " (tunnel closed)"
      : error === undefined ? ""
      : " (client reset)";
    log.info(
      `${this.label()} closed after ${duration(Date.now() - this.started)}${reason}, ` +
        `sent ${size(this.sent)}, received ${size(this.received)}`,
    );
  }
}
