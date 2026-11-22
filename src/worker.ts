import { parentPort, workerData } from "node:worker_threads";

import { Resolver } from "./dns.ts";
import { flowsEnded, markTunnelClosed } from "./flow.ts";
import { forward } from "./forward.ts";
import type { Forward } from "./forward.ts";
import * as log from "./log.ts";
import type { Level } from "./log.ts";
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
  hosts: Map<string, string>;
  forwards: Forward[];
  logLevel: Level;
};

const options = workerData as TunnelOptions;
log.setLevel(options.logLevel);
const tunnel = await Tunnel.connect(options.gateway, options.user, options.token);
void tunnel.done.catch(() => {});
const resolver = new Resolver(tunnel.stack, tunnel.dnsServer, options.hosts);
const proxy = await ProxyServer.listen(tunnel.stack, resolver, options, options.auth);
const forwards = await Promise.all(
  options.forwards.map((rule) => forward(tunnel.stack, resolver, options.host, rule)),
);
parentPort!.postMessage({ port: proxy.port });

try {
  await tunnel.done;
} finally {
  markTunnelClosed();
  await Promise.all([proxy.close(), ...forwards.map((forwarding) => forwarding.close())]);
  await flowsEnded();
  tunnel.close();
}
