# DeepSeek Harness Android App

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness is the display name of this lightweight, community-maintained Android WebView shell. It does not bundle a second DSH frontend. The app and mobile browsers load the same authenticated HTTPS origin, so both receive the same DSH features plus live-editable `mobile.css` presentation and `mobile.js` functionality.

Android is the only supported native target. The iOS client remains an unpublished local experiment and is outside the build, release, and support scope.

The current stable app is **0.6.1** (build 77). The app and npm plugin update independently; plugin web UI or connection fixes do not require reinstalling the APK. Install a new signed release APK for native updates or when the app reports that its version is too old. Older official APKs with the same signer retain pairing during in-place upgrades; a differently signed Debug build cannot overwrite the official app.

## 0.6.2 candidate (unreleased)

The local candidate is build 78. It keeps web content clear of system navigation, display cutouts and the keyboard, and adds **Settings → General → Page zoom** (80–125%, reset to 100%). Zoom is saved in this App, independently from the per-address mobile font settings, and does not reload the current conversation. The setting requires both this App and the corresponding plugin update; older Apps and browsers do not show an inactive control.

WebViews reporting Chromium below 100 receive a nonblocking update reminder once per detected build. You may continue, but an obsolete WebView can still lack APIs required by DSH. Use the official WebView/Chrome update route available on your device; an unknown engine version is not treated as obsolete.

These changes are not yet available in the stable APK linked above.

The candidate also protects paired records and legacy migration when encrypted data is temporarily unreadable: it does not treat failed reads as an empty list or replace existing credentials. Storage errors are reported without clearing pairings.

## 0.6.1 update

