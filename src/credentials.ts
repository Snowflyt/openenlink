import { AsyncEntry } from "@napi-rs/keyring";

import { object, text } from "./controller.ts";

export type Credentials = { accessToken: string; refreshToken?: string };
export type RememberedPassword = {
  origin: string;
  username: string;
  password: string;
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
    return {
      accessToken: text(value.accessToken, "saved access token"),
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
    const origin = new URL(text(value.origin, "password origin"));
    if (origin.protocol !== "https:" || origin.origin !== value.origin)
      throw new Error("Saved password origin must be an HTTPS origin");
    return {
      origin: origin.origin,
      username: text(value.username, "saved username"),
      password: text(value.password, "saved password"),
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
