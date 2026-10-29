import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { launch } from "puppeteer-core";
import type { Page } from "puppeteer-core";

import type { Credentials } from "./credentials.ts";

export function loginTokens(
  url: string,
  origin: string,
  cookie?: string,
): Omit<Credentials, "expiresAt"> | undefined {
  const location = new URL(url);
  if (location.origin !== origin) return;
  const fragment = location.hash.slice(1);
  const query = new URLSearchParams(
    fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : "",
  );
  const encoded = location.searchParams.get("accessToken") ?? query.get("accessToken") ?? cookie;
  if (!encoded) return;
  if (!/^[\w+/=-]+$/.test(encoded))
    throw new Error("School returned an invalid access token encoding");
  const accessToken = Buffer.from(encoded, "base64").toString();
  if (
    !accessToken ||
    Array.from(accessToken).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("School returned an invalid access token");
  const refreshToken = location.searchParams.get("refreshToken") ?? query.get("refreshToken");
  return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
}

export async function browserPath(explicit?: string): Promise<string> {
  const candidates =
    explicit ?
      [explicit]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
          .filter((root): root is string => Boolean(root))
          .map((root) => join(root, "Google/Chrome/Application/chrome.exe")),
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .flatMap((root) =>
            ["google-chrome", "chromium", "chromium-browser"].map((name) => join(root, name)),
          ),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Chrome or Chromium was not found; set --browser to its executable");
}

export async function login(url: URL, executable?: string): Promise<Credentials> {
  const executablePath = await browserPath(executable);
  const profile = await mkdtemp(join(tmpdir(), "openenlink-login-"));
  try {
    const browser = await launch({
      args: ["--no-proxy-server"],
      defaultViewport: null,
      executablePath,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: false,
      userDataDir: profile,
    });
    const stop = () => {
      void browser.close().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Could not close login browser");
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const page = await browser.newPage();
      return await captureAuthorization(page, url);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await browser.close();
    }
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
}

export async function captureAuthorization(page: Page, url: URL): Promise<Credentials> {
  const session = await page.createCDPSession();
  const credentials = Promise.withResolvers<Credentials>();
  const closed = () => credentials.reject(new Error("Login window closed"));
  page.once("close", closed);

  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      const location = new URL(event.request.url);
      const trusted = location.origin === url.origin;
      const headers = event.responseHeaders ?? [];
      const cookieHeader = headers.find(
        (entry) =>
          entry.name.toLowerCase() === "set-cookie" && entry.value.startsWith("access_token="),
      );
      let cookie = cookieHeader?.value.match(/^access_token=([^;]+)/)?.[1];
      if (trusted && event.responseStatusCode !== undefined && !cookie) {
        const cookies = await session.send("Network.getCookies", { urls: [url.origin] });
        cookie = cookies.cookies.find((entry) => entry.name === "access_token")?.value;
      }
      const redirect = headers.find((entry) => entry.name.toLowerCase() === "location")?.value;
      const callback = redirect ? new URL(redirect, location) : location;
      const tokens =
        trusted ?
          loginTokens(callback.href, url.origin, cookie ? decodeURIComponent(cookie) : undefined)
        : undefined;

      if (tokens) {
        // Stop at the callback response before its scripts can launch the native app.
        await session.send("Fetch.fulfillRequest", {
          body: Buffer.from("Authorization received. You can close this window.").toString(
            "base64",
          ),
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
        });
        credentials.resolve({ ...tokens, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        return;
      }

      const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
      if (
        (!trusted && local) ||
        !["http:", "https:", "data:", "blob:"].includes(location.protocol)
      ) {
        await session.send("Fetch.failRequest", {
          errorReason: "BlockedByClient",
          requestId: event.requestId,
        });
      } else if (event.responseStatusCode !== undefined) {
        await session.send("Fetch.continueResponse", { requestId: event.requestId });
      } else {
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
      }
    })().catch(credentials.reject);
  });

  try {
    await session.send("Fetch.enable", {
      patterns: [
        { requestStage: "Request", urlPattern: "*" },
        { requestStage: "Response", urlPattern: url.origin + "/*" },
      ],
    });
    void page
      .goto(url.href, { timeout: 0, waitUntil: "domcontentloaded" })
      .catch(credentials.reject);
    return await credentials.promise;
  } finally {
    page.off("close", closed);
    await session.detach();
  }
}
