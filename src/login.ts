import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { launch } from "puppeteer-core";

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
      headless: false,
      userDataDir: profile,
    });
    try {
      const page = await browser.newPage();
      let finished = false;
      const credentials = Promise.withResolvers<Credentials>();
      browser.once("disconnected", () => credentials.reject(new Error("Login window closed")));
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const location = new URL(request.url());
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
        // The school page normally hands tokens to the official local daemon.
        void (
          local || !["http:", "https:", "data:", "blob:"].includes(location.protocol) ?
            request.abort()
          : request.continue()).catch(() => {});
      });
      const inspect = async () => {
        if (finished || !browser.connected) return;
        const location = page.url();
        if (!location.startsWith(url.origin + "/")) return;
        const cookie = (await browser.cookies()).find(
          (entry) =>
            entry.name === "access_token" &&
            new URL(location).hostname.endsWith(entry.domain.replace(/^\./, "")),
        );
        const result = loginTokens(location, url.origin, cookie?.value);
        if (!result) return;
        finished = true;
        credentials.resolve({ ...result, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
      };
      const timer = setInterval(() => {
        void inspect().catch(credentials.reject);
      }, 250);
      try {
        void page
          .goto(url.href, { timeout: 0, waitUntil: "domcontentloaded" })
          .catch(credentials.reject);
        return await credentials.promise;
      } finally {
        clearInterval(timer);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
}
