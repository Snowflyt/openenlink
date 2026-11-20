# 使用说明

[English](usage.md) | 简体中文

```text
openenlink login [https://vpn.example.edu] [--user name] [--remember] [--browser]
                 [--insecure-storage] [--user-agent text]
openenlink serve [--port 1088] [--proxy-user name]
openenlink nc host port [--port 1088]
openenlink status
openenlink logout
```

示例里的可执行文件名是 `openenlink`。[从源码运行](building.md)时，同样的参数跟在 `npm start --` 后面。

## 登录

```sh
openenlink login https://vpn.example.edu
```

地址是网关的 HTTPS 源。`login` 会保存该地址，之后再登录只需执行 `openenlink login`。

授权保存在本机，直到执行 `openenlink logout`。登录方式取决于网关后面的登录页。

### 在终端里登录

登录页有[适配器](../README.zh-CN.md#适配器)时，`login` 询问用户名和密码，通过 HTTPS 提交给该登录页。用户名提示会给出上次使用的用户名，按回车就用它；`--user name` 提前回答它。输入密码时屏幕上不显示任何字符。密码错误时 `login` 会再次询问，一共三次机会。

登录页要求验证码时，`login` 在终端里画出验证码图片，然后询问答案。终端不支持图片和真彩色时，图片保存为临时文件，并打印文件路径。

### 在浏览器里登录

```sh
openenlink login --browser
```

`login --browser` 打印网关的登录地址。不带该选项时，登录页没有适配器，或者第一次询问用户名时留空、验证码留空，`login` 也会这样做。

1. 在浏览器里打开打印出的地址并登录。
2. 复制浏览器最后停留的地址。
3. 粘贴到 `Paste (hidden):` 提示后面。

该提示也接受网关的 `access_token` cookie 的值，可以从浏览器的开发者工具里复制。

### 保持登录

```sh
openenlink login --remember
```

`--remember` 把用户名和密码与授权保存在一起，同时保存登录页的会话 cookie。`serve` 运行期间会话结束时，客户端先用 cookie 重新登录，cookie 过期后再用密码。

- 密码只提交给你输入密码时所在的 HTTPS 源。
- 密码最多每五分钟尝试一次。
- 密码错误会删除已保存的密码。
- 遇到验证码时自动登录停止，需要重新执行 `openenlink login --remember`。
- 之后不带 `--remember` 的 `login` 会删除已保存的密码。

`--remember` 需要终端登录。浏览器登录不留下可以保存的密码，所以 `--browser` 不能和 `--remember` 一起用。

### 其他登录选项

`--user-agent text` 替换 Node.js 默认的 `User-Agent`，用于会过滤客户端的网关。该值会保存下来供之后使用，`--user-agent ""` 恢复默认值。

openenlink 信任 Node.js 信任的证书颁发机构。网关或登录页使用私有证书颁发机构时，把环境变量 `NODE_EXTRA_CA_CERTS` 设为其证书文件的路径。

## 运行代理

```sh
openenlink serve
```

`serve` 连接网关，在 `127.0.0.1:1088` 上监听，直到按下 `Ctrl+C`。`--port` 指定其他端口。

该端口接收 SOCKS5 请求（CONNECT 和 UDP ASSOCIATE）和 HTTP 代理请求（包括 CONNECT）。目标地址为 IPv4。

```sh
curl --socks5-hostname 127.0.0.1:1088 https://intranet.example.edu/
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

内网主机名只能由隧道内的网关解析器解析。使用 `socks5h://` 或 `--socks5-hostname` 把主机名交给代理解析。

读取 `http_proxy` 和 `https_proxy` 的工具（如 git 和 pip）填 `http://127.0.0.1:1088`。

### 一个账号同时只连一个客户端

同一账号的第二个客户端连上后，第一个客户端的隧道会被断开。第一个随后重连，又把第二个断开。同一时间只在一台机器上运行 `serve`，运行期间关闭官方客户端。

### 重连

隧道断开后 `serve` 自动重连。等待时间从 1 秒开始，每次翻倍，最长 30 秒。

授权过期时，`serve` 用网关的 refresh token 或已保存的登录信息续期。两者都失败时，它以状态 3 退出，需要重新执行 `openenlink login`。

### 多人共用的机器

同一台机器上的其他账号也能连接本地端口。`--proxy-user` 让代理要求用户名和密码：

```sh
openenlink serve --proxy-user alice
```

`serve` 从终端读取代理密码，或者从标准输入读取一行。客户端随后使用 `socks5h://alice:password@127.0.0.1:1088` 或 `http://alice:password@127.0.0.1:1088` 连接。

## SSH 和其他 TCP 连接

`nc host port` 通过正在运行的代理，把标准输入和输出接到一台内网主机上。在 `~/.ssh/config` 里：

```text
Host *.example.edu
  ProxyCommand openenlink nc %h %p
```

可执行文件不在 `PATH` 里时填写完整路径。`serve` 使用其他端口时，`nc` 加上 `--port`。`nc` 不发送代理密码，所以对应的 `serve` 启动时不能带 `--proxy-user`。

## 查看和删除已保存的凭据

```sh
openenlink status
openenlink logout
```

`status` 报告是否保存了授权，以及保存的是哪个用户名的密码。它只读取本机保存的内容，不向网关发送任何请求。

`logout` 删除本机保存的授权和密码。

## 凭据保存在哪里

网关地址、上次的用户名、`--user-agent` 的值和存储方式保存在 `config.json` 里。macOS 和 Linux 上，该文件是 `$XDG_CONFIG_HOME/openenlink/config.json`；变量未设置时是 `~/.config/openenlink/config.json`。Windows 上是 `%APPDATA%\openenlink\config.json`。

授权和已保存的密码存入操作系统的凭据存储：macOS 的钥匙串、Windows 的凭据管理器，Linux 上则是通过 libsecret 访问的 Secret Service，例如 GNOME Keyring 或 KWallet。

没有凭据存储的主机（如 Docker 容器和没有桌面会话的服务器）使用 `--insecure-storage`：

```sh
openenlink login https://vpn.example.edu --insecure-storage
```

该选项把授权和已保存的密码以明文 JSON 写入 `config.json` 旁边的 `credentials.json`，文件权限为仅所有者可读写。每次 `login` 都重新选择存储方式：之后不带该选项的 `login` 会回到操作系统的凭据存储，并删除文件里的副本。

## 退出状态

| 状态 | 含义                              |
| ---- | --------------------------------- |
| 0    | 命令完成。                        |
| 1    | 命令失败，原因不属于下面两种。    |
| 2    | 参数有误，同时打印用法。          |
| 3    | 需要有人执行 `openenlink login`。 |

自动重启 `serve` 的脚本可以在状态 3 时停止。
