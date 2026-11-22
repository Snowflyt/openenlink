# 使用说明

[English](usage.md) | 简体中文

```text
openenlink login [https://vpn.example.edu] [--user name] [--remember] [--browser]
                 [--insecure-storage] [--user-agent text]
openenlink serve [--bind 127.0.0.1] [--port 1088] [--proxy-user name]
                 [--add-host name=address]...
                 [--forward port:host:hostport[/udp]]...
                 [--log-level error|warn|info|debug]
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

登录页有[适配器](../README.zh-CN.md#适配器)时，`login` 提示输入用户名和密码，通过 HTTPS 提交给该登录页。用户名默认为上次使用的账号，`--user name` 跳过该提示。密码输入不回显，密码错误时最多尝试三次。

登录页要求验证码时，`login` 在终端中渲染验证码并提示输入。终端不支持图片显示或 256 色时，`login` 将图片写入临时文件并输出路径。

### 在浏览器里登录

```sh
openenlink login --browser
```

`login --browser` 输出网关的登录链接。未指定该选项时，如果登录页没有对应适配器，或在首次提示用户名、验证码时直接留空，`login` 也会切换为浏览器登录。

1. 在浏览器里打开输出的链接并登录。
2. 在 `Paste (hidden):` 提示后面粘贴浏览器最终停留的地址，或者从浏览器开发者工具里复制的网关 `access_token` cookie 的值。

有的网关登录后会马上跳到另一个页面，那个页面的地址不再包含登录信息，这时改为粘贴 cookie。

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

`--remember` 仅适用于终端登录。浏览器登录不经过本机密码输入，因此不能与 `--browser` 同时使用。

### 其他登录选项

`--user-agent text` 替换 Node.js 默认的 `User-Agent`，用于会过滤客户端的网关。该值会保存下来供之后使用，`--user-agent ""` 恢复默认值。

openenlink 信任 Node.js 信任的证书颁发机构。网关或登录页使用私有证书颁发机构时，把环境变量 `NODE_EXTRA_CA_CERTS` 设为其证书文件的路径。

## 运行代理

```sh
openenlink serve
```

`serve` 连接网关，在 `127.0.0.1:1088` 上监听，直到按下 `Ctrl+C`。`--port` 指定其他端口。`--bind` 指定监听地址，例如 `0.0.0.0`，供其他机器或 Docker 容器外的客户端连接。未设置 `--proxy-user` 时，能访问该地址的客户端都能使用隧道，`serve` 会输出警告。

该端口接收 SOCKS5 请求（CONNECT 和 UDP ASSOCIATE）和 HTTP 代理请求（包括 CONNECT）。目标地址为 IPv4。

```sh
curl --socks5-hostname 127.0.0.1:1088 https://intranet.example.edu/
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

内网主机名只能由隧道内的网关解析器解析。使用 `socks5h://` 或 `--socks5-hostname` 把主机名交给代理解析。

`--add-host name=address` 为主机名指定固定的 IPv4 地址，用于网关解析器无法解析的内网主机。多个主机名重复使用该选项。

读取 `http_proxy` 和 `https_proxy` 的工具（如 git 和 pip）填 `http://127.0.0.1:1088`。

### 一个账号同时只连一个客户端

同一账号的第二个客户端连上后，第一个客户端的隧道会被断开。第一个随后重连，又把第二个断开。同一时间只在一台机器上运行 `serve`，运行期间关闭官方客户端。

### 重连

隧道断开后 `serve` 自动重连。等待时间从 1 秒开始，每次翻倍，最长 30 秒。

授权过期时，`serve` 用网关的 refresh token 或已保存的登录信息续期。两者都失败时，以状态 3 退出，需要重新执行 `openenlink login`。

在别处登录可能超过账号同时登录的上限，挤掉这里的授权。刚启动的 `serve` 会续期，把账号拿回来。已经连上过的 `serve` 则以状态 3 退出，把账号留给新的登录。

### 日志

`serve` 输出的每一行以本地时间和级别开头。`debug` 和 `info` 写到标准输出，`warn` 和 `error` 写到标准错误。经过隧道的每条连接在打开时记一行，关闭或失败时再记一行：

```text
[2026-11-21 09:43:02.123] [info] Proxy listening on 127.0.0.1:1088
[2026-11-21 09:43:10.481] [info] [TCP] 127.0.0.1:52344 --> library.example.edu:443
[2026-11-21 09:54:41.902] [info] [TCP] 127.0.0.1:52344 --> library.example.edu:443 closed after 11m31s, sent 48.2 kB, received 1.3 MB
[2026-11-21 09:55:03.017] [error] [TCP] 127.0.0.1:52360 --> 10.20.0.5:8079 failed: tcp connection reset
```

时长后面的 `(client reset)` 表示客户端重置了连接，`(tunnel closed)` 表示连接还开着时隧道断了。代理密码错误记为警告。

`--log-level` 设定 `serve` 输出的最低级别：`error`、`warn`、`info`（默认）或 `debug`。`debug` 还会记录网关分配的地址、内网 DNS 的每个应答和会话续期。

日志不记录传输的数据、密码、token 和 HTTP 请求的路径，但会记下访问的内网主机和发起连接的本地客户端。`--log-level warn` 只保留警告和错误。

在 systemd 下，journal 会记录每一行的时间，`serve` 不再打印自己的时间。其他情况下可以这样把日志写进文件：

```sh
openenlink serve >> serve.log 2>&1
```

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

## 端口转发

`--forward port:host:hostport` 让 `serve` 另外监听一个端口，把该端口上的每个连接接到隧道内的 `host:hostport`。没有代理设置的程序（如数据库客户端和远程桌面）连接这个本地端口即可。转发 UDP 时加上 `/udp`。多个端口重复使用该选项。

```sh
openenlink serve --forward 15432:db.example.edu:5432 --forward 10053:10.0.0.53:53/udp
```

转发端口监听在 `--bind` 指定的地址上，不要求代理密码，能访问该地址的客户端都能使用。

## 查看和删除已保存的凭据

```sh
openenlink status
openenlink logout
```

`status` 报告是否保存了授权，以及保存的是哪个用户名的密码。它只读取本机保存的内容，不向网关发送任何请求。

`logout` 从本机删除已保存网关的授权和密码。请先停止 `serve`：运行中的 `serve` 会保持隧道，续期时还可能重新保存授权。

## 凭据保存在哪里

网关地址、上次的用户名、`--user-agent` 的值和存储方式保存在 `config.json` 里。macOS 和 Linux 上，该文件是 `$XDG_CONFIG_HOME/openenlink/config.json`，变量未设置时是 `~/.config/openenlink/config.json`。Windows 上是 `%APPDATA%\openenlink\config.json`。

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
| 3    | 需要重新执行 `openenlink login`。 |
| 130  | 被 Ctrl+C 中断。                  |

在 Linux 和 macOS 上，Ctrl+C 会让命令直接被该信号结束。shell 报告状态 130，在 shell 提示符下输入的循环也会一起停下。`serve` 收到 SIGTERM 时以 0 退出。

自动重启 `serve` 的脚本可以在状态 3 时停止。在 systemd 下，`RestartPreventExitStatus=3` 让 `Restart=on-failure` 在状态 3 时不再重启。
