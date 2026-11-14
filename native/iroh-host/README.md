# iroh host byte carrier

This crate owns one authenticated iroh endpoint and its paired peer registry. It forwards bounded concurrent streams only to one explicitly configured loopback TCP socket. The forwarded bytes are not parsed or rewritten: a TLS gateway retains its own certificate, Host, Origin, cookies, CSRF and WebSocket authorization checks. iroh pairing is transport authorization, not a replacement for DSH Mobile device credentials.

## Commands

```powershell
cargo build --locked --manifest-path native/Cargo.toml -p dsh-mobile-iroh-host
./native/target/debug/dsh-mobile-iroh-host host --data-dir <private-directory> --pair --proxy-target 127.0.0.1:3443
```

Run both commands from the repository root; the workspace root is `native/`, so cargo still writes to `native/target` (on Windows the debug binary is `dsh-mobile-iroh-host.exe`). The parent owns stdin and stdout. Closing stdin or sending `shutdown` closes the endpoint, active peer connections and their proxy tasks, then emits `stopped`. One OS file lock prevents simultaneous hosts from using the same data directory. Corrupt or unreadable identity/paired-device files fail startup rather than generating a new identity or opening a new pairing window.

Windows opens the verified private lock file without delete sharing, so its active pathname cannot be unlinked or renamed to bypass the lock. On Unix, the profile directory must remain exclusively application-owned and its `host.lock` pathname must not be manually removed while a host runs: advisory file locking does not prevent a process with the same UID from unlinking a locked inode. A compromised current user is outside the local credential isolation model.

On Windows, the default profile is `%USERPROFILE%\.dsh-mobile-iroh`. New private directories and secret/temporary files receive a protected DACL at creation, granting only the current user, SYSTEM and Administrators. Reads verify the existing owner and DACL before reading bytes through the same non-reparse handle. Every ancestor is checked for reparse points and untrusted replacement rights, with non-delete-shared handles held during the operation. An existing broadly accessible directory/file is rejected, not silently repaired; select a new private profile directory instead. Shared development folders and some sandbox-modified Temp/AppData directories therefore cannot be used as credential stores. Existing broad parent directories are never reconfigured by this implementation.

Windows acceptance includes real DACL inspection, current-token access allowed, an Everyone-restricted token rejected by `AccessCheck`, existing world-readable files rejected without replacement, a real owned junction rejected, and concurrent/exclusive temporary-file checks. This is same-machine restricted-token evidence, not an actual second-user login or a defense against a compromised current user, administrator or SYSTEM account.

On non-Android Unix, a non-sticky ancestor may not be group-writable even when its group is GID 0. Group membership is not equivalent to root UID. Android's explicitly trusted system/app ancestor groups are separate from this rule; the application's private leaf still forbids all group/other access.

On POSIX systems, existing directory/file ownership and modes are verified without `chmod`: broad legacy files such as a `0644` identity are rejected before reading and remain unchanged. New profile directories and files request `0700`/`0600`; safe stricter owner permissions remain valid. Parent traversal uses directory descriptors with `O_NOFOLLOW`, `openat` and `fstat`; reads, lock creation and atomic `renameat`/`unlinkat` keep the verified parent descriptor. Linux/Android use `O_PATH` for execute-only ancestors, then reopen the verified private leaf for directory sync. macOS uses `O_SEARCH`. Fixed system-owned `/var`, `/tmp`, `/home` and Android `/data/data`/`/data/user/0` aliases are resolved to an actual root that is then independently verified; arbitrary user symlinks are rejected. A root-owned sticky temporary ancestor is allowed, but the application profile below it must remain current-user-private. Android system UID/GID 1000 is trusted only as an operating-system ancestor, never as a substitute owner for the App's private leaf.

`--local-only` on both `host` and `phone-sim` disables public relay and discovery and binds iroh to loopback. Copy each `ready.direct_addresses` value to a repeated `phone-sim --peer-address <socket>` argument, and also supply `--peer <endpoint_id>`. Direct addresses never replace the authenticated endpoint identity. `--proxy-listen 127.0.0.1:0` selects an available local port; the actual origin is returned in `proxy-ready`. Local-only checks do not establish public NAT or relay behavior.

## Parent stdio protocol, version 1

