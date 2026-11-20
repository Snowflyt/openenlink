import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { text } from "./controller.ts";
import { osKeyring } from "./keyring.ts";
import type { Cookie } from "./web.ts";

export type Credentials = { accessToken: string; refreshToken?: string };
export type RememberedPassword = {
  origin: string;
  username: string;
  password: string;
  lastAttemptAt?: number;
  // The sign-in page's session cookies, tried before the password.
  cookies?: Cookie[];
};

type Secret = "authorization" | "password";

const SERVICES: Record<Secret, string> = {
  authorization: "openenlink",
  password: "openenlink-password",
};

const DAMAGED = "Saved credentials are damaged; run login again";

// Secrets live in the OS credential store, or in a JSON file keyed by origin when a file is
// given, for containers and hosts without a credential store.
export class CredentialStore {
  private readonly origin: string;
  readonly file: string | undefined;

  constructor(origin: string, file?: string) {
    this.origin = origin;
    this.file = file;
  }

  async load(): Promise<Credentials | undefined> {
    const value = await this.read("authorization");
    if (!value) return;
    return {
      accessToken: text(value.accessToken, "saved access token"),
      ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    };
  }

  async save(credentials: Credentials): Promise<void> {
    await this.write("authorization", credentials);
  }

  async clear(): Promise<void> {
    await this.write("authorization", undefined);
    await this.clearPassword();
  }

  async loadPassword(): Promise<RememberedPassword | undefined> {
    const value = await this.read("password");
    if (!value) return;
    const origin = new URL(text(value.origin, "password origin"));
    if (origin.protocol !== "https:" || origin.origin !== value.origin)
      throw new Error("Saved password origin must be an HTTPS origin");
    return {
      origin: origin.origin,
      username: text(value.username, "saved username"),
      password: text(value.password, "saved password"),
      ...(typeof value.lastAttemptAt === "number" ? { lastAttemptAt: value.lastAttemptAt } : {}),
      ...(value.cookies === undefined ? {} : { cookies: cookies(value.cookies) }),
    };
  }

  async savePassword(password: RememberedPassword): Promise<void> {
    await this.write("password", password);
  }

  async clearPassword(): Promise<void> {
    await this.write("password", undefined);
  }

  private async read(secret: Secret): Promise<Record<string, unknown> | undefined> {
    if (this.file) {
      const entry = (await readEntries(this.file))[this.origin];
      const value = entry === undefined ? undefined : saved(entry)[secret];
      return value === undefined ? undefined : saved(value);
    }
    const value = osKeyring().read(SERVICES[secret], this.origin);
    return value === undefined ? undefined : parse(value);
  }

  private async write(secret: Secret, value: object | undefined): Promise<void> {
    if (!this.file) {
      if (value === undefined) osKeyring().delete(SERVICES[secret], this.origin);
      else osKeyring().write(SERVICES[secret], this.origin, JSON.stringify(value));
      return;
    }

    const entries = await readEntries(this.file);
    const previous = entries[this.origin];
    const entry = {
      ...without(previous === undefined ? {} : saved(previous), secret),
      ...(value === undefined ? {} : { [secret]: value }),
    };
    const next = {
      ...without(entries, this.origin),
      ...(Object.keys(entry).length ? { [this.origin]: entry } : {}),
    };

    if (!Object.keys(next).length) return rm(this.file, { force: true });
    await mkdir(dirname(this.file), { mode: 0o700, recursive: true });
    // Readers see the old file or the new one, never half of one.
    const temporary = `${this.file}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

async function readEntries(file: string): Promise<Record<string, unknown>> {
  try {
    return parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function parse(value: string): Record<string, unknown> {
  try {
    return saved(JSON.parse(value));
  } catch {
    throw new Error(DAMAGED);
  }
}

function saved(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(DAMAGED);
  return value as Record<string, unknown>;
}

function cookies(value: unknown): Cookie[] {
  if (!Array.isArray(value)) throw new Error(DAMAGED);
  return value.map((entry: unknown) => {
    const cookie = saved(entry);
    return {
      name: text(cookie.name, "saved cookie name"),
      value: text(cookie.value, "saved cookie value"),
      host: text(cookie.host, "saved cookie host"),
      path: text(cookie.path, "saved cookie path"),
      ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
    };
  });
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}
