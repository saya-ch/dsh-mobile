# Logs and diagnostics

## Log file

`<state>/logs/dsh-mobile.log`. One JSON object per line:

```json
{"timestamp":"<ISO 8601>","level":"info|warn|error|debug","logger":"dsh-mobile","message":"<text>"}
```

`logger` is always `dsh-mobile` — this is the plugin's log, not DSH's. The file rotates to `dsh-mobile.log.1` at 5 MiB, keeping one generation. Writes are `0600` and refuse symlinks. If the file cannot be written the sink disables itself, prints a warning, and other logging continues.

Diagnostic payloads are JSON **inside the message string**, because the plugin logs `'http failure %s', JSON.stringify(entry)`.

## `http failure`

Four mutually exclusive shapes, plus an optional `suppressed` count:

| `kind` | Fields | Meaning |
|---|---|---|
| `parser` | `status` 400/408/431, `code` | Malformed or oversized request. `ERR_HTTP_REQUEST_TIMEOUT` → 408; `HPE_HEADER_OVERFLOW` → 431; everything else 400, unknown codes become `other`. |
| `transport` | `code` = `ECONNRESET` / `EPIPE` / `ETIMEDOUT` / `ERR_STREAM_PREMATURE_CLOSE` | Connection-layer failure. **No HTTP status** — this is not a 400 and does not indicate a malformed request. |
| `target` | `status` 400, `code` `bad_request` | Invalid request target (URL shape). |
| `upstream` | `status` 4xx/5xx, `method` POST, `path` `/api/session/prompt` | An authenticated prompt was rejected by DSH. Only this route is sampled. |

`suppressed` counts occurrences skipped since the last recorded line of the same kind.

## `auth failure`

`{kind: 'authorize'|'csrf', status, method, path, sessionCookie, csrfHeader, csrfCookies, origin?, site?, device?, suppressed?}`

`path` is a **category** (`/`, `/api/*`, `/plugins/*`, `/assets/*`, `/mobile-access/*`), never the raw path. `device` is the first 8 characters of an authorized device id.

## `upstream auth`

`{sequence, outcome, stage, durationMs, status?, suppressed?}`

- `outcome`: `accepted`, `invalid-target`, `unexpected-status`, `invalid-cookie`, `timeout`, `transport-error`.
- `stage`: `target` → `request` → `response` → `cookie`.
- `status` is the **upstream** HTTP status, not what the phone saw.

`accepted` means the gateway successfully authenticated to DSH. A browser still seeing a login page after that points at browser cookies, not at DSH.

## `slow api`

`{kind: 'api', method, path, status, durationMs, suppressed?}` for proxied API responses taking at least 3000 ms. `path` is a fixed first-segment category; query strings are dropped. `status: 0` means no response headers were sent (the client gave up).

## Sampling

Every class keeps a 30-second window per kind, recording the first occurrence immediately and counting the rest into `suppressed`. **No line does not prove no event**, and a `suppressed` count is not the real failure total.

## Connection diagnostics

`GET /api/mobile-access/diagnostics` returns:

`{version, generatedAt, overall, versions, summary, checks[], report, coverage}`

`overall` is `ok`, `attention` or `error`. `coverage` states `measuredFrom: 'computer'` and lists `phone`, `authenticated-page`, `resources`, `websocket` as **unverified**. A green report therefore does not mean the phone works.

### Checks, in order

| id | What it reports |
|---|---|
| `versions` | Plugin, DSH and minimum Android app version |
| `remote-plugin-conflict` | Another plugin owns the page transport |
| `plugin-inspection` | Whether page injection could be read |
| `network` | LAN setup state, chosen interface, unavailable/fixed network |
| `lan` | LAN listener up or off |
| `firewall` | Windows rules present and enabled (read-only probe) |
| `remote-service` | Remote channel running and ready |
| `remote-dns` | DNS classification: public, tailnet, fake-IP, private, mixed, unknown |
| `remote` | Per-channel readiness, or the controller error with `facts.controllerCode` |
| `phone-network` | Always `unknown` — the computer cannot measure it |

Remote health probing only runs for a running, ready, non-`origin`, non-`iroh` channel with an `origin`, by requesting `<origin>/mobile-access/health` (6 s budget). If a direct attempt fails and a proxy is configured, it retries through the proxy.

### Reasons worth knowing

`remote-tailnet-shadowed` — the computer resolves the Funnel name to a tailnet address, so a failure here does not prove the public route is broken. Try from outside the tailnet.

`remote-fake-ip` / `dns-fake-ip` — DNS returns a proxy fake-IP, so reachability results are not trustworthy.

`remote-controller-error` — carries the channel's `errorCode`; look it up in the channel reference.

`remote-rate-limited`, `remote-needs-login`, `remote-connecting`, `remote-unreachable`, `remote-probe-timeout`, `remote-tls-failed`, `remote-http-failed`, `remote-dns-failed`.

LAN reasons: `lan-setup-required`, `network-unavailable`, `network-interface`, `network-fixed`, `lan-ready`, `lan-off`, `firewall-ready`, `firewall-missing`, `firewall-unknown`, `firewall-inactive`.

## Diagnosing from evidence

| Observation | Conclusion | What it does not tell you |
|---|---|---|
| `parser` + `ERR_HTTP_REQUEST_TIMEOUT` | The whole request took longer than the receive deadline (5 minutes by default) | Not that the model is slow; not that upstream rejected anything |
| `parser` + `HPE_HEADER_OVERFLOW` | Request headers exceeded the budget | Which side sent them |
| `transport` + `ECONNRESET` | Connection reset | **Not** a 400; not a request-format problem |
| `auth failure` `sessionCookie: false` | The browser sent no session cookie | Not that the password or pairing is wrong |
| `auth failure` `kind: csrf` | Session present, CSRF header missing or wrong | Not that an attack succeeded |
| `upstream auth accepted` | The gateway authenticated to DSH | Not that the page, assets or WebSocket work |
| `upstream auth` `stage: response` | Token exchange returned an unexpected status | Not that session data is corrupt |
| `slow api` ≥3000 ms | The proxied request waited | Not where the latency was introduced |
| No `iroh_tls_*` code anywhere | Expected: iroh collapses TLS failures into `gateway_start_failed` | The specific TLS cause, which is only in the log text |

## What cannot be measured from here

The computer cannot verify the phone's network, the authenticated page in the phone's browser, resource loading, or WebSocket behaviour. Say so instead of presenting a computer-side check as end-to-end verification.
