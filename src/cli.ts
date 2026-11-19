#!/usr/bin/env node
import { parseArgs } from "node:util";

import { serve } from "./client.ts";
import { loadConfig, portNumber, saveConfig } from "./config.ts";
import { AuthenticationError, Controller, serverOrigin } from "./controller.ts";
import { CredentialStore } from "./credentials.ts";
import { login } from "./login.ts";
import { askSecret } from "./prompt.ts";

const USAGE = `Usage:
  openenlink login [https://vpn.example.edu] [--remember] [--browser path] [--user-agent text]
  openenlink serve [--port 1088] [--proxy-user name]
  openenlink status
  openenlink logout`;

class UsageError extends Error {}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") return console.log(USAGE);

  if (command === "login") {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args,
      options: {
        browser: { type: "string" },
        remember: { type: "boolean" },
        "user-agent": { type: "string" },
      },
    });
    if (positionals.length > 1) throw new UsageError("login takes one gateway address");
    const previous = await loadConfig();
    const server = positionals[0] ?? previous?.server;
    if (!server) throw new UsageError("login needs the gateway address");
    const config = {
      browser: values.browser ?? previous?.browser,
      server: serverOrigin(server),
      userAgent: (values["user-agent"] ?? previous?.userAgent) || undefined,
    };
    const store = new CredentialStore(config.server);
    const controller = new Controller(config.server, { userAgent: config.userAgent });
    try {
      const url = await controller.loginUrl();
      console.log("Sign in on the school page.");
      if (values.remember)
        console.log("The school username and password will be kept in the OS credential store.");
      const { rememberedPassword, ...credentials } = await login(url, config.browser, {
        remember: values.remember,
      });
      await store.save(credentials);
      if (rememberedPassword) await store.savePassword(rememberedPassword);
      else await store.clearPassword();
      await saveConfig(config);
      await controller.user(credentials.accessToken);
      if (values.remember && !rememberedPassword)
        console.log(
          "Authorization saved; the school did not use a supported username/password form.",
        );
      console.log("Authorization saved. Run openenlink serve to connect.");
    } finally {
      await controller.close();
    }
    return;
  }

  if (command === "serve") {
    const { values } = parseArgs({
      args,
      options: { port: { type: "string" }, "proxy-user": { type: "string" } },
    });
    const port = portNumber(values.port ?? 1088);
    const config = await loadConfig();
    if (!config) throw new AuthenticationError("Run openenlink login first");
    const username = values["proxy-user"];
    const auth =
      username === undefined ? undefined : (
        { username, password: await askSecret("Proxy password: ") }
      );
    if (auth && Object.values(auth).some((value) => !value || Buffer.byteLength(value) > 255))
      throw new UsageError("Proxy username and password must be 1 to 255 bytes");

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await serve(config, { port, auth }, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    return;
  }

  if (command !== "status" && command !== "logout")
    throw new UsageError(`Unknown command ${command}`);
  parseArgs({ args, options: {} });
  const config = await loadConfig();
  const store = config && new CredentialStore(config.server);
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
