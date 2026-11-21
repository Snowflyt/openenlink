# Soochow University

English | [简体中文](suda.zh-CN.md)

The gateway is `https://wvpn.suda.edu.cn`. Its sign-in page is the university's unified identity platform (统一身份认证) at `https://auth.suda.edu.cn`.

## Get started

```sh
openenlink login https://wvpn.suda.edu.cn
openenlink serve
curl --proxy http://127.0.0.1:1088 "http://file.suda.edu.cn/defaultroot/SInformAction.do?action=init&type=1"
```

`login` prompts for your unified identity username and password. The `curl` command fetches the internal notices page (校内通知), which is only reachable from inside the university network.

[Usage](../usage.md) covers the rest of the commands.

## Terminal sign-in

| Step                  | In the terminal                                                            |
| --------------------- | -------------------------------------------------------------------------- |
| Username and password | Supported.                                                                 |
| Captcha               | Supported. `login` shows the image and allows up to three attempts.        |
| `--remember`          | Supported. Keeps the `CASTGC` and `LOGIN_TOKEN` cookies with the password. |
| Other sign-in methods | Run `openenlink login --browser` and finish in a browser.                  |

The gateway does not issue a refresh token. Without `--remember`, `serve` exits with status 3 when the authorization expires, and you need to run `openenlink login` again. With `--remember`, `serve` re-authenticates automatically.

## SSH

In `~/.ssh/config`:

```text
Host *.suda.edu.cn
  ProxyCommand openenlink nc %h %p
```

## Sign-in flow

This section is for maintaining the adapter in `src/adapters/suda.ts`.

The gateway's OIDC entry redirects to `auth.suda.edu.cn`: `/sso/oauth2/authorize`, then `/sso/login`, then the CAS page `/cas/login`. The adapter recognises that page by its path and the `login-type` element.

The page renders its form with a script. On submit, the script copies the hidden `.for-form` fields into `#login-form`, leaves out `pid`, and posts `_eventId`, `execution`, `lt`, `source`, `username` and `password` to `/cas/login`. The adapter posts the same fields. A page with other input fields stops the terminal sign-in before it prompts for a password.

A successful post sets `CASTGC` (path `/cas/`) and returns a ticket to `/sso/login`, which sets `LOGIN_TOKEN` (path `/sso`). The browser then goes back through `/sso/oauth2/authorize` to the gateway's `/oidc/callback?code=…`. Either cookie signs in again later without the password.

While the server keeps an `X_CAPTCHA` cookie, the form also carries `captcha` and `token`. `GET /sso/apis/v2/open/captcha?imageWidth=100` returns the image as a Base64 JPEG in `img`, with its `token`.

A rejected post returns the page with a code in `#errorcode` and a message in `#errormes`.

| Code contains                                                                | Meaning                    |
| ---------------------------------------------------------------------------- | -------------------------- |
| `INVALID_PASSWORD`, `ACCOUNT_NOT_FOUND`, `USER_NOT_FOUND`, `INVALID_ACCOUNT` | Wrong username or password |
| `INVALID_CAPTCHA`, `EXPIRED_CAPTCHA`                                         | Wrong or expired captcha   |

The university's [client guide](https://its.suda.edu.cn/ae/d0/c3658a700112/page.htm) describes the official client for the same gateway.
