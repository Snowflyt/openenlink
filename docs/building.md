# Building

## Run from source

Install Node.js 26.9 or newer, Git and curl, then:

```sh
git clone --recursive https://github.com/Snowflyt/openenlink.git
cd openenlink
npm install
npm start -- login https://vpn.example.edu
npm start -- serve
```

`npm start --` takes the same arguments as the executable; [Usage](usage.md) lists them. For SSH, the `ProxyCommand` is `node /path/to/openenlink/src/cli.ts nc %h %p`.

## The TCP/IP stack

The tunnel carries raw IPv4 packets, so the client runs its own TCP/IP stack: [tcpip.js](https://github.com/chipmk/tcpip.js) 0.4.0, which wraps lwIP 2.2.0 compiled to WebAssembly. Both are Git submodules under `vendor`.

`npm install` builds the stack in four steps:

1. It checks out the submodules.
2. It applies `vendor/tcpip.js.patch` to `vendor/tcpip.js`.
3. It strips the types from the tcpip.js sources into `vendor/tcpip.js/packages/tcpip/dist`.
4. It compiles `tcpip.wasm` with wasi-sdk 24. The first install downloads wasi-sdk into `.cache`.

The patch fixes faults that let one lost packet stall or corrupt a connection:

| Part       | Change                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| JavaScript | Keeps the write side open after the peer's FIN.                                      |
| JavaScript | Frees packet buffers copied into WASM memory.                                        |
| Both       | Rejects the pending connect and errors the streams of a reset or aborted connection. |
| WASM       | Delivers every pbuf of out-of-order data.                                            |
| WASM       | Sends chained outgoing packets whole.                                                |
| WASM       | Copies incoming packets before lwIP queues them.                                     |
| WASM       | Uses a 182 KiB window with window scaling, up from 5.6 KiB.                          |
| WASM       | Starts retransmission after 1 second, down from 3 seconds.                           |

To change the stack, edit the files in `vendor/tcpip.js`, save the patch and rebuild:

```sh
git -C vendor/tcpip.js diff > vendor/tcpip.js.patch
npm install
```

The tcpip.js version stays pinned until the fixes are available upstream.

## Single executable

```sh
npm run build
```

The build writes `dist/openenlink`, or `dist/openenlink.exe` on Windows, for the current system.

It strips the types from `src` with ts-blank-space, which leaves the JavaScript line for line as written. The executable carries that code, the runtime dependencies and `tcpip.wasm` in its virtual file system, and runs them from there without unpacking.

The virtual file system needs Node.js 27.0.0-alpha.0.1.1 or newer. With an older Node.js, the build downloads that release from [nodejs.org](https://nodejs.org/) into `dist` and builds with it. Node.js 27 has no build for Intel Macs, so they run from source.

On macOS the build signs the executable ad hoc.

wasi-sdk runs only on glibc, so a musl executable takes two steps on one checkout: `npm install` on a glibc system, then `npm ci --ignore-scripts` and `npm run build` in an Alpine container.

## Releases

Pushing a `v*` tag runs the checks, builds the six executables listed in the [README](../README.md#install) and attaches them to a GitHub release. Starting the CI workflow by hand builds the same executables as workflow artifacts, without a release.
