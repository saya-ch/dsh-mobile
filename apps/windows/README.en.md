# DSH Mobile for Windows

[简体中文](README.md) · [Back to the project](../../README.en.md) · [Architecture and security model](ARCHITECTURE.en.md)

A portable Windows client for DSH Mobile, the counterpart of the Android app in this repository (`apps/mobile/android/`): it lets Windows use DSH sessions through the authenticated HTTPS page served by the DSH Mobile plugin on the computer. The program is a WebView2 shell with pairing and certificate validation; it does not bundle a second frontend.

- Display name matches the Android app: **DeepSeek Harness**
- The launcher icon reuses the Android launcher icon (`apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`; `DshMobile.Win/app.ico` is converted from that PNG)
- Component responsibilities, the three-channel data flow and the trust model are in [ARCHITECTURE.en.md](ARCHITECTURE.en.md)

## Status and support

- **No installer yet**: this client is still in development. There is no official download and it is not part of the npm package; to try it, build it yourself with the commands below.
- **It may not connect**: the iroh / LAN / remote acceptance matrix has not been completed on a real Windows machine. This document and `ARCHITECTURE.en.md` describe the design and the checks in the repository. Failures are expected at this stage; attach `data\client.log` when reporting one.
- **Where it runs**: a Windows 10 1809+ / Windows 11 **x64** PC. Windows ARM64 is unsupported, and this client cannot be built on Linux/macOS.
- **Prerequisites**: .NET 8 SDK (x64) and the WebView2 Evergreen Runtime (included in Windows 11; install it on Windows 10 — see https://developer.microsoft.com/microsoft-edge/webview2 ). The first iroh connection downloads and verifies the official sidecar (about 14.8 MB / 14,865,920 bytes).

## Features

- **Three connection channels**
  - `iroh`: paste the iroh pairing content; the official component builds the encrypted tunnel.
  - `LAN` / `remote`: paste the `https://…/mobile-access/pair#…` pairing link and connect directly to the gateway.
- **Reconnect without scanning**: pair once, then click Connect; nothing to paste again.
- **Device management**: multiple device cards, rename and delete; each card shows the connection type and credential expiry.
- **Security**: pairing pins that computer's certificate, and a mismatch refuses the connection instead of asking you to install a certificate. Credentials are encrypted with your Windows account inside this folder, so another PC or another user must pair again.
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

No Rust/Android toolchain is needed: the iroh transport reuses the official component, and **the component itself is not stored in this repository**. The first iroh connection downloads it from a fixed address and verifies size plus SHA-256; if the plugin already installed and verified the same copy on this computer, that copy is reused. The component is re-verified before every start, and a mismatch refuses to launch.

`.github/workflows/windows-client.yml` runs on `windows-latest`: it restores the test project, then builds the main project with `--no-restore` and runs the tests (equivalent to the restore/build/test above). It covers source build and pure-logic tests only; it does not produce a release package and does not exercise WebView2 or real hardware. Whether that job is a required check is configured by the maintainer in GitHub branch protection, not in the repository. Dependencies come from the default NuGet feed (nuget.org). For slow networks add a mirror at the **user** level rather than changing repository configuration: `dotnet nuget add source <mirror-url> -n <name>`.

The publish directory root holds `DshMobile.Win.exe` and the .NET dependencies; runtime data (`devices.json`, `client.log`, the WebView2 user-data folder, and the downloaded sidecar cache) lives under `data\` inside that directory. The sidecar and the license texts under `sidecar/` are not copied into the publish directory.

## Portability boundaries

- iroh client identity is forced by the sidecar into `%USERPROFILE%\.dsh-mobile-win\iroh` (its private-directory ACL check rejects drive roots); moving to another machine requires pairing again.
- The sidecar cache lives under `data\components\iroh\<version>\`; a corrupt or mismatched cache is deleted and re-fetched, and an unverified binary is never launched.
- Paired devices are stored in `data\devices.json`; deviceToken is encrypted with DPAPI (CurrentUser) and does not migrate across machines.
- Log: `data\client.log`.

## Relationship to the upstream repository

This directory is an additional client; it does not modify the plugin or the existing Android code. Repository conventions are in `AGENTS.md` at the repository root (upstream DSH sources are read-only; changes stay in this repository). Functional changes stay under `apps/windows/`; the only repository-level exception is `.github/workflows/windows-client.yml` (the Windows client CI job). No other upstream file should appear in the diff.
