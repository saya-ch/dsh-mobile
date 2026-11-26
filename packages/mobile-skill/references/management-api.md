# Management API

All local management routes live under `/api/mobile-access`. Two requirements apply to every call:

1. **Base URL** from `$DSH_WEB_URL` (the DSH port changes by launch, so never hard-code one).
2. **`Origin` header equal to that same URL.** Without it the gateway answers `403 {"error":"forbidden"}` before validating the body. With a wrong origin the same 403 appears, so a 403 means the header, not the payload.

`Content-Type: application/json` is required on POST. Bodies are capped per route (4096 or 8192 bytes); an oversized body is rejected.

A successful call answers `200` with the whole remote payload (`providers`, per-channel state and `configuration`), so the response already confirms the effect.

## Reading state

| Route | Returns |
|---|---|
| `GET /remote/control` | Every channel's switch, runtime state and configuration metadata |
| `GET /diagnostics` | The full connection diagnostic with `checks`, `report` and `coverage` |
| `GET /remote/frp/self-check` | FRP entry details: certificate, CA fingerprint, reachability, component |
| `GET /remote/frp/attach-plan` or `POST` it | Attach-mode checklist with the token masked |
| `GET /lan/control` | LAN configured/running state, `restartRequired`, pending origin |
| `GET /lan/networks` | Candidate LAN interfaces with the recommended one |
| `GET /lan/devices`, `GET /remote/devices` | Paired devices (never the credentials) |

## Channels and switching

| Route | Body | Effect |
|---|---|---|
| `POST /remote/provider` | `{"provider":"tailscale"\|"cpolar"\|"cloudflared"\|"frp"\|"origin"\|"iroh"}` | Select the channel; disables the others |
| `POST /remote/control` | `{"running":true\|false,"provider"?:…}` | Turn the selected (or named) channel on or off |
| `POST /remote/reconnect` | `{}` | Restart the channel, keeping its identity and pairings |
| `POST /remote/reset` | `{"confirm":true}` | Turn off and delete `remote/devices.json` — **every remote pairing is lost** |

## Per-channel configuration

### FRP

| Route | Body |
|---|---|
| `POST /remote/frp/configure` | `{serverAddress, serverPort, token, publicOrigin, mode?, entryTls?, vhostHttpPort?, publicPort?, user?}` |
| `POST /remote/frp/component/install` | `{confirm:true}` |
| `POST /remote/frp/component/purge` | `{confirm:true}` — also deletes the configuration and the self-signed certificates |
| `POST /remote/frp/vps/host-keys` | `{serverAddress, sshUser, sshPort, sshKeyPath?}` |
| `POST /remote/frp/vps/deploy` | `{confirm:true, serverAddress, serverPort, sshUser, sshPort, sshKeyPath?, hostFingerprints:[…]}` |
| `POST /remote/frp/vps/uninstall-script` | `{serverAddress?, serverPort?, certName?}` |
| `POST /remote/frp/vps/uninstall` | `{confirm:true, …ssh parameters, hostFingerprints, certName?}` |

`configure` merges: an empty or absent core field keeps the stored value, `token` is reused only when the address and port are unchanged, and an absent `mode`/`entryTls` keeps the stored one. Errors: `frp_settings_invalid`, `frp_server_address_invalid`, `frp_server_port_invalid`, `frp_token_invalid`, `frp_public_origin_invalid`, `frp_attach_mode_requires_vhost_port`, `frp_self_signed_requires_public_ipv4`, `frp_user_invalid`, `frp_config_missing`.

**SSH host keys must be confirmed by the user.** Call `host-keys`, show the fingerprints, and submit them only after the user has matched them against their provider. Never invent `hostFingerprints` to skip that check.

### cloudflared

| Route | Body |
|---|---|
| `POST /remote/cloudflared/tunnel` | `{mode?, hostname?, port?, token?, connect?}` |
| `POST /remote/cloudflared/tunnel/purge` | `{confirm:true}` — deletes the named-tunnel configuration, returning to quick mode |
| `POST /remote/cloudflared/component/install` | `{confirm:true}` |
| `POST /remote/cloudflared/component/purge` | `{confirm:true}` — keeps `tunnel.json` |

