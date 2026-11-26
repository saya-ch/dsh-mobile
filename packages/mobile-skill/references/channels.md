# Channels

Every channel persists an on/off switch in `control.json` as `{"version":1,"enabled":<bool>}`. The selected channel is `remote/provider.json`. Runtime fields (`state`, `origin`, `errorCode`, `loginUrl`, `setupUrl`) exist only in the panel's management payload.

Common state values: `off`, `unavailable` (switch on, prerequisites missing), `starting`, `connecting`, `ready`, `error`. Tailscale adds `needs-login`. `origin` has no `connecting`.

---

## Local network

### Configuration: `<state>/setup.json` (version 2)

| Field | Type | Notes |
|---|---|---|
| `version` | `2` | |
| `networkInterface` | string | OS interface name — the address is **not** stored, so DHCP changes follow automatically |
| `listenPort` | integer 1024–65535 | Default 3443 |
| `upstreamOrigin` | string | Compatibility snapshot only; the runtime follows the live DSH WebServer port |
| `extraAllowedCidrs` | string[] | Additional trusted networks |
| `loopbackTunnel` | boolean | Adds `127.0.0.1`/`::1` to the certificate SAN and accepted authorities |
| `loopbackTunnelPort` | integer 1–65535 | Defaults to `listenPort` |
| `tls` | object | Paths to the managed CA and leaf under `<state>/tls/` |

### What setup produces

A private EC P-256 CA (5 years) and a leaf (397 days) whose SANs are the LAN address plus loopback when enabled. Two Windows firewall rules named exactly `DSH Mobile HTTPS` (TCP) and `DSH Mobile Discovery` (UDP), scoped to `LocalSubnet`. Non-Windows adds no rules at all.

### Setup facts

```bash
dsh-mobile setup [--address <ip>] [--port 3443] [--dsh-port 3080] [--no-firewall]
```

Run through the profile: `dsh plugin --profile <profile> exec dsh-mobile setup`.

- `--address` must exactly equal one active private LAN address; only the interface name is persisted.
- The CLI does **not** reject the reserved ports 3080/3443/3444.
- Firewall runs before `setup.json` is written: on failure the certificates remain on disk and the setup is not recorded.
- **The first setup requires one DSH restart.** Until then the panel answers `lan_setup_restart_required`.
- Address changes are followed automatically (2 s polling, re-signed leaf, gateway rebind), but the phone's saved origin becomes stale, so it must rediscover or re-pair.

### Device store

`<state>/devices.json` — LAN only.

---

## Tailscale Funnel

### What actually runs

A Go `tsnet` sidecar for `win32-x64`, `linux-x64`, `linux-arm64`, `darwin-x64` and `darwin-arm64`. **Not** the system `tailscale` binary — the plugin never invokes it, and it never downloads the sidecar either.

The sidecar does **not** ship inside the plugin tarball. Each target is its own optional npm package (`dsh-mobile-funnel-<platform>-<arch>`) whose `os`/`cpu` fields make the package manager install only the one this machine can run; the plugin resolves it through the module loader. Two consequences: a registry mirror that has not mirrored the new packages leaves a correct install with no sidecar, which reports `component_missing` even though nothing is wrong with the plugin; and there is no `win32-arm64` package, so Windows on ARM reports the same code.

The sidecar listens on port 443 with `FunnelOnly`, meaning it accepts only the public Funnel path — tailnet-internal access is intentionally rejected. This is why the diagnostic reason `remote-tailnet-shadowed` exists.

### Configuration

Only a switch: `<state>/remote/control.json`. Everything else — the node identity, the login and the certificate — lives in `<state>/remote/tailscale/` and is owned by tsnet. **Do not hand-edit it**; resetting deletes the whole tree and forces a new login.

### Prerequisites, all owned by the user

1. A Tailscale account and **one browser login**. The plugin never sees the password and strips `TS_AUTHKEY`-style environment variables, so an auth key cannot be used instead.
2. The node must be **authorized for Funnel** on the tailnet, by an Owner, Admin or Network admin. Otherwise `funnel_permission_required`.
3. The tailnet must have **HTTPS certificates enabled**. Otherwise `funnel_https_required`, and if the certificate cannot be issued, `funnel_certificate_failed`.
4. The node needs a `*.ts.net` DNS name, otherwise `tailscale_dns_missing`.

