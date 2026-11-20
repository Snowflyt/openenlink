// HTTP for sign-in pages. Cookies stay with the host that set them, and redirects are
// followed one hop at a time so every request stays on HTTPS and a posted password never
// travels to a second address.

import { Agent } from "undici";

import { requestFailure } from "./controller.ts";

export type Cookie = { name: string; value: string; host: string; path: string; expires?: number };

const HOPS = 12;

// undici alone gives up on a connection after 10 seconds, the name lookup included, and a slow
// network needs longer. The limit stays on because nothing else ends a connection that stalls
// while opening: a signal ends the request and leaves the socket.
const dispatcher = new Agent({ connect: { timeout: 60_000 } });

export class Page {
  readonly url: URL;
  readonly status: number;
  readonly html: string;

  constructor(url: URL, status: number, html: string) {
    this.url = url;
    this.status = status;
    this.html = html;
  }
}

export class Web {
  private readonly jar = new Map<string, Cookie>();
  private readonly signal: AbortSignal | undefined;
  private readonly userAgent: string | undefined;

  constructor({
    cookies = [],
    signal,
    userAgent,
  }: { cookies?: Cookie[]; signal?: AbortSignal; userAgent?: string } = {}) {
    for (const cookie of cookies) this.jar.set(cookieKey(cookie), cookie);
    this.signal = signal;
    this.userAgent = userAgent;
  }

  cookies(host: string): Cookie[] {
    return [...this.jar.values()].filter(
      (cookie) => cookie.host === host && (cookie.expires ?? Infinity) > Date.now(),
    );
  }

  cookie(url: URL, name: string): string | undefined {
    return this.cookies(url.hostname).find(
      (cookie) => cookie.name === name && pathMatches(url.pathname, cookie.path),
    )?.value;
  }

  async json(url: URL): Promise<unknown> {
    const response = await this.send(url);
    if (!response.ok) throw new Error(`${url.host} returned HTTP ${response.status}`);
    return response.json();
  }

  // Follows redirects from url until done recognises an address, which is returned without
  // being requested, or until a page loads.
  async follow<T>(
    url: URL,
    done: (url: URL) => T | undefined,
    form?: { body: URLSearchParams; referer: URL },
  ): Promise<T | Page> {
    for (let hop = 0; hop < HOPS; hop++) {
      const result = done(url);
      if (result !== undefined) return result;
      const response = await this.send(url, form);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || location === null)
        return new Page(url, response.status, await response.text());
      await response.body?.cancel();
      if (form && (response.status === 307 || response.status === 308))
        throw new Error(`${url.host} tried to resend the sign-in form to another address`);
      url = new URL(location, url);
      form = undefined;
    }
    throw new Error("Sign-in redirected too many times");
  }

  private async send(url: URL, form?: { body: URLSearchParams; referer: URL }): Promise<Response> {
    if (url.protocol !== "https:") throw new Error(`Sign-in left HTTPS at ${url.host}`);
    const cookies = this.cookies(url.hostname)
      .filter((cookie) => pathMatches(url.pathname, cookie.path))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const options = {
      ...(form ? { body: form.body, method: "POST" } : {}),
      dispatcher,
      headers: {
        ...(cookies ? { Cookie: cookies } : {}),
        ...(form ? { Referer: form.referer.href } : {}),
        ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
      },
      redirect: "manual" as const,
      ...(this.signal ? { signal: this.signal } : {}),
    };
    const response = await fetch(url, options).catch((error: unknown) => {
      throw requestFailure(url, error);
    });
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseCookie(header, url);
      if (!cookie) continue;
      if ((cookie.expires ?? Infinity) > Date.now()) this.jar.set(cookieKey(cookie), cookie);
      else this.jar.delete(cookieKey(cookie));
    }
    return response;
  }
}

function cookieKey(cookie: Cookie): string {
  return `${cookie.host}\t${cookie.path}\t${cookie.name}`;
}

// RFC 6265 path matching; a Domain attribute is ignored, so cookies return only to their host.
function pathMatches(path: string, cookiePath: string): boolean {
  return (
    path === cookiePath ||
    (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"))
  );
}

export function parseCookie(header: string, url: URL): Cookie | undefined {
  const [pair = "", ...attributes] = header.split(";");
  const at = pair.indexOf("=");
  if (at <= 0) return;
  const directory = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
  const cookie: Cookie = {
    name: pair.slice(0, at).trim(),
    value: pair.slice(at + 1).trim(),
    host: url.hostname,
    path: directory || "/",
  };
  let maxAge = false;
  for (const attribute of attributes) {
    const equals = attribute.indexOf("=");
    const name = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const value = equals < 0 ? "" : attribute.slice(equals + 1).trim();
    if (name === "path" && value.startsWith("/")) cookie.path = value;
    else if (name === "max-age" && /^-?\d+$/.test(value)) {
      cookie.expires = Date.now() + Number(value) * 1000;
      maxAge = true;
    } else if (name === "expires" && !maxAge && !Number.isNaN(Date.parse(value)))
      cookie.expires = Date.parse(value);
  }
  return cookie;
}

const ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

// Attributes of every <name> start tag; enough for the server-rendered forms of sign-in pages.
export function tags(html: string, name: string): Partial<Record<string, string>>[] {
  const pattern = new RegExp(`<${name}\\b((?:"[^"]*"|'[^']*'|[^'">])*)>`, "gi");
  // A group that took no part in a match is undefined, which the RegExp types leave out.
  return [...html.matchAll(pattern)].map(([, attributes = ""]) =>
    Object.fromEntries(
      [
        ...attributes.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g),
      ].map(([, key = "", double, single, bare]: (string | undefined)[]) => [
        key.toLowerCase(),
        decodeEntities(double ?? single ?? bare ?? ""),
      ]),
    ),
  );
}

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body.toLowerCase()] ?? entity;
  });
}

// Server text shown in the terminal loses control characters, so it cannot move the cursor or
// rewrite earlier lines.
export function printable(text: string, limit = 200): string {
  return Array.from(text)
    .filter(
      (char) =>
        char.charCodeAt(0) >= 32 && !(char.charCodeAt(0) >= 127 && char.charCodeAt(0) < 160),
    )
    .join("")
    .slice(0, limit);
}