`{"mode":"quick","connect":true}` returns to quick mode. An empty `token` always keeps the stored one. Errors: `cloudflared_tunnel_token_invalid`, `_hostname_invalid`, `_port_invalid`, `_port_reserved`, `_settings_invalid`, `_config_missing`.

### cpolar

| Route | Body |
|---|---|
| `POST /remote/cpolar/configure` | `{"authtoken":"<token>"}` |
| `POST /remote/cpolar/component/install` | `{confirm:true}` |
| `POST /remote/cpolar/component/purge` | `{confirm:true}` — keeps the device store |

The correct order is install, then configure, then `POST /remote/control {"running":true}`. An invalid token answers `400 cpolar_authtoken_invalid`.

### iroh

| Route | Body |
|---|---|
| `POST /remote/iroh/component/install` | `{confirm:true}` — reuses a valid companion copy when one exists |
| `POST /remote/iroh/component/purge` | `{confirm:true}` — refuses with `409 iroh_component_running` while the channel is on |
| `POST /remote/iroh/pairing/begin` | `{}` — returns the descriptor and `qrSvg`; requires `state === 'ready'` |

The descriptor contains the pairing code and the gateway token. Do not print it.

### origin

| Route | Body |
|---|---|
| `POST /remote/origin/configure` | `{publicOrigin, listenHost, listenPort, allowedCidrs}` |
| `POST /remote/origin/purge` | `{confirm:true}` — keeps paired devices |
| `POST /remote/origin/mode` | `{"mode":"external"\|"managed"}` |
| `POST /remote/caddy/settings` | `{settings:{publicOrigin, dnsProvider:"tencentcloud", listenPort}, secretId?, secretKey?, connect?}` |
| `POST /remote/caddy/component/install` / `purge` | `{confirm:true}` |

Empty `secretId` and `secretKey` together keep the stored credentials. Note that Caddy configuration and install errors reach the API as `500 internal_error`; the real `caddy_*` code is only in the log.

## Local network

| Route | Body |
|---|---|
| `POST /lan/setup` | `{confirm:true, address, configureFirewall?}` — only while unconfigured; needs one DSH restart afterwards |
| `POST /lan/control` | `{"running":true\|false}` |
| `POST /lan/rebind` | `{"networkInterface":"<name>"}` — reissues the certificate and restarts the listener |
| `POST /lan/trusted-networks` | `{"extraAllowedCidrs":[…]}` |
| `POST /lan/loopback-tunnel` | `{"enabled":true\|false,"port"?:…}` |
| `POST /lan/pairing/open` | `{}` — opens a pairing window, returns the code, URL and QR |
| `POST /lan/devices/revoke` | `{"deviceId":"<32 hex>"}` |
| `POST /lan/devices/reset` | `{"confirm":true}` — LAN devices only |

`lan/trusted-networks` and `lan/loopback-tunnel` answer `restartRequired: true`; the change applies after a DSH restart, a LAN rebind, or an off/on cycle.

## Pairing

| Route | Body |
|---|---|
| `POST /remote/pairing/open` | `{}` — opens a window on the selected remote channel |
| `POST /remote/iroh/pairing/begin` | `{}` — iroh's two-stage descriptor instead of a URL |

Both answer with a one-time secret. They are the only routes whose response must not be quoted back to the user in full: show the QR or let them generate it, never paste the code or token into a reply.

## Error shape

Failures answer `{"error":"<code>"}` with a status that says what went wrong:

| Status | Meaning |
|---|---|
| 400 | The body failed validation; `error` names the field problem |
| 403 | Missing or wrong `Origin` header — the body was never examined |
| 404 | Unknown route, or no pairing window is open |
| 409 | The operation conflicts with current state (channel running, already configured, wrong selection) |
| 429 | Too many pairing attempts |
| 500 | `internal_error`; the specific cause is in `<state>/logs/dsh-mobile.log` |
