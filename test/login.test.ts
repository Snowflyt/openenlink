import assert from "node:assert/strict";
import dns from "node:dns";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { mock, test } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { generate } from "selfsigned";

import { UnsupportedLogin } from "../src/adapter.ts";
import { serve } from "../src/client.ts";
import { AuthenticationError, Controller, PolicyError } from "../src/controller.ts";
import { CredentialStore } from "../src/credentials.ts";
import type { Credentials, RememberedPassword } from "../src/credentials.ts";
import { WrongPassword, login, pastedLogin } from "../src/login.ts";
import type { LoginOptions } from "../src/login.ts";

// One server plays the gateway at 127.0.0.1 and the CAS sign-in page at auth.suda.edu.cn, which
// resolves to the same address here. The two hosts keep separate cookies.
const cas = {
  password: "right-password",
  form: "normal" as "normal" | "changed",
  captcha: false,
  rejectCodes: false,
  sessions: new Set<string>(),
  tickets: new Set<string>(),
  codes: new Set<string>(),
  posts: [] as { body: URLSearchParams; referer: string | undefined }[],
  unexpected: 0,
};
let issued = 0;
const issue = (set: Set<string>) => {
  const value = `value-${String(++issued)}`;
  set.add(value);
  return value;
};
const base64 = (text: string) => Buffer.from(text).toString("base64");
const CAPTCHA = Buffer.from("captcha image");

const IDP = "auth.suda.edu.cn";
const { lookup } = dns;
mock.method(dns, "lookup", (hostname: string, ...rest: unknown[]) => {
  Reflect.apply(lookup, dns, [hostname === IDP ? "127.0.0.1" : hostname, ...rest]);
});

const certificate = await generate([{ name: "commonName", value: IDP }], {
  extensions: [
    {
      altNames: [
        { type: 2, value: IDP },
        { ip: "127.0.0.1", type: 7 },
      ],
      name: "subjectAltName",
    },
  ],
});
setDefaultCACertificates([...getCACertificates(), certificate.cert]);
const server = createServer(
  { key: certificate.private, cert: certificate.cert },
  (request, response) => {
    void handle(request, response);
  },
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("The test server has no port");
const gateway = `https://127.0.0.1:${String(address.port)}`;
const idp = `https://${IDP}:${String(address.port)}`;
const entry = new URL(`${gateway}/sso`);
const token = base64("access-token");

function page(code = "", message = "") {
  return `<form id="login-form"></form>
<input class="for-form" type="hidden" name="lt" value="LT-1">
<input class="for-form" type="hidden" name="pid" value="pid-1">
<input class="for-form" type="hidden" id="login-type" name="source" value="cas">
<input class="for-form" type="hidden" name="execution" value="e1s1">
<input type="hidden" name="_eventId" value="submit">
<input id="x_random" type="hidden" value="">
${cas.form === "changed" ? '<input type="hidden" name="device" value="1">' : ""}
<span id="errorcode" value="${code}"></span><span id="errormes" value="${message}"></span>`;
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `https://${request.headers.host ?? ""}`);
  const cookies = new Map(
    (request.headers.cookie ?? "")
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const redirect = (location: string, cookie?: string) => {
    response.writeHead(302, { Location: location, ...(cookie ? { "Set-Cookie": cookie } : {}) });
    response.end();
  };
  const html = (status: number, body: string) => {
    response.writeHead(status, {
      "Content-Type": "text/html",
      ...(cas.captcha ? { "Set-Cookie": "SSO_X_CAPTCHA=1; Path=/" } : {}),
    });
    response.end(body);
  };

  if (url.hostname === "127.0.0.1") {
    if (url.pathname === "/sso") return redirect(`${idp}/sso/oauth2/authorize?state=ENLINK_OIDC`);
    const code = url.searchParams.get("code");
    if (url.pathname === "/oidc/callback" && code && !cas.rejectCodes && cas.codes.delete(code))
      return redirect(
        `/enclient/#/login/wxLoginLoading?accessToken=${token}`,
        `access_token=${encodeURIComponent(token)}; Path=/`,
      );
    if (url.pathname === "/oidc/callback")
      return redirect(
        `/enclient/#/login/wxLoginLoading?state=${base64(JSON.stringify({ code: "400", message: "未查找到用户信息" }))}`,
      );
  } else if (url.pathname === "/sso/oauth2/authorize") {
    if (cas.sessions.has(cookies.get("LOGIN_TOKEN") ?? ""))
      return redirect(`${gateway}/oidc/callback?code=${issue(cas.codes)}&state=ENLINK_OIDC`);
    return redirect("/sso/login");
  } else if (url.pathname === "/sso/login") {
    const ticket = url.searchParams.get("ticket");
    if (ticket && cas.tickets.delete(ticket))
      return redirect(
        "/sso/oauth2/authorize",
        `LOGIN_TOKEN=${issue(cas.sessions)}; Path=/sso; HttpOnly`,
      );
    return redirect(`/cas/login?service=${encodeURIComponent(new URL("/sso/login", idp).href)}`);
  } else if (url.pathname === "/cas/login" && request.method === "GET") {
    if (cas.sessions.has(cookies.get("CASTGC") ?? ""))
      return redirect(`/sso/login?ticket=${issue(cas.tickets)}`);
    return html(200, page());
  } else if (url.pathname === "/cas/login" && request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body = new URLSearchParams(text);
    cas.posts.push({ body, referer: request.headers.referer });
    if (cas.captcha && (body.get("captcha") !== "right" || body.get("token") !== "captcha"))
      return html(401, page("INVALID_CAPTCHA", "验证码错误"));
    if (body.get("password") !== cas.password)
      return html(401, page("INVALID_PASSWORD", "用户名或密码错误"));
    response.writeHead(302, {
      Location: `/sso/login?ticket=${issue(cas.tickets)}`,
      "Set-Cookie": `CASTGC=${issue(cas.sessions)}; Path=/cas/; Secure; HttpOnly`,
    });
    return response.end();
  } else if (url.pathname === "/sso/apis/v2/open/captcha") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ img: CAPTCHA.toString("base64"), token: "captcha" }));
  }
  cas.unexpected++;
  response.writeHead(404);
  response.end();
}

