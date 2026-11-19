#!/usr/bin/env node
import { parseArgs } from "node:util";

import { serve } from "./client.ts";
import { loadConfig, portNumber, saveConfig } from "./config.ts";
import { Controller, serverOrigin } from "./controller.ts";
import { CredentialStore } from "./credentials.ts";
import { login } from "./login.ts";

const HELP = `openenlink login --server https://vpn.example.edu [--browser path] [--port 1088] [--remember]
openenlink serve
openenlink status
openenlink logout`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      browser: { type: "string" },
      help: { short: "h", type: "boolean" },
      port: { type: "string" },
      remember: { type: "boolean" },
      server: { type: "string" },
    },
  });
  if (values.help || !positionals.length) return console.log(HELP);
  if (positionals.length !== 1) throw new Error("Choose one command");
  const command = positionals[0];
  if (!["login", "serve", "status", "logout"].includes(command)) throw new Error(HELP);

  const previous = await loadConfig();
  const server = values.server ?? previous?.server;
  if (!server) throw new Error("Run login with --server https://your-campus-gateway");
  const config = {
    browser: values.browser ?? previous?.browser,
    port: portNumber(values.port ?? previous?.port ?? 1088),
    server: serverOrigin(server),
  };
  const store = new CredentialStore(config.server);
  if (command === "login") {
    const controller = new Controller(config.server);
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
  } else if (command === "logout") {
    await store.clear();
    console.log("Saved authorization removed.");
  } else if (command === "status") {
    console.log((await store.load()) ? "Authorization saved" : "Login required");
    const password = await store.loadPassword();
    if (password) console.log(`Password remembered for ${password.username}`);
  } else {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await serve(config, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "openenlink failed");
  process.exitCode = 1;
});
