import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { serverOrigin } from "./controller.ts";
import { CredentialStore } from "./credentials.ts";
import { object, text } from "./json.ts";

export type Config = {
  server: string;
  // The last username, offered as the default at login.
  user?: string;
  userAgent?: string;
  insecureStorage?: boolean;
};

function configDirectory(): string {
  if (process.platform === "win32") {
    if (!process.env.APPDATA) throw new Error("APPDATA is not set");
    return join(process.env.APPDATA, "openenlink");
  }
  // XDG Base Directory: an unset, empty or relative XDG_CONFIG_HOME means ~/.config.
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "openenlink");
}

export function credentialStore(config: Config): CredentialStore {
  return new CredentialStore(
    config.server,
    config.insecureStorage ? join(configDirectory(), "credentials.json") : undefined,
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
    saved = await readFile(join(configDirectory(), "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const config = object(JSON.parse(saved));
  return {
    server: serverOrigin(text(config.server, "server address")),
    ...(typeof config.user === "string" && config.user ? { user: config.user } : {}),
    ...(typeof config.userAgent === "string" ? { userAgent: config.userAgent } : {}),
    ...(config.insecureStorage === true ? { insecureStorage: true } : {}),
  };
}

export async function saveConfig(config: Config): Promise<void> {
  const file = join(configDirectory(), "config.json");
  await mkdir(dirname(file), { mode: 0o700, recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
