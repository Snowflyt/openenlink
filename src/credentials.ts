import { AsyncEntry } from "@napi-rs/keyring";

import { object, text } from "./controller.ts";

export type Credentials = { accessToken: string; refreshToken?: string; expiresAt: number };

export class CredentialStore {
  private readonly entry: AsyncEntry;

  constructor(origin: string) {
    this.entry = new AsyncEntry("openenlink", origin);
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
  }
}
