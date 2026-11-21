import { createHash, randomInt } from "node:crypto";

import { Agent } from "undici";

import { object, text } from "./json.ts";
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

// fetch rejects with "fetch failed" and keeps the reason, such as a timeout or a refused
// connection, in the cause.
export function requestFailure(url: URL, error: unknown): Error {
  const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return new Error(
    `Request to ${url.host} failed: ${reason instanceof Error ? reason.message : String(reason)}`,
    { cause: error },
  );
}

export class Controller {
  readonly origin: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly userAgent: string | undefined;
  // undici alone gives up on a connection after 10 seconds, the name lookup included, and a slow
  // network needs longer. The limit stays on because nothing else ends a connection that stalls
  // while opening: a signal ends the request and leaves the socket.
  private readonly dispatcher = new Agent({
    connect: { rejectUnauthorized: true, timeout: 60_000 },
  });

  constructor(
    server: string,
    {
      fetch = globalThis.fetch,
      userAgent,
    }: { fetch?: typeof globalThis.fetch; userAgent?: string } = {},
  ) {
    this.origin = serverOrigin(server);
    this.fetch = fetch;
    this.userAgent = userAgent;
  }

  async request(
    path: string,
    token = "",
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new Error("Controller endpoint belongs to another server");
    const json = body === undefined ? undefined : JSON.stringify(body);
    const authorization = token ? `Bearer ${token}` : "";
    const options = {
      body: json,
      dispatcher: this.dispatcher,
      headers: {
        ...signature(url, authorization, json),
        "Content-Type": "application/json",
        ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
      },
      method: body === undefined ? "GET" : "POST",
      redirect: "error" as const,
      ...(signal ? { signal } : {}),
    };
    const response = await this.fetch(url, options).catch((error: unknown) => {
      throw requestFailure(url, error);
    });
    if (response.status === 401) throw new AuthenticationError("Authorization expired");
    if (!response.ok)
      throw new Error(
        `Controller ${options.method} ${url.pathname} returned HTTP ${response.status}`,
      );

    const result = object(await response.json());
    if (result.code === "401" || result.code === "3010")
      throw new AuthenticationError("Authorization expired");
    if (result.code !== "200") {
      const code =
        typeof result.code === "string" && /^[\w-]{1,32}$/.test(result.code) ?
          result.code
        : "invalid";
      throw new PolicyError(`Controller rejected ${url.pathname}, code ${code}`);
    }
    return object(result.data);
  }

  async loginUrl(signal?: AbortSignal): Promise<URL> {
    const path = "/enclient/api/users/custom/page/login/cfg/select";
    const config = await this.request(path, "", {}, signal);
    if (!Array.isArray(config.ssoLoginTypes)) throw new Error("Server did not offer browser SSO");
    const oidc = config.ssoLoginTypes
      .map(object)
      .find((entry) => entry.loginType === "SSO_OIDC" && !entry.hidden);
    if (!oidc) throw new Error("Server did not offer OIDC login");
    const url = new URL(text(oidc.loginUrl, "OIDC login URL"), this.origin);
    if (url.origin !== this.origin) throw new Error("SSO entry belongs to another server");
    return url;
  }

  async user(token: string, signal?: AbortSignal): Promise<string> {
    const user = await this.request("/enclient/api/users/info", token, undefined, signal);
    return text(user.username, "username");
  }

  async rules(token: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/enclient/api/users/terminal/rules", token, undefined, signal);
  }

  async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const path = "/enclient/api/users/client/refreshToken";
    const result = await this.request(path, refreshToken, undefined, signal);
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
        ipv4Address(text(gateway.dns, "internal DNS"))
      : undefined;
    return { host, port: Number(endpoint.port || 443), ...(dns ? { dns } : {}) };
  });
  if (!gateways.length) throw new Error("Controller returned no public gateways");
  return { gateways, token: text(rules.token, "tunnel token") };
}
