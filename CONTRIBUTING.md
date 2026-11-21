# Contributing to openenlink

Issues and pull requests are welcome. Terminal sign-in for another sign-in page is the most useful contribution, and [Writing an adapter](docs/adapters/README.md) walks through it.

## Local Setup

Install Node.js 26.9 or newer, Git and curl, then:

```sh
git clone --recursive https://github.com/Snowflyt/openenlink.git
cd openenlink
npm install
```

`npm install` also builds the TCP/IP stack from the `vendor` submodules and points Git at the commit hook in `.githooks`. [Building](docs/building.md) explains that build.

Common commands:

```sh
npm start -- login https://vpn.example.edu
npm test
npm run typecheck
npm run lint
npm run format
```

`npm start --` runs the CLI from source and takes the same arguments as the executable. Run the three checks before opening a pull request. CI runs them too.

## Project Layout

| Path                                                                        | Contents                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/cli.ts`, `src/prompt.ts`                                               | Commands, options and terminal prompts                                     |
| `src/login.ts`, `src/web.ts`, `src/adapter.ts`, `src/adapters/`             | Terminal sign-in and one adapter per sign-in page                          |
| `src/image.ts`, `src/jpeg.ts`                                               | Captcha display in the terminal                                            |
| `src/controller.ts`                                                         | Controller API requests and their signing                                  |
| `src/client.ts`                                                             | The `serve` loop: renewal and reconnects                                   |
| `src/worker.ts`, `src/tunnel.ts`, `src/protocol.ts`, `src/packet.ts`        | The tunnel, which runs in a worker thread: TLS frames and the TCP/IP stack |
| `src/proxy.ts`, `src/socks.ts`, `src/http.ts`, `src/relay.ts`, `src/dns.ts` | The local proxy and its resolver                                           |
| `src/nc.ts`                                                                 | The `nc` command                                                           |
| `src/config.ts`, `src/credentials.ts`, `src/keyring.ts`                     | Settings and credential storage                                            |
| `test/`                                                                     | Tests for the Node.js test runner                                          |
| `vendor/`                                                                   | The tcpip.js and lwIP submodules, with `tcpip.js.patch`                    |
| `docs/`                                                                     | User and contributor documentation                                         |

## Code And Tests

Node.js runs the TypeScript sources directly, so imports name `.ts` files and the code keeps to syntax that disappears when types are stripped.

Tests run against servers they start themselves: a TLS gateway, a sign-in page and the proxy, all on the loopback interface. A test never contacts a real gateway or uses a real account. Add a test with each behavior change, next to the tests of the same area.

`test/keyring.test.ts` writes to the OS credential store, so it is skipped unless the `OPENENLINK_TEST_KEYRING` environment variable is `1`. CI runs it on macOS, Linux and Windows.

## Documentation

`README.md`, `docs/usage.md` and each adapter guide have a `.zh-CN.md` twin with the same content. Change both together. Contributor documents are in English.

Facts about one sign-in page or gateway belong in that adapter's guide. The general documents use `vpn.example.edu` and `intranet.example.edu`.

## Commits

A commit header has the form `<emoji> <type>(<scope>): <Subject>`. The scope is optional, the subject starts with a capital letter and has no final period, and the header is at most 72 characters. The commit hook checks it.

```text
✨ feat: Add terminal sign-in for Example University
🐞 fix(socks): Close the UDP relay when its TCP connection ends
```

| Emoji | Type       | Use                                        |
| ----- | ---------- | ------------------------------------------ |
| 🎉    | `init`     | Project initialization                     |
| ✨    | `feat`     | A new feature                              |
| 🐞    | `fix`      | A bug fix                                  |
| 📃    | `docs`     | Documentation only                         |
| 🌈    | `style`    | Formatting, with the logic unchanged       |
| 🦄    | `refactor` | Restructuring, with the behavior unchanged |
| 🎈    | `perf`     | Performance                                |
| 🧪    | `test`     | Tests                                      |
| 🔧    | `build`    | Dependencies and the build                 |
| 🐎    | `ci`       | CI configuration                           |
| 🐳    | `chore`    | Other maintenance                          |
| ↩     | `revert`   | Reverting an earlier commit                |

Keep one change per commit.

## Pull Requests

A pull request should include:

- A short description of the behavior change.
- Tests for the changed behavior.
- Documentation updates when commands, options or an adapter change.
- For a new adapter, its guide in both languages and a row in the adapter tables of both READMEs.
