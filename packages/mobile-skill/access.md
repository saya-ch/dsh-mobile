# DSH Mobile access

DSH Mobile exposes the DSH desktop to a phone through one HTTPS gateway. Use this when a phone cannot reach DSH, when a channel must be enabled, switched or configured, or when the user asks which channel to use.

Two independent things exist, and confusing them is the most common diagnostic error:

- **Local network (LAN)** — the gateway listens on the computer's private IPv4 address. Works with no account and no internet.
- **One remote channel** — `tailscale` (Funnel), `cpolar`, `cloudflared`, `frp`, `origin` (own reverse proxy) or `iroh`. Exactly one can be enabled: changing the provider disables all others. LAN is unaffected by this.

## Five facts that decide most answers

1. **`enabled` is not "working".** Each channel persists a boolean switch; readiness is `state === 'ready'` plus an `origin`. `enabled: true` with `state: 'error'` is normal and means the switch is on but the channel failed.
2. **LAN and remote keep separate device stores.** LAN devices are in `<state>/devices.json`; all remote channels share `<state>/remote/devices.json`. Revoking on one side does not touch the other.
3. **Pairing is the only authorization.** A pairing code authorizes a phone; it does not keep a channel running. Codes live in gateway memory only, are single-use, and expire in **2 minutes** by default (5 minutes on iroh).
4. **The current channel is whatever `<state>/remote/provider.json` says.** Do not infer it from which directories exist; every channel keeps its configuration whether or not it is selected.
5. **Secrets never leave the machine.** Pairing codes, `dsh1.`/`dsh2.` keys, iroh descriptors, `deviceToken`, `sessionToken`, `csrfToken`, cookies, `identity.key`, `*-key.pem` and `tls-state.json` must never be printed, pasted into a reply, or written to a log. If the user needs one, they generate it themselves in the panel.

## Where the state lives

`<state>` is `$DSH_HOME/mobile-access` (`~/.dsh/mobile-access` by default).

```
mobile-access/
├── setup.json                 LAN configuration (version 2)
├── control.json               LAN on/off switch
├── devices.json               LAN device store
├── tls/                       LAN CA and leaf certificates
│   ├── ca.pem  ca-key.pem  server-cert.pem  server-key.pem
│   └── dsh-mobile-ca.cer      CA DER for the phone
├── logs/dsh-mobile.log        plugin log; rotated to .1 at 5 MiB
├── mobile.css  mobile.js      user customizations
├── extensions/                user extension modules
├── components/<name>/<ver>/   downloaded components
├── staging/                   install scratch space
└── remote/
    ├── provider.json          {"version":1,"provider":"<channel>"}
    ├── devices.json           device store shared by all remote channels
    ├── control.json           Tailscale on/off switch
    ├── tailscale/             tsnet node state
    ├── cpolar/                control.json + state/cpolar/cpolar.yml (Authtoken)
    ├── cloudflared/           control.json + tunnel.json (quick/named config)
    ├── frp/                   control.json + config/settings.json + frpc.toml
    ├── origin/                control.json + config/settings.json + upstream.json
    ├── iroh/                  control.json + sidecar/ (identity, peers, TLS)
    ├── iroh-tls/              CA the phone pins for iroh
    ├── iroh-identity.json     {"version":1,"endpointId","caFingerprint"}
    └── ingress/               self-signed FRP entry CA and leaf
```

Managed Caddy (an `origin` upstream mode) keeps its own tree at `<state>/caddy/`.

There is **no** `<state>/lan/` directory.

## Channels at a glance

| Channel | Needs from the user | Configured in | Plugin downloads |
|---|---|---|---|
| LAN | Choosing a network; Windows UAC for two firewall rules; one DSH restart after first setup | `<state>/setup.json` | nothing |
| `tailscale` | Tailscale account; sign in once in a browser; **Funnel enabled** for the tailnet; **HTTPS certificates enabled**; Owner/Admin/Network-admin to authorize | panel only | Funnel sidecar (bundled per platform, no download) |
| `cpolar` | cpolar account; Authtoken from `dashboard.cpolar.com/auth`; optional reserved subdomain | panel + `<state>/state/cpolar/cpolar.yml` | cpolar 3.3.18 |
| `cloudflared` | Nothing for a quick tunnel; for a named tunnel: Cloudflare account, connector token, a hostname in that account, and the route pointing at `http://127.0.0.1:<port>` | `<state>/remote/cloudflared/tunnel.json` | cloudflared 2026.10.7 |
| `frp` | A public VPS running frps (or an existing frps to attach to), plus a domain or public IPv4 | `<state>/remote/frp/config/settings.json` | frpc 0.70.1 |
| `origin` | Their own reverse proxy terminating public HTTPS, plus reachable public ingress | `<state>/remote/origin/config/settings.json` | nothing (or Caddy, if managed mode) |
| `iroh` | The full Android app; the component download | `<state>/remote/iroh/control.json` | iroh host 0.1.0-alpha.2 |

**Never perform an account step for the user.** Signing in to Tailscale, pasting a cpolar Authtoken, creating a Cloudflare tunnel and confirming an SSH host key all authorize access to their machine. Explain the step and let them do it.

**A component install is a download the user triggers.** Every install route requires an explicit `confirm: true`; do not install components on your own initiative.

## Choosing a channel

