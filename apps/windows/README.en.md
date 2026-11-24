# DSH Mobile Windows client

[中文](README.md) · [Project home](../../README.en.md) · [Architecture and security model](ARCHITECTURE.en.md)

A portable Windows client for DSH Mobile. It connects through the authenticated HTTPS page the DSH Mobile plugin already serves on the computer, and the program itself is a WebView2 shell with pairing and certificate validation — it does not bundle a second frontend and does not modify the page DOM.

- Same display name as the Android app: **DeepSeek Harness**
- Shares the phone's launcher artwork (4 mascot poses and 6 whale colourways, switchable in settings)
- Component responsibilities, the three transports and the trust model: [ARCHITECTURE.en.md](ARCHITECTURE.en.md)

## Download

Download `dsh-mobile-windows-v<version>-win-x64.zip` from the `windows-v*` tag in [GitHub Releases](https://github.com/saya-ch/dsh-mobile/releases), unzip it into any writable folder, and run `DshMobile.Win.exe`. A `.sha256` file sits beside the archive.

The package is **self-contained**: no .NET install, no registry writes, no administrator rights. The whole folder is portable, but the device token in `devices.json` is sealed with the current Windows account, so moving to another machine or user means pairing again.

> **Alpha preview**: currently `0.1.0-alpha`. It does not ship with the plugin and is not part of the npm package; the plugin and the Android app remain the stable surfaces. The three transports have not been accepted on real Windows hardware yet, so failures are expected; attach `data\client.log` when reporting one.

## Requirements

| Item | Requirement |
| --- | --- |
| OS | Windows 10 1809+ / Windows 11 |
| Architecture | **x64** only (no ARM64; cannot run or be built on Linux/macOS) |
| Runtime | No .NET install needed (self-contained publish) |
| WebView2 | Evergreen Runtime. Included in Windows 11; install it once on Windows 10 — see https://developer.microsoft.com/microsoft-edge/webview2 |
| First iroh connection | Downloads and verifies the official component (about 14.8 MB) |

## Features

### Connecting

- **Three transports**: `LAN`, `remote` (both paste a `https://…/mobile-access/pair#…` pairing link), and `iroh` (paste iroh pairing content; the official component builds the encrypted tunnel).
- **LAN discovery**: scan the network or type an address to find a computer, then paste that computer's pairing link. A link whose address disagrees with the discovery result asks for confirmation.
- **No re-scanning**: pair once, then just press Connect.
- **Address tracking**: when a remote address changes or a credential expires, paste that computer's current link to update the address and keep its name. A computer with a pinned certificate only accepts links that also require pinning; it is never downgraded.
- **Start behaviour**: show the device list on launch, or reconnect the last computer directly.

### Device list

- **Visible status**: each computer shows whether it is reachable (reachable / checking / unreachable / connected / credential expired / revoked on the computer). Reachability is polled in the background and paused while connecting.
- **Recency**: shows when the computer was last opened ("19 minutes ago", "2 days ago").
- **Rename and order**: rename, move up, move to front; the order survives a restart.
- **Undoable delete**: a delete can be undone within five seconds (it only removes the local record, not the computer's authorisation).

### Notifications and appearance

- **Task notifications**: completions raise a desktop notification while connected; switchable in settings. Revoking the device on the computer reports it and stops the notifications.
- **App icon**: 4 mascot poses and 6 whale colourways, the same artwork the phone ships. Frames below 32px use the simplified whale mark so the tray icon stays legible.
- **Light and dark**: follows Windows, or pin light/dark in settings.
- **Page zoom, font size, reading mode** stay in the DSH page's own settings, exactly as on the phone.

### Security

- **Certificate pinning**: the computer's certificate is pinned when you pair, and a mismatch stops the connection instead of asking you to trust something. The client also verifies the pin over its own TLS handshake before handing the origin to the browser, rather than relying on the browser's verdict alone.
- **Encrypted credentials**: the device token is sealed with your Windows account; another machine or user means pairing again.
- **Downloads and permissions**: downloads from the gateway's own origin go through a save dialog, other origins are blocked; the page may use the microphone (routed to the computer), the camera and every other permission is refused.
- **No page injection**: the top bar is a native window control; the page DOM is neither injected nor modified.

## Using it

1. Unzip and run `DshMobile.Win.exe`;
2. In the computer's DSH "mobile access" panel, generate a pairing, paste the link into the client and press "Pair and connect";
3. Afterwards just press Connect.

Runtime data lives in `data\` beside the executable:

| Path | Contents |
| --- | --- |
| `data\devices.json` | Paired computers (token sealed with the Windows account) |
| `data\settings.json` | Icon, theme, start behaviour, notification switch |
| `data\client.log` | Log (rotates at 2 MB, keeps one previous file) |
| `data\components\iroh\` | Verified iroh component cache |
| `data\webview2\` | WebView2 user folder (cache and cookies) |

The iroh client identity is kept by the component in `%USERPROFILE%\.dsh-mobile-win\iroh`, so another machine means pairing again.

## Building from source

Prerequisite: .NET 8 SDK (x64). Building and running are Windows x64 only.

```bash
cd apps/windows/DshMobile.Win

dotnet restore
dotnet build -c Release
dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release

# Portable build (self-contained .NET, a folder you can copy)
dotnet publish -c Release -r win-x64 --self-contained true -o <target>
```

No Rust or Android toolchain is needed: the iroh transport reuses the official published component, which is not in the repository. It is downloaded from a pinned address on first use, its size and SHA-256 are verified, and it is verified again before every launch.

## Layout

```
apps/windows/
├── ARCHITECTURE.md / .en.md   # Architecture and security model
├── README.md / .en.md         # This document
├── DshMobile.Win/             # Client source (WPF + WebView2)
│   ├── *.cs / *.xaml
│   ├── icons/                 # 10 selectable icons (multi-size ICO + brand art)
│   ├── sidecar/               # Pinned version / URL / SHA-256 + licence texts
│   └── DshMobile.Win.csproj
└── DshMobile.Win.Tests/       # Pure-logic unit tests (xunit)
```

## For maintainers

**Version and release**: the version lives in `<Version>` in `DshMobile.Win.csproj` and is independent of the plugin version and the iroh component pin. To release, push a `windows-v<version>` tag; `.github/workflows/windows-release.yml` checks the tag against the project version, builds, runs the unit tests, packages the zip with a SHA-256, and uploads it as a prerelease.

**The iroh component pin exists in three places** and `scripts/check-windows-sidecar-pin.mjs` asserts they agree: `IROH_COMPONENT_RELEASES['win32-x64']` in `src/iroh-component.ts` is authoritative, `SidecarProvisioner.cs` hardcodes the same value, and `sidecar/manifest.json` mirrors it. Changing the pin means changing all three.

**CI**: `.github/workflows/windows-client.yml` builds and runs the pure-logic tests on `windows-latest` and produces no package; only `windows-release.yml` produces one, when a tag is pushed.

This directory is a new surface and does not modify existing plugin or Android code; repository conventions are in the root `AGENTS.md`.
