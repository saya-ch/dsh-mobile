# DeepSeek Harness Android App

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness is the display name of this lightweight, community-maintained Android WebView shell. It does not bundle a second DSH frontend. The app and mobile browsers load the same authenticated HTTPS origin, so both receive the same DSH features plus live-editable `mobile.css` presentation and `mobile.js` functionality.

Android is the only supported native target. The iOS client remains an unpublished local experiment and is outside the build, release, and support scope.

## Use the app

1. Complete the plugin quick start and run `dsh-mobile setup`.
2. Install the Android APK from GitHub Releases.
3. Choose **Local network** or **Remote access** on the app home screen.
4. For LAN, create a key or pairing link under **Mobile Access → Local network**. For remote access, configure a provider and create the remote pairing QR code. Scan the corresponding QR code or paste its link in the app.
5. The two paths store separate device credentials. LAN certificate trust stays private to the app; remote access uses the provider's public HTTPS certificate and requires no provider app on the phone.

Self-hosted FRP uses the same remote pairing flow with an explicitly paired custom HTTPS domain. It requires Android app 0.3.3 or later; older supported apps continue to work with LAN, cpolar, and Tailscale Funnel.

After the first pairing, the app encrypts a revocable, long-lived device token with Android Keystore. Every later launch uses it only with the exact saved Origin to renew a short Web session before opening DSH. If the computer receives another LAN address, the app scans the default port, matches the stable DSH installation identifier, and updates the saved origin automatically. A rotating remote address such as a free cpolar URL cannot be discovered through its expired predecessor; scan the computer's current remote QR code to validate the new Origin with a one-time pairing token. The app never sends the stored device token to that new Origin, and discovery never exposes device or Session credentials.

Before pairing, the app reads separate version metadata to distinguish an outdated app, an outdated plugin, and an unsupported protocol. A legacy plugin without that endpoint continues through the original flow. After pairing, the connection chooser remains immediately usable while the saved connection restores in the background. Bounded automatic retries run only for transient network or provider failures. Native app screens automatically follow the Android system locale in Simplified Chinese, English, or Italian without a separate language switch. Plugin-owned UI inside the WebView follows DSH's selected locale. DSH does not currently expose Italian, but the dictionaries are ready to activate without another plugin change when it does.

Discovery listens to DNS-SD/mDNS and periodic UDP announcements at the same time, sends an active UDP query on port `3443`, and retains bounded HTTPS scans of visible private Wi-Fi and phone-hotspot `/24` networks as a compatibility fallback. Every discovery path carries metadata only and results are merged by stable installation identifier, so a changed address updates the existing device. The first screen offers **Scan QR code** (point the camera at the screen to pair without a key), Scan, a result list, and a manual address field (enter `https://IP:port` to connect when discovery fails, e.g. across subnets, on a non-default port, or behind a firewall); select one DSH before entering its key. For a browser's first connection, open the **Copy pairing link** link on the phone (the pairing code is prefilled), or visit `/mobile-access/pair` on the shown HTTPS origin and enter the 43-character pairing code after the generated key's final dot.

The CA is not discovery data. After selection and key entry, Android retrieves it from the chosen origin without sending credentials, checks that its SHA-256 fingerprint matches the key and installation identifier, and stores it with the encrypted device credential. Native requests use an app-private trust store. WebView accepts only an otherwise-untrusted leaf signed by that pinned CA for the exact origin and validity period; every other TLS error is cancelled. No system CA installation is required.

## Mobile extension bridge

The authenticated page can call the Android bridge through `dshMobile` extensions. It uses an `androidx.webkit` WebMessage listener, checks the exact configured top-level origin and `isMainFrame` on every message, and never uses `addJavascriptInterface`. Inbound messages are capped at 1 MiB, clipboard text at 256 KiB, binary results at 8 MiB, and replies at 12 MiB. The bridge does not expose cookies, device tokens, pairing keys, CA private keys, or arbitrary Android APIs.

Available actions are `files.pick`, `camera.capture`, `share`, `clipboard.read`, `clipboard.write`, and `notification.notify`. For an open session whose DSH attachment owner reports `canAcceptDrop`, image selection and capture appear in a dedicated top row of the composer plus menu. Selected files are validated and routed through the current DSH attachment owner; the compatibility adapter may synthesize the same drag-and-drop events used by DSH. The picker accepts PNG, JPEG, WebP, and GIF up to 8 MiB. Camera capture requests Android camera permission only when used, writes a full-resolution JPEG through `FileProvider`, and returns it as a browser `File`. Task reminders (`notification.notify`) fire while the page is hidden when a run finishes after a quiet period or a question waits for input; the first use requests the Android notification permission, same-session updates replace the previous reminder, and tapping opens the app. Only one interactive Android result runs at a time and receives a five-minute deadline; cancellation, rotation, WebView destruction, timeout, and stale-session results are cleaned up or rejected. Browsers use the corresponding Web APIs and return `unsupported` when a capability is unavailable.

Computer-side extensions are separate: their `host.mjs` runs as trusted local Node.js code on the DSH host, while `mobile.js` calls its scoped actions and routes. The app bridge cannot edit or upload extension source files.

The client validates the extension manifest and revisioned resource URLs. File changes trigger an authenticated server-sent event so the phone can refresh immediately; 45-second visible and 5-minute hidden polling remains a recovery fallback. Every UI activation is pinned to its Host, script, stylesheet, and asset generation. Failed Host staging keeps the current version; failed client activation closes that extension and retries instead of mixing generations.

## Why use the app

- No browser address or tab bars.
- System Back navigates same-origin WebView history first.
- File selection, same-origin downloads, sharing, and site-data clearing use narrow native implementations.
- The app remains a shell around the same Web UI and protocol used by browsers.

A mobile browser is always a first-class alternative; the app is optional.

## Security properties

| Control | Android behavior |
| --- | --- |
| Transport | HTTPS origins only; cleartext traffic is disabled. |
| TLS | The pairing-key CA is stored privately. Only `SSL_UNTRUSTED` for its valid, exact-host leaf is accepted; every other TLS error is cancelled. |
| Origin | Only scheme, normalized host, and port persist. Ordinary paths, queries, and fragments do not. |
| Navigation | Same-origin main frames stay inside; user-initiated external HTTPS links open in the system browser. |
| Permissions | File input uses the system document picker without storage permission; camera permission is requested only when the user starts QR scanning or photo capture. |
| Downloads | Foreground GET from the exact origin only; authentication control paths are never downloads. |
| Data | The device token is encrypted by Android Keystore; Web storage stays in the app sandbox; Clear Site Data removes the credential, origin, cookies, cache, and Web storage. |
| Backup | App backup is disabled; TLS private keys and signing keys must remain outside the repository. |

The network security configuration does not trust user-installed CAs. The plugin signs a fresh SAN for the selected interface's current address while the app retains the stable CA pin in its encrypted credential record.

## Build

Requirements: Android Studio or Android SDK 36 and JDK 17. The repository includes the Gradle 8.11.1 Wrapper.

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Releases build a signed release APK with a stable signing key stored only in repository secrets; signing keys and passwords never enter the source tree or build artifacts.

## Acceptance

Shared URL-policy tests cover origin normalization, pairing entry, same-origin navigation, and download paths. Device acceptance must still cover small screens, landscape, cutouts and gestures, the keyboard, font scaling, valid and invalid TLS, file input, downloads, Back, rotation, and reauthentication after clearing data.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
