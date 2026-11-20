// Soochow University's unified identity platform (统一身份认证, auth.suda.edu.cn). Its CAS login
// page renders the form with Vue; on submit the script copies the hidden ".for-form" fields into
// #login-form, drops pid and posts to /cas/login. A captcha appears while the server keeps an
// X_CAPTCHA cookie; its image and token come from /sso/apis/v2/open/captcha.

import { UnsupportedLogin } from "../adapter.ts";
import type { Adapter } from "../adapter.ts";
import { object, text } from "../controller.ts";
import { printable, tags } from "../web.ts";

const FIELDS = ["_eventId", "execution", "lt", "pid", "source"];

const PASSWORD = ["INVALID_PASSWORD", "ACCOUNT_NOT_FOUND", "USER_NOT_FOUND", "INVALID_ACCOUNT"];
const CAPTCHA = ["INVALID_CAPTCHA", "EXPIRED_CAPTCHA"];

export const suda: Adapter = {
  session: ["CASTGC", "LOGIN_TOKEN"],

  form(page, web) {
    if (page.url.pathname !== "/cas/login" || !page.html.includes('id="login-type"')) return;
    const inputs = tags(page.html, "input").flatMap(({ name, type, value = "" }) =>
      name === undefined ? [] : [{ name, type, value }],
    );
    const fields = new Map(inputs.map(({ name, value }) => [name, value]));
    if (
      inputs.length !== FIELDS.length ||
      FIELDS.some((name) => !fields.has(name)) ||
      inputs.some(({ type }) => type !== "hidden") ||
      !fields.get("source")?.toLowerCase().includes("cas")
    )
      throw new UnsupportedLogin(`The sign-in page at ${page.url.host} changed`);
    const hidden = Object.fromEntries(
      inputs.filter(({ name }) => name !== "pid").map(({ name, value }) => [name, value]),
    );
    let token = "";
    return {
      action: new URL("/cas/login", page.url),
      body: (account, captcha) =>
        new URLSearchParams({
          ...hidden,
          username: account.username,
          password: account.password,
          ...(captcha === undefined ? {} : { captcha, token }),
        }),
      ...(web.cookies(page.url.hostname).some((cookie) => cookie.name.includes("X_CAPTCHA")) ?
        {
          captcha: async () => {
            const captcha = object(
              await web.json(new URL("/sso/apis/v2/open/captcha?imageWidth=100", page.url)),
            );
            token = text(captcha.token, "captcha token");
            return Buffer.from(text(captcha.img, "captcha image"), "base64");
          },
        }
      : {}),
    };
  },

  failure(page) {
    const spans = tags(page.html, "span");
    const code = spans.find((span) => span.id === "errorcode")?.value ?? "";
    const message = printable(spans.find((span) => span.id === "errormes")?.value ?? "");
    const known = /^[A-Z_]{1,64}$/.test(code) ? code : "";
    if (PASSWORD.some((name) => known.includes(name)))
      return { reason: "password", message: "Wrong username or password" };
    if (CAPTCHA.some((name) => known.includes(name)))
      return { reason: "captcha", message: "Wrong or expired captcha" };
    let description = "Sign-in failed";
    if (known) description += ` (${known})`;
    if (message) description += `: ${message}`;
    return { reason: "other", message: description };
  },
};
