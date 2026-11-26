# Architecture and security model

[简体中文](ARCHITECTURE.md) · [Back to README](README.en.md)

This document describes the Windows client internals for maintainers and follow-up work. Features, build commands, requirements and release status are in [README.en.md](README.en.md).

> Status: the client is merged into `main` and published as a prerelease on the `windows-v*` track (`0.1.0-alpha`–`0.1.2-alpha`); maintainer acceptance on real Windows hardware is still incomplete. The support envelope is under "Requirements" in the README, and the alpha-preview note under "Download" carries the acceptance status.

## Component responsibilities

| File | Responsibility |
| --- | --- |
| `App.xaml(.cs)` | Application startup, system light/dark following, and the `DSH_MOBILE_THEME=light\|dark` override |
| `MainWindow.xaml(.cs)` | WPF shell: connect page + browser page, connect/reconnect orchestration, WebView2 boundary policy, and the native TLS pin check (`VerifyPinnedOriginAsync`) |
| `MainWindow.Devices.cs` / `MainWindow.DevicePage.cs` | The device list page's two partial classes: card rendering, reachability wiring, ordering menu and delete with a five-second undo (`Devices`), plus the brand mark, the empty state's three pairing entry points and the pairing panel's method tabs (`DevicePage`); the settings page lives in `MainWindow.xaml(.cs)` |
| `AppSettings.cs` | `data/settings.json`: icon, start behaviour, theme, task-completion notices, last connected computer; a missing or damaged file falls back to defaults instead of failing |
| `AppIcons.cs` | The ten launcher artworks the Android app ships (four mascot poses, six whale skins), shared by the titlebar and the tray; previews use the largest frame in the file |
| `StartupBehavior.cs` | Decides between the device list and "reconnect the last computer" on launch; a record whose credential expired or cannot be read is never auto-connected |
| `DeviceOrder.cs` | Display order (`SortOrder`) and the move-up / move-to-top actions, mirroring Android `PairedDeviceOrderPolicy` |
| `DeviceStatus.cs` / `DeviceReachability.cs` | Maps the eight reachability states to user-visible text and semantic colour tokens; 15-second probe rounds, 8-second timeout, paused while a session is live |
| `ClientLog.cs` | Appends to `data/client.log`; at 2 MB the live file rotates to `client.log.1`, and a failed write never becomes an application error |
| `PortableData.cs` | Proves `data/` accepts a new file (write then delete a probe); an unwritable folder such as Program Files produces one actionable message |
| `ConnectionDiagnosis.cs` | Classifies connection failures (credential, protocol version, missing WebView2, CA mismatch, DNS, HTTP 426/429/5xx) and owns their user-facing text |
| `WebView2Availability.cs` | Probes the WebView2 Evergreen Runtime before startup and reports the install link and x64 hint instead of waiting out an initialization timeout |
| `UpdateCheck.cs` | Version comparison and `windows-v*` release selection, including the installer and its `.sha256` asset (pure logic) |
| `UpdateInstaller.cs` | The update path: download the installer (whole-transfer and per-read deadlines plus cancellation), compare SHA-256, start the Inno Setup silent upgrade; a failed comparison never installs |
| `CrashGuard.cs` / `RelativeTime.cs` | Last-resort handling for unhandled exceptions; "19 minutes ago" style timestamps on device cards |
| `UrlPairing.cs` | Parses `https://…/mobile-access/pair#…` links (legacy `instance/token` or a `dsh1`/`dsh2` key) and classifies LAN/remote through the `RemoteHostPolicy` in the same file |
| `PairingTrustPolicy.cs` | `/mobile-access/ca.cer` outcome decision (whether a 404 may fall back to platform trust), mirroring Android `PairingTrust.selectTrustAnchor` / `RemotePairingTrust.decide` |
| `PairingDescriptor.cs` | Parses the iroh pairing JSON descriptor (EndpointId / Hostname / Origin / LocalPort / InstanceId / CA) |
| `GatewayAuth.cs` | Second authorization layer over the TLS carrier: `native-pair` / `native-renew`, plus the `/mobile-access/ca.cer` bootstrap |
| `CertificatePolicy.cs` | Pairing-CA pinning, leaf certificate validation, CA fingerprint anchoring |
| `IrohCarrier.cs` | Runs the pinned `phone-sim` sidecar process; re-verifies the binary pin before launch |
| `SidecarProvisioner.cs` | Acquires and verifies the official sidecar by pinned URL, byte count and SHA-256; the binary is not distributed in this repository |
| `DeviceStore.cs` | Atomic device-record I/O, DPAPI encryption, and per-load validation; `AdoptNewOrigin` follows a moved gateway (same instanceId only) |
| `LanDiscovery.cs` | LAN discovery: UDP announcement validation, manual address normalization, single `GET /mobile-access/discovery` probes, subnet scans |
| `BackgroundEventWatcher.cs` | While connected, subscribes to `/mobile-access/background-events` and raises desktop balloons on task completion; `SseParser` parses SSE line by line |
| `WebViewPolicy.cs` | Exact gateway-origin check shared by navigation/downloads/microphone, free of WebView2 types so it stays testable |
| `DshMobile.Win.Tests/` | Pure-logic unit tests (pairing links, trust decisions, certificate chain/SAN, pinned-origin gate, device store and ordering, reachability states, start behaviour, log rotation, portable folder, failure diagnosis, update selection, WebView2 probe) |

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
- **The sidecar is not committed**: the authoritative pin is `IROH_COMPONENT_RELEASES['win32-x64']` in `src/iroh-component.ts`; `SidecarProvisioner` hardcodes the same values and `sidecar/manifest.json` mirrors them, and `scripts/check-windows-sidecar-pin.mjs` machine-checks all three in `windows-client.yml` (update all three when the upstream pin moves). On first use `SidecarProvisioner` downloads from the pinned URL, verifies byte count + SHA-256, or reuses the copy installed by the DSH Mobile plugin (default `~/.dsh` layout only). A corrupt cache is deleted and re-fetched, and `IrohCarrier.StartAsync` re-verifies before every process start, refusing to launch on a hash mismatch. License texts live under `sidecar/` in the repository; `dotnet publish` does not copy them, and the release workflow copies them into the package's `licenses/`.