function reset() {
  Object.assign(cas, {
    password: "right-password",
    form: "normal",
    captcha: false,
    rejectCodes: false,
    posts: [],
    unexpected: 0,
  });
  cas.sessions.clear();
}

const typed =
  (origins: string[]): LoginOptions["account"] =>
  (origin) => {
    origins.push(origin);
    return Promise.resolve({ username: "student", password: "right-password" });
  };

await test("Sign in on the CAS page from the terminal", async () => {
  reset();
  const origins: string[] = [];
  const result = await login(entry, { account: typed(origins) });
  assert.deepEqual(result.credentials, { accessToken: "access-token" });
  assert.deepEqual(origins, [idp]);
  assert.deepEqual(result.account, {
    origin: idp,
    username: "student",
    password: "right-password",
  });
  assert.deepEqual(result.cookies.map((cookie) => cookie.name).sort(), ["CASTGC", "LOGIN_TOKEN"]);
  assert.equal(cas.posts.length, 1);
  const [post] = cas.posts;
  assert.deepEqual(Object.fromEntries(post.body), {
    _eventId: "submit",
    execution: "e1s1",
    lt: "LT-1",
    source: "cas",
    username: "student",
    password: "right-password",
  });
  assert.match(post.referer ?? "", /\/cas\/login\?service=/);
  assert.equal(cas.unexpected, 0);

  const again = await login(entry, {
    cookies: result.cookies,
    account: () => Promise.reject(new Error("The password was asked for")),
  });
  assert.deepEqual(again.credentials, { accessToken: "access-token" });
  assert.equal(again.account, undefined);
  assert.deepEqual(again.cookies.map((cookie) => cookie.name).sort(), ["CASTGC", "LOGIN_TOKEN"]);
  assert.equal(cas.posts.length, 1);
});

await test("Refuse a changed sign-in page before asking for the password", async () => {
  reset();
  cas.form = "changed";
  const origins: string[] = [];
  await assert.rejects(login(entry, { account: typed(origins) }), UnsupportedLogin);
  assert.deepEqual(origins, []);
  assert.equal(cas.posts.length, 0);
});

await test("Report a wrong password and a gateway refusal", async () => {
  reset();
  cas.password = "changed-password";
  await assert.rejects(login(entry, { account: typed([]) }), WrongPassword);
  reset();
  cas.rejectCodes = true;
  await assert.rejects(
    login(entry, { account: typed([]) }),
    /The gateway refused the sign-in: 未查找到用户信息/,
  );
});

await test("Ask for the captcha again after a wrong answer", async () => {
  reset();
  cas.captcha = true;
  const images: Buffer[] = [];
  const answers = ["wrong", "right"];
  const result = await login(entry, {
    account: typed([]),
    captcha: (image) => {
      images.push(image);
      return Promise.resolve(answers.shift());
    },
  });
  assert.deepEqual(result.credentials, { accessToken: "access-token" });
  assert.deepEqual(images, [CAPTCHA, CAPTCHA]);
  assert.deepEqual(
    cas.posts.map(({ body }) => [body.get("captcha"), body.get("token")]),
    [
      ["wrong", "captcha"],
      ["right", "captcha"],
    ],
  );

  reset();
  cas.captcha = true;
  const origins: string[] = [];
  await assert.rejects(login(entry, { account: typed(origins) }), /asks for a captcha/);
  assert.deepEqual(origins, []);
  await assert.rejects(
    login(entry, { account: typed([]), captcha: () => Promise.resolve("") }),
    UnsupportedLogin,
  );
});

