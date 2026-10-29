import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { launch } from "puppeteer-core";

import { browserPath, captureAuthorization } from "../src/login.ts";

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
        const startedAt = Date.now();
        const credentials = await captureAuthorization(
          page,
          new URL(`http://127.0.0.1:${address.port}${path}`),
        );
        assert.equal(credentials.accessToken, "test-access-token");
        assert.equal(credentials.refreshToken, path === "/query" ? "test-refresh" : undefined);
        const retention = 7 * 24 * 60 * 60 * 1000;
        assert.ok(credentials.expiresAt >= startedAt + retention);
        assert.ok(credentials.expiresAt <= Date.now() + retention);
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
