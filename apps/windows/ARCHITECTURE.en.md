# Architecture and security model

[简体中文](ARCHITECTURE.md) · [Back to README](README.en.md)

This document describes the Windows client internals for maintainers and follow-up work. Features, build commands, status and support are in [README.en.md](README.en.md).

> Status: the client is merged into `main`, but it is not shipped in any Release and has not completed maintainer acceptance on real Windows hardware; see "Status and support" in the README.

## Component responsibilities

| File | Responsibility |
| --- | --- |
| `App.xaml(.cs)` | Application startup, system light/dark following, and the `DSH_MOBILE_THEME=light\|dark` override |
| `MainWindow.xaml(.cs)` | WPF shell: connect page + browser page, device list, connect/reconnect orchestration, WebView2 boundary policy |
| `UrlPairing.cs` | Parses `https://…/mobile-access/pair#…` links (legacy `instance/token` or a `dsh1`/`dsh2` key) and classifies LAN/remote through the `RemoteHostPolicy` in the same file |
| `PairingTrustPolicy.cs` | `/mobile-access/ca.cer` outcome decision (whether a 404 may fall back to platform trust), mirroring Android `PairingTrust.selectTrustAnchor` / `RemotePairingTrust.decide` |
| `PairingDescriptor.cs` | Parses the iroh pairing JSON descriptor (EndpointId / Hostname / Origin / LocalPort / InstanceId / CA) |
| `GatewayAuth.cs` | Second authorization layer over the TLS carrier: `native-pair` / `native-renew`, plus the `/mobile-access/ca.cer` bootstrap |
| `CertificatePolicy.cs` | Pairing-CA pinning, leaf certificate validation, CA fingerprint anchoring |
| `IrohCarrier.cs` | Runs the pinned `phone-sim` sidecar process; re-verifies the binary pin before launch |
| `SidecarProvisioner.cs` | Acquires and verifies the official sidecar by pinned URL, byte count and SHA-256; the binary is not distributed in this repository |
| `DeviceStore.cs` | Atomic device-record I/O, DPAPI encryption, and per-load validation |
| `DshMobile.Win.Tests/` | Pure-logic unit tests (pairing links, trust decisions, certificate chain/SAN, device store, sidecar pin) |

## Two layers

1. **TLS carrier**: certificates pinned to the pairing CA (or platform trust for a public-CA remote key).
2. **Application-layer authentication**: `native-pair` (first time) or `native-renew` (reconnect) on the established TLS, independent of certificate validation.

## Three connection channels

### iroh

```
client ──SslStream──▶ 127.0.0.1:<LocalPort> ──sidecar──▶ QUIC(ALPN dsh-mobile-iroh/0) ──▶ remote Gateway
```

- Sidecar arguments: `phone-sim --data-dir <dir> --peer <EndpointId> --name … --proxy-listen 127.0.0.1:<LocalPort>`; first-time pairing appends `--code <pairingCode>`.
- Wire: with a code the sidecar sends `Pair`; without one it sends `Hello` (reconnect for an already-paired device without a pairing window).
- The sidecar uses `presets::N0` (discovery + relay); the loopback listener forwards **raw TLS bytes**, and TLS still terminates at the remote Gateway.
- The client connects to `127.0.0.1:<LocalPort>`, uses the remote `Hostname` as SNI, and validates the leaf against the pinned CA.
- **The sidecar is not committed**: the authoritative pin is `IROH_COMPONENT_RELEASES['win32-x64']` in `src/iroh-component.ts`; `SidecarProvisioner` hardcodes the same values and `sidecar/manifest.json` mirrors them, with no machine check across the three copies (update all three when the upstream pin moves). On first use `SidecarProvisioner` downloads from the pinned URL, verifies byte count + SHA-256, or reuses the copy installed by the DSH Mobile plugin (default `~/.dsh` layout only). A corrupt cache is deleted and re-fetched, and `IrohCarrier.StartAsync` re-verifies before every process start, refusing to launch on a hash mismatch. License texts ship under `sidecar/` (repository only; not copied by `dotnet publish`).

### LAN / remote (direct)

```
client ──TCP──▶ https origin ──GET /mobile-access/ca.cer(TOFU)──▶ pinned CA ──SslStream(pin)──▶ native-pair/renew
```

