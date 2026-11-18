# Loopback tunnel access (with your own frp stcp)

[中文](LOOPBACK_TUNNEL.md) · [Back to remote access](../README.en.md#remote-access)

> Plugin 0.8.12 adds a **Loopback tunnel · Advanced** switch under **Mobile Access → Local network**. It is off by default, adds no remote channel, installs and manages no frp component, and requires no Android app update. With the switch off, behaviour is unchanged.

If you already run your own frps and want to reach the DSH mobile gateway through frp's **stcp (secret tcp)** proxy, turn this switch on: the gateway accepts `127.0.0.1` and `::1` as additional address names and includes them in its server certificate. The phone actually opens **its own** `127.0.0.1:<listener port>`, and the frpc visitor on the phone forwards the connection through frps back to the gateway on the computer.

Be precise about what this is: the plugin does **not** support the stcp protocol. It does not read, validate or manage your frp processes and configuration. It only allows requests that arrive through a **local loopback tunnel** and makes the certificate cover the loopback names. The channel itself — frps, both frpc instances, the `sk`, and the network route — is yours to deploy and operate.

> **Do not open the loopback link on the computer to test it.** The gateway itself listens only on the LAN address and never on `127.0.0.1`; what listens on that loopback address is the **frpc visitor on the phone**. From the computer, or any device with no visitor running, there are two outcomes and neither means the feature is broken:
>
> - Nothing listens on the port: the connection is refused outright, so the tunnel is not running.
> - Something listens but the TLS handshake fails (on Windows usually `SEC_E_INVALID_TOKEN`; with `http://` it reports `Received HTTP/0.9`): that listener does speak TLS, but it forwards to the wrong target, typically an frpc `localIP` that points at an address the gateway does not listen on. Find the owner with `netstat -ano | findstr :3443`.
>
> Check the route from the **phone**.

## When to use it

- You already own an frps (a public VPS) and do not want to publish the DSH HTTPS port, a domain or a public certificate.
- You want stcp's access control: only a visitor holding the same `sk` can connect. frp's client-to-server connection uses TLS by default, while DSH's HTTPS still ends at the computer's gateway and is not parsed by frps.
- The phone can run frpc (typically in Termux) and you accept reaching DSH on a local loopback address.

If the computer has no public ingress and you would rather not maintain frps, prefer the [experimental iroh connection](IROH.en.md) or another remote channel.

## Difference from iroh

| | Loopback tunnel + your own frp stcp | iroh (experimental) |
| --- | --- | --- |
| Who runs the channel | You deploy, configure and maintain frps and both frpc instances | The plugin downloads and starts a pinned sidecar |
| Phone side | You run an frpc visitor in Termux or similar | The full Android app has a native transport |
| Public server required | Yes, the frps control port must be reachable from both ends | No |
| What the plugin owns | Accepting the loopback names, putting them in the certificate, offering a loopback pairing link | The whole channel, endpoint certificates and pairing descriptor |

Neither option guarantees a working connection: the route, firewalls, carrier and your frp configuration still decide the result.

## Topology

```text
Phone app / phone browser
  └─ HTTPS → 127.0.0.1:3443 (frpc visitor listening on the phone)
       └─ stcp tunnel (relayed by your frps; only a visitor with the same sk may connect)
            └─ frpc on the computer (a type = stcp proxy)
                 └─ computer LAN address:3443 (the DSH Mobile HTTPS gateway)
```

What the plugin changes: the gateway server certificate gains `127.0.0.1` and `::1` SANs, and the gateway also accepts the exact origins `https://127.0.0.1:<listener port>` and `https://[::1]:<listener port>`. Nothing else changes.

## Required: the phone port must equal the computer's listener port

> **Which port to use**: by default the visitor's `bindPort` on the phone is the **DSH Mobile gateway listener port on the computer** (default `3443`), and the computer-side frpc `localPort` uses the same port. If you want the visitor on a different port, such as `6000`, put that port in the panel's **Tunnel port** field: the gateway then accepts the loopback origin at that port without changing its own listener. Both ends always agree on `bindPort` and `localPort`.
>
> The gateway only accepts an authority whose port equals its own listener port: the request's `Host` and `Origin` must be `127.0.0.1:3443` or `[::1]:3443`. With a different port the tunnel may report itself as connected, but the gateway answers 403. This restriction is deliberate, so that the gateway never becomes a wildcard listener for arbitrary ports.

## Prerequisites

- **Mobile Access → Local network** on the computer is managed by DSH Mobile and already configured. The switch is available only for that kind of setup; it cannot be saved when the configuration cannot be read or is unsupported, and the panel then shows "Available only with managed LAN setup."
- Your own frps is running and both the phone and the computer can reach its control port.
- frp 0.52.0 or later with TOML configuration is recommended; legacy INI still runs but is deprecated upstream.
- Termux (or another environment that can run frpc) is installed on the phone, and local port `3443` is free.
- This route needs no inbound port on the computer; only the frps control port on your VPS must be reachable.

## Computer: frps and the stcp proxy

frps needs an ordinary stcp server; add no proxy-specific rule for this entry. Example `frps.toml`:

```toml
bindPort = 7000
auth.method = "token"
auth.token = "replace-with-a-strong-token"
```

`frpc.toml` on the computer (the stcp server side, on the same machine as DSH):

```toml
serverAddr = "your VPS address"
serverPort = 7000
auth.method = "token"
auth.token = "replace-with-a-strong-token"

[[proxies]]
name = "dsh-mobile-gateway"
type = "stcp"
secretKey = "replace-with-a-random-sk"
localIP = "192.168.1.20"
localPort = 3443
```

- `localIP` is the **LAN address the gateway actually listens on** (for example `192.168.1.20` as shown in the Local network panel). The gateway binds to the LAN address and its source-network check only accepts that LAN subnet (plus any extra trusted networks you added), so do **not** use `127.0.0.1`.
- `localPort` is the gateway listener port (default `3443`).
- `secretKey` is the stcp `sk` and must match on both ends; do not reuse the frps token for it.
- Check the file with `frpc verify -c frpc.toml` before starting.

## Phone: the visitor in Termux

Download the frp archive that matches the phone (the version and file names below are examples; use the current files on the [frp releases](https://github.com/fatedier/frp/releases) page — arm64 phones usually need `linux_arm64`, 32-bit devices `linux_arm`):

```sh
pkg install wget tar openssl-tool
wget https://github.com/fatedier/frp/releases/download/v0.72.0/frp_0.72.0_linux_arm64.tar.gz
tar -xzf frp_0.72.0_linux_arm64.tar.gz
```

`frpc.toml` on the phone:

```toml
serverAddr = "your VPS address"
serverPort = 7000
auth.method = "token"
auth.token = "replace-with-a-strong-token"

[[visitors]]
name = "dsh-mobile-visitor"
type = "stcp"
serverName = "dsh-mobile-gateway"
secretKey = "the same sk as the computer"
bindAddr = "127.0.0.1"
bindPort = 3443
```

- `serverName` must equal the computer-side `[[proxies]]` `name`.
- `bindAddr = "127.0.0.1"` listens on the phone's loopback only, so other devices on the same Wi-Fi cannot reach it.
- `bindPort` and the computer-side `localPort` must be the same value; the gateway listener port is the default. For another port, enter the same value in the panel's **Tunnel port** field.

Start the visitor:

```sh
cd frp_0.72.0_linux_arm64
./frpc -c ./frpc.toml
```

Android may reclaim Termux in the background; keeping it running is up to you. The plugin does not manage this process.

If you still use legacy INI configuration, the equivalent visitor looks like this (`role = visitor` is old syntax; prefer the TOML above):

```ini
[common]
server_addr = your VPS address
server_port = 7000
token = replace-with-a-strong-token

[dsh-mobile-visitor]
role = visitor
type = stcp
server_name = dsh-mobile-gateway
secret_key = the same sk as the computer
bind_addr = 127.0.0.1
bind_port = 3443
```

## Computer: turn on the switch and get a loopback pairing link

1. Open **Mobile Access → Local network**, expand **Loopback tunnel · Advanced**, and select the toggle that reads **Disabled** so it reads **Enabled** (provided since plugin 0.8.12; available only with managed LAN setup).
2. Saving leaves the panel reporting that a restart is pending: stop and start local network access again, or restart DSH. Rebinding the LAN re-issues the server certificate, so its SANs contain the original LAN address, `127.0.0.1` and `::1`; the LAN address stays first.
3. Select **Generate pairing QR code** or **Copy pairing link** again. While the switch is on, a successful pairing operation reveals a **Copy loopback pairing link** button that copies the loopback address link, such as `https://127.0.0.1:3443/mobile-access/pair#instance=…&token=…`. It shares the one-time pairing code with the LAN link, and the QR code still encodes the LAN address. The button only appears when the gateway really returned a loopback link; if it is missing, the switch has not taken effect yet.
4. In the Android app's **Local network** flow, paste that loopback link. The panel does not produce a loopback QR code — the QR code encodes the LAN address only and is useless here, because the phone is not on that LAN. The phone is not on this computer's LAN, so automatic discovery will not list it either; just use the link. The app treats the loopback address as a local-network entry. You can also open that link directly in the phone's browser.
5. A browser shows a private-certificate warning on first visit; that is normal for the self-signed CA. Continue only after confirming the link came from your own computer. The app reads the CA from the gateway and checks it against the CA fingerprint represented by `instance` in the pairing code.

From Termux you can first confirm the tunnel reaches the gateway:

```sh
curl -fsS -k https://127.0.0.1:3443/mobile-access/health
# Expect {"ok":true}; -k only skips certificate validation and does not prove the entry's identity
```

Then confirm the certificate already covers the loopback name:

```sh
openssl s_client -connect 127.0.0.1:3443 </dev/null 2>/dev/null | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'
# Expect IP Address:127.0.0.1 (IPv6 may appear in expanded form)
```

## Turning it off and removing the route

1. Expand **Loopback tunnel · Advanced** and switch the **Enabled** toggle back to **Disabled**. Rebinding the LAN is required again (stop and start local network access, or restart DSH). Afterwards the gateway no longer accepts the loopback origins, the re-issued certificate has no loopback names, and no loopback pairing link is offered.
2. Stop the frpc visitor on the phone and frpc on the computer, and delete the stcp entry from frps. That removes the route completely.
3. The plugin installs, configures and manages no frp. Processes, configuration files and VPS-side rules are yours to clean up.
4. Turning the switch off does not delete paired devices. If you only need the route occasionally, stop the phone visitor when you are done.

## Residual risks (assess them yourself)

1. **The loopback port is visible to every app on the phone**: once the frpc visitor listens on `127.0.0.1:3443`, any other app on that phone can reach it; Android offers no "only this app may use the loopback port" isolation. Signing in still requires DSH Mobile pairing credentials, but do not treat this as operating-system isolation.
2. **A previously bound port can impersonate the gateway**: if another app on the phone has already taken `127.0.0.1:3443`, it receives the connection first. The app refuses it because the pairing CA fingerprint does not match, but if you clicked through a browser certificate warning, that one-time pairing token can be intercepted. Do not dismiss certificate warnings in the browser, and continue only when you know the port belongs to your own frpc.
3. **The certificate gains a loopback SAN**: the server certificate gains `127.0.0.1` and `::1` (the LAN address stays). This does not affect pinning the CA per device, and forging a certificate still requires your CA private key; the only cost is two extra names in the certificate, which by itself grants nobody access to your gateway.
4. **Only names are added**: the switch does not relax the Origin or CSRF checks, the trusted networks, the pairing credentials or any other validation. Requests must still come from an allowed network with an exactly matching Host and Origin, and a valid pairing is still required. It creates no VPN, changes no firewall and publishes no public port.
5. **Your own channel strength decides the overall security**: the frps token, the stcp secret key and the exposure of the frps control port are all yours to configure. The plugin neither reads nor validates them, and does not compensate when they are wrong.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The tunnel is up but pages return 403 `forbidden` | The phone's `bindPort` differs from the gateway listener port, so Host/Origin is rejected. Set `bindPort` to the gateway port (default 3443) |
| 403 `source_network_untrusted` | The computer-side `localIP` points outside the allowed network (for example `127.0.0.1`). Use the LAN address the gateway listens on |
| A certificate error when opening `https://127.0.0.1:3443` | The switch has not been applied by a rebind, or the certificate has not been re-issued. Rebind the LAN and try again; never disable certificate validation in the browser or app |
| `curl` cannot connect to `127.0.0.1:3443` | frpc is not running on the phone, `serverName`/`sk`/token mismatch, or the frps control port is unreachable |
| The computer is missing from the app's LAN discovery list | This route does not use LAN broadcast discovery. Pair with the link from **Copy loopback pairing link**. The QR code encodes the LAN address only and does not apply here |
| The phone reports port 3443 is in use | Another program on the phone holds the port. `bindPort` cannot be changed arbitrarily (it must equal the gateway port), so free 3443 first |

## Relation to other channels

- **Attach to an existing frps** ([guide](ATTACH_EXISTING_FRPS.en.md)) has the plugin manage the local frpc and publish a public HTTPS entry on frps, so the phone connects to a public address. This page is the opposite: you manage frpc yourself, nothing is published publicly, and the phone connects to its own loopback address.
- **iroh** is a channel managed by the plugin and needs no public server; stcp needs your frps but leaves the channel under your control.
- **Own reverse proxy / managed Caddy** require an existing public HTTPS entry and combine differently.

For frp configuration syntax, follow the official documentation: [stcp example](https://gofrp.org/en/docs/examples/stcp/).
