import { parentPort, workerData } from "node:worker_threads";

import { ProxyServer } from "./proxy.ts";
import type { ProxyAuth } from "./proxy.ts";
import { Tunnel } from "./tunnel.ts";
import type { Gateway } from "./tunnel.ts";

export type TunnelOptions = {
  gateway: Gateway;
  user: string;
  token: string;
  host: string;
  port: number;
  auth?: ProxyAuth;
};

const options = workerData as TunnelOptions;
const tunnel = await Tunnel.connect(options.gateway, options.user, options.token);
void tunnel.done.catch(() => {});
const proxy = await ProxyServer.listen(tunnel.stack, tunnel.dnsServer, options, options.auth);
parentPort!.postMessage({ port: proxy.port });

try {
  await tunnel.done;
} finally {
  await proxy.close();
  tunnel.close();
}