- Link forms: `https://<origin>/mobile-access/pair#instance=<64hex>&token=<43base64url>`, or `#key=dsh1|dsh2.<64hex>.<43base64url>`; a bare `https://origin` is also accepted (the fragment credential is still required).
- Classification: `RemoteHostPolicy` treats tunnel suffixes (`*.ts.net`, `.cpolar.cn` / `.cpolar.io` / `.cpolar.top` / `.cpolar.com`, `*.trycloudflare.com`), private/loopback/link-local ranges, and `.local` / `.lan` / `.home` / `.internal` / `.localhost` as well as single-label hostnames as LAN or remote.
- Bootstrap: first connect with TOFU to fetch `/mobile-access/ca.cer`. A `dsh2` key (`requiresCa=true`) requires the pairing CA — **a 404 is an identity mismatch and fails closed**; `dsh1` and the legacy `instance/token` form describe a public-CA gateway and may fall back to platform trust only on the remote channel after an explicit 404; a LAN 404 always fails; an already-pinned device is never downgraded. The decision lives in `PairingTrustPolicy.Decide`, and `requiresCa` is persisted in the device record and re-validated on every load.

## Trust model

- **The pairing CA is the only trust anchor for pinned channels.**
- TOFU is used only to fetch `ca.cer`: the handshake accepts any certificate; **the real trust decision** is `ValidateFetchedCa(der, instanceId)` — the CA SHA-256 must match the `instanceId` in the link, so an attacker cannot forge a CA with the same fingerprint.
- Leaf validation order: `Issuer` → CA/leaf validity → not a CA → `EKU(serverAuth)` → chain to the pinned CA → `SAN` (exact DNS or one-level wildcard; LAN gateways also present IP SANs, compared byte by byte).
- WebView2 `ServerCertificateErrorDetected`: allowed only when the pinned validation above passes; `Expired`/`Revoked` are always rejected.
- Re-validation on load: `SavedDevice.Validate()` recomputes `SHA-256(CA) == instanceId`, asserts the CA is self-signed, and checks that `Origin` matches the host/port, so tampering with stored data cannot inject a new trust anchor.

## WebView2 boundary policy

Mirrors Android's `SecureWebViewClient` / `GatewayUrlPolicy` / `MainActivity` and defines the behavior instead of leaving it open:

| Event | Policy |
| --- | --- |
| `NavigationStarting` | Only the exact paired-gateway origin (including port) and `about:blank` are allowed; anything else is cancelled, and external https links open in the system browser |
| `NewWindowRequested` | Pop-ups are blocked; external https links open in the system browser |
| `DownloadStarting` | Always cancelled with a notice (the client does not support downloads yet) |
| `PermissionRequested` | Always `Deny`; when the microphone is denied the user is told that voice input is unsupported |
| `ProcessFailed` | Browser process exit shows a reconnect notice; renderer/frame crashes reload and notify |

Notices are shown at most once per category per session, so permission/download events do not spam dialogs.

## Persistence and portability

- `Root = AppContext.BaseDirectory`; `data/` holds `devices.json`, `client.log`, and the WebView2 user-data folder.
- iroh identity is forced by the sidecar into `%USERPROFILE%\.dsh-mobile-win\iroh` (its private-directory ACL check rejects drive roots).
- The sidecar cache lives under `data/components/iroh/<version>/`; a corrupt or mismatched cache is deleted and re-fetched, and an unverified binary is never launched.
- `deviceToken` is encrypted with DPAPI(CurrentUser) and does not work across users or machines; one-time `irohCode` / `gatewayToken` values are never persisted.

## Build and test

- Prerequisites: .NET 8 SDK (x64) + WebView2 Evergreen; building and running are only supported on Windows x64 (see "Status and support" in the README).
- Commands: `dotnet restore` / `dotnet build -c Release` / `dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release`.
- CI: `.github/workflows/windows-client.yml` runs the same restore/build/test steps on `windows-latest` (it restores the test project, then builds the main project with `--no-restore` and runs the tests); it does not produce a release package and does not exercise WebView2 or real hardware.
- Unit tests: `DshMobile.Win.Tests/` covers `UrlPairing`, `PairingDescriptor`, `PairingTrustPolicy` (including the dsh2 hard failure and dsh1 fallback on 404), `CertificatePolicy` (`ValidateFetchedCa`, DNS/wildcard/IP SAN), `DeviceStore.Validate`, and `SidecarProvisioner.Verify`. Case counts and results come from an actual `dotnet test` run; this document does not record one-off local results.
- Acceptance: iroh, LAN, remote channels and the five WebView2 policies have not completed maintainer acceptance on real hardware yet; they need a Windows machine and the acceptance checklist.
