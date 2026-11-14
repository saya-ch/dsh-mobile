# DSH Mobile for Windows

[简体中文](README.md) · [Back to the project](../../README.en.md) · [Architecture and security model](ARCHITECTURE.en.md)

A portable Windows client for DSH Mobile, the counterpart of the Android app in this repository (`apps/mobile/android/`): it lets Windows use DSH sessions through the authenticated HTTPS page served by the DSH Mobile plugin on the computer. The program is a WebView2 shell with pairing and certificate validation; it does not bundle a second frontend.

- Display name matches the Android app: **DeepSeek Harness**
- The launcher icon reuses the Android launcher icon (`apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`; `DshMobile.Win/app.ico` is converted from that PNG)
- Component responsibilities, the three-channel data flow and the trust model are in [ARCHITECTURE.en.md](ARCHITECTURE.en.md)

## Status and support

- **Source preview, not released**: this directory is merged into `main`, but it is **not shipped in any Release** — there is no official download, and it is not part of the npm package (`files`). Build it yourself with the commands below.
- **Not yet accepted by a maintainer**: the maintainer has not completed the acceptance matrix on a real Windows machine (iroh, LAN, remote, and the five WebView2 policies). This document and `ARCHITECTURE.en.md` describe the design and the checks in the repository, **not a promise of usability**.
- **Support**: Windows 10 1809+ / Windows 11, **x64**. Windows ARM64 is unsupported, as are builds on Linux/macOS (WPF `net8.0-windows` + `RuntimeIdentifiers=win-x64`).
- **Prerequisites**: .NET 8 SDK (x64) and the WebView2 Evergreen Runtime (included in Windows 11; install it on Windows 10 — see https://developer.microsoft.com/microsoft-edge/webview2 ). The first iroh connection downloads and verifies the official sidecar (about 14.8 MB / 14,865,920 bytes).

## Features

- **Three connection channels**
  - `iroh`: paste the iroh pairing JSON descriptor; the official sidecar (`phone-sim`) builds a QUIC tunnel plus a loopback TLS carrier. The sidecar is not distributed in the repository: it is fetched from a pinned URL and verified by SHA-256, and re-verified before every process start.
  - `LAN` / `remote`: paste the `https://…/mobile-access/pair#…` pairing link (legacy `instance/token` or a `dsh1`/`dsh2` key); the pairing CA is bootstrapped from `/mobile-access/ca.cer` (TOFU plus the instanceId fingerprint) before connecting directly to the gateway.
- **Reconnect without scanning**: the first pairing stores the device credential (deviceToken encrypted with DPAPI); later launches reconnect with a single click — `Hello` over iroh, `native-renew` for direct channels.
- **Device management**: multiple device cards, rename and delete; each card shows the channel type and credential expiry.
- **Security**: the pairing CA is the only trust anchor for pinned channels. A leaf certificate is accepted only after `Issuer` → CA/leaf validity → not a CA → `EKU(serverAuth)` → chain to the pinned CA → `SAN` (exact DNS or one-level wildcard; IP SANs compared byte by byte for LAN gateways) all pass. On the WebView2 error path `Expired`/`Revoked` are always rejected; the custom-CA native TLS channel does not check revocation (`X509RevocationMode.NoCheck` — the self-signed pairing CA has no revocation data).
- **Top bar and title bar**: a window-level bar under the native title bar (device list / connection status / disconnect), colored like the DWM caption; the page DOM is not injected or modified.
- **Light and dark**: semantic color tokens (`design-system/dsh-mobile/MASTER.md`) follow the system theme; `DSH_MOBILE_THEME=light|dark` overrides it.

## Layout

```
apps/windows/
├── .gitignore                # ignores bin/ obj/ data/
├── ARCHITECTURE.md           # architecture and security model (Chinese)
├── ARCHITECTURE.en.md        # architecture and security model (English)
├── README.en.md              # this file
├── DshMobile.Win/            # client sources (WPF + WebView2)
│   ├── *.cs / *.xaml          # sources
│   ├── app.ico                # launcher icon converted from the Android PNG
│   ├── DshMobile.Win.csproj
│   └── sidecar/
│       ├── manifest.json                 # pinned version / URL / bytes / SHA-256 (mirror)
│       ├── LICENSE.dsh-mobile-iroh      # the next three files come from native/iroh-host/
│       ├── LICENSE.dsh-tether
│       └── NOTICE.dsh-mobile-iroh
└── DshMobile.Win.Tests/      # pure-logic unit tests (xunit)
    └── DshMobile.Win.Tests.csproj
```

## Build and publish

Prerequisites are in "Status and support". Building and running are only supported on Windows x64.

```bash
cd apps/windows/DshMobile.Win

# build
dotnet restore
dotnet build -c Release

# pure-logic unit tests (no device or gateway required)
dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release

# portable publish (self-contained .NET, a standalone directory)
dotnet publish -c Release -r win-x64 --self-contained true -o <target-directory>
```

No Rust/Android toolchain is needed: the iroh transport reuses the official sidecar, and **the binary is not stored in this repository**. The authoritative pin is `IROH_COMPONENT_RELEASES['win32-x64']` in `src/iroh-component.ts`; `SidecarProvisioner` hardcodes the same values and `sidecar/manifest.json` mirrors them, with no machine check across the three copies (update all three when the upstream pin moves). The first iroh connection downloads from the pinned URL and verifies byte count plus SHA-256; if the DSH Mobile plugin already installed and verified the same copy under the default `~/.dsh/mobile-access/components/iroh/<version>/`, it is reused (custom DSH homes are not reused and fall back to a download). The binary is re-verified before every sidecar process start, and a hash mismatch refuses to launch.

`.github/workflows/windows-client.yml` runs on `windows-latest`: it restores the test project, then builds the main project with `--no-restore` and runs the tests (equivalent to the restore/build/test above). It covers source build and pure-logic tests only; it does not produce a release package and does not exercise WebView2 or real hardware. Whether that job is a required check is configured by the maintainer in GitHub branch protection, not in the repository. Dependencies come from the default NuGet feed (nuget.org). For slow networks add a mirror at the **user** level rather than changing repository configuration: `dotnet nuget add source <mirror-url> -n <name>`.

The publish directory root holds `DshMobile.Win.exe` and the .NET dependencies; runtime data (`devices.json`, `client.log`, the WebView2 user-data folder, and the downloaded sidecar cache) lives under `data\` inside that directory. The sidecar and the license texts under `sidecar/` are not copied into the publish directory.

## Portability boundaries

- iroh client identity is forced by the sidecar into `%USERPROFILE%\.dsh-mobile-win\iroh` (its private-directory ACL check rejects drive roots); moving to another machine requires pairing again.
- The sidecar cache lives under `data\components\iroh\<version>\`; a corrupt or mismatched cache is deleted and re-fetched, and an unverified binary is never launched.
- Paired devices are stored in `data\devices.json`; deviceToken is encrypted with DPAPI (CurrentUser) and does not migrate across machines.
- Log: `data\client.log`.

## Relationship to the upstream repository

This directory is an additional client; it does not modify the plugin or the existing Android code. Repository conventions are in `AGENTS.md` at the repository root (upstream DSH sources are read-only; changes stay in this repository). Functional changes stay under `apps/windows/`; the only repository-level exception is `.github/workflows/windows-client.yml` (the Windows client CI job). No other upstream file should appear in the diff.