### LAN / remote (direct)

```
client ──TCP──▶ https origin ──GET /mobile-access/ca.cer(TOFU)──▶ pinned CA ──SslStream(pin)──▶ native-pair/renew
```

- Link forms: `https://<origin>/mobile-access/pair#instance=<64hex>&token=<43base64url>`, or `#key=dsh1|dsh2.<64hex>.<43base64url>`; a bare `https://origin` is also accepted (the fragment credential is still required).
- Classification: `RemoteHostPolicy` treats tunnel suffixes (`*.ts.net`, `.cpolar.cn` / `.cpolar.io` / `.cpolar.top` / `.cpolar.com`, `*.trycloudflare.com`), private/loopback/link-local ranges, and `.local` / `.lan` / `.home` / `.internal` / `.localhost` as well as single-label hostnames as LAN or remote.
- Bootstrap: first connect with TOFU to fetch `/mobile-access/ca.cer`. A `dsh2` key (`requiresCa=true`) requires the pairing CA — **a 404 is an identity mismatch and fails closed**; `dsh1` and the legacy `instance/token` form describe a public-CA gateway and may fall back to platform trust only on the remote channel after an explicit 404; a LAN 404 always fails; an already-pinned device is never downgraded. The decision lives in `PairingTrustPolicy.Decide`, and `requiresCa` is persisted in the device record and re-validated on every load.

### Discovery and address follow-up