### Error codes

Controller: `component_missing`, `component_invalid`, `funnel_state_invalid`, `funnel_start_timeout` (45 s with no event), `sidecar_launch_failed`, `sidecar_stopped`, `sidecar_exited`, `invalid_sidecar_protocol`, `gateway_start_failed`, `control_channel_failed`, `funnel_cleanup_failed`.

Sidecar, passed through verbatim: `invalid_arguments`, `state_directory_failed`, `tailscale_start_failed`, `tailscale_identity_missing`, `tailscale_dns_missing`, `funnel_permission_required`, `funnel_https_required`, `funnel_start_failed`, `funnel_certificate_failed`, `control_channel_failed`.

Only `funnel_permission_required` and `funnel_https_required` carry a `setupUrl` (`https://tailscale.com/s/no-funnel`, `https://tailscale.com/s/https`), plus a validated `https://login.tailscale.com/...` page. Those three origins are the only ones accepted — do not construct a different URL.

### Lifecycle

`reconnect` keeps the login. `reset` deletes the node state (a logout) **and** `<state>/remote/devices.json`, invalidating every remote pairing.

---

## cpolar

### Configuration

| File | Content |
|---|---|
| `<state>/remote/cpolar/control.json` | on/off switch |
| `<state>/state/cpolar/cpolar.yml` | `authtoken: "<token>"`, `console_ui: false`, `update: false`, `inspect_db_size: -1` — 0600, private ACL |

The token is never returned by any status payload and never appears in process arguments. Do not read it out or reprint it.

### Component

Pinned `3.3.18` from `www.cpolar.com`. Supported: `win32-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. Windows ships a zip containing an MSI; the plugin extracts the binary from the MSI's CAB stream **without running the installer**. Verified by content length, archive SHA-256, then executable size and SHA-256.

### Prerequisites

Account; Authtoken from `https://dashboard.cpolar.com/auth`, pasted by the user; the plugin then runs `install` → `configure` → `control{running:true}`.

A **stable** address additionally needs a reserved subdomain in the cpolar console **and** `cpolarSubdomain`/`cpolarRegion` in the profile's `cordis.patch.yml` — the panel has no fields for those — followed by a full DSH restart. Even then the plugin only uses the address cpolar actually reports.

### Address behavior

Without a reserved subdomain, cpolar assigns the address; the plugin learns it from the process output (`Tunnel established at https://...`), validates the domain against the official suffixes, and keeps it **in memory only**. Any restart, reconnect or DSH restart can change it, and the old QR/URL stops working.

### Error codes

`cpolar_component_missing`, `cpolar_component_invalid`, `cpolar_config_missing`, `cpolar_config_invalid`, `cpolar_port_unavailable` (note: `state: 'error'`, not `unavailable`), `cpolar_launch_failed`, `cpolar_start_timeout` (45 s), `cpolar_stopped`, `cpolar_exited`, `cpolar_invalid_output`, `cpolar_invalid_origin`, `gateway_start_failed`.

Install/configure: `cpolar_component_unsupported`, `cpolar_download_failed`, `cpolar_download_timeout`, `cpolar_download_size_mismatch`, `cpolar_download_http_<status>`, `cpolar_download_redirect_*`, `cpolar_download_hash_mismatch`, `cpolar_extract_failed`, `cpolar_executable_missing`, `cpolar_executable_hash_mismatch`, `cpolar_storage_failed`, `cpolar_authtoken_invalid` (HTTP 400).

---

## cloudflared

### Two modes

| Mode | Requires | Fields |
|---|---|---|
| `quick` (default) | Only the component | none — a stray `tunnel.json` in quick mode is deleted |
| `named` | Cloudflare account, connector token, a hostname in that account, a stable local port | `version:1`, `mode:"named"`, `token`, `hostname`, `port` |

`<state>/remote/cloudflared/tunnel.json`, 8192-byte cap, 0600.

