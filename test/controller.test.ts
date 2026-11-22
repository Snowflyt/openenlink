import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  AuthenticationError,
  Controller,
  PolicyError,
  SessionTaken,
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
        data: { username: "student", refreshToken: "new-refresh", token: "new-access" },
      }),
    );
  };
  const controller = new Controller("https://vpn.example.test", {
    fetch: mock,
    userAgent: "Example/1.0",
  });
  try {
    assert.equal(await controller.user("access"), "student");
    assert.deepEqual(await controller.refresh("refresh"), {
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    assert.equal(new Headers(requests[0].options.headers).get("Authorization"), "Bearer access");
    assert.equal(requests[0].url.pathname, "/enclient/api/users/info");
    assert.equal(new Headers(requests[0].options.headers).get("User-Agent"), "Example/1.0");
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

await test("Controller names the host and reason when a request fails", async () => {
  const controller = new Controller("https://vpn.example.test", {
    fetch: () =>
      Promise.reject(
        new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 192.0.2.1:443") }),
      ),
  });
  try {
    await assert.rejects(controller.user("token"), {
      message: "Request to vpn.example.test failed: connect ECONNREFUSED 192.0.2.1:443",
    });
  } finally {
    await controller.close();
  }
});

await test("Controller distinguishes expired authorization from malformed replies", async () => {
  const controller = new Controller("https://vpn.example.test", {
    fetch: () => Promise.resolve(new Response(null, { status: 401 })),
  });
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
      gateways: [{ host: "gateway.example.test", port: 8443 }],
      token: "tunnel",
    },
  );
});

await test("Controller recognizes expired sessions returned with HTTP 200", async () => {
  const controller = new Controller("https://vpn.example.test", {
    fetch: () => Promise.resolve(Response.json({ code: "3010", data: null })),
  });
  try {
    await assert.rejects(controller.user("expired"), AuthenticationError);
  } finally {
    await controller.close();
  }
});

await test("Controller rejections carry the server's message", async () => {
  let code = "1001";
  const controller = new Controller("https://vpn.example.test", {
    fetch: () => Promise.resolve(Response.json({ code, messages: "Signed in\u001b[2J elsewhere" })),
  });
  try {
    await assert.rejects(controller.user("taken"), (error) => {
      assert(error instanceof SessionTaken);
      assert.equal(
        error.message,
        "Controller rejected /enclient/api/users/info, code 1001: Signed in[2J elsewhere",
      );
      return true;
    });
    code = "1000";
    await assert.rejects(controller.user("refused"), PolicyError);
  } finally {
    await controller.close();
  }
});

await test("Gateway policy selects the internal DNS", () => {
  const { gateways } = tunnelRules({
    gateway_list: [
      {
        ip: "gateway.example.test:443||10.0.0.1||58679",
        internalDnsResolveStatus: "true",
        dns: "10.0.0.53",
      },
    ],
    token: "tunnel",
  });
  assert.equal(gateways[0].dns, "10.0.0.53");
});

await test("Browser completion accepts tokens only from the configured gateway origin", () => {
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

await test("Browser login uses the SSO entry advertised by the server", async () => {
  const path = "/enclient/api/users/admin/custom/page/login/sso/OIDC";
  const controller = new Controller("https://vpn.example.test", {
    fetch: () =>
      Promise.resolve(
        Response.json({
          code: "200",
          data: { ssoLoginTypes: [{ hidden: false, loginType: "SSO_OIDC", loginUrl: path }] },
        }),
      ),
  });
  try {
    const url = await controller.loginUrl();
    assert.equal(url.pathname, path);
    assert.equal(url.search, "");
  } finally {
    await controller.close();
  }
});
