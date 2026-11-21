# Enlink protocol

An Enlink deployment has a controller, which serves an HTTPS API on the gateway address, and one or more gateways, which carry IP packets over TLS. This document describes both as openenlink speaks them. A sign-in page behind the controller is described in its [adapter guide](adapters/README.md).

## Sign-in

`POST /enclient/api/users/custom/page/login/cfg/select` with an empty JSON object lists the sign-in methods in `ssoLoginTypes`. The client takes the entry whose `loginType` is `SSO_OIDC` and follows its `loginUrl`, such as `/enclient/api/users/admin/custom/page/login/sso/OIDC`. The `OIDC-UES?blankwindow=blank` variant of that address hands the sign-in to the official app and can start a competing session.

The entry redirects to the organization's sign-in page. After a successful sign-in, the browser returns to the controller's `/oidc/callback?code=…`, which redirects to the completion page `/login/wxLoginLoading`. That address carries a Base64 `accessToken` parameter, in its query or in the query after the `#`, or the response sets an `access_token` cookie. A `refreshToken` parameter may come with it. The client follows every redirect itself and stops at the completion address without requesting it.

A refused callback lands on the same page with a `state` parameter: Base64 JSON with `code` and `message`.

## Controller API

| Endpoint                                      | Result                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /enclient/api/users/info`                | `data.username` is the tunnel username.                                  |
| `GET /enclient/api/users/terminal/rules`      | `data.token` is the tunnel token, and `gateway_list` supplies endpoints. |
| `GET /enclient/api/users/client/refreshToken` | Refresh-token Bearer authentication. Returns `token` and `refreshToken`. |

Responses wrap results in `{code:"200",data:...}`. An expired authorization returns HTTP 401, or HTTP 200 with code `"401"` or `"3010"`.

Each gateway's `ip` field encodes `publicHost:port||internalAddress||internalPort`. When `internalDnsResolveStatus` is `"true"`, its `dns` field overrides the DNS address in the data-channel handshake.

Every request carries the headers `now`, `requestId`, `finger` and `Authorization`. `now` is Unix milliseconds. `requestId` contains 16 random characters from `qwertyuiopasdfghjklzxcvbnm1234567890`. The checksum is:

```text
R = raw query + exact JSON body, when present
A = "Bearer " + token, or empty
finger = hex(MD5(R + now + requestId + "enlink" + requestId + A))
```

The official signer removes a leading dot from that combined input. The client signs the same bytes it sends.

## TLS data channel

Client frames have a 12-byte header: magic `01`, type, big-endian total length, four zero bytes and a little-endian flag. Authentication uses type 1 and flag 1, and heartbeats use type 1 and flag 3. IPv4 packets use type 4 and flag `0x29000000`.

Authentication contains tagged username and tunnel-token strings followed by `FF`. The response uses a 12-byte header with success byte 8 equal to 1 and a zero status code at bytes 10–11. Address fields use a one-byte tag, two-byte big-endian length and value. Tag `0B` is the four-byte IPv4 address, `24` is textual DNS, and `35` is a 16-byte IPv6 address.

Subsequent gateway frames use an 8-byte header. Type 2 is control traffic, and type 4 carries IPv4. The client emits a heartbeat every 500 milliseconds and closes a tunnel whose gateway sends nothing for 30 seconds.

## DNS

The proxy's resolver sends UDP queries through the tunnel to the resolver from the handshake and decodes replies with `dns-packet`, which handles the compressed names gateways send. Answers can map internal host names to virtual `192.19.*` addresses that exist only inside the tunnel, so a public resolver cannot replace it. Truncated replies are reported. DNS over TCP and IPv6 transport are unimplemented.

lwIP treats `127/8` as local. For a resolver at a loopback address, the client uses an internal RFC 2544 alias and translates IPv4 addresses and checksums at the TLS boundary.

## SPA

SPA is unimplemented. Rules with `spa_status: true` stop `serve` with an error.

The official client sends one SPA packet over UDP immediately before TLS setup, to the gateway's `spaPort`, 62201 by default. The format extends fwknop with inner and outer `enlink` markers. With `b64` denoting standard Base64 without trailing padding:

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

The SPA key and controller port are separate from the tunnel token and rules. How a deployment supplies the key, and which allow-IP it expects, are unknown.
