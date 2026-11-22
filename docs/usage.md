# Usage

English | [简体中文](usage.zh-CN.md)

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

The examples call the executable as `openenlink`. When running [from source](building.md), the same arguments follow `npm start --`.

## Sign in

```sh
openenlink login https://vpn.example.edu
```

The address is the HTTPS origin of your gateway. `login` saves it, so a later sign-in needs only `openenlink login`.

The authorization stays on this machine until `openenlink logout`. How you sign in depends on the sign-in page behind the gateway.

### In the terminal

On a sign-in page with an [adapter](../README.md#adapters), `login` prompts for the username and password and submits them to that page over HTTPS. The username prompt defaults to the last used account, and `--user name` skips the prompt. Password input is hidden, and `login` allows up to three attempts on a wrong password.

When the page requires a captcha, `login` renders it in the terminal and prompts for the code. In terminals without image or 256-color support, it writes the image to a temporary file and prints the path.

### In a browser

```sh
openenlink login --browser
```

`login --browser` prints the gateway's sign-in URL. Without the flag, `login` falls back to browser sign-in when no adapter matches, or on an empty response at the first username prompt or the captcha prompt.

1. Open the printed URL in a browser and sign in.
2. At the `Paste (hidden):` prompt, paste the address the browser ends on, or the value of the gateway's `access_token` cookie from the browser's developer tools.

Some gateways move on to another page right after the sign-in. That page's address no longer holds the sign-in, so paste the cookie instead.

### Stay signed in

```sh
openenlink login --remember
```

`--remember` saves the username and password next to the authorization, along with the sign-in page's session cookies. When the session ends while `serve` runs, the client signs in again with the cookies, and with the password once they expire.

- The password is posted only to the HTTPS origin where you typed it.
- The password is tried at most once every five minutes.
- A wrong password removes the remembered one.
- A captcha stops the automatic sign-in. Run `openenlink login --remember` again.
- A later `login` without `--remember` removes the remembered password.

`--remember` requires a terminal sign-in. Browser sign-in does not handle the password locally, so `--remember` cannot be combined with `--browser`.

### Other sign-in options

`--user-agent text` replaces Node.js's default `User-Agent` for gateways that filter clients. The value is saved for later runs, and `--user-agent ""` restores the default.

openenlink trusts the certificate authorities Node.js trusts. For a gateway or sign-in page behind a private certificate authority, set the `NODE_EXTRA_CA_CERTS` environment variable to the path of its certificate file.

## Run the proxy

```sh
openenlink serve
```

`serve` connects to the gateway and listens on `127.0.0.1:1088` until `Ctrl+C`. `--port` chooses another port. `--bind` chooses the address, such as `0.0.0.0` for clients on other machines or outside a Docker container. Without `--proxy-user`, any client that reaches the address can use the tunnel, and `serve` prints a warning.

The port accepts SOCKS5 requests (CONNECT and UDP ASSOCIATE) and HTTP proxy requests, CONNECT included. Destinations are IPv4.

```sh
curl --socks5-hostname 127.0.0.1:1088 https://intranet.example.edu/
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

Internal host names resolve only through the gateway's resolver inside the tunnel. Pass names to the proxy with `socks5h://` or `--socks5-hostname` so that it resolves them.

`--add-host name=address` gives a name a fixed IPv4 address, for internal hosts that the gateway's resolver does not know. Repeat it for more names.

Tools that read `http_proxy` and `https_proxy`, such as git and pip, take `http://127.0.0.1:1088`.

### One client per account

A second client that connects with the same account ends the first one's tunnel. The first then reconnects and ends the second. Run `serve` on one machine at a time, and close the official client while it runs.

### Reconnecting

After a dropped tunnel, `serve` reconnects by itself. The delay starts at one second and doubles up to 30 seconds.

When the authorization expires, `serve` renews it using the gateway's refresh token or the remembered credentials. If neither works, it exits with status 3. Run `openenlink login` again.

Signing in elsewhere can take the authorization over the account's limit of simultaneous sign-ins. A `serve` that has just started then renews it and takes the account back. Once it has connected, it exits with status 3 instead, and leaves the account to the newer sign-in.

### Log

Each line from `serve` starts with the local time and a level. `debug` and `info` go to standard output, `warn` and `error` to standard error. A connection through the tunnel gets one line when it opens, and one when it closes or fails:

```text
[2026-11-21 09:43:02.123] [info] Proxy listening on 127.0.0.1:1088
[2026-11-21 09:43:10.481] [info] [TCP] 127.0.0.1:52344 --> library.example.edu:443
[2026-11-21 09:54:41.902] [info] [TCP] 127.0.0.1:52344 --> library.example.edu:443 closed after 11m31s, sent 48.2 kB, received 1.3 MB
[2026-11-21 09:55:03.017] [error] [TCP] 127.0.0.1:52360 --> 10.20.0.5:8079 failed: tcp connection reset
```

`(client reset)` after the duration means the client reset the connection, and `(tunnel closed)` means the tunnel dropped while the connection was open. A wrong proxy password is a warning.

`--log-level` sets the lowest level that `serve` prints: `error`, `warn`, `info`, which is the default, or `debug`. `debug` adds the addresses the gateway assigned, each internal DNS answer, and session renewals.

No line holds the data, a password, a token or the path of an HTTP request. The lines do name the internal hosts and the local clients that reach them. `--log-level warn` keeps only warnings and errors.

Under systemd the journal records the time of each line, and `serve` leaves its own out. To keep the log in a file elsewhere:

```sh
openenlink serve >> serve.log 2>&1
```

### Shared machines

Other accounts on the same machine can reach the local port. `--proxy-user` makes the proxy require a username and password:

```sh
openenlink serve --proxy-user alice
```

`serve` reads the proxy password from the terminal, or one line from standard input. Clients then connect with `socks5h://alice:password@127.0.0.1:1088` or `http://alice:password@127.0.0.1:1088`.

## SSH and other TCP connections

`nc host port` joins standard input and output to an internal host through the running proxy. In `~/.ssh/config`:

```text
Host *.example.edu
  ProxyCommand openenlink nc %h %p
```

Give the full path of the executable when it is outside `PATH`. `nc` takes `--port` when `serve` uses another port. It sends no proxy password, so it needs a `serve` started without `--proxy-user`.

## Forward ports

`--forward port:host:hostport` makes `serve` listen on another port as well and join each connection on it to `host:hostport` inside the tunnel. Programs without proxy settings, such as database clients and remote desktop, then connect to the local port. Add `/udp` to forward UDP. Repeat the option for more ports.

```sh
openenlink serve --forward 15432:db.example.edu:5432 --forward 10053:10.0.0.53:53/udp
```

Forwarded ports listen on the `--bind` address and take no proxy password, so any client that reaches the address can use them.

## Check and remove saved credentials

```sh
openenlink status
openenlink logout
```

`status` reports whether an authorization is saved and which username is remembered. It reads only what this machine saved and sends nothing to the gateway.

`logout` removes the authorization and the remembered password from this machine.

## Where credentials are kept

The gateway address, the last username, the `--user-agent` value and the storage choice are saved in `config.json`. On macOS and Linux the file is `$XDG_CONFIG_HOME/openenlink/config.json`, or `~/.config/openenlink/config.json` when the variable is unset. On Windows it is `%APPDATA%\openenlink\config.json`.

The authorization and the remembered password go to the OS credential store: Keychain on macOS, Credential Manager on Windows, and a Secret Service such as GNOME Keyring or KWallet on Linux, reached through libsecret.

Hosts without a credential store, such as Docker containers and servers without a desktop session, use `--insecure-storage`:

```sh
openenlink login https://vpn.example.edu --insecure-storage
```

It keeps the authorization and any remembered password as plain JSON in `credentials.json` next to `config.json`, with owner-only file permissions. Each `login` chooses again: a later `login` without the option returns to the OS credential store and removes the copy in the file.

## Exit statuses

| Status | Meaning                                           |
| ------ | ------------------------------------------------- |
| 0      | The command finished.                             |
| 1      | The command failed for a reason not listed below. |
| 2      | Invalid arguments. The usage text is printed.     |
| 3      | Sign in again with `openenlink login`.            |
| 130    | Stopped with Ctrl+C.                              |

On Linux and macOS, Ctrl+C ends the command by the signal itself. The shell reports 130, and a loop typed at the shell prompt stops as well. `serve` stopped with SIGTERM exits with 0.

A script that restarts `serve` can stop at status 3. Under systemd, `RestartPreventExitStatus=3` does this for `Restart=on-failure`.
