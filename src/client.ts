import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import type { Config } from "./config.ts";
import { AuthenticationError, Controller, PolicyError, tunnelRules } from "./controller.ts";
import { CredentialStore } from "./credentials.ts";
import type { Credentials } from "./credentials.ts";
import { login } from "./login.ts";
import type { SocksAuth } from "./socks.ts";
import type { Gateway } from "./tunnel.ts";
import type { TunnelOptions } from "./worker.ts";

export async function serve(
  config: Config,
  listener: { port: number; socks?: SocksAuth },
  signal: AbortSignal,
): Promise<void> {
  const store = new CredentialStore(config.server);
  const controller = new Controller(config.server, { userAgent: config.userAgent });
  let retry = 1000;
  let gatewayIndex = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const credentials = await store.load();
      if (!credentials) throw new AuthenticationError("Run login to authorize this client");
      try {
        const { gateways, token, user } = await session(
          controller,
          credentials,
          store,
          config.browser,
        );
        const gateway = gateways[gatewayIndex++ % gateways.length];
        await runWorker({ gateway, ...listener, token, user }, signal, () => {
          retry = 1000;
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AuthenticationError || error instanceof PolicyError) throw error;
        console.error(error instanceof Error ? error.message : "Campus connection failed");
      }
      signal.throwIfAborted();
      console.error(`Reconnecting in ${retry / 1000} seconds`);
      await setTimeout(retry, undefined, { signal });
      retry = Math.min(retry * 2, 30_000);
    }
  } finally {
    await controller.close();
  }
}

async function session(
  controller: Controller,
  credentials: Credentials,
  store: CredentialStore,
  browser?: string,
): Promise<{ user: string; token: string; gateways: Gateway[] }> {
  try {
    const user = await controller.user(credentials.accessToken);
    return { ...tunnelRules(await controller.rules(credentials.accessToken)), user };
  } catch (error) {
    if (!(error instanceof AuthenticationError)) throw error;
    let renewed;
    if (credentials.refreshToken) {
      try {
        renewed = await controller.refresh(credentials.refreshToken);
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
      }
    }
    if (!renewed) {
      const password = await store.loadPassword();
      if (!password) throw error;
      if (Date.now() - (password.lastAttemptAt ?? 0) < 5 * 60 * 1000)
        throw new AuthenticationError(
          "Automatic sign-in will retry after five minutes; login --remember can continue now",
        );
      await store.savePassword({ ...password, lastAttemptAt: Date.now() });
      console.log("Campus session ended; signing in on the school site");
      renewed = await login(await controller.loginUrl(), browser, { password });
    }
    await store.save(renewed);
    const user = await controller.user(renewed.accessToken);
    return { ...tunnelRules(await controller.rules(renewed.accessToken)), user };
  }
}

async function runWorker(
  options: TunnelOptions,
  signal: AbortSignal,
  connected: () => void,
): Promise<void> {
  // Ending the worker releases lwIP's timer, sockets and WASM memory together.
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: options });
  const stop = () => {
    void worker.terminate();
  };
  signal.addEventListener("abort", stop, { once: true });
  worker.once("message", () => {
    connected();
    console.log(`Campus SOCKS listening on 127.0.0.1:${options.port}`);
  });

  try {
    const [code] = await once(worker, "exit");
    if (code !== 0 && !signal.aborted)
      throw new Error(`Campus tunnel stopped with status ${String(code)}`);
  } finally {
    signal.removeEventListener("abort", stop);
    await worker.terminate();
  }
}
