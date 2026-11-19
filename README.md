# openenlink

A TypeScript client for Enlink campus networks. It provides a local SOCKS5 proxy using a TLS tunnel and [lwIP compiled to WebAssembly](https://github.com/chipmk/tcpip.js).

Tested with Soochow University's OIDC login, campus websites and SSH. Servers requiring SPA are reported as unsupported.

## Run

Install Node.js 22.19.0 or newer, then:

```sh
npm install
npm start -- login https://wvpn.suda.edu.cn
npm start -- serve
```

Login opens an isolated Chrome window on the school's SSO page. Enter school credentials there. The client keeps authorization in the OS credential store until `logout` and removes the temporary browser profile. Chrome or Chromium must be installed; `--browser` selects an executable. Close other clients using the same campus account before logging in.

Use `login --remember` to save a CAS username and password in the OS credential store. When a campus session ends, the client signs in again through the school page in a background browser. The saved password is filled only on its original HTTPS origin. A failed sign-in waits five minutes before another attempt; verification challenges can be completed with `login --remember`. `logout` removes both the authorization and remembered password.

The proxy listens on `127.0.0.1:1088` while `serve` runs; `serve --port` chooses another port. It supports SOCKS5 CONNECT and UDP ASSOCIATE over IPv4. Destination DNS queries use the campus resolver inside the tunnel. Configure applications to resolve names through SOCKS, for example:

```sh
curl --socks5-hostname 127.0.0.1:1088 https://its.suda.edu.cn/
```

On a shared machine, other accounts can reach the same local port. `serve --socks-user name` reads a password from the terminal, or one line from standard input, and makes the proxy require SOCKS5 username/password authentication. Clients then connect with `socks5h://name:password@127.0.0.1:1088`.

Controller requests carry Node.js's default User-Agent. `login --user-agent text` replaces it for gateways that filter clients, and `--user-agent ""` restores the default.

The client leaves system routes and DNS settings unchanged. IPv6 requests receive an unsupported-address response.

```sh
npm start -- status
npm start -- logout
```

`logout` removes this client's saved authorization. `Ctrl+C` stops the proxy. After a dropped tunnel, the client retries with a delay of up to 30 seconds. It renews expired access tokens with a refresh token or remembered password. Run `login` when credentials expire or the school requests verification.

Settings are saved in `~/.config/openenlink/config.json`, or `%APPDATA%\openenlink\config.json` on Windows. Authorization stays in the OS credential store. Linux needs Secret Service or the kernel keyring; kernel-keyring credentials last until reboot.

## Development

```sh
npm test
npm run typecheck
npm run lint
```

Tests cover a local TLS gateway, certificate rejection, SOCKS TCP/UDP, compressed and loopback DNS replies, connection half-close, TCP under packet loss and reordering, controller signing and SSO callback interception in Chromium. Browser tests require Chrome or Chromium. Each tunnel runs in a worker so disconnecting releases its WASM memory and timers.

The install step patches `tcpip` 0.4.0 from `patches/tcpip`. The JavaScript fixes keep the write side open after a peer FIN and free packet buffers copied into WASM memory. The rebuilt WASM delivers every pbuf of out-of-order data, sends chained outgoing packets whole and copies incoming packets before lwIP queues them. Without these, one lost packet could stall or corrupt a connection. It also uses a 182 KiB window with window scaling instead of 5.6 KiB, and a 1 s initial retransmission timeout instead of 3 s. `patches/tcpip/build.sh` rebuilds `tcpip.wasm` from `lwip-glue.patch` with wasi-sdk 24. That dependency is pinned until the fixes are available upstream.

Protocol details are in [docs/protocol.md](docs/protocol.md).
