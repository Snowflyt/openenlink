import { AsyncEntry } from "@napi-rs/keyring";

import { object, text } from "./controller.ts";

export type Credentials = { accessToken: string; refreshToken?: string; expiresAt: number };
export type RememberedPassword = {
  origin: string;
  username: string;
  password: string;
  expiresAt: number;
  lastAttemptAt?: number;
};

export class CredentialStore {
  private readonly entry: AsyncEntry;
  private readonly passwordEntry: AsyncEntry;

  constructor(origin: string) {
    this.entry = new AsyncEntry("openenlink", origin);
    this.passwordEntry = new AsyncEntry("openenlink-password", origin);
  }

  async load(): Promise<Credentials | undefined> {
    const saved = await this.entry.getPassword();
    if (saved === null) return;
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(saved));
    } catch {
      throw new Error("Saved authorization is damaged; run login again");
    }
    if (typeof value.expiresAt !== "number") throw new Error("Saved authorization has no expiry");
    if (value.expiresAt <= Date.now()) {
      await this.clear();
      return;
    }

    return {
      accessToken: text(value.accessToken, "saved access token"),
      expiresAt: value.expiresAt,
      ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    };
  }

  async save(credentials: Credentials): Promise<void> {
    await this.entry.setPassword(JSON.stringify(credentials));
  }

  async clear(): Promise<void> {
    await this.entry.deletePassword();
    await this.clearPassword();
  }

  async loadPassword(): Promise<RememberedPassword | undefined> {
    const saved = await this.passwordEntry.getPassword();
    if (saved === null) return;
    const value = object(JSON.parse(saved));
    if (typeof value.expiresAt !== "number") throw new Error("Saved password has no expiry");
    if (value.expiresAt <= Date.now()) {
      await this.clearPassword();
      return;
    }
    const origin = new URL(text(value.origin, "password origin"));
    if (origin.protocol !== "https:" || origin.origin !== value.origin)
      throw new Error("Saved password origin must be an HTTPS origin");
    return {
      origin: origin.origin,
      username: text(value.username, "saved username"),
      password: text(value.password, "saved password"),
      expiresAt: value.expiresAt,
      ...(typeof value.lastAttemptAt === "number" ? { lastAttemptAt: value.lastAttemptAt } : {}),
    };
  }

  async savePassword(password: RememberedPassword): Promise<void> {
    await this.passwordEntry.setPassword(JSON.stringify(password));
  }

  async clearPassword(): Promise<void> {
    await this.passwordEntry.deletePassword();
  }
}
