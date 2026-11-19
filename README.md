# openenlink

A TypeScript client for Enlink campus networks. It provides a local SOCKS5 and HTTP proxy using a TLS tunnel and [lwIP compiled to WebAssembly](https://github.com/chipmk/tcpip.js).

Tested with Soochow University's OIDC login, campus websites and SSH. Servers requiring SPA are reported as unsupported.

## Run

Each [release](https://github.com/Snowflyt/openenlink/releases) carries a single executable for macOS (arm64, x64), Linux (x64, arm64; `-gnu` for glibc distributions, `-musl` for Alpine) and Windows (x64), named after its platform. Rename it to `openenlink` (`openenlink.exe` on Windows), run `chmod +x openenlink` on macOS and Linux, then `openenlink login https://wvpn.suda.edu.cn` and `openenlink serve`. macOS rejects a file downloaded through a browser until `xattr -d com.apple.quarantine openenlink` clears the flag. The examples below run from source with `npm start --`; the executable takes the same arguments.

To run from source, install Node.js 24 or newer, Git and curl, then:

```sh
git clone --recursive https://github.com/Snowflyt/openenlink.git
cd openenlink
npm install
npm start -- login https://wvpn.suda.edu.cn
npm start -- serve
```

Login opens an isolated Chrome window on the school's SSO page. Enter school credentials there. The client keeps authorization in the OS credential store until `logout` and removes the temporary browser profile. Chrome or Chromium must be installed; `--browser` selects an executable. Close other clients using the same campus account before logging in.

Use `login --remember` to save a CAS username and password in the OS credential store. When a campus session ends, the client signs in again through the school page in a background browser. The saved password is filled only on its original HTTPS origin. A failed sign-in waits five minutes before another attempt; verification challenges can be completed with `login --remember`. `logout` removes both the authorization and remembered password.

The proxy listens on `127.0.0.1:1088` while `serve` runs; `serve --port` chooses another port. The port accepts SOCKS5 (CONNECT and UDP ASSOCIATE over IPv4) and HTTP proxy requests, including CONNECT. Destination DNS queries use the campus resolver inside the tunnel, so SOCKS clients should resolve names through the proxy. For example:

```sh
curl --socks5-hostname 127.0.0.1:1088 https://its.suda.edu.cn/
curl --proxy http://127.0.0.1:1088 https://its.suda.edu.cn/
```

Tools that read `http_proxy` and `https_proxy`, such as git and pip, can use `http://127.0.0.1:1088`.

`nc host port` joins standard input and output to a campus host through the running proxy, which suits SSH on any system, including Windows. It takes `--port` when `serve` uses another port and works with a proxy started without `--proxy-user`. In `~/.ssh/config`:

```
Host *.suda.edu.cn
  ProxyCommand /path/to/openenlink nc %h %p
```

From source, the command is `node /path/to/openenlink/src/cli.ts nc %h %p`.

On a shared machine, other accounts can reach the same local port. `serve --proxy-user name` reads a password from the terminal, or one line from standard input, and makes the proxy require it through SOCKS5 username/password or HTTP Basic proxy authentication. Clients then connect with `socks5h://name:password@127.0.0.1:1088` or `http://name:password@127.0.0.1:1088`.

Controller requests carry Node.js's default User-Agent. `login --user-agent text` replaces it for gateways that filter clients, and `--user-agent ""` restores the default.

The client leaves system routes and DNS settings unchanged. IPv6 requests receive an unsupported-address response.

```sh
npm start -- status
npm start -- logout
```

`logout` removes this client's saved authorization. Commands exit with status 2 on usage errors and 3 when someone needs to run `login`, so a script that restarts `serve` can stop at 3. `Ctrl+C` stops the proxy. After a dropped tunnel, the client retries with a delay of up to 30 seconds. It renews expired access tokens with a refresh token or remembered password. Run `login` when credentials expire or the school requests verification.

Settings are saved in `~/.config/openenlink/config.json`, or `%APPDATA%\openenlink\config.json` on Windows. Authorization stays in the OS credential store. Linux needs Secret Service or the kernel keyring; kernel-keyring credentials last until reboot.

## Development

```sh
npm test
npm run typecheck
npm run lint
```

Tests cover a local TLS gateway, certificate rejection, SOCKS TCP/UDP, HTTP CONNECT and request forwarding, `nc`, compressed and loopback DNS replies, connection half-close, TCP under packet loss and reordering, controller signing and SSO callback interception in Chromium. Browser tests require Chrome or Chromium. Each tunnel runs in a worker so disconnecting releases its WASM memory and timers.

`npm install` builds `tcpip` 0.4.0 from the `vendor/tcpip.js` submodule with `vendor/tcpip.js.patch` applied. The JavaScript fixes keep the write side open after a peer FIN and free packet buffers copied into WASM memory. The WASM, compiled from `vendor/lwip` (lwIP 2.2.0), delivers every pbuf of out-of-order data, sends chained outgoing packets whole and copies incoming packets before lwIP queues them. A connection that the peer resets or lwIP aborts rejects its pending connect and errors its streams. Without these, one lost packet could stall or corrupt a connection. It also uses a 182 KiB window with window scaling instead of 5.6 KiB, and a 1 s initial retransmission timeout instead of 3 s. The first install downloads wasi-sdk 24 into `.cache` to compile it. After changing the submodule, `git -C vendor/tcpip.js diff > vendor/tcpip.js.patch` saves the patch and `npm install` rebuilds. That dependency is pinned until the fixes are available upstream.

`npm run build` writes a single executable for the current platform to `dist/openenlink`, or `dist/openenlink.exe` on Windows. It needs Node.js 25.5 or newer from [nodejs.org](https://nodejs.org/); Homebrew's Node.js leaves single executable support out. Rolldown bundles the client and its tunnel worker, and the executable carries them with `tcpip.wasm` and the credential-store addon, which it copies to the temporary directory on first run. Pushing a `v*` tag builds every platform in GitHub Actions and attaches them to a release.

Protocol details are in [docs/protocol.md](docs/protocol.md).
