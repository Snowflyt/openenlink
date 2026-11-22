# openenlink

English | [简体中文](README.zh-CN.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-dark.svg" />
  <img align="right" src="assets/mark-light.svg" width="64" alt="openenlink icon" />
</picture>

A command-line client for the Enlink VPN gateways used by EnUES and EnAgent, providing a local SOCKS5 and HTTP proxy for internal network access. It authenticates through the gateway's OIDC, with a username and password in the terminal when an adapter is available, or in a browser otherwise.

## Install

Download the file for your system. Each link fetches it from the [latest release](https://github.com/Snowflyt/openenlink/releases/latest).

| System               | File                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Windows x64          | [`openenlink-windows-x64.exe`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-windows-x64.exe)   |
| macOS, Apple silicon | [`openenlink-darwin-arm64`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-darwin-arm64)         |
| Linux x64            | [`openenlink-linux-x64-gnu`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-x64-gnu)       |
| Linux arm64          | [`openenlink-linux-arm64-gnu`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-arm64-gnu)   |
| Alpine Linux x64     | [`openenlink-linux-x64-musl`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-x64-musl)     |
| Alpine Linux arm64   | [`openenlink-linux-arm64-musl`](https://github.com/Snowflyt/openenlink/releases/latest/download/openenlink-linux-arm64-musl) |

Rename the file to `openenlink`, or `openenlink.exe` on Windows. On macOS and Linux, make it executable:

```sh
chmod +x openenlink
```

macOS blocks a file downloaded through a browser until its quarantine flag is cleared:

```sh
xattr -d com.apple.quarantine openenlink
```

Slim Linux container images omit required shared libraries. Install `libatomic1` on Debian and Ubuntu. On Alpine, install `libstdc++`, plus `libatomic` on x64.

Intel Macs [run from source](docs/building.md).

## Get started

In the directory that holds the file, or with `.\openenlink` in Windows Command Prompt:

```sh
./openenlink login https://vpn.example.edu
./openenlink serve
```

`login` saves the authorization for the gateway locally. `serve` runs in the foreground and listens on `127.0.0.1:1088` for SOCKS5 and HTTP proxy requests. While it runs, try the proxy from another terminal:

```sh
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

See [Usage](docs/usage.md) for all commands and options, including SSH via `openenlink nc`.

## Adapters

An adapter lets `login` prompt for the username and password in the terminal and submit them to the sign-in page directly.

| Adapter            | Gateway                    | Terminal sign-in                             | Guide                                          |
| ------------------ | -------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Soochow University | `https://wvpn.suda.edu.cn` | Username and password, captcha, `--remember` | [docs/adapters/suda.md](docs/adapters/suda.md) |

Each adapter in the table is tested on its gateway.

Other Enlink gateways that offer OIDC single sign-on work through a browser: `login` prints the sign-in URL, and you paste back the final redirect URL. Gateways that require SPA are unsupported.

## Documentation

- [Usage](docs/usage.md): commands, options, credential storage and exit statuses.
- [Soochow University](docs/adapters/suda.md): the gateway and its sign-in page.
- [Contributing](CONTRIBUTING.md): setup, checks, commit format and pull requests.
- [Writing an adapter](docs/adapters/README.md): an adapter for another sign-in page.
- [Protocol](docs/protocol.md): the Enlink controller API and tunnel frames.
- [Building](docs/building.md): running from source, the patched TCP/IP stack and the single executable.

## Acknowledgements

The protocol behavior of [mihomo-smart-enagent](https://github.com/airline233/mihomo-smart-enagent) informed this independent implementation. The TCP/IP stack inside the tunnel is [tcpip.js](https://github.com/chipmk/tcpip.js), which runs [lwIP](https://savannah.nongnu.org/projects/lwip/) compiled to WebAssembly.

## License

[AGPL-3.0-or-later](LICENSE)
