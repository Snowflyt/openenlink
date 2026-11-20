# Usage

English | [简体中文](usage.zh-CN.md)

```text
openenlink login [https://vpn.example.edu] [--user name] [--remember] [--browser]
                 [--insecure-storage] [--user-agent text]
openenlink serve [--port 1088] [--proxy-user name]
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

On a sign-in page with an [adapter](../README.md#adapters), `login` asks for the username and password and posts them to that page over HTTPS. The username prompt offers the last one used, and Enter accepts it; `--user name` answers it in advance. Nothing appears while the password is typed. After a wrong password, `login` asks again, three attempts in all.

When the page asks for a captcha, `login` draws the image in the terminal and asks for the answer. A terminal without image or true-color support gets the image as a temporary file, with its path printed.

### In a browser

```sh
openenlink login --browser
```

`login --browser` prints the gateway's sign-in address. Without the option, `login` does the same on a sign-in page without an adapter, and after an empty answer at the first username prompt or at the captcha prompt.

1. Open the printed address in a browser and sign in.
2. Copy the address the browser ends on.
3. Paste it at the `Paste (hidden):` prompt.

The prompt also takes the value of the gateway's `access_token` cookie, copied from the browser's developer tools.

### Stay signed in

```sh
openenlink login --remember
```

`--remember` saves the username and password next to the authorization, along with the sign-in page's session cookies. When the session ends while `serve` runs, the client signs in again with the cookies, and with the password once they expire.

- The password is posted only to the HTTPS origin where you typed it.
- The password is tried at most once every five minutes.
- A wrong password removes the remembered one.
- A captcha stops the automatic sign-in; run `openenlink login --remember` again.
- A later `login` without `--remember` removes the remembered password.

`--remember` needs a terminal sign-in. A browser sign-in leaves no password to save, so `--browser` refuses `--remember`.

### Other sign-in options

`--user-agent text` replaces Node.js's default `User-Agent` for gateways that filter clients. The value is saved for later runs, and `--user-agent ""` restores the default.

openenlink trusts the certificate authorities Node.js trusts. For a gateway or sign-in page behind a private certificate authority, set the `NODE_EXTRA_CA_CERTS` environment variable to the path of its certificate file.

## Run the proxy

```sh
openenlink serve
```

`serve` connects to the gateway and listens on `127.0.0.1:1088` until `Ctrl+C`. `--port` chooses another port.

The port accepts SOCKS5 requests (CONNECT and UDP ASSOCIATE) and HTTP proxy requests, CONNECT included. Destinations are IPv4.

```sh
curl --socks5-hostname 127.0.0.1:1088 https://intranet.example.edu/
curl --proxy http://127.0.0.1:1088 https://intranet.example.edu/
```

Internal host names resolve only through the gateway's resolver inside the tunnel. Pass names to the proxy with `socks5h://` or `--socks5-hostname` so that it resolves them.

Tools that read `http_proxy` and `https_proxy`, such as git and pip, take `http://127.0.0.1:1088`.

### One client per account

A second client that connects with the same account ends the first one's tunnel. The first then reconnects and ends the second. Run `serve` on one machine at a time, and close the official client while it runs.

### Reconnecting

After a dropped tunnel, `serve` reconnects by itself. The delay starts at one second and doubles up to 30 seconds.

When the authorization expires, `serve` renews it with the gateway's refresh token or the remembered sign-in. When neither works, it exits with status 3; run `openenlink login` again.

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

| Status | Meaning                                              |
| ------ | ---------------------------------------------------- |
| 0      | The command finished.                                |
| 1      | The command failed for a reason not listed below.    |
| 2      | The arguments were wrong; the usage text is printed. |
| 3      | Someone needs to run `openenlink login`.             |

A script that restarts `serve` can stop at status 3.