Field rules: `token` 32–4096 chars of `[A-Za-z0-9_=+/-]`; `hostname` a real DNS name, not an IP, not a wildcard, and not under `trycloudflare.com`/`cfargotunnel.com`; `port` 1024–65535 and **not 3443** (the LAN gateway). Unknown fields are rejected.

### How it runs

The gateway listens in **plain HTTP** on `127.0.0.1:<port>`; Cloudflare terminates TLS. Quick mode passes `--url http://127.0.0.1:<port>`; named mode runs `tunnel --no-autoupdate run` with the token only in `TUNNEL_TOKEN`. Readiness for named mode requires the connector registration line in the log; for quick mode it requires parsing the public URL out of stdout/stderr.

The quick tunnel URL is random per start and changes on every reconnect. It is a test address: no availability guarantee, no SSE support.

### Component

Pinned `2026.10.7`, five platforms (`win32-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`).

### Error codes

`cloudflared_component_missing`, `cloudflared_component_invalid`, `cloudflared_port_unavailable`, `cloudflared_tunnel_port_unavailable`, `cloudflared_port_reservation_failed`, `cloudflared_launch_failed`, `cloudflared_stopped`, `cloudflared_exited`, `cloudflared_start_timeout` (60 s quick, up to 300 s named), `cloudflared_invalid_output`, `cloudflared_invalid_origin`, `gateway_start_failed`.

Configuration codes (they appear in `providers.cloudflared.configuration.errorCode`, not the controller state): `cloudflared_tunnel_config_invalid`, `cloudflared_tunnel_target_invalid`, `cloudflared_tunnel_token_invalid`, `cloudflared_tunnel_hostname_invalid`, `cloudflared_tunnel_port_invalid`, `cloudflared_tunnel_port_reserved`, `cloudflared_tunnel_settings_invalid`, `cloudflared_tunnel_config_missing`.

Installing an empty token keeps the stored one; FRP does not behave that way.

---

## frp

Two orthogonal dimensions:

