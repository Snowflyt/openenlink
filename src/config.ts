import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { object, serverOrigin, text } from "./controller.ts";
import type { SocksAuth } from "./socks.ts";

export type Config = { server: string; port: number; browser?: string; socks?: SocksAuth };

const configFile = join(
  process.platform === "win32" ? (process.env.APPDATA ?? homedir()) : join(homedir(), ".config"),
  "openenlink",
  "config.json",
);

export function portNumber(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Port must be between 1 and 65535");
  return port;
}

export async function loadConfig(): Promise<Config | undefined> {
  let saved: string;
  try {
    saved = await readFile(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const config = object(JSON.parse(saved));
  const socks = config.socks === undefined ? undefined : object(config.socks);
  return {
    port: portNumber(text(String(config.port), "SOCKS port")),
    server: serverOrigin(text(config.server, "server address")),
    ...(typeof config.browser === "string" ? { browser: config.browser } : {}),
    ...(socks ?
      {
        socks: {
          username: text(socks.username, "SOCKS username"),
          password: text(socks.password, "SOCKS password"),
        },
      }
    : {}),
  };
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(configFile), { mode: 0o700, recursive: true });
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
