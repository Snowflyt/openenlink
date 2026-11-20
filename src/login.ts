import { UnsupportedLogin } from "./adapter.ts";
import type { Account, Adapter, LoginForm } from "./adapter.ts";
import { suda } from "./adapters/suda.ts";
import { AuthenticationError } from "./controller.ts";
import type { Credentials } from "./credentials.ts";
import { Page, Web, printable } from "./web.ts";
import type { Cookie } from "./web.ts";

const ADAPTERS: Adapter[] = [suda];

const CAPTCHA_ATTEMPTS = 3;

export class WrongPassword extends AuthenticationError {}

export type SignIn = {
  credentials: Credentials;
  // The account typed into the sign-in page, with that page's origin.
  account?: Account & { origin: string };
  // The sign-in page's session cookies; sent again, they sign in without the password.
  cookies: Cookie[];
};

export type LoginOptions = {
  // Called once the sign-in page is recognised; nothing means the browser takes over.
  account: (origin: string) => Promise<Account | undefined>;
  // Shows the captcha image and returns the answer; nothing means the browser takes over.
  captcha?: (image: Buffer) => Promise<string | undefined>;
  cookies?: Cookie[];
  // Ends the sign-in's requests.
  signal?: AbortSignal;
  userAgent?: string;
};

export function loginTokens(url: string, origin: string, cookie?: string): Credentials | undefined {
  const location = new URL(url);
  if (location.origin !== origin) return;
  const encoded =
    location.searchParams.get("accessToken") ?? hashParam(location, "accessToken") ?? cookie;
  if (!encoded) return;
  if (!/^[\w+/=-]+$/.test(encoded)) throw new Error("Invalid access token encoding");
  const accessToken = Buffer.from(encoded, "base64").toString();
  if (
    !accessToken ||
    Array.from(accessToken).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Invalid access token");
  const refreshToken =
    location.searchParams.get("refreshToken") ?? hashParam(location, "refreshToken");
  return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
}

// A parameter of the query after the hash, such as #/login?state=…. URLSearchParams would read
// the "+" of a Base64 value as a space.
function hashParam(url: URL, name: string): string | undefined {
  const fragment = url.hash.slice(1);
  if (!fragment.includes("?")) return;
  for (const pair of fragment.slice(fragment.indexOf("?") + 1).split("&")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at) === name) return decodeURIComponent(pair.slice(at + 1));
  }
}

// Signs in from the gateway's SSO entry: through the sign-in page with a typed password, or
// straight through while the session cookies are still accepted.
export async function login(entry: URL, options: LoginOptions): Promise<SignIn> {
  const web = new Web({
    ...(options.cookies ? { cookies: options.cookies } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  const done = (url: URL) => gatewayTokens(url, entry, web);
  const start = await web.follow(entry, done);
  if (!(start instanceof Page)) return { credentials: start, cookies: kept(web, options.cookies) };

  let page = start;
  let match: { adapter: Adapter; form: LoginForm } | undefined;
  for (const adapter of ADAPTERS) {
    const form = adapter.form(page, web);
    if (form) {
      match = { adapter, form };
      break;
    }
  }
  if (!match) throw new UnsupportedLogin(`No terminal sign-in for ${page.url.host}`);
  const { adapter } = match;
  let { form } = match;
  if (form.captcha && !options.captcha)
    throw new AuthenticationError("The sign-in page asks for a captcha; run openenlink login");
  const origin = page.url.origin;
  const account = await options.account(origin);
  if (!account) throw new UnsupportedLogin("");

  for (let attempt = 1; ; attempt++) {
    let answer: string | undefined;
    if (form.captcha && options.captcha) {
      answer = await options.captcha(await form.captcha());
      if (!answer) throw new UnsupportedLogin("");
    }
    const result = await web.follow(form.action, done, {
      body: form.body(account, answer),
      referer: page.url,
    });
    if (!(result instanceof Page)) {
      const session = web.cookies(page.url.hostname);
      return {
        credentials: result,
        account: { ...account, origin },
        cookies: session.filter((cookie) => adapter.session.includes(cookie.name)),
      };
    }
    const failure = adapter.failure(result);
    if (failure.reason === "password") throw new WrongPassword(failure.message);
    const next = failure.reason === "captcha" ? adapter.form(result, web) : undefined;
    if (!next || attempt === CAPTCHA_ATTEMPTS) throw new AuthenticationError(failure.message);
    page = result;
    form = next;
  }
}

// Reads what a browser sign-in left behind: the address it ended on, a gateway callback
// address, or the value of the gateway's access_token cookie.
export async function pastedLogin(
  pasted: string,
  entry: URL,
  userAgent?: string,
): Promise<Credentials> {
  const value = pasted.trim().replace(/^access_token=/, "");
  if (!value) throw new AuthenticationError("Nothing was pasted");
  if (!/^https?:\/\//i.test(value)) {
    const credentials = loginTokens(entry.href, entry.origin, decodeURIComponent(value));
    if (!credentials) throw new AuthenticationError("Nothing was pasted");
    return credentials;
  }
  const url = new URL(value);
  if (url.origin !== entry.origin)
    throw new AuthenticationError(`The pasted address is not on ${entry.host}`);
  const web = new Web({ ...(userAgent ? { userAgent } : {}) });
  const credentials = gatewayTokens(url, entry, web);
  if (credentials) return credentials;
  if (!url.searchParams.has("code"))
    throw new AuthenticationError("The pasted address carries no sign-in result");
  const result = await web.follow(url, (next) => gatewayTokens(next, entry, web));
  if (result instanceof Page)
    throw new AuthenticationError("The gateway did not accept the pasted address");
  return result;
}

// The gateway ends a sign-in on its own page, with the token in the address or in the
// access_token cookie, or with a base64 JSON error in the state parameter.
function gatewayTokens(url: URL, entry: URL, web: Web): Credentials | undefined {
  if (url.origin !== entry.origin) return;
  const state = hashParam(url, "state");
  if (state) {
    const message = gatewayMessage(state);
    if (message !== undefined)
      throw new AuthenticationError(`The gateway refused the sign-in: ${message}`);
  }
  const cookie = web.cookie(url, "access_token");
  return loginTokens(url.href, entry.origin, cookie && decodeURIComponent(cookie));
}

function gatewayMessage(state: string): string | undefined {
  try {
    const error: unknown = JSON.parse(Buffer.from(state, "base64").toString());
    if (error && typeof error === "object" && "message" in error)
      return printable(String(error.message)) || "no reason given";
  } catch {
    return;
  }
}

function kept(web: Web, cookies: Cookie[] = []): Cookie[] {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return [...new Set(cookies.map((cookie) => cookie.host))]
    .flatMap((host) => web.cookies(host))
    .filter((cookie) => names.has(cookie.name));
}
