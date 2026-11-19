import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { test } from "node:test";

import { launch } from "puppeteer-core";
import { generate } from "selfsigned";

import { serve } from "../src/client.ts";
import { AuthenticationError, Controller, PolicyError } from "../src/controller.ts";
import { CredentialStore } from "../src/credentials.ts";
import type { Credentials, RememberedPassword } from "../src/credentials.ts";
import { browserPath, captureAuthorization, fillPassword } from "../src/login.ts";

await test(
  "Capture SSO callbacks before their scripts can launch an application",
  { timeout: 20_000 },
  async (t) => {
    let unexpected = 0;
    let queryPage = 0;
    const token = Buffer.from("test-access-token").toString("base64");
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      if (path === "/query") {
        response.writeHead(302, {
          Location:
            "/complete?accessToken=" + encodeURIComponent(token) + "&refreshToken=test-refresh",
        });
        response.end();
      } else if (path === "/cookie") {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Set-Cookie": `access_token=${token}; Path=/; HttpOnly`,
        });
        response.end("<script>fetch('/unexpected')</script>");
      } else {
        if (path === "/unexpected") unexpected++;
        if (path === "/complete") queryPage++;
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<script>fetch('/unexpected')</script>");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const browser = await launch({ executablePath: await browserPath(), headless: true });
    t.after(() => browser.close());
    try {
      for (const path of ["/query", "/cookie"]) {
        const page = await browser.newPage();
        const credentials = await captureAuthorization(
          page,
          new URL(`http://127.0.0.1:${address.port}${path}`),
        );
        assert.equal(credentials.accessToken, "test-access-token");
        assert.equal(credentials.refreshToken, path === "/query" ? "test-refresh" : undefined);
        await page.waitForFunction(() =>
          document.body.textContent.includes("Authorization received"),
        );
        await page.close();
      }
      assert.equal(queryPage, 0);
      assert.equal(unexpected, 0);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

await test(
  "Remember CAS credentials across origins and refuse to fill them on another origin",
  { timeout: 30_000 },
  async () => {
    const certificate = await generate([{ name: "commonName", value: "localhost" }], {
      keySize: 2048,
    });
    let port = 0;
    const server = createHttpsServer(
      { key: certificate.private, cert: certificate.cert },
      (request, response) => {
        if (request.url === "/start") {
          response.writeHead(302, { Location: `https://school.test:${port}/login` });
          response.end();
        } else if (request.url === "/submit") {
          response.writeHead(302, {
            Location:
              `https://portal.test:${port}/complete?accessToken=` +
              Buffer.from("remembered-access").toString("base64"),
          });
          response.end();
        } else {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(
            '<form method="post" action="/submit"><input id="username" name="username"><input id="password" name="password" type="password"><input id="login-submit" type="submit"></form>',
          );
        }
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    port = address.port;
    const url = new URL(`https://portal.test:${port}/start`);
    const browser = await launch({
      executablePath: await browserPath(),
      headless: true,
      acceptInsecureCerts: true,
      args: [
        "--no-proxy-server",
        "--host-resolver-rules=MAP portal.test 127.0.0.1, MAP school.test 127.0.0.1",
      ],
    });
    try {
      const page = await browser.newPage();
      const password: RememberedPassword = {
        origin: `https://school.test:${port}`,
        username: "student",
        password: "test-password",
      };
      const capture = captureAuthorization(page, url, true);
      await page.waitForSelector("#password");
      assert.equal(
        await page.evaluate(
          () => typeof (window as unknown as { openenlinkPassword?: unknown }).openenlinkPassword,
        ),
        "undefined",
      );
      await fillPassword(page, password);
      const captured = await capture;
      assert.equal(captured.accessToken, "remembered-access");
      assert.equal(captured.rememberedPassword?.username, password.username);
      assert.equal(captured.rememberedPassword.password, password.password);
      assert.equal(captured.rememberedPassword.origin, password.origin);
      await page.close();

      const foreign = await browser.newPage();
      await foreign.goto(password.origin + "/login");
      await assert.rejects(
        fillPassword(foreign, { ...password, origin: "https://outside.example.test" }),
        AuthenticationError,
      );
      assert.deepEqual(
        await foreign.$$eval("#username, #password", (inputs) =>
          inputs.map((input) => (input as HTMLInputElement).value),
        ),
        ["", ""],
      );
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

await test(
  "Reauthorize an expired session with remembered credentials",
  { timeout: 25_000 },
  async (t) => {
    let submitted = 0;
    const server = createServer((request, response) => {
      if (request.url === "/submit") {
        submitted++;
        response.writeHead(302, {
          Location: "/complete?accessToken=" + Buffer.from("renewed-access").toString("base64"),
        });
        response.end();
      } else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          '<form method="post" action="/submit"><input id="username"><input id="password" type="password"><input id="login-submit" type="submit"></form>',
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const url = new URL(`http://127.0.0.1:${address.port}/login`);
    let remembered: RememberedPassword = {
      origin: url.origin,
      username: "student",
      password: "test-password",
    };
    const saved: Credentials[] = [];
    let refreshToken: string | undefined;
    t.mock.method(CredentialStore.prototype, "load", () =>
      Promise.resolve({
        accessToken: "expired",
        ...(refreshToken ? { refreshToken } : {}),
      }),
    );
    t.mock.method(CredentialStore.prototype, "loadPassword", () => Promise.resolve(remembered));
    t.mock.method(CredentialStore.prototype, "savePassword", (value: RememberedPassword) => {
      remembered = value;
      return Promise.resolve();
    });
    t.mock.method(CredentialStore.prototype, "save", (value: Credentials) => {
      saved.push(value);
      return Promise.resolve();
    });
    t.mock.method(Controller.prototype, "loginUrl", () => Promise.resolve(url));
    t.mock.method(Controller.prototype, "refresh", () =>
      Promise.reject(new AuthenticationError("Refresh expired")),
    );
    t.mock.method(Controller.prototype, "user", (token: string) => {
      if (token === "expired") return Promise.reject(new AuthenticationError("Expired"));
      return Promise.resolve("student");
    });
    t.mock.method(Controller.prototype, "rules", () => {
      return Promise.reject(new PolicyError("Mock authorization complete"));
    });
    try {
      await assert.rejects(
        serve({ server: "https://vpn.example.test" }, { port: 1088 }, new AbortController().signal),
        /Mock authorization complete/,
      );
      assert.deepEqual(saved, [{ accessToken: "renewed-access" }]);
      assert.equal(submitted, 1);
      await assert.rejects(
        serve({ server: "https://vpn.example.test" }, { port: 1088 }, new AbortController().signal),
        /retry after five minutes/,
      );
      assert.equal(submitted, 1);
      remembered = { ...remembered, lastAttemptAt: 0 };
      refreshToken = "rejected-refresh";
      await assert.rejects(
        serve({ server: "https://vpn.example.test" }, { port: 1088 }, new AbortController().signal),
        /Mock authorization complete/,
      );
      assert.equal(submitted, 2);
      assert.deepEqual(saved[1], { accessToken: "renewed-access" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
