import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { launch } from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";

import { AuthenticationError } from "./controller.ts";
import type { Credentials, RememberedPassword } from "./credentials.ts";

type LoginResult = Credentials & { rememberedPassword?: RememberedPassword };
type PasswordInput = Pick<RememberedPassword, "origin" | "username" | "password">;

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

export async function login(
  url: URL,
  executable?: string,
  options: { remember?: boolean; password?: RememberedPassword } = {},
): Promise<LoginResult> {
  const executablePath = await browserPath(executable);
  const profile = await mkdtemp(join(tmpdir(), "openenlink-login-"));
  try {
    const browser = await launch({
      args: ["--no-proxy-server"],
      defaultViewport: null,
      executablePath,
      pipe: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: Boolean(options.password),
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
      const captured = captureAuthorization(page, url, options.remember);
      if (!options.password) return await captured;
      const timeout = AbortSignal.timeout(30_000);
      timeout.addEventListener("abort", stop, { once: true });
      try {
        const [result] = await Promise.all([captured, fillPassword(page, options.password)]);
        return { ...result, expiresAt: options.password.expiresAt };
      } catch (error) {
        if (timeout.aborted)
          throw new AuthenticationError(
            "Automatic school sign-in timed out; run login --remember to complete verification",
          );
        throw error;
      } finally {
        timeout.removeEventListener("abort", stop);
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await browser.close();
    }
  } finally {
    await rm(profile, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function fillPassword(page: Page, password: RememberedPassword): Promise<void> {
  await page.waitForSelector("#password", { timeout: 15_000 });
  if (new URL(page.url()).origin !== password.origin)
    throw new AuthenticationError("School login moved to another origin; run login --remember");
  await page.locator("#username").fill(password.username);
  await page.locator("#password").fill(password.password);
  await page.click("#login-submit");
}

export async function captureAuthorization(
  page: Page,
  url: URL,
  remember = false,
): Promise<LoginResult> {
  const session = await page.createCDPSession();
  let password: PasswordInput | undefined;
  if (remember)
    await watchPassword(session, (value) => {
      password = value;
    });
  const credentials = Promise.withResolvers<LoginResult>();
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
        const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
        credentials.resolve({
          ...tokens,
          expiresAt,
          ...(password ? { rememberedPassword: { ...password, expiresAt } } : {}),
        });
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
    if (!session.detached) await session.detach();
  }
}

async function watchPassword(
  session: CDPSession,
  update: (password: PasswordInput) => void,
): Promise<void> {
  await session.send("Page.enable");
  const mainFrame = (await session.send("Page.getFrameTree")).frameTree.frame.id;
  const contexts = new Map<string, number>();
  session.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.name === "openenlink-password" && context.auxData?.frameId === mainFrame)
      contexts.set(context.uniqueId, context.id);
  });
  session.on("Runtime.executionContextDestroyed", ({ executionContextUniqueId }) =>
    contexts.delete(executionContextUniqueId),
  );
  session.on("Runtime.executionContextsCleared", () => contexts.clear());
  session.on("Runtime.bindingCalled", (event) => {
    if (
      event.name === "openenlinkPassword" &&
      contexts.values().some((id) => id === event.executionContextId)
    )
      update(JSON.parse(event.payload) as PasswordInput);
  });
  await session.send("Runtime.enable");
  await session.send("Runtime.addBinding", {
    name: "openenlinkPassword",
    executionContextName: "openenlink-password",
  });
  const script = () => {
    if (window.top !== window) return;
    const capture = () => {
      const username = document.querySelector<HTMLInputElement>("#username");
      const password = document.querySelector<HTMLInputElement>("#password");
      if (location.protocol !== "https:" || !username?.value || !password?.value) return;
      const binding = window as unknown as { openenlinkPassword: (input: string) => void };
      binding.openenlinkPassword(
        JSON.stringify({
          origin: location.origin,
          username: username.value,
          password: password.value,
        }),
      );
    };
    document.addEventListener(
      "input",
      (event) => {
        if (event.isTrusted) capture();
      },
      true,
    );
    document.addEventListener("click", capture, true);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") capture();
      },
      true,
    );
  };
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    worldName: "openenlink-password",
    source: "(" + script.toString() + ")()",
  });
}
