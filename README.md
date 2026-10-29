# openenlink

A TypeScript client for Enlink campus networks. It provides a local SOCKS5 proxy using a TLS tunnel and [lwIP compiled to WebAssembly](https://github.com/chipmk/tcpip.js).

Tested with Soochow University's OIDC login, campus websites and SSH. Servers requiring SPA are reported as unsupported.

## Run

Install Node.js 22.19.0 or newer, then:

```sh
npm install
npm start -- login --server https://wvpn.suda.edu.cn
npm start -- serve
```

Login opens an isolated Chrome window on the school's SSO page. Enter school credentials there. The client keeps authorization in the OS credential store for up to 24 hours and removes the temporary browser profile. Chrome or Chromium must be installed; `--browser` selects an executable. Close other clients using the same campus account before logging in.

The proxy listens on `127.0.0.1:1088`. Use `--port` during login to choose another port. It supports SOCKS5 CONNECT and UDP ASSOCIATE over IPv4. Destination DNS queries use the campus resolver inside the tunnel. Configure applications to resolve names through SOCKS, for example:

```sh
curl --socks5-hostname 127.0.0.1:1088 https://its.suda.edu.cn/
```

The client leaves system routes and DNS settings unchanged. IPv6 requests receive an unsupported-address response.

```sh
npm start -- status
npm start -- logout
```

`logout` removes this client's saved authorization. `Ctrl+C` stops the proxy. After a dropped tunnel, the client retries with a delay of up to 30 seconds. It renews expired access tokens when login supplied a refresh token; otherwise run `login` again. The school may expire authorization before the local 24-hour limit.

Settings are saved in `~/.config/openenlink/config.json`, or `%APPDATA%\openenlink\config.json` on Windows. Authorization stays in the OS credential store. Linux needs Secret Service or the kernel keyring; kernel-keyring credentials last until reboot.

## Development

```sh
npm test
npm run typecheck
npm run lint
```

Tests cover a local TLS gateway, certificate rejection, SOCKS TCP/UDP, compressed and loopback DNS replies, connection half-close, controller signing and SSO callback interception in Chromium. Browser tests require Chrome or Chromium. Each tunnel runs in a worker so disconnecting releases its WASM memory and timers.

The install step corrects a TCP half-close bug in `tcpip` 0.4.0: a peer FIN must leave the write side available. That dependency is pinned until the fix is available upstream.

Protocol details are in [docs/protocol.md](docs/protocol.md).
