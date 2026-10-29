import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  AuthenticationError,
  Controller,
  serverOrigin,
  signature,
  tunnelRules,
} from "../src/controller.ts";
import { loginTokens } from "../src/login.ts";

await test("Controller signs the bytes it sends and uses the refresh token for renewal", async () => {
  const requests: { url: URL; options: RequestInit }[] = [];
  const mock: typeof fetch = (input, init) => {
    assert(input instanceof URL);
    const url = input;
    const options = init!;
    const headers = new Headers(options.headers);
    assert(options.body === undefined || typeof options.body === "string");
    const signed = `${url.search.slice(1)}${options.body ?? ""}${headers.get("now")}${headers.get("requestId")}enlink${headers.get("requestId")}${headers.get("Authorization")}`;
    // eslint-disable-next-line sonarjs/hashing
    assert.equal(headers.get("finger"), createHash("md5").update(signed).digest("hex"));
    assert.equal(options.redirect, "error");
    requests.push({ options, url });
    return Promise.resolve(
      Response.json({
        code: "200",
        data: { account: "student", refreshToken: "new-refresh", token: "new-access" },
      }),
    );
  };
  const controller = new Controller("https://vpn.example.test", mock);
  try {
    assert.equal(await controller.user("access"), "student");
    assert.deepEqual(await controller.refresh("refresh"), {
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    assert.equal(new Headers(requests[0].options.headers).get("Authorization"), "Bearer access");
    assert.equal(new Headers(requests[1].options.headers).get("Authorization"), "Bearer refresh");
    assert.equal(requests[1].url.pathname, "/enclient/api/users/client/refreshToken");
    await assert.rejects(
      controller.request("https://outside.example/api", "access"),
      /another server/,
    );
    assert.equal(requests.length, 2);
  } finally {
    await controller.close();
  }
});

await test("Controller distinguishes expired authorization from malformed replies", async () => {
  const controller = new Controller("https://vpn.example.test", () =>
    Promise.resolve(new Response(null, { status: 401 })),
  );
  try {
    await assert.rejects(controller.user("expired"), AuthenticationError);
  } finally {
    await controller.close();
  }
  assert.throws(() => serverOrigin("http://vpn.example.test"), /HTTPS/);
  assert.throws(() => serverOrigin("https://user:password@vpn.example.test"), /HTTPS/);
  assert.throws(() => tunnelRules({ gateway_list: [], token: "token" }), /no public gateways/);
  assert.throws(() => tunnelRules({ spa_status: true }), /SPA/);
  assert.deepEqual(
    tunnelRules({
      gateway_list: [{ ip: "gateway.example.test:8443||10.0.0.1||443" }],
      token: "tunnel",
    }),
    {
      gateways: [{ host: "gateway.example.test", port: 8443, serverName: "gateway.example.test" }],
      token: "tunnel",
    },
  );
});

await test("Browser completion accepts tokens only from the configured school origin", () => {
  const origin = "https://vpn.example.test";
  const encoded = Buffer.from("access-token").toString("base64");
  const url = `${origin}/#/login/wxLoginLoading?accessToken=${encodeURIComponent(encoded)}&refreshToken=refresh-token`;
  assert.deepEqual(loginTokens(url, origin), {
    accessToken: "access-token",
    refreshToken: "refresh-token",
  });
  assert.equal(loginTokens(url.replace("vpn.example.test", "outside.example"), origin), undefined);
  assert.throws(() => loginTokens(`${origin}/?accessToken=invalid!`, origin), /encoding/);
  assert.equal(
    signature(new URL(origin), "", "", "1700000000000", "abcdefghijklmnop").now,
    "1700000000000",
  );
});