Every newline-terminated UTF-8 command includes `"version":1`. Unknown/duplicate fields, explicit nulls, unsupported commands and lines over 16 KiB are rejected. Invalid commands stop the sidecar rather than leaving a parent with uncertain authorization state. Commands contain no gateway/DSH credential injection operation.

| Command | Additional fields |
| --- | --- |
| `pairing-begin` | None |
| `device-list` | None |
| `device-forget` | `id`: canonical authenticated EndpointId |
| `shutdown` | None |

Every stdout event includes `"version":1` and `type`.

| Event | Additional fields |
| --- | --- |
| `ready` | `endpoint_id`, `direct_addresses` (socket strings), `local_only` |
| `pairing` | `code`, `expires_in_sec` |
| `pairing-closed` | `reason` |
| `pairing-done` | `peer`, `name` |
| `peer-connected` | `peer`, `name` |
| `peer-path` | `peer`, `kind` (`direct` or `relay`), `remote` |
| `peer-disconnected` | `peer` |
| `proxy-opened` | `peer` (first accepted proxy attempt per connection) |
| `devices` | `devices`: `{id,name,paired_at,online}[]` |
| `error` | `code`, `message` (sanitized, not the original command) |
| `stopped` | None |
| `proxy-ready` | `origin` (phone-sim only, after handshake ACK and successful local bind) |

The pairing code is an intentional private control response for the owning parent; do not mirror it into telemetry or human-readable logs. Device and path events contain identifiers/network addresses, not DSH credentials or model content. Proxy payloads are never logged.

## Peer protocol

ALPN is `dsh-mobile-iroh/0`. Every first control or proxy-stream line requires `"version":1`; the decoder is shared by host, Android transport and phone-sim. A new peer sends `pair` with a six-ASCII-digit `code` and a trimmed 1–64 character `name`. Only a successful private-state write permits `pair-ok`. A paired peer sends `hello` with `name` and must receive `hello-ok` before exposing its local proxy. Unknown fields and extra post-handshake control messages are rejected.

The control stream remains owned for the entire connection. EOF, protocol error, replacement or revocation closes the connection and all proxy tasks. A later connection generation cannot be removed by an older handler's teardown. An already paired endpoint can explicitly pair again with a fresh valid pairing window, which permits recovery when gateway authorization failed after transport pairing; this updates the existing row, does not duplicate it and never bypasses the new code. `device-forget` persists revocation before changing in-memory authorization or closing the targeted peer; a persistence failure stops the host rather than reporting success. Other peers are not revoked.

Each later bidirectional stream begins with `{"version":1,"type":"proxy"}` plus a newline, then carries unmodified TCP bytes. QUIC's authenticated transport protects network replay; this carrier does not accept standalone approvals or decisions. The host bounds concurrent connections, per-peer/global proxy streams, handshake time, proxy discriminator time and loopback connect time. Streams that exceed capacity are reset rather than queued indefinitely. Long-running authenticated payload streams remain open until the gateway, peer or owner closes them.

## Downloaded release and pin

The plugin does not build this crate on the user's machine. It downloads the pinned `dsh-mobile-iroh 0.1.0-alpha.1` release for the current platform from the npm CDN, verifies the byte length and SHA-256, and only then promotes the executable into plugin-private storage; an already installed companion with a verified copy is reused instead of downloading. The authoritative bytes and hashes are `src/iroh-component.ts` line 14 (`IROH_VERSION`) and lines 34-49 (per-platform entries: Windows x64 14,865,920 bytes, Linux x64 24,451,352 bytes).

Local and CI builds use `npm run build:iroh-host` (`scripts/build-iroh-host.mjs`), not the debug command above. It builds the release profile through `native/Cargo.toml`, copies the binary from `native/target/release` to `bin/` under its published name (`dsh-mobile-iroh-host-win32-x64.exe` or `dsh-mobile-iroh-host-linux-x64`), checks the executable header and prints `bytes`/`sha256` for the release manifest. CI runs the same script in the repository's `iroh host` job (`.github/workflows/ci.yml`).

## Verification

`cargo test --locked --manifest-path native/Cargo.toml -p dsh-mobile-iroh-core -p dsh-mobile-iroh-host` includes real offline QUIC endpoints, handshake rejection, durable pairing and Hello ACK, same-peer replacement, raw HTTP/cookies/WebSocket/binary forwarding, revocation, control EOF and persistence failure. These checks do not establish Android WebView integration, production DSH authorization or public-network support. Process-level smoke is owned by the repository's JavaScript harness.
