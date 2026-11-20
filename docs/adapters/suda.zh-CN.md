# 苏州大学

[English](suda.md) | 简体中文

网关是 `https://wvpn.suda.edu.cn`。登录页是学校的统一身份认证平台 `https://auth.suda.edu.cn`。

## 开始使用

```sh
openenlink login https://wvpn.suda.edu.cn
openenlink serve
curl --proxy http://127.0.0.1:1088 "http://file.suda.edu.cn/defaultroot/SInformAction.do?action=init&type=1"
```

`login` 询问统一身份认证账号的用户名和密码。第三条命令在另一个终端里执行，读取校内通知页面，该页面只在校内网络里有响应。

其余命令见[使用说明](../usage.zh-CN.md)。

## 终端登录

| 步骤         | 在终端里                                                     |
| ------------ | ------------------------------------------------------------ |
| 用户名和密码 | 支持。                                                       |
| 验证码       | 支持。`login` 显示图片，最多接受三次回答。                   |
| `--remember` | 支持。`CASTGC` 和 `LOGIN_TOKEN` 两个 cookie 与密码一起保存。 |
| 其他登录方式 | 执行 `openenlink login --browser`，在浏览器里完成。          |

该网关不发放 refresh token。不带 `--remember` 时，授权过期后 `serve` 以状态 3 退出，需要重新执行 `openenlink login`。带 `--remember` 时，`serve` 自己重新登录。

## SSH

在 `~/.ssh/config` 里：

```text
Host *.suda.edu.cn
  ProxyCommand openenlink nc %h %p
```

## 登录流程

本节供维护 `src/adapters/suda.ts` 里的适配器时参考。

网关的 OIDC 入口重定向到 `auth.suda.edu.cn`：先到 `/sso/oauth2/authorize`，再到 `/sso/login`，最后到 CAS 页面 `/cas/login`。适配器根据路径和 `login-type` 元素识别该页面。

该页面用脚本渲染表单。提交时，脚本把隐藏的 `.for-form` 字段复制进 `#login-form`，去掉 `pid`，然后把 `_eventId`、`execution`、`lt`、`source`、`username` 和 `password` 提交到 `/cas/login`。适配器提交同样的字段。页面上出现其他输入字段时，终端登录在询问密码之前停止。

提交成功后服务器设置 `CASTGC`（路径 `/cas/`），并带着 ticket 回到 `/sso/login`，后者设置 `LOGIN_TOKEN`（路径 `/sso`）。浏览器随后经过 `/sso/oauth2/authorize` 回到网关的 `/oidc/callback?code=…`。之后凭其中任意一个 cookie 都能免密码再次登录。

服务器保留 `X_CAPTCHA` cookie 期间，表单还要带上 `captcha` 和 `token`。`GET /sso/apis/v2/open/captcha?imageWidth=100` 返回验证码：`img` 是 Base64 编码的 JPEG，`token` 是对应的令牌。

提交被拒绝时，服务器返回同一页面，错误码在 `#errorcode` 里，错误信息在 `#errormes` 里。

| 错误码包含                                                                   | 含义             |
| ---------------------------------------------------------------------------- | ---------------- |
| `INVALID_PASSWORD`、`ACCOUNT_NOT_FOUND`、`USER_NOT_FOUND`、`INVALID_ACCOUNT` | 用户名或密码错误 |
| `INVALID_CAPTCHA`、`EXPIRED_CAPTCHA`                                         | 验证码错误或过期 |

学校的[客户端使用指南](https://its.suda.edu.cn/ae/d0/c3658a700112/page.htm)介绍了同一网关的官方客户端。