| Dimension | Values |
|---|---|
| `mode` | `deploy` (plugin installs frps on a VPS over SSH) or `attach` (user's own frps; the plugin touches nothing on it) |
| `entryTls` | `public-ip-cert` (Caddy on the VPS terminates TLS) or `self-signed` (this computer terminates TLS with its own CA) |

Hard rules: `self-signed` requires `attach`; `attach` + `public-ip-cert` requires an explicit `vhostHttpPort`; `self-signed` requires a public IPv4 entry.

### Configuration: `<state>/remote/frp/config/settings.json`

| Field | Required | Notes |
|---|---|---|
| `serverAddress` | yes | IP or DNS name, no scheme or port |
| `serverPort` | yes | 1–65535 |
| `token` | yes | 16–512 chars |
| `publicOrigin` | yes | `https://` + domain or globally routable IPv4, no port/path/query |
| `mode` | no | `deploy` (default) or `attach` |
| `entryTls` | no | `public-ip-cert` (default) or `self-signed` |
| `vhostHttpPort` | attach+public | Default 7080; must be the real value |
| `publicPort` | no | Default 33080; not 3080/3443/3444 |
| `user` | no | Optional frps user |

The proxy name is derived from the installation id (`dsh-mobile-<12 hex>`), not configurable.

An empty token reuses the stored one **only if** the address and port are unchanged.

### Generated files

`config/frpc.toml` is rewritten per start and deleted on stop. Deploy mode installs frps `0.70.1` as a systemd service with config at `/etc/dsh-mobile/frps.toml`. Self-signed mode keeps its CA and leaf in `<state>/remote/ingress/` with a fingerprint in `<state>/remote/ingress-identity.json`.

Only `http` and `tcp` proxy types are generated. **There is no protocol selector.** stcp is a different feature (see loopback tunnel below) and the plugin manages no frp process for it.

### Components

frpc pinned `0.70.1` for six platforms including `win32-arm64`. Verified by download size and SHA-256, then `frpc --version`.

### Error codes

Controller state: `frp_component_missing`, `frp_component_invalid`, `frp_vhost_publicly_reachable` (a safety gate — the plugin refuses to start when the plaintext vhost port answers from the internet), `frp_vhost_probe_failed`, `gateway_start_failed`, `frp_attach_cert_unknown`, `frp_ingress_*`, `frp_config_verify_failed`, `frp_launch_failed`, `frp_proxy_name_in_use`, `frp_remote_port_in_use`, `frp_proxy_start_failed`, `frp_discovery_mismatch`, `frp_discovery_invalid`, `frp_start_timeout` (45 s), `frp_stopped`, `frp_exited`, `frp_ingress_renewal_failed`.

`frp_config_missing` and `frp_entry_tls_invalid` are **save-time** failures, not controller states: the first comes from `mergeSavedFrpSettings` when the required fields are absent, the second from `parseFrpSettings` when the mode and entry-certificate combination is impossible. Both reach the API as `409` because of the `frp_*` mapping, so do not go looking for them in `state`.

Configuration codes live in `providers.frp.configuration.errorCode`: `frp_config_invalid`, plus save-time `frp_settings_invalid`, `frp_server_address_invalid`, `frp_server_port_invalid`, `frp_token_invalid`, `frp_public_origin_invalid`, `frp_attach_mode_requires_vhost_port`, `frp_self_signed_requires_public_ipv4`, `frp_user_invalid`.

### Loopback tunnel (not an FRP channel)

A LAN setting: `<state>/setup.json` gains `loopbackTunnel` and `loopbackTunnelPort`. The plugin only adds `127.0.0.1`/`::1` to the certificate SAN and accepts those authorities. **The tunnel itself — for example an frp stcp visitor — is entirely the user's.** Changing it requires a DSH restart or a LAN rebind.

---

## origin

It is **not** a tunnel. The plugin runs a private, fully authenticated HTTP backend; the user's own reverse proxy terminates public HTTPS and forwards to it with the original `Host` and `Origin` preserved.

`external` mode readiness means **the local listener is up** — it says nothing about public reachability.

### Configuration: `<state>/remote/origin/config/settings.json`

| Field | Notes |
|---|---|
| `publicOrigin` | `https://` host; port optional (443); no IPv6 literal; no path/query/credentials; excludes `localhost`, `.local`, `.lan`, `.home`, `.internal`, `.home.arpa` |
| `listenHost` | Loopback, RFC1918, or IPv6 ULA only — `0.0.0.0` and public IPs are rejected |
| `listenPort` | 1024–65535; not 3443 or 3080; default 3444 |
| `allowedCidrs` | Up to 16; must fall inside loopback/RFC1918/ULA; a non-loopback listen host needs at least one non-loopback CIDR |

`upstream.json` selects `{"version":1,"mode":"external"|"managed"}`. A corrupt `upstream.json` fails plugin activation; a corrupt `settings.json` only degrades to `origin_config_invalid`.

### Managed Caddy mode

An `origin` upstream mode, not another channel. Requires a domain, **Tencent Cloud DNSPod credentials** (only `tencentcloud` is supported), a free local HTTPS port (1024–65535, not 3080/3443/3444; default 8443), and real public HTTPS ingress. DNS-01 proves domain control only — it does **not** solve CGNAT or a network without inbound access. Readiness is only reported after a public HTTPS probe returns this instance's `instanceId`.

The Caddy component exists for `win32-x64` and `linux-x64` only.

Configuration and install errors from Caddy surface through the management API as **HTTP 500 `internal_error`** (a mapping gap); the real `caddy_*` code is only in the log and component state.

### Error codes

Controller: `origin_config_missing`, `origin_config_invalid`, `origin_listen_port_in_use`, `origin_listen_address_unavailable`, `origin_gateway_start_failed`.

Caddy: `caddy_config_missing`, `caddy_component_unavailable`, `caddy_credentials_missing`, `caddy_config_validation_failed`, `caddy_launch_failed`, `caddy_exited`, `caddy_start_timeout` (120 s), `caddy_start_cancelled`, `caddy_public_identity_invalid`, `caddy_backend_port_in_use`, `caddy_start_failed`, `caddy_cleanup_failed`.

Save-time: `origin_settings_invalid`, `origin_public_origin_invalid`, `origin_listen_host_invalid`, `origin_listen_port_invalid`, `origin_listen_port_reserved`, `origin_allowed_cidrs_invalid`, `origin_mode_invalid`.

---

## iroh

Experimental. The phone must run the full Android app; browsers cannot use it.

### Component

`IROH_VERSION = 0.1.0-alpha.2`, four targets:

| Target | Bytes | SHA-256 |
|---|---|---|
| `win32-x64` | 14,861,312 | `38d32e37e535ae5c7174008057326fe1afdb1859650871043f02622099fc6cfa` |
| `linux-x64` | 24,451,352 | `be391dfba3f0f1323d4fe9989e56a0554ceaf74e00a44acdf4a3bfd163bdcab5` |
| `darwin-x64` | 18,084,584 | `2420851d31239e8a4f875370debc774ac82a89567445d96a64e6725ee15bd596` |
| `darwin-arm64` | 17,632,400 | `e6106f481f8a1c1e2cb9d83e6e0bc91aaca1ce6d468556d387fcdc394f36ad29` |

Downloaded from `https://unpkg.com/dsh-mobile-iroh@<version>/native/<file>`. Any other platform reports `irohPlatformUnsupported` (component state) / `iroh_platform_unsupported` (thrown code).

**Installing is the only thing that downloads.** Starting a channel uses `ensureAvailable()` and never downloads; a component can also be reused from the companion `dsh-mobile-iroh` package if its native manifest validates.

A damaged component reports `irohSidecarInvalid` / `iroh_sidecar_invalid` instead of downloading a replacement. `purge` deletes only the current version directory — it keeps the identity, the pairings, and any older version directory, which is never cleaned up automatically.

### State

`<state>/remote/iroh/sidecar/` holds the transport layer's own files: `host.lock`, `identity.key` (the endpoint secret), `paired.json` (transport peers), `tls.lock`, `tls-state.json` and `tls/`. The path contains **no version**, so a component upgrade keeps the identity and transport pairings.

The certificate the **phone** pins is different: `<state>/iroh-tls/ca.pem` — a sibling of `remote/`, not a child of it — recorded with `caFingerprint` in `<state>/remote/iroh-identity.json`. Do not confuse the two.

### Pairing

Two-stage, unlike every other channel: the sidecar issues a 6-digit transport code (10 minutes, 3 attempts) and the gateway opens a 43-character token window (5 minutes). The QR content is a **JSON descriptor**, not a URL, with exactly these ten fields: `version`, `type` (`dsh-mobile-iroh-pairing`), `endpointId`, `origin`, `localPort` (25443), `irohCode`, `gatewayToken`, `caCertificate`, `instanceId` (the CA fingerprint), `expiresAt`. Maximum 2200 bytes.

Treat the descriptor as a secret: it contains the code and the token.

The peer registry (`paired.json`) and the device store are separate authorizations. Revoking a device does not revoke the transport peer.

### Error codes

Component: `iroh_platform_unsupported`, `iroh_companion_missing`, `iroh_sidecar_invalid`, `iroh_artifact_invalid`, `iroh_download_failed`, `iroh_download_timeout`, `iroh_download_size_mismatch`, `iroh_download_hash_mismatch`, `iroh_download_http_<status>`, `iroh_download_redirect_*`, `iroh_component_cleanup_failed`.

Runtime: `iroh_not_ready`, `iroh_pairing_failed`, `iroh_identity_timeout`, `iroh_identity_output_too_large`, `iroh_identity_failed`, `iroh_identity_invalid`, `iroh_data_directory_insecure`, `iroh_data_directory_invalid`, `iroh_launch_failed`, `iroh_start_timeout` (45 s), `iroh_start_failed`, `iroh_exited`, `iroh_cleanup_failed`, `gateway_start_failed` (hides the specific `iroh_tls_*` cause), `iroh_component_running` (HTTP 409).

`ready` means the sidecar connected and the loopback gateway is listening. It does **not** mean the phone can reach it.