The app is rebuilt with matching release metadata. Native functionality, package identity and pairing/renewal protocol are unchanged from 0.6.0, using the established release signer. This release improves the computer-side remote settings and Caddy build/test tooling; it does not enable official managed Caddy installation. See the [release notes](../../CHANGELOG.md#061---2026-10-08).

## 0.6.0 updates

- Fixed list order with new pairings appended. Move up / Move to top affect presentation only; startup still prefers the last-used computer.
- The list's **Settings → App icon** offers the mascot and six whale-mark colors without changing package identity or paired data.
- Proportionally cropped scanner preview, camera-supported continuous focus, pinch/double-tap zoom and 48dp zoom controls.
- Hold the top-left drawer toggle inside the app to return to the list. **Settings → General → Switch computer** remains available.

These native features require app 0.6.0 or later. See the [release notes](../../CHANGELOG.md#060---2026-10-07) for plugin module management, mobile font size and compatibility improvements.

## Use the app

1. Install and enable the plugin using the [project quick start](../../README.en.md#quick-start). For a command-line LAN installation, run the setup command shown there; plugin-market users can complete LAN setup in **Mobile Access** instead.
2. Install the signed Android APK from [GitHub Releases](https://github.com/saya-ch/dsh-mobile/releases).
3. With no paired computers, choose **Local network** or **Remote access**. For LAN, create a pairing key or link under **Mobile Access → Local network**. For remote access, configure a provider and generate its pairing QR code. Scan the corresponding QR code or paste its link in the app.
4. Name the computer after pairing. The app stores each LAN or remote pairing as a device record: LAN pins its private CA; ordinary remote paths use platform-trusted public HTTPS certificates; the self-signed FRP entry pins a remote CA. No provider app is needed on the phone.

The **Paired computers** list shows each computer's name, connection type, address, reachability and last connection. Tap a row to connect; long-press or use its **More** button to connect, rename, check, re-pair or delete the local record. The list's settings offer **Open DSH directly** (the default, using the last-used eligible computer even when several are paired) and **Show device list**. In the app's DSH page, **Settings → General → Switch computer** returns to the list. Existing LAN and remote credentials migrate without re-pairing. A revoked computer remains listed for re-pairing or deletion; temporary unreachability is not treated as revocation.

Startup options are under the list's **Settings → Startup behavior**. Deleting a local device does not revoke its authorization on the computer; use the computer's Mobile Access device controls for revocation.

### Connection recovery and certificates

The managed self-hosted FRP path uses a public-CA HTTPS domain or IPv4 origin and requires Android app 0.3.3 or later. The existing-frps path, introduced in 0.4.6, can use the same public-CA pairing or a public-IPv4 self-signed entry that requires app 0.4.6 or later. See the [attachment guide](../../docs/ATTACH_EXISTING_FRPS.en.md); older supported apps continue to work with LAN, cpolar, and Tailscale Funnel.

See the [self-hosted FRP guide](../../docs/SELF_HOSTED_FRP.en.md) for manual and automatic VPS deployment, host-key verification, cleanup, and troubleshooting.

After the first pairing, the app encrypts its device records, including revocable long-lived tokens and any pinned CA, with Android Keystore. On a later launch it sends a stored token only to its exact saved Origin to renew a short Web session before opening DSH. If the computer receives another LAN address, the app scans the default port, matches the stable DSH installation identifier, and updates the saved origin automatically. A rotating remote address such as a free cpolar URL cannot be discovered through its expired predecessor; scan the computer's current remote QR code to validate the new Origin with a one-time pairing token. The app never sends the stored device token to that new Origin, and discovery never exposes device or Session credentials.

Before pairing, the app reads separate version metadata to distinguish an outdated app, an outdated plugin, and an unsupported protocol. A legacy plugin without that endpoint continues through the original flow. When direct launch is selected, the app attempts the saved connection within a bounded recovery budget and returns to the device list if it cannot reconnect. Automatic retries run only for transient network or provider failures. Native app screens automatically follow the Android system locale in Simplified Chinese, English, or Italian without a separate language switch. Plugin-owned UI inside the WebView follows DSH's selected locale. DSH does not currently expose Italian, but the dictionaries are ready to activate without another plugin change when it does.

When automatic recovery renews a Session, the app keeps the existing DSH page if its interface is still mounted. A page that did not finish starting or whose renderer stopped must be reopened; unsaved in-page state cannot be recovered in that case.

The app keeps the live WebView when rotating, resizing the window or changing keyboard availability, preserving the page's scroll position, references and unsent images. It requests new layout and Insets without reloading. Android still recreates the Activity for language, font-scale or system-theme changes; process termination and renderer failure can also discard unpersisted page state. This follows the [Android WebView state-management guidance](https://developer.android.com/develop/adaptive-apps/cookbook/webview-state).

Once the app receives a computer-side revocation notification, later probes cannot replace **Removed on computer** with an expiry or network status. Re-pairing obtains a new credential before the row becomes usable again. A device revoked while offline may still show **Pairing expired**, because the computer deletes its token record and returns the same generic failure as for an unknown token.

LAN discovery listens to DNS-SD/mDNS and periodic UDP announcements at the same time, sends an active UDP query on port `3443`, and retains bounded HTTPS scans of visible private Wi-Fi and phone-hotspot `/24` networks as a compatibility fallback. Every discovery path carries metadata only and results are merged by stable installation identifier, so a changed address updates the existing device. After choosing **Local network**, the setup screen offers **Scan QR code** (point the camera at the computer's QR code), Scan, a result list, and a manual address field (enter `https://IP:port` when discovery fails, e.g. across subnets, on a non-default port, or behind a firewall); select one DSH before entering its key. For a browser's first connection, open the **Copy pairing link** link on the phone (the pairing code is prefilled), or visit `/mobile-access/pair` on the shown HTTPS origin and enter the 43-character pairing code after the generated key's final dot.

The private CA is not discovery data. After explicit LAN or self-signed FRP pairing, Android retrieves the gateway CA from the chosen HTTPS Origin without sending a device credential, checks its validity and SHA-256 fingerprint against the pairing key, and stores it with the encrypted device credential. Native requests and WebView then trust only a valid leaf signed by that pinned CA for the exact Origin; other TLS errors are cancelled. For a public-CA remote entry, the gateway serves no private CA and Android uses platform trust instead. A leaf renewed under the same CA needs no re-pairing; an expired, replaced, or mismatched CA must never be silently accepted and requires a new pairing. No private CA is installed in Android's system trust settings.

## Why use the app

- No browser address or tab bars.
- System Back dismisses supported page layers before same-origin WebView history and exits the app at the root. Model submenus return to their parent before closing.
- File selection, same-origin downloads and sharing use narrow native implementations; no extra native toolbar appears above the WebView.
- The app remains a shell around the same Web UI and protocol used by browsers.

A mobile browser remains an alternative for LAN and publicly trusted remote entries. The self-signed FRP entry requires the 0.4.6 Android app: ordinary browsers do not trust its private CA automatically.

On WebView 151 or later, the app gives its own HTTP cache a 64 MiB minimum quota so large versioned DSH scripts can be reused across page loads. Older WebViews keep their default quota; the app never lowers a larger existing quota.

To remove one computer, delete its row from the device list. A full reset uses Android system app information → clear app data (labels vary by system). It deletes all pairings, cookies, cache and Web storage and requires pairing again; do not use it as the first response to an ordinary reconnection failure.

Deleting a row removes the App's saved device token and pinned certificate, not computer-side authorization. WebView's short-lived site cookies are separate; revoke the device on the computer when access must end immediately. A full App reset clears all sites, so do not use it to remove only one computer.

## Security properties

| Control | Android behavior |
| --- | --- |
| Transport | HTTPS origins only; cleartext traffic is disabled. |
| TLS | LAN pins its pairing-key CA privately. The self-signed FRP entry requires a remote CA pin in app 0.4.6 or later. Both accept only an otherwise-untrusted, valid leaf for the exact Origin. Public-CA remote entries use platform trust; every other TLS error is cancelled. |
| Origin | Only scheme, normalized host, and port persist. Ordinary paths, queries, and fragments do not. |
| Navigation | Same-origin main frames stay inside; user-initiated external HTTPS links open in the system browser. |
| Permissions | File input uses the system document picker without storage permission. Camera permission is requested for QR scanning or photo capture; microphone permission is requested for DSH voice input. |
| Downloads | Foreground GET from the exact origin only; authentication control paths are never downloads. |
| Data | Android Keystore encrypts device records, including tokens, origins and pinned CAs; Web storage stays in the app sandbox. Deleting a device removes its record only; system clear-app-data removes all pairings and Web data. |
| Backup | App backup is disabled; TLS private keys and signing keys must remain outside the repository. |

The network security configuration does not trust user-installed CAs. For LAN, the plugin signs a new leaf for the selected interface address while the app retains the stable CA pin. For the self-signed FRP entry, the computer-side CA lasts five years and its public-IPv4 leaf lasts 397 days; the leaf can rotate under the same CA, but CA expiry or replacement requires a new fingerprint check and re-pairing. These are certificate lifetimes, not an unattended-availability guarantee.

## Mobile extension bridge

The authenticated page can call the Android bridge through `dshMobile` extensions. It uses an `androidx.webkit` WebMessage listener, checks the exact configured top-level origin and `isMainFrame` on every message, and never uses `addJavascriptInterface`. Inbound messages are capped at 1 MiB, clipboard text at 256 KiB, binary results at 8 MiB, and replies at 12 MiB. The bridge does not expose cookies, device tokens, pairing keys, CA private keys, or arbitrary Android APIs.

Available actions include `files.pick`, `camera.capture`, `share`, `clipboard.read`, `clipboard.write`, `notification.notify`, `notification.settings` and `mobile.switch-computer`. DSH keeps its file-attachment action in Add; Mobile adds camera capture there when the current attachment owner accepts images. The separate `files.pick` follows the caller's MIME types and returns at most 8 MiB through the bridge; that is not a limit on DSH's file selector. Camera capture requests permission when used, writes a full-resolution JPEG through `FileProvider` and returns a browser `File`.

Task reminders use Host completion events and explicit pending-input cards while the page remains alive. Enable notifications or open system settings from DSH **Settings → General** inside the app. Lock-screen text is generic, different tasks do not replace each other and tapping opens the app. Completion reminders require SSE and have no offline event replay; Cloudflare Quick Tunnels do not support the stream. See [channel limits](../../docs/CLOUDFLARE_TUNNEL.en.md#quick-tunnel-feature-limits).

Only one file-selection or camera interaction runs at a time, with a five-minute deadline. Cancellation, WebView destruction, timeout and stale-session results are cleaned up or rejected. Browsers use corresponding Web APIs and return `unsupported` when unavailable.

From App 0.4.7, its native keyboard adapter uses plain Enter for a new draft line when an inset-backed on-screen keyboard is visible, Android reports no hardware keyboard, and an active session composer is focused. The Send button still submits a multiline draft. Floating keyboards, unknown state and older Apps do not use this native rule; the plugin's touch-browser rule below can still apply. Physical keyboards can use Shift+Enter for a line break.

From 0.6.0, the main composer in touch-primary browsers uses Enter to add a line to a nonempty draft and does nothing for an empty draft. DSH retains menus, composition and modified shortcuts. An external keyboard on a touch-primary browser uses that same rule; a non-touch desktop is unchanged. General settings offers a mobile font size of 12–32px, default 16px, saved for the current address only; editable inputs retain a 16px minimum.

The plugin 0.6.3 candidate adds **More font settings** for body/code fonts, with **Restore defaults**. These are webpage preferences for the current address, not computer-wide settings; they do not require the new APK. Terminal fonts remain controlled by DSH. **Page zoom** is a separate native control described in the App candidate section above.

DSH records through `getUserMedia` and sends audio to the configured computer-side DSH speech provider for transcription, not browser-native SpeechRecognition or the extension bridge. The app requests microphone permission on first use and grants audio-only capture for the paired HTTPS Origin. Computer components, model and network must be available; permission does not guarantee transcription. Same-origin client plugins share the page's permissions, so grant recording only when you trust them.

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

Shared URL-policy tests cover origin normalization, pairing entry, same-origin navigation and download paths. PJW110 with Android 16 and WebView 151 was used to verify model-menu Back, rotation with draft/reference/image retention, known revocation through checks and restart, and re-pairing the same device. That evidence uses an isolated HTTPS instance over USB, not a public tunnel. A real VPS plus phone end-to-end test of the self-signed FRP entry has not been recorded; other devices, cutouts, font scaling, TLS failures, file input and downloads still require device-specific acceptance.

A 0.5.6 development build used to prepare 0.6.0 additionally verified in-place Debug upgrade with paired data retained, all seven Launcher choices, two isolated computers, explicit order surviving later connections, scanner buttons/double-tap zoom and camera release on this device. Physical pinch, real QR recognition, older-Android fallback and process-death restoration are not represented as completed device checks.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
