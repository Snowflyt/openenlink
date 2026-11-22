import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { UnsupportedLogin } from "./adapter.ts";
import { credentialStore } from "./config.ts";
import type { Config } from "./config.ts";
import {
  AuthenticationError,
  Controller,
  PolicyError,
  SessionTaken,
  tunnelRules,
} from "./controller.ts";
import type { CredentialStore, Credentials, RememberedPassword } from "./credentials.ts";
import type { Forward } from "./forward.ts";
import * as log from "./log.ts";
import { WrongPassword, login } from "./login.ts";
import type { ProxyAuth } from "./proxy.ts";
import type { Gateway } from "./tunnel.ts";
import type { TunnelOptions } from "./worker.ts";

export async function serve(
  config: Config,
  listener: {
    host: string;
    port: number;
    auth?: ProxyAuth;
    hosts: Map<string, string>;
    forwards: Forward[];
    logLevel: log.Level;
  },
  signal: AbortSignal,
): Promise<void> {
  const store = credentialStore(config);
  const controller = new Controller(config.server, { userAgent: config.userAgent });
  let retry = 1000;
  let gatewayIndex = 0;
  let connected = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const credentials = await store.load();
      if (!credentials) throw new AuthenticationError("Run login to authorize this client");
      let lived = 0;
      try {
        // Nobody watches these requests, so a server that stops answering must not hold the
        // loop. Two minutes covers them on a slow network.
        const limit = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        const { gateways, token, user } = await session(
          controller,
          credentials,
          store,
          limit,
          config.userAgent,
          !connected,
        );
        connected = true;
        const gateway = gateways[gatewayIndex++ % gateways.length];
        const started = Date.now();
        await runWorker({ gateway, ...listener, token, user }, signal).finally(() => {
          lived = Date.now() - started;
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AuthenticationError || error instanceof PolicyError) throw error;
        // A local port that is taken or not allowed stays so on the next attempt.
        const { syscall } = error as { syscall?: unknown };
        if (syscall === "listen" || syscall === "bind") throw error;
        log.error(error instanceof Error ? error.message : "Connection failed");
      }
      signal.throwIfAborted();
      // Another client on the same account ends our tunnel right after it starts; growing the
      // delay keeps the two from replacing each other every second.
      if (lived > 60_000) retry = 1000;
      log.warn(`Reconnecting in ${retry / 1000} second${retry === 1000 ? "" : "s"}`);
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
  signal: AbortSignal,
  userAgent: string | undefined,
  starting: boolean,
): Promise<{ user: string; token: string; gateways: Gateway[] }> {
  try {
    const user = await controller.user(credentials.accessToken, signal);
    return { ...tunnelRules(await controller.rules(credentials.accessToken, signal)), user };
  } catch (error) {
    // A serve that was just started takes the account back from a newer sign-in. Once connected,
    // it leaves the account to that sign-in, so two machines do not keep taking it from each other.
    if (!(error instanceof AuthenticationError) || (error instanceof SessionTaken && !starting))
      throw error;
    let renewed;
    if (credentials.refreshToken) {
      log.debug(`${error.message}; renewing the session with the refresh token`);
      try {
        renewed = await controller.refresh(credentials.refreshToken, signal);
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
      }
    }
    if (!renewed) {
      const password = await store.loadPassword();
      if (!password) throw error;
      log.info("Session ended; signing in again");
      renewed = await renew(await controller.loginUrl(signal), password, store, signal, userAgent);
    }
    await store.save(renewed);
    const user = await controller.user(renewed.accessToken, signal);
    return { ...tunnelRules(await controller.rules(renewed.accessToken, signal)), user };
  }
}

// Signs in again with the sign-in page's session cookies, or with the remembered password at most
// once every five minutes, so a changed password cannot lock the account.
async function renew(
  entry: URL,
  password: RememberedPassword,
  store: CredentialStore,
  signal: AbortSignal,
  userAgent?: string,
): Promise<Credentials> {
  try {
    const { cookies, credentials } = await login(entry, {
      signal,
      ...(password.cookies ? { cookies: password.cookies } : {}),
      ...(userAgent ? { userAgent } : {}),
      account: async (origin, failure) => {
        if (failure) return;
        if (origin !== password.origin)
          throw new AuthenticationError(
            "The sign-in page moved to another site; run openenlink login --remember",
          );
        if (Date.now() - (password.lastAttemptAt ?? 0) < 5 * 60 * 1000)
          throw new AuthenticationError(
            "Automatic sign-in will retry after five minutes; login --remember can continue now",
          );
        await store.savePassword({ ...password, lastAttemptAt: Date.now() });
        return password;
      },
    });
    const { lastAttemptAt: _, ...kept } = password;
    await store.savePassword({ ...kept, ...(cookies.length ? { cookies } : {}) });
    return credentials;
  } catch (error) {
    if (error instanceof WrongPassword) {
      await store.clearPassword();
      throw new AuthenticationError(
        `${error.message}; the remembered password was removed, run openenlink login --remember`,
      );
    }
    if (error instanceof UnsupportedLogin)
      throw new AuthenticationError(
        `${error.message || "Sign-in needs a browser"}; run openenlink login`,
      );
    throw error;
  }
}

async function runWorker(options: TunnelOptions, signal: AbortSignal): Promise<void> {
  // Ending the worker releases lwIP's timer, sockets and WASM memory together.
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: options });
  const stop = () => {
    void worker.terminate();
  };
  signal.addEventListener("abort", stop, { once: true });
  worker.once("message", () => {
    const host = options.host.includes(":") ? `[${options.host}]` : options.host;
    log.info(`Proxy listening on ${host}:${options.port}`);
    for (const rule of options.forwards) {
      const local = `${host}:${rule.port}${rule.udp ? "/udp" : ""}`;
      log.info(`Forwarding ${local} to ${rule.host}:${rule.hostPort}`);
    }
  });

  try {
    const [code] = await once(worker, "exit");
    if (code !== 0 && !signal.aborted)
      throw new Error(`Tunnel stopped with status ${String(code)}`);
  } finally {
    signal.removeEventListener("abort", stop);
    await worker.terminate();
  }
}
