# openenlink

[English](README.md) | 简体中文

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-dark.svg" />
  <img align="right" src="assets/mark-light.svg" width="64" alt="openenlink 图标" />
</picture>

易安联（Enlink）VPN 的命令行客户端，连接 EnUES 和 EnAgent 所用网关，在本地提供 SOCKS5 和 HTTP 代理以访问内网。认证基于网关的 OIDC，存在对应适配器时在终端输入账号密码，否则在浏览器中登录。

## 安装

下载对应系统的文件。每个链接取自[最新发布](https://github.com/Snowflyt/openenlink/releases/latest)。

| 系统               | 文件                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Windows x64        | [`openenlink-windows-x64.exe`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-windows-x64.exe)   |
| macOS，Apple 芯片  | [`openenlink-darwin-arm64`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-darwin-arm64)         |
| Linux x64          | [`openenlink-linux-x64-gnu`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-x64-gnu)       |
| Linux arm64        | [`openenlink-linux-arm64-gnu`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-arm64-gnu)   |
| Alpine Linux x64   | [`openenlink-linux-x64-musl`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-x64-musl)     |
| Alpine Linux arm64 | [`openenlink-linux-arm64-musl`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-arm64-musl) |

把文件改名为 `openenlink`，Windows 上是 `openenlink.exe`。macOS 和 Linux 上加上执行权限：

```sh
chmod +x openenlink
```

macOS 会拦截浏览器下载的文件，清掉隔离标记后才能运行：

```sh
xattr -d com.apple.quarantine openenlink
```

精简的 Linux 容器镜像缺少可执行文件要加载的库。Debian 和 Ubuntu 安装 `libatomic1`。Alpine 安装 `libstdc++`，x64 再加 `libatomic`。

其他系统（包括 Intel Mac）[从源码运行](docs/building.md)。

## 开始使用

```sh
openenlink login https://vpn.example.edu
openenlink serve
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

`login` 接收网关地址，把授权保存在本机。`serve` 一直运行，在 `127.0.0.1:1088` 上接收 SOCKS5 和 HTTP 代理请求。第三条命令在另一个终端里执行，通过代理读取一个内网页面。

[使用说明](docs/usage.zh-CN.md)列出全部命令和选项，包括用 `openenlink nc` 走 SSH。

## 适配器

有适配器的登录页，`login` 直接在终端里询问用户名和密码，并由它提交给登录页。

| 适配器   | 网关                       | 终端登录                           | 说明                                                       |
| -------- | -------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| 苏州大学 | `https://wvpn.suda.edu.cn` | 用户名和密码、验证码、`--remember` | [docs/adapters/suda.zh-CN.md](docs/adapters/suda.zh-CN.md) |

其他提供 OIDC 单点登录的 Enlink 网关通过浏览器登录：`login` 打印要打开的地址，登录完成后把浏览器最后停留的地址粘贴回来。要求 SPA 的网关暂不支持。

## 文档

- [使用说明](docs/usage.zh-CN.md)：命令、选项、凭据存储和退出状态。
- [苏州大学](docs/adapters/suda.zh-CN.md)：目前唯一的适配器，包括网关和登录页。
- [Contributing](CONTRIBUTING.md)：环境、检查命令、提交格式和 Pull Request。
- [Writing an adapter](docs/adapters/README.md)：给另一个登录页写终端登录。
- [Protocol](docs/protocol.md)：Enlink 控制器 API 和隧道帧格式。
- [Building](docs/building.md)：从源码运行、打过补丁的 TCP/IP 协议栈和单文件可执行程序。

## 致谢

本项目是独立实现，协议行为参考了 [mihomo-smart-enagent](https://github.com/airline233/mihomo-smart-enagent)。隧道内的 TCP/IP 协议栈是 [tcpip.js](https://github.com/chipmk/tcpip.js)，它运行编译成 WebAssembly 的 [lwIP](https://savannah.nongnu.org/projects/lwip/)。

## 许可证

[AGPL-3.0-or-later](LICENSE)
