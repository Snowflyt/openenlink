# Protocol notes

The protocol behavior of [mihomo-smart-enagent](https://github.com/airline233/mihomo-smart-enagent) informed this independent implementation.

## Authentication

Soochow University advertises OIDC through `POST /enclient/api/users/custom/page/login/cfg/select`. The client uses the advertised `/enclient/api/users/admin/custom/page/login/sso/OIDC` entry. Its registered OIDC callback remains on the university VPN server. The `OIDC-UES?blankwindow=blank` variant hands authentication to the native app and can create a competing session.

The completion page `/login/wxLoginLoading` reads a Base64 `accessToken` query parameter or `access_token` cookie, plus a possible `refreshToken`. The client intercepts the callback before page scripts run and saves authorization before validating it. Chromium omits `Set-Cookie` from intercepted response headers, so cookie capture also reads the browser's cookie store for the configured school origin. This stops the callback from launching the native app.

Authenticated controller calls:

| Endpoint                                      | Result                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /enclient/api/users/info`                | `data.username` is the tunnel username.                                  |
| `GET /enclient/api/users/terminal/rules`      | `data.token` is the tunnel token; `gateway_list` supplies endpoints.     |
| `GET /enclient/api/users/client/refreshToken` | Refresh-token Bearer authentication; returns `token` and `refreshToken`. |

Responses wrap results in `{code:"200",data:...}`. Expired authorization can return HTTP 200 with code `"3010"`. Each gateway's `ip` field encodes `publicHost:port||internalAddress||internalPort`. When `internalDnsResolveStatus` is `"true"`, its `dns` field overrides the DNS address in the data-channel handshake.

Browser request signing uses headers `now`, `requestId`, `finger` and `Authorization`. `now` is Unix milliseconds. `requestId` contains 16 random characters from `qwertyuiopasdfghjklzxcvbnm1234567890`. The checksum is:

```text
R = raw query + exact JSON body, when present
A = "Bearer " + token, or empty
finger = hex(MD5(R + now + requestId + "enlink" + requestId + A))
```

The official signer removes a leading dot from that combined input. The client signs the same bytes it sends.

## TLS data channel

Client frames have a 12-byte header: magic `01`, type, big-endian total length, four zero bytes and a little-endian flag. Authentication uses type 1, flag 1; heartbeats use type 1, flag 3. IPv4 packets use type 4 and flag `0x29000000`.

Authentication contains tagged username and tunnel-token strings followed by `FF`. The response uses a 12-byte header with success byte 8 equal to 1 and a zero status code at bytes 10–11. Address fields use a one-byte tag, two-byte big-endian length and value. Tag `0B` is the four-byte IPv4 address; `24` is textual DNS; `35` is a 16-byte IPv6 address.

Subsequent gateway frames use an 8-byte header. Type 2 is control traffic; type 4 carries IPv4. The client emits a heartbeat every 500 milliseconds.

lwIP treats `127/8` as local. For a loopback campus resolver, the client uses an internal RFC 2544 alias and translates IPv4 addresses and checksums at the TLS boundary. Both resolver forms have end-to-end tests.

The proxy's resolver sends UDP queries through the virtual stack and decodes replies with `dns-packet`. The DNS decoder bundled with `tcpip` cannot handle the compressed names in the live gateway's replies. DNS answers can map campus hostnames to virtual `192.19.*` addresses, so substituting public DNS breaks those resources. Truncated DNS replies are reported; DNS over TCP and IPv6 transport are unimplemented.

## SPA

SPA is unimplemented. A server requiring SPA stops startup with an explicit error. SPA uses UDP and server-provided connection settings. The official client uses Enlink-specific additions to the fwknop format, including inner and outer `enlink` markers. The SPA key and controller port are separate from the tunnel token and rules. Where a deployment supplies them is unknown.

The official client encodes the packet as follows, with `b64` denoting standard Base64 without trailing padding:

```text
K = decodeHex(key), or decodeHex(hex(MD5(key))) when key text is not 32 characters
encoded = nonce16digits + ":" + b64(OS username) + ":" + unixSeconds
          + ":3.0.0:1:" + b64(allowIP + ",tcp/" + servicePort)
plain = encoded + ":" + b64(SHA256(encoded)) + ":enlink"
D1 = MD5(K + salt8bytes)
D2 = MD5(D1 + K + salt8bytes)
D3 = MD5(D2 + K + salt8bytes)
blob = "Salted__" + salt8bytes + AES-256-CBC-PKCS7(D1 + D2, D3, plain)
full = b64(blob)
wire = full.slice(10) + b64(HMAC-SHA256(K, full)) + "enlink"
```

The gateway SPA UDP port is `spaPort`, defaulting to `62201`. Controller SPA settings come from connection configuration. The official client sends the packet once, immediately before TLS setup. The default allow-IP and the deployed key are unknown.

The [university's client guide](https://its.suda.edu.cn/ae/d0/c3658a700112/page.htm) identifies the EnAgent/EnUES client and school SSO.
