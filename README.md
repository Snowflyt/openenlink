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

Slim Linux container images leave out libraries the executable loads. Install `libatomic1` on Debian and Ubuntu. On Alpine, install `libstdc++`, and `libatomic` as well on x64.

Other systems, Intel Macs included, [run from source](docs/building.md).

## Get started

```sh
openenlink login https://vpn.example.edu
openenlink serve
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

`login` takes the address of your gateway and saves the authorization on this machine. `serve` keeps running and listens on `127.0.0.1:1088` for SOCKS5 and HTTP proxy requests. The third command, in another terminal, fetches an internal page through the proxy.

[Usage](docs/usage.md) covers every command and option, including SSH through `openenlink nc`.

## Adapters

An adapter lets `login` ask for the username and password in the terminal and post them to the sign-in page itself.

| Adapter            | Gateway                    | Terminal sign-in                             | Guide                                          |
| ------------------ | -------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Soochow University | `https://wvpn.suda.edu.cn` | Username and password, captcha, `--remember` | [docs/adapters/suda.md](docs/adapters/suda.md) |

Other Enlink gateways that offer OIDC single sign-on work through a browser: `login` prints the address to open, and you paste the address the browser ends on. Gateways that require SPA are unsupported.

## Documentation

- [Usage](docs/usage.md): commands, options, credential storage and exit statuses.
- [Soochow University](docs/adapters/suda.md): the gateway and sign-in page of the one adapter so far.
- [Contributing](CONTRIBUTING.md): setup, checks, commit format and pull requests.
- [Writing an adapter](docs/adapters/README.md): terminal sign-in for another sign-in page.
- [Protocol](docs/protocol.md): the Enlink controller API and tunnel frames.
- [Building](docs/building.md): running from source, the patched TCP/IP stack and the single executable.

## Acknowledgements

The protocol behavior of [mihomo-smart-enagent](https://github.com/airline233/mihomo-smart-enagent) informed this independent implementation. The TCP/IP stack inside the tunnel is [tcpip.js](https://github.com/chipmk/tcpip.js), which runs [lwIP](https://savannah.nongnu.org/projects/lwip/) compiled to WebAssembly.

## License

[AGPL-3.0-or-later](LICENSE)