- Same Wi-Fi, no account → **LAN**. One setup command, no third party.
- Tailscale account exists, no public ingress → **Funnel**: stable `*.ts.net` name, no router changes.
- Mainland China networks → **cpolar** is usually more reliable than Cloudflare there.
- Cloudflare already in use → **cloudflared**; quick tunnel for a one-off address, named tunnel for a stable hostname.
- Already running frps → **frp** (attach mode touches nothing on their server).
- Own reverse proxy with public HTTPS → **origin**.
- No account anywhere and both ends can reach a relay → **iroh** (experimental; needs the full App, not a browser).

State the trade-off instead of choosing silently: a remote channel puts the desktop behind a public URL, and pairing is what keeps it private.

## Writing configuration

Read state from files. **Change it through the local management API.**

The plugin holds configuration in memory: it reads each settings file once when the plugin activates and only updates that copy when a management route writes it. Editing `<state>/remote/.../settings.json` directly therefore changes nothing — the panel keeps showing the previous value, and the channel keeps using it.

Every local management route needs two things:

- the base URL, available as `$DSH_WEB_URL` in the agent shell;
- an `Origin` header equal to that same URL. Without it the gateway answers `403 forbidden` before it validates anything.

```bash
# read the current state of every channel
curl -s "$DSH_WEB_URL/api/mobile-access/remote/control" -H "Origin: $DSH_WEB_URL"

# write FRP configuration
curl -s -X POST "$DSH_WEB_URL/api/mobile-access/remote/frp/configure" \
  -H "Content-Type: application/json" \
  -H "Origin: $DSH_WEB_URL" \
  -d '{"serverAddress":"frp.example.com","serverPort":7000,
       "token":"<token>","publicOrigin":"https://mobile.example.com"}'
```

A successful write answers `200` with the whole remote payload, and the change is live immediately — there is no reload step and no DSH restart.

**Credentials are allowed through these routes, with a condition.** Before sending a token, key or account secret, state its purpose to the user in that same turn — "I will use the cpolar Authtoken you provided to register the tunnel". Then: never echo it back, never write it to a file or a log, never carry one over from an earlier turn without asking again. If the user has not supplied the credential, stop and ask for it rather than inventing one.

Two token-reuse rules differ and are easy to get wrong:

- **cloudflared** keeps the stored token whenever the field is empty.
- **frp** reuses the stored token only when the address and port are unchanged; changing either while leaving the token empty fails with `frp_token_invalid`.

Full route list: [management-api.md](references/management-api.md)

## Reading state without the panel

Read files under `<state>` (all are JSON unless noted):

- Current channel: `remote/provider.json` → `provider`.
- Per-channel switch: `remote/<channel>/control.json` → `enabled` (Tailscale uses `remote/control.json`).
- LAN: `setup.json` (interface name, port, TLS paths) and `control.json`.
- Devices: `devices.json` (LAN) and `remote/devices.json` (remote). Both are `{"version":2,"devices":[...]}` with `id`, `label`, `tokenDigest`, `createdAt`, `expiresAt`, `lastSeenAt`, `nativeInstanceId?`. **No device token, origin, endpoint id or certificate is stored there.**
- Components: `components/<name>/<version>/`.
- Log: `logs/dsh-mobile.log`, one JSON object per line: `{"timestamp","level","logger":"dsh-mobile","message"}`.

Runtime state (`state`, `origin`, `errorCode`, `loginUrl`, `setupUrl`) is **in memory only** — it is not on disk, and the panel's management API is the only way to read it. That API (`/api/mobile-access/...`) requires a loopback peer plus DSH desktop authentication, so a shell usually cannot call it. Read the files and the log, and ask the user to read the panel.

## Reading the log

`http failure` lines carry a `kind`:

- `parser` — malformed or oversized request; has `status` (400/408/431) and an HTTP parser `code`. `ERR_HTTP_REQUEST_TIMEOUT` means the whole request body took too long (5 minutes by default).
- `transport` — connection reset or closed (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`); no HTTP status. Usually the network path, not a request defect.
- `target` — invalid request target (URL shape).
- `upstream` — an authenticated prompt was rejected by DSH itself; only `/api/session/prompt` is sampled.

Other lines: `auth failure` (authorize/CSRF), `upstream auth` (`outcome`, `stage`, `status` — `accepted` means the gateway authenticated to DSH successfully), `slow api` (≥3 s).

Every class is **sampled with a 30-second window** and carries `suppressed` for skipped occurrences. Absence of a line does not prove absence of the event.

## Boundaries

- Do not disable authentication, CSRF, certificate validation, ACL checks or CIDR restrictions to make something connect.
- Do not revoke devices, reset device stores, switch channels, purge components or run `dsh-mobile purge --yes` unless the user asked for it in that turn. Each disconnects phones immediately.
- Do not hand-edit or delete `devices.json`, `paired.json`, `identity.key`, `tls-state.json`, `iroh-identity.json`, `control.json` or `provider.json`. Replacing a CA or identity invalidates pairings.
- Do not claim a channel is verified from its own status. Diagnostics measure the computer only; the phone, the authenticated page, resources and WebSockets are explicitly unverified.
- Do not treat a green diagnostic, `state: 'ready'` or `upstream auth accepted` as proof that the phone works.

## Further detail

- Channel fields, states and every error code: [channels.md](references/channels.md)
- Every management route, its body and its errors: [management-api.md](references/management-api.md)
- Pairing internals, device store and cookie attributes: [pairing.md](references/pairing.md)
- Log line fields and the diagnostic checks: [diagnostics.md](references/diagnostics.md)
