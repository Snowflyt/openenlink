import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { object, serverOrigin, text } from "./controller.ts";

export type Config = { server: string; browser?: string; userAgent?: string };

function configFile(): string {
  if (process.platform === "win32") {
    if (!process.env.APPDATA) throw new Error("APPDATA is not set");
    return join(process.env.APPDATA, "openenlink", "config.json");
  }
  // XDG Base Directory: an unset, empty or relative XDG_CONFIG_HOME means ~/.config.
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
    "openenlink",
    "config.json",
  );
}

export function portNumber(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Port must be between 1 and 65535");
  return port;
}

export async function loadConfig(): Promise<Config | undefined> {
  let saved: string;
  try {
    saved = await readFile(configFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const config = object(JSON.parse(saved));
  return {
    server: serverOrigin(text(config.server, "server address")),
    ...(typeof config.browser === "string" ? { browser: config.browser } : {}),
    ...(typeof config.userAgent === "string" ? { userAgent: config.userAgent } : {}),
  };
}

export async function saveConfig(config: Config): Promise<void> {
  const file = configFile();
  await mkdir(dirname(file), { mode: 0o700, recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