- Discovery (`LanDiscovery`): broadcasts `DSH_MOBILE_DISCOVER_V1` over UDP and collects gateway announcements, then probes each local IPv4 /24 for `GET /mobile-access/discovery`; a manually entered address can also be probed directly. All five announcement fields must agree and the origin must be the answering address (spoofed announcements are dropped); discovery is never a trust decision — pairing still pins the CA to the instanceId fingerprint.
- When a pasted link's origin disagrees with the selected discovery result, pairing asks for confirmation so another computer's link cannot be pasted silently.
- Follow-up (`SavedDevice.AdoptNewOrigin`): when a saved lan/remote computer stops resolving or its credential expires, its current link from the same computer updates the address; the instanceId must match, the user-visible name is kept, and the old CA pin and device token are dropped so the adopted record completes a fresh `native-pair`. A record that requires the pinned CA refuses a link that does not require one, so following an address cannot drop it onto platform trust; only the unpinned-to-pinned direction is allowed.

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
| `DownloadStarting` | Same-origin downloads from the paired gateway go through a save dialog; off-gateway addresses stay cancelled with a notice |
| `PermissionRequested` | Only the microphone on paired-gateway pages is allowed (the computer's voice path); the camera and everything else stay `Deny` |
| `ProcessFailed` | Browser process exit shows a reconnect notice; renderer/frame crashes reload and notify |

Notices are shown at most once per category per session, so permission/download events do not spam dialogs.

## Known gaps

- **Real-hardware acceptance is incomplete**: the iroh, LAN and remote channels and the five WebView2 policies have not been walked through on the maintainer's Windows machine; this document describes the design and the checks that are in the repository.
- **The update path is unsigned**: the installer has no code signature, so the first run triggers SmartScreen. `PrivilegesRequired=lowest` means no administrator rights are needed, but an install in a protected folder cannot be upgraded in place (Inno's error dialog is the only signal). The client exits once the installer starts and does not ask Inno's Restart Manager to relaunch it, so the user reopens the client after the upgrade.

## Persistence and portability

- `Root = AppContext.BaseDirectory`; `data/` holds `devices.json`, `settings.json`, `client.log` (rotated to `client.log.1` at 2 MB) and the WebView2 user-data folder `data/webview2/`.
- `settings.json` carries the icon, start behaviour, theme, task-completion notice switch and the last connected computer. It is shell preference, not trust data: a damaged or missing file simply falls back to the defaults.
- iroh identity is forced by the sidecar into `%USERPROFILE%\.dsh-mobile-win\iroh` (its private-directory ACL check rejects drive roots).
- The sidecar cache lives under `data/components/iroh/<version>/`; a corrupt or mismatched cache is deleted and re-fetched, and an unverified binary is never launched.
- `deviceToken` is encrypted with DPAPI(CurrentUser) and does not work across users or machines; one-time `irohCode` / `gatewayToken` values are never persisted.

## Build and test

- Prerequisites: .NET 8 SDK (x64) + WebView2 Evergreen; building and running are only supported on Windows x64 (see "Requirements" in the README).
- Commands: `dotnet restore` / `dotnet build -c Release` / `dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release`.
- CI: `.github/workflows/windows-client.yml` runs the same restore/build/test steps on `windows-latest` (it restores the test project, then builds the main project with `--no-restore` and runs the tests); it does not produce a release package and does not exercise WebView2 or real hardware. Only `.github/workflows/windows-release.yml` produces packages, when a `windows-v<version>` tag is pushed (self-contained win-x64 folder → zip + SHA-256 → prerelease).
- Unit tests: `DshMobile.Win.Tests/` covers `UrlPairing`, `PairingDescriptor`, `PairingTrustPolicy` (including the dsh2 hard failure and dsh1 fallback on 404), `CertificatePolicy` (`ValidateFetchedCa`, DNS/wildcard/IP SAN, the pinned-origin gate), `DeviceStore.Validate` (including `AdoptNewOrigin` and ordering), `DeviceOrder`, `DeviceStatus`/`DeviceReachability`, `StartupBehavior`, `ClientLog` rotation, `PortableData`, `ConnectionDiagnosis`, `UpdateCheck` (including installer/checksum asset selection), `UpdateInstaller` (digest parsing and comparison, interrupted/stalled/cancelled transfers, no installer launch when the digest does not match), `WebView2Availability`, `SidecarProvisioner.Verify`, `LanDiscovery` (announcement validation, manual normalization, subnet derivation, UDP listen), `SseParser`, and `WebViewPolicy` (same-origin decisions). Case counts and results come from an actual `dotnet test` run; this document does not record one-off local results.
- Acceptance: iroh, LAN, remote channels and the five WebView2 policies have not completed maintainer acceptance on real hardware yet; they need a Windows machine and the acceptance checklist.
