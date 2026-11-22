#!/usr/bin/env node
import { isIP, isIPv4 } from "node:net";
import { parseArgs, styleText } from "node:util";

import { UnsupportedLogin } from "./adapter.ts";
import { serve } from "./client.ts";
import { credentialStore, loadConfig, portNumber, saveConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { AuthenticationError, Controller, serverOrigin } from "./controller.ts";
import { hostName } from "./dns.ts";
import type { Forward } from "./forward.ts";
import { showImage } from "./image.ts";
import * as log from "./log.ts";
import { login, pastedLogin } from "./login.ts";
import type { SignIn } from "./login.ts";
import { nc } from "./nc.ts";
import { Interrupted, ask, askPaste, askSecret } from "./prompt.ts";

const USAGE = `Usage:
  openenlink login [https://vpn.example.edu] [--user name] [--remember] [--browser]
                   [--insecure-storage] [--user-agent text]
  openenlink serve [--bind 127.0.0.1] [--port 1088] [--proxy-user name]
                   [--add-host name=address]...
                   [--forward port:host:hostport[/udp]]...
                   [--log-level error|warn|info|debug]
  openenlink nc host port [--port 1088]
  openenlink status
  openenlink logout`;

const PASSWORD_ATTEMPTS = 3;

class UsageError extends Error {}

// Signs in on the sign-in page from the terminal; a page without an adapter, or an empty
// username or captcha, moves the sign-in to a browser. login --browser starts there.
async function signIn(entry: URL, config: Config, user?: string): Promise<SignIn> {
  let username = user ?? config.user;
  let attempt = 0;
  try {
    return await login(entry, {
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
      account: async (origin, failure) => {
        if (++attempt > PASSWORD_ATTEMPTS) return;
        if (failure) console.error(failure);
        const host = new URL(origin).host;
        if (user && attempt === 1) {
          console.log(`Type the password for ${user} at ${host} below.`);
        } else {
          if (attempt === 1) {
            console.log(`Type your ${host} username and password below.`);
            if (!username)
              console.log("Leave the username empty to sign in with a browser instead.");
          }
          const typed = await ask(
            username ? `Username (press Enter for ${username}): ` : "Username: ",
          );
          username = typed || username;
        }
        if (!username) return;
        return { username, password: await askSecret("Password (hidden): ") };
      },
      captcha: async (image) => {
        const cleanup = await showImage(image);
        try {
          return await ask(
            "Type the characters in the image (press Enter alone to use a browser): ",
          );
        } finally {
          await cleanup();
        }
      },
    });
  } catch (error) {
    if (!(error instanceof UnsupportedLogin)) throw error;
    if (error.message) console.error(error.message);
    return { credentials: await browserSignIn(entry, config.userAgent), cookies: [] };
  }
}

// A clickable, underlined address in a terminal that shows styles; the plain address elsewhere.
function link(url: string): string {
  if (!process.stdout.isTTY || !process.stdout.hasColors()) return url;
  return `\x1b]8;;${url}\x1b\\${styleText("underline", url)}\x1b]8;;\x1b\\`;
}

async function browserSignIn(entry: URL, userAgent?: string) {
  const bold = (text: string) => styleText("bold", text);
  const dim = (text: string) => styleText("dim", text);
  console.log(`Sign in with a browser at
  ${link(entry.href)}

Then paste ${bold("either of these")}:
  ${bold("1.")} The address the browser ends on.
     ${dim("If the gateway moves on to another page, that address no longer")}
     ${dim("holds the sign-in. Use 2 instead.")}
  ${bold("2.")} The value of the access_token cookie of ${entry.host}:
       Chrome, Edge   Developer tools > Application > Cookies
       Firefox        Developer tools > Storage > Cookies
       Safari         Develop > Show Web Inspector > Storage > Cookies
`);
  return pastedLogin(await askPaste("Paste (hidden): "), entry, userAgent);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") return console.log(USAGE);

  if (command === "login") {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args,
      options: {
        browser: { type: "boolean" },
        "insecure-storage": { type: "boolean" },
        remember: { type: "boolean" },
        user: { type: "string" },
        "user-agent": { type: "string" },
      },
    });
    if (positionals.length > 1) throw new UsageError("login takes one gateway address");
    if (values.browser && (values.user !== undefined || values.remember))
      throw new UsageError("--browser signs in without --user or --remember");
    const previous = await loadConfig();
    const server = positionals[0] ?? previous?.server;
    if (!server) throw new UsageError("login needs the gateway address");
    const origin = serverOrigin(server);
    const config: Config = {
      server: origin,
      ...(previous?.server === origin && previous.user ? { user: previous.user } : {}),
      ...((values["user-agent"] ?? previous?.userAgent) ?
        { userAgent: values["user-agent"] ?? previous?.userAgent }
      : {}),
      ...(values["insecure-storage"] ? { insecureStorage: true } : {}),
    };
    const store = credentialStore(config);
    store.open();
    const where = store.file ?? "the OS credential store";
    const controller = new Controller(config.server, { userAgent: config.userAgent });
    try {
      const entry = await controller.loginUrl();
      if (values.remember) console.log(`The username and password will be kept in ${where}.`);
      const { account, cookies, credentials }: SignIn =
        values.browser ?
          { credentials: await browserSignIn(entry, config.userAgent), cookies: [] }
        : await signIn(entry, config, values.user);
      await store.save(credentials);
      if (values.remember && account) await store.savePassword({ ...account, cookies });
      else await store.clearPassword();
      await saveConfig({ ...config, ...(account ? { user: account.username } : {}) });
      if (previous && Boolean(previous.insecureStorage) !== Boolean(config.insecureStorage)) {
        const old = credentialStore(previous);
        await old.clear().catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(
            `Could not remove the copy in ${old.file ?? "the OS credential store"}: ${reason}`,
          );
        });
      }
      console.log(`Signed in as ${await controller.user(credentials.accessToken)}`);
      if (values.remember && !account)
        console.log("A browser sign-in leaves no password to remember for serve.");
      console.log(`Authorization saved in ${where}. Run openenlink serve to connect.`);
    } finally {
      await controller.close();
    }
    return;
  }

  if (command === "serve") {
    const { values } = parseArgs({
      args,
      options: {
        "add-host": { multiple: true, type: "string" },
        bind: { type: "string" },
        forward: { multiple: true, type: "string" },
        "log-level": { type: "string" },
        port: { type: "string" },
        "proxy-user": { type: "string" },
      },
    });
    const logLevel = log.LEVELS.find((level) => level === (values["log-level"] ?? "info"));
    if (!logLevel) throw new UsageError("--log-level needs error, warn, info or debug");
    log.setLevel(logLevel);
    const host = values.bind ?? "127.0.0.1";
    if (!isIP(host)) throw new UsageError("--bind needs an IP address");
    const port = portNumber(values.port ?? 1088);
    const hosts = new Map<string, string>();
    for (const entry of values["add-host"] ?? []) {
      const at = entry.indexOf("=");
      const name = hostName(entry.slice(0, at));
      const address = entry.slice(at + 1);
      if (at < 0 || !name || !isIPv4(address))
        throw new UsageError("--add-host needs a name and an IPv4 address, as name=address");
      hosts.set(name, address);
    }
    const forwards: Forward[] = [];
    for (const entry of values.forward ?? []) {
      const [, port, target = "", hostPort, protocol] =
        /^(\d+):([^:]+):(\d+)(?:\/(tcp|udp))?$/.exec(entry) ?? [];
      if (!port || !hostPort || !hostName(target) || Buffer.byteLength(target) > 255)
        throw new UsageError("--forward needs port:host:hostport, with /udp for UDP");
      forwards.push({
        host: target,
        hostPort: portNumber(hostPort),
        port: portNumber(port),
        udp: protocol === "udp",
      });
    }
    const config = await loadConfig();
    if (!config) throw new AuthenticationError("Run openenlink login first");
    const username = values["proxy-user"];
    const auth =
      username === undefined ? undefined : (
        { username, password: await askSecret("Proxy password: ") }
      );
    if (auth && Object.values(auth).some((value) => !value || Buffer.byteLength(value) > 255))
      throw new UsageError("Proxy username and password must be 1 to 255 bytes");
    if (!/^127\.|^::1$/.test(host)) {
      if (!auth)
        log.warn("Other machines can use the proxy without a password; --proxy-user sets one");
      else if (forwards.length)
        log.warn("Other machines can use the forwarded ports without a password");
    }

    const controller = new AbortController();
    let stopped: NodeJS.Signals | undefined;
    const stop = (signal: NodeJS.Signals) => {
      stopped = signal;
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const listener = { auth, forwards, host, hosts, logLevel, port };
    await serve(config, listener, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    // systemd counts exit status 0 as a clean stop; Ctrl+C ends with its signal, as at a prompt.
    if (stopped === "SIGINT") throw new Interrupted(stopped);
    return;
  }

  if (command === "nc") {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args,
      options: { port: { type: "string" } },
    });
    const [host, port, ...rest] = positionals;
    if (!host || !port || rest.length) throw new UsageError("nc needs a host and a port");
    if (Buffer.byteLength(host) > 255) throw new UsageError("Host names must be at most 255 bytes");
    await nc(host, portNumber(port), portNumber(values.port ?? 1088));
    return;
  }
  if (command !== "status" && command !== "logout")
    throw new UsageError(`Unknown command ${command}`);
  parseArgs({ args, options: {} });
  const config = await loadConfig();
  const store = config && credentialStore(config);
  if (command === "logout") {
    await store?.clear();
    console.log("Saved authorization removed.");
    return;
  }
  const saved = await store?.load();
  console.log(saved ? "Authorization saved" : "Login required");
  if (!saved) process.exitCode = 3;
  const password = await store?.loadPassword();
  if (password) console.log(`Password remembered for ${password.username}`);
}

await main().catch((error: unknown) => {
  // A command stopped by a signal ends by that signal, without a message, so a loop around it at
  // the shell prompt stops too. Windows has no such end and takes the shell's 128 + 2.
  if (error instanceof Interrupted) {
    if (process.platform === "win32") process.exitCode = 130;
    else process.kill(process.pid, error.signal);
    return;
  }
  const usage =
    error instanceof UsageError ||
    String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS");
  console.error(error instanceof Error ? error.message : "openenlink failed");
  if (usage) console.error(USAGE);
  process.exitCode =
    usage ? 2
    : error instanceof AuthenticationError ? 3
    : 1;
});
