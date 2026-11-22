import { createSocket } from "node:dgram";
import type { RemoteInfo } from "node:dgram";
import { once } from "node:events";
import { createServer, isIPv6 } from "node:net";
import type { Socket } from "node:net";

import type { NetworkStack } from "#tcpip";

import type { Resolver } from "./dns.ts";
import { Flow, address } from "./flow.ts";
import * as log from "./log.ts";
import { relay } from "./relay.ts";
import { ByteReader } from "./stream.ts";

export type Forward = { port: number; host: string; hostPort: number; udp: boolean };

// The port is the one listened on, which differs from the rule's when the rule asks for port 0.
export type Forwarding = { port: number; close: () => Promise<void> };

// A UDP client keeps its tunnel socket, and with it the address replies come back to, until it has
// sent and received nothing for a minute.
const UDP_IDLE = 60_000;

// Listens on bind:port and joins each connection, or each UDP client, to host:hostPort through the
// tunnel.
export async function forward(
  stack: NetworkStack,
  resolver: Resolver,
  bind: string,
  rule: Forward,
): Promise<Forwarding> {
  return rule.udp ?
      forwardUdp(stack, resolver, bind, rule)
    : forwardTcp(stack, resolver, bind, rule);
}

async function forwardTcp(
  stack: NetworkStack,
  resolver: Resolver,
  bind: string,
  rule: Forward,
): Promise<Forwarding> {
  const clients = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket);
    const controller = new AbortController();
    socket.on("error", () => {});
    socket.once("close", () => {
      clients.delete(socket);
      controller.abort();
    });
    const reader = new ByteReader(socket);
    const flow = new Flow("TCP", socket);
    flow.to(rule.host, rule.hostPort);
    void (async () => {
      const host = await resolver.lookup(rule.host, controller.signal);
      const connection = await stack.tcp.connect({ host, port: rule.hostPort });
      await relay(socket, reader, connection, flow, {});
    })().then(
      () => flow.end(),
      (error: unknown) => {
        flow.end(error);
        socket.destroy();
      },
    );
  });

  server.listen(rule.port, bind);
  await once(server, "listening");
  const listening = server.address();
  if (!listening || typeof listening === "string") throw new Error("Forwarding has no port");
  return {
    close: async () => {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    port: listening.port,
  };
}

type Session = { send: (data: Buffer) => void; close: () => Promise<void> };

async function forwardUdp(
  stack: NetworkStack,
  resolver: Resolver,
  bind: string,
  rule: Forward,
): Promise<Forwarding> {
  const local = createSocket(isIPv6(bind) ? "udp6" : "udp4");
  const controller = new AbortController();
  const sessions = new Map<string, Session>();

  const open = (client: RemoteInfo): Session => {
    const key = `${client.address} ${client.port}`;
    const flow = new Flow("UDP", address(client.address, client.port));
    flow.to(rule.host, rule.hostPort);
    const ready = (async () => {
      const remote = await stack.udp.open();
      try {
        const host = await resolver.lookup(rule.host, controller.signal);
        return { host, remote, writer: remote.writable.getWriter() };
      } catch (error) {
        await remote.close();
        throw error;
      }
    })();
    let queue: Promise<unknown> = ready;

    const close = async (error?: unknown) => {
      sessions.delete(key);
      clearTimeout(timer);
      flow.end(error);
      const opened = await ready.catch(() => undefined);
      if (!opened) return;
      opened.writer.releaseLock();
      await opened.remote.close();
    };
    const end = (error?: unknown) => {
      if (sessions.get(key) !== session) return;
      void close(error);
    };
    const timer = setTimeout(end, UDP_IDLE);
    const session: Session = {
      close: () => close(),
      send: (data) => {
        timer.refresh();
        flow.sent += data.length;
        queue = queue.then(async () => {
          const { host, writer } = await ready;
          await writer.write({ data, host, port: rule.hostPort });
        });
        void queue.catch(end);
      },
    };

    void ready
      .then(async ({ host, remote }) => {
        flow.open();
        for await (const packet of remote) {
          if (packet.host !== host || packet.port !== rule.hostPort) continue;
          timer.refresh();
          flow.received += packet.data.length;
          local.send(packet.data, client.port, client.address);
        }
      })
      .catch(end);
    sessions.set(key, session);
    return session;
  };

  local.on("message", (data, client) => {
    (sessions.get(`${client.address} ${client.port}`) ?? open(client)).send(data);
  });
  local.bind(rule.port, bind);
  await once(local, "listening");
  local.on("error", (error) => {
    log.error(`[UDP] forwarding port ${String(local.address().port)} failed: ${error.message}`);
  });
  return {
    close: async () => {
      controller.abort();
      local.close();
      await Promise.all(Array.from(sessions.values(), (session) => session.close()));
    },
    port: local.address().port,
  };
}