await test("Read what a browser sign-in left behind", async () => {
  reset();
  const expected = { accessToken: "access-token" };
  assert.deepEqual(await pastedLogin(` ${token}\n`, entry), expected);
  assert.deepEqual(await pastedLogin(`access_token=${encodeURIComponent(token)}`, entry), expected);
  assert.deepEqual(
    await pastedLogin(`${gateway}/enclient/#/login/wxLoginLoading?accessToken=${token}`, entry),
    expected,
  );
  // Base64 keeps its "+" after the hash.
  assert.deepEqual(
    await pastedLogin(
      `${gateway}/enclient/#/login/wxLoginLoading?accessToken=${base64("token>>>")}`,
      entry,
    ),
    { accessToken: "token>>>" },
  );
  const code = issue(cas.codes);
  assert.deepEqual(
    await pastedLogin(`${gateway}/oidc/callback?code=${code}&state=ENLINK_OIDC`, entry),
    expected,
  );
  await assert.rejects(
    pastedLogin(`${idp}/enclient/#/login/wxLoginLoading?accessToken=${token}`, entry),
    /not on 127\.0\.0\.1/,
  );
  await assert.rejects(pastedLogin(`${gateway}/enclient/`, entry), /no sign-in result/);
  await assert.rejects(pastedLogin("not a token", entry), /Invalid access token encoding/);
});

await test("Renew an expired session with the session cookies, then the password", async (t) => {
  reset();
  const { cookies } = await login(entry, { account: typed([]) });
  let remembered: RememberedPassword | undefined = {
    origin: idp,
    username: "student",
    password: "right-password",
    cookies,
  };
  const saved: Credentials[] = [];
  t.mock.method(CredentialStore.prototype, "load", () =>
    Promise.resolve({ accessToken: "expired" }),
  );
  t.mock.method(CredentialStore.prototype, "loadPassword", () => Promise.resolve(remembered));
  t.mock.method(CredentialStore.prototype, "savePassword", (value: RememberedPassword) => {
    remembered = value;
    return Promise.resolve();
  });
  t.mock.method(CredentialStore.prototype, "clearPassword", () => {
    remembered = undefined;
    return Promise.resolve();
  });
  t.mock.method(CredentialStore.prototype, "save", (value: Credentials) => {
    saved.push(value);
    return Promise.resolve();
  });
  t.mock.method(Controller.prototype, "loginUrl", () => Promise.resolve(entry));
  t.mock.method(Controller.prototype, "user", (accessToken: string) =>
    accessToken === "expired" ?
      Promise.reject(new AuthenticationError("Expired"))
    : Promise.resolve("student"),
  );
  t.mock.method(Controller.prototype, "rules", () =>
    Promise.reject(new PolicyError("Mock authorization complete")),
  );
  const run = () =>
    serve(
      { server: "https://vpn.example.test" },
      { host: "127.0.0.1", hosts: new Map(), port: 1088 },
      new AbortController().signal,
    );

  cas.posts = [];
  await assert.rejects(run(), /Mock authorization complete/);
  assert.deepEqual(saved, [{ accessToken: "access-token" }]);
  assert.equal(cas.posts.length, 0);

  cas.sessions.clear();
  await assert.rejects(run(), /Mock authorization complete/);
  assert.equal(cas.posts.length, 1);
  assert.equal(remembered.lastAttemptAt, undefined);
  assert.deepEqual(remembered.cookies?.map((cookie) => cookie.name).sort(), [
    "CASTGC",
    "LOGIN_TOKEN",
  ]);

  cas.sessions.clear();
  remembered = { ...remembered, lastAttemptAt: Date.now() };
  await assert.rejects(run(), /retry after five minutes/);
  assert.equal(cas.posts.length, 1);

  remembered = { ...remembered, lastAttemptAt: 0 };
  cas.password = "changed-password";
  await assert.rejects(run(), /the remembered password was removed/);
  assert.equal(cas.posts.length, 2);
  assert.equal(remembered, undefined);

  remembered = { origin: "https://elsewhere.test", username: "student", password: "x" };
  await assert.rejects(run(), /moved to another site/);
  assert.equal(cas.posts.length, 2);
});

server.closeAllConnections();
server.close();
