# openenlink

A TypeScript client for Enlink campus networks. It provides a local SOCKS5 and HTTP proxy using a TLS tunnel and [lwIP compiled to WebAssembly](https://github.com/chipmk/tcpip.js).

Tested with Soochow University's OIDC login, campus websites and SSH. Servers requiring SPA are reported as unsupported.

## Run

Each [release](https://github.com/Snowflyt/openenlink/releases) carries a single executable for macOS (arm64), Linux (x64, arm64; `-gnu` for glibc distributions, `-musl` for Alpine) and Windows (x64), named after its platform. Rename it to `openenlink` (`openenlink.exe` on Windows), run `chmod +x openenlink` on macOS and Linux, then `openenlink login https://wvpn.suda.edu.cn` and `openenlink serve`. macOS rejects a file downloaded through a browser until `xattr -d com.apple.quarantine openenlink` clears the flag. The Linux executables load the GCC runtime libraries, which slim container images leave out: install `libatomic1` on Debian and Ubuntu, or `libstdc++` on Alpine, plus `libatomic` for x64. The examples below run from source with `npm start --`; the executable takes the same arguments.

To run from source, install Node.js 26.9 or newer, Git and curl, then:

```sh
git clone --recursive https://github.com/Snowflyt/openenlink.git
cd openenlink
npm install
npm start -- login https://wvpn.suda.edu.cn
npm start -- serve
```

Login signs in on the school's SSO page from the terminal. It asks for the school username, offering the last one as the default (`--user name` skips the question), and the password. When the school asks for a captcha, it shows the image with iTerm2 inline images (iTerm2, WezTerm, Konsole), the kitty graphics protocol, sixel or colored half blocks; other terminals get a private temporary file whose path is printed. The client keeps authorization in the OS credential store until `logout`. Close other clients using the same campus account before logging in.

Terminal sign-in knows Soochow University's CAS page. On any other school page, or after an empty username or captcha answer, login prints the gateway's sign-in address to open in a browser. When the browser finishes, paste the address it ends on, or the value of the gateway's `access_token` cookie from the developer tools.

Use `login --remember` to save a CAS username and password in the OS credential store, along with the school's session cookies. When a campus session ends, the client signs in again with those cookies, and with the password once they expire. The password is posted only to the HTTPS origin where it was typed. A failed sign-in waits five minutes before another attempt, a wrong password removes the remembered one, and a captcha needs `login --remember` again. `logout` removes both the authorization and remembered password.

School sign-in trusts the certificates Node.js trusts. For a school behind a private certificate authority, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

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

Settings are saved in `$XDG_CONFIG_HOME/openenlink/config.json` (`~/.config/openenlink/config.json` when it is unset), or `%APPDATA%\openenlink\config.json` on Windows. Authorization stays in the OS credential store. Linux needs libsecret and a Secret Service such as GNOME Keyring or KWallet.

Hosts without a credential store, such as Docker containers and servers without a desktop session, can use `login --insecure-storage`. It keeps the authorization and any remembered password as plain JSON in `credentials.json` next to `config.json`, readable only by its owner. Each `login` chooses again: a later `login` without the flag returns to the OS credential store and removes the copy in the file.

## Development

```sh
npm test
npm run typecheck
npm run lint
```

Tests cover a local TLS gateway, certificate rejection, SOCKS TCP/UDP, HTTP CONNECT and request forwarding, `nc`, compressed and loopback DNS replies, connection half-close, TCP under packet loss and reordering, controller signing, terminal sign-in against a local school page (session cookies, captcha retries, a changed page, wrong passwords, gateway errors, pasted results, renewal in `serve`), JPEG decoding against libjpeg and terminal image output. Each tunnel runs in a worker so disconnecting releases its WASM memory and timers.

`npm install` builds `tcpip` 0.4.0 from the `vendor/tcpip.js` submodule with `vendor/tcpip.js.patch` applied. The JavaScript fixes keep the write side open after a peer FIN and free packet buffers copied into WASM memory. The WASM, compiled from `vendor/lwip` (lwIP 2.2.0), delivers every pbuf of out-of-order data, sends chained outgoing packets whole and copies incoming packets before lwIP queues them. A connection that the peer resets or lwIP aborts rejects its pending connect and errors its streams. Without these, one lost packet could stall or corrupt a connection. It also uses a 182 KiB window with window scaling instead of 5.6 KiB, and a 1 s initial retransmission timeout instead of 3 s. The first install downloads wasi-sdk 24 into `.cache` to compile it. After changing the submodule, `git -C vendor/tcpip.js diff > vendor/tcpip.js.patch` saves the patch and `npm install` rebuilds. That dependency is pinned until the fixes are available upstream.

`npm run build` writes a single executable for the current platform to `dist/openenlink`, or `dist/openenlink.exe` on Windows. The build strips the types from `src` with ts-blank-space, leaving the JavaScript line for line as written, and the executable carries that with the runtime dependencies and `tcpip.wasm` in its virtual file system, and they run from there without unpacking. The virtual file system needs Node.js 27.0.0-alpha.0.1.1 or newer from [nodejs.org](https://nodejs.org/), so with an older Node.js the build downloads that release into `dist` first. Node.js 27 no longer ships for Intel Macs, so they run from source. Pushing a `v*` tag builds every platform in GitHub Actions and attaches them to a release.

Protocol details are in [docs/protocol.md](docs/protocol.md).
