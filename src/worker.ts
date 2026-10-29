import { parentPort, workerData } from "node:worker_threads";

import { SocksServer } from "./socks.ts";
import { Tunnel } from "./tunnel.ts";
import type { Gateway } from "./tunnel.ts";

export type TunnelOptions = { gateway: Gateway; user: string; token: string; port: number };

const options = workerData as TunnelOptions;
const tunnel = await Tunnel.connect(options.gateway, options.user, options.token);
void tunnel.done.catch(() => {});
const socks = await SocksServer.listen(tunnel.stack, tunnel.dnsServer, options.port);
parentPort!.postMessage({ port: socks.port });

try {
  await tunnel.done;
} finally {
  await socks.close();
  tunnel.close();
}
