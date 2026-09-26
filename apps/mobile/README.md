# DeepSeek Harness Android App

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness is the display name of this lightweight, community-maintained Android WebView shell. It does not bundle a second DSH frontend. The app and mobile browsers load the same authenticated HTTPS origin, so both receive the same DSH features plus live-editable `mobile.css` presentation and `mobile.js` functionality.

Android is the only supported native target. The iOS client remains an unpublished local experiment and is outside the build, release, and support scope.

Version 0.5.0 keeps paired computers in one device list and supports choosing whether launch opens the last-used DSH or the list. The self-signed HTTPS entry for an existing frps requires Android app 0.4.6 or later to pin the remote gateway CA; older apps cannot use that entry but can continue using their existing LAN and publicly trusted remote connections.

## Use the app

1. Install and enable the plugin using the [project quick start](../../README.en.md#quick-start). For a command-line LAN installation, run the setup command shown there; plugin-market users can complete LAN setup in **Mobile Access** instead.
2. Install the signed Android APK from [GitHub Releases](https://github.com/saya-ch/dsh-mobile/releases).
3. With no paired computers, choose **Local network** or **Remote access**. For LAN, create a pairing key or link under **Mobile Access → Local network**. For remote access, configure a provider and generate its pairing QR code. Scan the corresponding QR code or paste its link in the app.
4. Name the computer after pairing. The app stores each LAN or remote pairing as a device record: LAN pins its private CA; ordinary remote paths use platform-trusted public HTTPS certificates; the self-signed FRP entry pins a remote CA. No provider app is needed on the phone.

The **Paired devices** list shows each computer's name, connection type, address, reachability, and last connection. Tap a row to connect; long-press or use its **More** button to connect, rename, check, re-pair, or delete the local record. The list's settings offer **Open DSH directly** (the default, using the last-used eligible computer even when several are paired) and **Show device list**. In the Android app's DSH page, **Settings → General → Switch computer** returns to the list. Existing LAN and remote credentials migrate on first launch without re-pairing. A computer revoked on the desktop stays listed for re-pairing or local deletion; a temporarily unreachable computer is not treated as revoked.

The managed self-hosted FRP path uses a public-CA HTTPS domain or IPv4 origin and requires Android app 0.3.3 or later. The existing-frps path, introduced in 0.4.6, can use the same public-CA pairing or a public-IPv4 self-signed entry that requires app 0.4.6 or later. See the [attachment guide](../../docs/ATTACH_EXISTING_FRPS.en.md); older supported apps continue to work with LAN, cpolar, and Tailscale Funnel.

See the [self-hosted FRP guide](../../docs/SELF_HOSTED_FRP.en.md) for manual and automatic VPS deployment, host-key verification, cleanup, and troubleshooting.

After the first pairing, the app encrypts its device records, including revocable long-lived tokens and any pinned CA, with Android Keystore. On a later launch it sends a stored token only to its exact saved Origin to renew a short Web session before opening DSH. If the computer receives another LAN address, the app scans the default port, matches the stable DSH installation identifier, and updates the saved origin automatically. A rotating remote address such as a free cpolar URL cannot be discovered through its expired predecessor; scan the computer's current remote QR code to validate the new Origin with a one-time pairing token. The app never sends the stored device token to that new Origin, and discovery never exposes device or Session credentials.

Before pairing, the app reads separate version metadata to distinguish an outdated app, an outdated plugin, and an unsupported protocol. A legacy plugin without that endpoint continues through the original flow. When direct launch is selected, the app attempts the saved connection within a bounded recovery budget and returns to the device list if it cannot reconnect. Automatic retries run only for transient network or provider failures. Native app screens automatically follow the Android system locale in Simplified Chinese, English, or Italian without a separate language switch. Plugin-owned UI inside the WebView follows DSH's selected locale. DSH does not currently expose Italian, but the dictionaries are ready to activate without another plugin change when it does.

When automatic recovery renews a Session, the app keeps the existing DSH page if its interface is still mounted. A page that did not finish starting or whose renderer stopped must be reopened; unsaved in-page state cannot be recovered in that case.

LAN discovery listens to DNS-SD/mDNS and periodic UDP announcements at the same time, sends an active UDP query on port `3443`, and retains bounded HTTPS scans of visible private Wi-Fi and phone-hotspot `/24` networks as a compatibility fallback. Every discovery path carries metadata only and results are merged by stable installation identifier, so a changed address updates the existing device. After choosing **Local network**, the setup screen offers **Scan QR code** (point the camera at the computer's QR code), Scan, a result list, and a manual address field (enter `https://IP:port` when discovery fails, e.g. across subnets, on a non-default port, or behind a firewall); select one DSH before entering its key. For a browser's first connection, open the **Copy pairing link** link on the phone (the pairing code is prefilled), or visit `/mobile-access/pair` on the shown HTTPS origin and enter the 43-character pairing code after the generated key's final dot.

The private CA is not discovery data. After explicit LAN or self-signed FRP pairing, Android retrieves the gateway CA from the chosen HTTPS Origin without sending a device credential, checks its validity and SHA-256 fingerprint against the pairing key, and stores it with the encrypted device credential. Native requests and WebView then trust only a valid leaf signed by that pinned CA for the exact Origin; other TLS errors are cancelled. For a public-CA remote entry, the gateway serves no private CA and Android uses platform trust instead. A leaf renewed under the same CA needs no re-pairing; an expired, replaced, or mismatched CA must never be silently accepted and requires a new pairing. No private CA is installed in Android's system trust settings.

## Why use the app

- No browser address or tab bars.
- System Back navigates same-origin WebView history first.
- File selection, same-origin downloads, sharing, and site-data clearing use narrow native implementations.
- The app remains a shell around the same Web UI and protocol used by browsers.

A mobile browser remains an alternative for LAN and publicly trusted remote entries. The self-signed FRP entry requires the 0.4.6 Android app: ordinary browsers do not trust its private CA automatically.

On WebView 151 or later, the app gives its own HTTP cache a 64 MiB minimum quota so large versioned DSH scripts can be reused across page loads. Older WebViews keep their default quota; the app never lowers a larger existing quota. **Clear Site Data** also removes this cached content.

## Security properties

| Control | Android behavior |
| --- | --- |
| Transport | HTTPS origins only; cleartext traffic is disabled. |
| TLS | LAN pins its pairing-key CA privately. The self-signed FRP entry requires a remote CA pin in app 0.4.6 or later. Both accept only an otherwise-untrusted, valid leaf for the exact Origin. Public-CA remote entries use platform trust; every other TLS error is cancelled. |
| Origin | Only scheme, normalized host, and port persist. Ordinary paths, queries, and fragments do not. |
| Navigation | Same-origin main frames stay inside; user-initiated external HTTPS links open in the system browser. |
| Permissions | File input uses the system document picker without storage permission. Camera permission is requested for QR scanning or photo capture; microphone permission is requested for DSH voice input. |
| Downloads | Foreground GET from the exact origin only; authentication control paths are never downloads. |
| Data | Android Keystore encrypts paired-device records, including tokens, origins, and any pinned LAN or self-signed FRP CA; Web storage stays in the app sandbox. Clear Site Data removes credentials, origins, cookies, cache, and Web storage. |
| Backup | App backup is disabled; TLS private keys and signing keys must remain outside the repository. |

The network security configuration does not trust user-installed CAs. For LAN, the plugin signs a new leaf for the selected interface address while the app retains the stable CA pin. For the self-signed FRP entry, the computer-side CA lasts five years and its public-IPv4 leaf lasts 397 days; the leaf can rotate under the same CA, but CA expiry or replacement requires a new fingerprint check and re-pairing. These are certificate lifetimes, not an unattended-availability guarantee.

## Mobile extension bridge

The authenticated page can call the Android bridge through `dshMobile` extensions. It uses an `androidx.webkit` WebMessage listener, checks the exact configured top-level origin and `isMainFrame` on every message, and never uses `addJavascriptInterface`. Inbound messages are capped at 1 MiB, clipboard text at 256 KiB, binary results at 8 MiB, and replies at 12 MiB. The bridge does not expose cookies, device tokens, pairing keys, CA private keys, or arbitrary Android APIs.

Available actions are `files.pick`, `camera.capture`, `share`, `clipboard.read`, `clipboard.write`, `notification.notify`, and `notification.settings`. DSH keeps its own file-attachment action in the composer Add group; Mobile adds camera capture to that same group when the current attachment owner can accept the image. Extensions may use `files.pick` separately: its system picker follows the caller's accepted MIME types and returns at most 8 MiB through the bridge, which is not a limit on DSH's native file selector. Camera capture requests Android camera permission only when used, writes a full-resolution JPEG through `FileProvider`, and returns it as a browser `File`. Task reminders use exact Host completion events and explicit pending-input cards while the page remains alive in the background. Open notification permission or system settings from DSH General settings inside the app; reminders use generic lock-screen text, separate completed turns do not replace each other, and tapping opens the app. Only one interactive Android result runs at a time and receives a five-minute deadline; cancellation, rotation, WebView destruction, timeout, and stale-session results are cleaned up or rejected. Browsers use the corresponding Web APIs and return `unsupported` when a capability is unavailable.

From 0.4.7, the app uses plain Enter for a new draft line only when an inset-backed on-screen keyboard is visible, Android reports no hardware keyboard, and an active session composer is focused. The Send button still submits a multiline draft. Floating keyboards, unknown state, older apps, and mobile browsers retain DSH's original Enter behavior; physical keyboards can still use Shift+Enter for a line break.

Voice input uses the DSH page's `getUserMedia`, not the extension bridge. The Android app requests microphone permission on first use and grants only audio-only capture from the paired HTTPS Origin; camera and other Origins remain denied. Client plugins loaded into that page share its Origin, so use voice input only with plugins you trust. This permission integration does not guarantee that DSH's speech-recognition service succeeds on every device or network.

Computer-side extensions are separate: their `host.mjs` runs as trusted local Node.js code on the DSH host, while `mobile.js` calls its scoped actions and routes. The app bridge cannot edit or upload extension source files.

The client validates the extension manifest and revisioned resource URLs. File changes trigger an authenticated server-sent event so the phone can refresh immediately; 45-second visible and 5-minute hidden polling remains a recovery fallback. Every UI activation is pinned to its Host, script, stylesheet, and asset generation. Failed Host staging keeps the current version; failed client activation closes that extension and retries instead of mixing generations.

## Build

Requirements: Android Studio or Android SDK 36 and JDK 17. The repository includes the Gradle 9.7.1 Wrapper.

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Releases build a signed release APK with a stable signing key stored only in repository secrets; signing keys and passwords never enter the source tree or build artifacts.

## Acceptance

Shared URL-policy tests cover origin normalization, pairing entry, same-origin navigation, and download paths. Local tests cover the 0.4.6 remote-CA trust decision, but a real VPS plus phone end-to-end test of the self-signed FRP entry has not been recorded. Device acceptance must still cover that path, small screens, landscape, cutouts and gestures, the keyboard, font scaling, valid and invalid TLS, file input, downloads, Back, rotation, and reauthentication after clearing data.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
