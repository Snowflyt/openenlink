import { createHash, randomInt } from "node:crypto";

import { Agent } from "undici";

import { ipv4Address } from "./protocol.ts";
import type { Gateway } from "./tunnel.ts";

export class AuthenticationError extends Error {}
export class PolicyError extends Error {}

export function serverOrigin(server: string): string {
  const url = new URL(server);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Server must be an HTTPS address");
  }
  if (url.pathname !== "/") throw new Error("Server must be an HTTPS origin without a path");
  return url.origin;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Controller returned an invalid object");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`Controller omitted ${field}`);
  return value;
}

export function signature(
  url: URL,
  authorization: string,
  body = "",
  now = String(Date.now()),
  requestId = Array.from(
    { length: 16 },
    () => "qwertyuiopasdfghjklzxcvbnm1234567890"[randomInt(36)],
  ).join(""),
): Record<string, string> {
  const content = `${url.search.slice(1)}${body}${now}${requestId}enlink${requestId}${authorization}`;
  // The controller protocol specifies MD5 for this request checksum.
  // eslint-disable-next-line sonarjs/hashing
  const finger = createHash("md5")
    .update(content.startsWith(".") ? content.slice(1) : content)
    .digest("hex");
  return { Authorization: authorization, finger, now, requestId };
}

export class Controller {
  readonly origin: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly dispatcher = new Agent({ connect: { rejectUnauthorized: true } });

  constructor(server: string, fetch = globalThis.fetch) {
    this.origin = serverOrigin(server);
    this.fetch = fetch;
  }

  async request(
    path: string,
    token = "",
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new Error("Controller endpoint belongs to another server");
    const json = body === undefined ? undefined : JSON.stringify(body);
    const authorization = token ? `Bearer ${token}` : "";
    const options = {
      body: json,
      dispatcher: this.dispatcher,
      headers: { ...signature(url, authorization, json), "Content-Type": "application/json" },
      method: body === undefined ? "GET" : "POST",
      redirect: "error" as const,
      signal: AbortSignal.timeout(15_000),
    };
    const response = await this.fetch(url, options);
    if (response.status === 401) throw new AuthenticationError("Campus authorization expired");
    if (!response.ok)
      throw new Error(
        `Campus controller ${options.method} ${url.pathname} returned HTTP ${response.status}`,
      );

    const result = object(await response.json());
    if (result.code === "401" || result.code === "3010")
      throw new AuthenticationError("Campus authorization expired");
    if (result.code !== "200") {
      const code =
        typeof result.code === "string" && /^[\w-]{1,32}$/.test(result.code) ?
          result.code
        : "invalid";
      throw new PolicyError(`Campus controller rejected ${url.pathname}, code ${code}`);
    }
    return object(result.data);
  }

  async loginUrl(): Promise<URL> {
    const config = await this.request("/enclient/api/users/custom/page/login/cfg/select", "", {});
    if (!Array.isArray(config.ssoLoginTypes)) throw new Error("Server did not offer browser SSO");
    const oidc = config.ssoLoginTypes
      .map(object)
      .find((entry) => entry.loginType === "SSO_OIDC" && !entry.hidden);
    if (!oidc) throw new Error("Server did not offer OIDC login");
    const url = new URL(text(oidc.loginUrl, "OIDC login URL"), this.origin);
    if (url.origin !== this.origin) throw new Error("SSO entry belongs to another server");
    return url;
  }

  async user(token: string): Promise<string> {
    const user = await this.request("/enclient/api/users/info", token);
    return text(user.username, "username");
  }

  async rules(token: string): Promise<Record<string, unknown>> {
    return this.request("/enclient/api/users/terminal/rules", token);
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const result = await this.request("/enclient/api/users/client/refreshToken", refreshToken);
    return {
      accessToken: text(result.token, "access token"),
      refreshToken: text(result.refreshToken, "refresh token"),
    };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

export function tunnelRules(rules: Record<string, unknown>): {
  token: string;
  gateways: Gateway[];
} {
  if (rules.spa_status === true)
    throw new PolicyError("This server requires SPA; its handshake is still being implemented");
  if (!Array.isArray(rules.gateway_list))
    throw new Error("Controller did not return a gateway list");
  const gateways = rules.gateway_list.map((entry) => {
    const gateway = object(entry);
    const parts = text(gateway.ip, "gateway address").split("||");
    if (parts.length !== 3) throw new Error("Controller returned an invalid gateway address");
    const endpoint = new URL("https://" + parts[0]);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("Controller returned an invalid gateway endpoint");
    }
    const host = endpoint.hostname.replace(/^\[|\]$/g, "");
    const dns =
      gateway.internalDnsResolveStatus === "true" ?
        ipv4Address(text(gateway.dns, "campus DNS"))
      : undefined;
    return { host, port: Number(endpoint.port || 443), serverName: host, ...(dns ? { dns } : {}) };
  });
  if (!gateways.length) throw new Error("Controller returned no public gateways");
  return { gateways, token: text(rules.token, "tunnel token") };
}
