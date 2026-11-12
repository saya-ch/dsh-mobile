# DeepSeek Harness Android App

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness is the display name of this community-maintained Android WebView app. It opens the plugin's authenticated HTTPS page rather than bundling another DSH frontend. The app and mobile browsers receive the same DSH features and computer-side mobile customizations.

The current stable app is **0.7.4** (build 89). The npm plugin and Android App have independent versions: a plugin update does not automatically require another APK. See the [0.7.4 changes](#074-update).

This APK supports Android 10 or later. iPhone and iPad use the [Safari Home Screen web app and optional Web Push](../../docs/WEB_PUSH.en.md), not this Android package; no native iOS app is distributed.

## Install and pair

1. Install and enable the plugin using the [project quick start](../../README.en.md#quick-start). Complete LAN setup from the command line or the computer's **Mobile Access** panel.
2. Install a signed Android APK from [GitHub Releases](https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.7.4). Choose the compatibility `.apk` for existing HTTPS channels, or the full `-iroh.apk` for experimental iroh on arm64-v8a/x86_64. Both have the same package ID and official signer; install only one and upgrade in place to retain pairings. A differently signed Debug APK cannot replace it; do not uninstall or clear data just to bypass that mismatch.
3. On the computer, generate a pairing key/link under **Mobile Access → Local network**, or configure a remote provider and generate its remote pairing QR code. In the app, choose the matching connection mode and scan or paste the link.
4. Name the computer. The app stores each LAN or remote pairing as its own record. The phone does not need a cpolar, Cloudflare or Tailscale app.

For LAN, the app also offers a scan and manual `https://IP:port` entry. Discovery cannot bypass firewall rules, campus-network isolation or missing routes; use a reachable address or a remote channel when necessary. Browser pairing has its own [connection instructions](../../README.en.md).

## Devices and settings

The **Paired computers** list shows names, connection types, addresses, reachability and recent connections. Tap a row to connect; long-press or use **More** to rename, check, reorder or delete its local record. New records append to the list; **Move up / Move to top** changes presentation, not the startup choice. **Add computer** accepts a fresh pairing link; pairing the same installation in the same mode retains its custom name.

| Location | Setting or action |
| --- | --- |
| Device list → Settings → Startup behavior | **Open DSH directly** (default) selects the last-used eligible pairing, even when several computers are saved. **Show device list** asks you to choose at each launch. |
| Device list → Settings → App icon | Choose the mascot or one of six whale-mark colors without changing package identity or paired data. |
| Device list → Settings → Automatic same-computer connection | App 0.6.7+ with plugin 0.6.16+: keep **Manual** (default), choose **Detect and ask**, or enable **Automatic switch and notify**. Pair LAN and remote independently; [switching rules](#automatic-same-computer-connection) explain draft handling. |
| DSH page → Settings → General → Switch computer | Return to the paired-computer list. Holding the top-left drawer toggle provides another entry. These actions belong inside the app's webpage, not the device-list settings. |
| <a id="062-update"></a>DSH page → Settings → General → Page zoom | App 0.6.2+ with plugin 0.6.3+: 80–125%, reset to 100%. Saved app-wide without reloading the conversation. |
| DSH page → Settings → General → Mobile font size | Default 16px, range 12–32px; saved for the current address. Supported themes also expose code size and body/code font choices. Editable inputs retain a 16px minimum; terminal fonts remain DSH-owned. |
| DSH page → Settings → General → Mobile page modules → Manage | Choose optional frontend modules for this paired device. This neither uninstalls computer plugins nor revokes their authorization; [module rules](../../docs/CLIENT_MODULES.en.md) describe dependencies and applying changes. |
| DSH page → Settings → General → Task notifications | Request Android notification access or open the app's system notification settings. See [notification limits](#notifications-and-extensions). |

Page zoom changes the whole page and is separate from per-address text preferences. App-only actions are shown only when the native bridge supports them. Native screens follow the Android system language in Simplified Chinese, English or Italian; webpage copy follows DSH's selected locale. DSH does not currently expose Italian.

Deleting a local record removes its saved token and pinned CA, not the computer's authorization or every short-lived WebView cookie. Use **Mobile Access** on the computer to revoke access immediately. A full Android clear-app-data reset removes all pairings and web data and is not a normal reconnection step.

## 0.7.4 update

Cache the revision-addressed mobile page payload on the device, independently of the WebView's HTTP cache: a revalidated boot batch can revalidate with `If-None-Match` and serve the stored body after a 304, and a revision-named plugin combo bundle is addressed by its ordered module list and revision. A body is stored only after its size and SHA-256 match, and a cache miss or any integrity, epoch or ownership failure falls back to the ordinary request; documents, API responses, credentials and non-revisioned assets never qualify, and clearing site data or removing the paired device clears the store. The persistent background-reminder notification now reports the real phase — connecting, connected or not connected — and publishes `connected`, `lastEventAt` and a bounded `lastError` stage through `notification.background.get` and a `DshMobileBg` logcat line, background-service completion notifications carry their own `dsh-task-bg-` tag, the service rebinds to the newly active paired computer instead of retrying the previous Origin, and the opt-in is withdrawn when the active record cannot serve it, including an iroh pairing. A tapped task notification now opens the notified Session inside the live page through the page's in-place hook, falling back to route navigation when the page is not ready or cannot handle the route. Both APK variants retain the established signer and existing pairings; the page-side halves need plugin 0.8.7 or later.

## 0.7.3 update

Open the matching conversation after a task-notification tap by carrying a bounded same-origin `dsh-session` route through the native notification, and add an explicit, opt-in `dataSync` foreground service that keeps the current paired-computer event stream alive for completion alerts after Android suspends the page. The service shows a persistent notification, refuses iroh pairings, does not replay events across disconnection, and remains subject to Android foreground-service time limits and battery policy. Both APK variants retain the established signer and existing pairings; the background stream needs plugin 0.8.6 or later.

## 0.7.2 update

Accept the paired gateway's `wss:` certificate callback only when its host and port match the saved HTTPS origin and its certificate passes the pinned CA, validity, signature and SAN checks. Ordinary HTTPS navigation and download rules remain unchanged; third-party WebSocket paths still require computer-side approval. This is an App change and cannot be installed by updating npm. Both APK variants retain the established signer and existing pairings.

## 0.7.1 update

Update AndroidX WebKit to 1.18.0 and the build toolchain to AGP 9.4.1 / Gradle 9.8.2, retaining Android API 36 and the existing pairing format. Both APK variants keep the established signer and upgrade in place. Plugin 0.8.0's iPhone/iPad Web Push is a computer-side feature, not a reason to update the Android app.

## 0.7.0 update

App 0.7.0/build 85 adds optional experimental iroh pairing and native transport in the full APK, working with plugin 0.7.0 or later. The compatibility APK retains existing HTTPS channels without native libraries, including on 32-bit devices. Legacy updates download compatibility by default; choose the full APK explicitly when using iroh. Both retain the device list, HTTPS pairings and established signer. Records from the separate experimental App do not migrate automatically.

iroh is off by default. Select **iroh (Experimental)** in the computer's **Mobile access** connection list, install the verified component, then enable it and generate a dedicated pairing QR code. Direct/relayed connectivity depends on both networks; mobile browsers cannot use this transport directly. See the [iroh guide](../../docs/IROH.en.md).

## 0.6.8 update

App 0.6.8/build 84 keeps the first page download under the existing overall connection deadline instead of interrupting it with a shorter page timer and automatically starting over. A genuine first-load failure keeps explicit retry; recovery for an already running page, TLS verification and cancellation remain available. Upgrade the App to receive this native fix; a plugin-only update cannot provide it.

## 0.6.7 update

App 0.6.7/build 83 adds optional same-computer LAN/remote switching when used with plugin 0.6.16 or later. Manual remains the default. Pair both entries independently, then choose a switching mode in device-list Settings. Eligible same-Session plain-text drafts can follow an automatic switch; this is not full-page state migration. See the [switching rules](#automatic-same-computer-connection).

Foreground recovery uses DSH's public reconnect operation. App 0.6.7 also advertises `auth.renew` for one native renewal attempt during a continuous disconnection. Page-requested renewal uses the existing cancellation and connection deadline, retains a compact **Stop reconnecting** action over an already displayed document and does not deliberately hide its keyboard. Session Cookie writes wait for platform callbacks and are serialized by host across Activity replacement. Recovery neither automatically replays operations nor refreshes the current page; Back at the root still exits the app. Existing official pairings and the release signer are retained.

Plugin 0.6.16 adds **Gallery → Take photo → File** to the dedicated mobile attachment menu when image attachments are supported. Gallery requests images through the standard picker, without a capture request; cancellation keeps the draft unchanged and old results cannot attach to another composer or document. App 0.6.4+ already supports this picker path, so the shortcut alone does not require another APK. **File** remains the general attachment entry; the picker shown depends on Android and the available providers. Browser pairing and reconnect pages also remember the supported DSH display language for the gateway hostname; native Android screens still follow the system language.

## 0.6.6 update

Android 0.6.6/build 82 prevents repeated automatic recovery while renewal or Cookie installation is already pending. Background restore work for the same credential waits for the previous worker to exit instead of overlapping it.

Cancellation and the connection deadline withdraw queued work and late results so an older recovery cannot replace a newer action. Existing pairings, package identity and the pairing protocol are unchanged; no data reset or re-pairing is required for this update. Network availability and recovery of an unsaved webpage still depend on the connection and WebView state.

## 0.6.5 update

Android 0.6.5/build 81 adds an immediate **Cancel connection** action during startup, saved-computer connection, LAN scanning and pairing. Cancellation returns to the device list or editable form without deleting existing pairings. **Stop reconnecting** retains a usable DSH page; a blank or failed document returns to the list.

The initial wait uses the whale-girl background, a centered loading indicator and a cancellation button, without a separate modal dialog. A trusted page's first visible commit reveals its own loading progress immediately. A small, nonblocking Cancel button remains until usable page controls appear; the app does not wait for every image or require a particular layout class.

One overall budget covers each connection, including queued work, native authentication, retries and initial page loading: **30 seconds for LAN, 60 seconds for remote access**. Retries do not restart it. Manual failures settle visibly, a cached unreachable status still permits retry, and failure never silently selects another computer.

Cancellation withdraws queued retries and late navigation results and requests native network disconnection. It cannot roll back a pairing already accepted on the computer; generate a new QR code if its one-time code was consumed. These native controls require App 0.6.5 or later; updating npm alone does not install them.

## Automatic same-computer connection

App 0.6.7 with plugin 0.6.16 or later offers three modes under Device list → Settings → Automatic same-computer connection: **Manual**, **Detect and ask**, and **Automatic switch and notify**. Manual remains the default. Pair LAN and remote independently. Only matching authenticated `installationId` values from successful native pair/renew/probe responses group endpoints. Older plugins/records without this value remain separate until authenticated refresh or renewal learns it; no re-pair/reset is needed. Discovery, names and matching addresses never authorize grouping. Every endpoint retains its own token, `instanceId` pin and CA.

Enabled modes prefer that same computer’s eligible LAN pairing on cold startup. When Wi-Fi is lost while using LAN, foreground detection probes the trusted remote candidate immediately instead of waiting for LAN renewal to time out. Foreground network callbacks and 30-second checks still use debounce, rate limiting and a switch cooldown. A transient LAN renewal failure may try only its trusted same-computer remote pairing; revocation, expiry, TLS and identity errors do not trigger fallback. Background callbacks and stale navigation results cannot switch pages. No sends or other writes are replayed.

**Limited plain-text migration, without DSH core changes.** When a page is already open, Detect and ask requires confirmation before replacing it. Automatic switch and notify can transfer one observed session's plain-text draft (including an empty draft, at most 256 KiB UTF-8) using the plugin's public session-scoped input facade. It keeps the source WebView alive while independently authenticating the target, opens that same session through the public UI navigation API, and imports only into an empty or identical target draft. The target import and final source revision must still match immediately before adoption; changed/conflicting text, stale callbacks, navigation or failed authentication cannot authorize adoption. A successful switch shows a brief notice; the old page is discarded only after adoption. Same-Origin recovery retains its existing preservation path.

This is **not full cross-Origin state migration**. Attachments, structured references, command mode, queues, observed submission/media/IME activity, multiple observed composers, and unknown or missing protocol state are not eligible for this automatic plain-text path. An ineligible source requires confirmation before switching. Target readiness or migration failure retains the source rather than silently discarding it. Cancel/defer keeps the page. Unobserved hidden drafts, detached/in-flight work, scroll and open panels are not transferred; these public APIs cannot prove their exhaustive safety. Save/copy that work before a confirmed reload.

Migration snapshots and leases are temporary in-memory state, not new cross-Origin storage. Writing the target uses DSH's normal draft persistence. Abort conditionally undoes only this import if its target revision is still unchanged; renderer loss or unavailable rollback cannot guarantee removal of a target draft already persisted by DSH. No send/upload is replayed. Device-test coverage and remaining network limits are listed under [acceptance and known limits](#acceptance-and-known-limits).

## Connections, recovery and trust

Device records, long-lived revocable tokens and pinned CAs are encrypted with Android Keystore. Existing LAN/remote slots migrate without re-pairing. Temporarily unreadable encrypted data is reported, not treated as an empty list or overwritten. An expired CA record remains available for deletion or re-pairing, while TLS continues to reject the expired certificate.

The app renews a short Web session only at the exact saved Origin. After a LAN address change, it can discover the same installation on the default port and renew under the existing pin. A rotated remote Origin cannot be discovered through its expired predecessor: scan the computer's current remote QR code to verify the new address. The old device token is never sent to that unverified address.

Discovery carries metadata only. DNS-SD/mDNS, UDP announcements and active port-3443 queries are supplemented by bounded HTTPS probes of visible private Wi-Fi/hotspot `/24` subnets. For other ports or routed subnets, enter the address manually. Discovery success is not pairing authorization.

LAN and self-signed FRP pairings fetch the CA without device credentials, verify its validity and fingerprint against the pairing key, and pin it privately for the exact Origin. Other TLS errors are rejected; no CA is installed in Android's system trust store. A leaf renewed under the same CA does not require re-pairing, but a changed or expired CA does.

Ordinary remote entries use publicly trusted HTTPS. The [managed FRP](../../docs/SELF_HOSTED_FRP.en.md) public-CA path supports App 0.3.3+; [existing-frps self-signed ingress](../../docs/ATTACH_EXISTING_FRPS.en.md) requires App 0.4.6+. Normal browsers do not automatically trust that private CA. Certificate lifetimes do not guarantee unattended availability.

Temporary network failures are not revocation. An online computer-side revocation marks the row **Removed on computer** and prevents later probes from restoring it. A device revoked while offline may instead receive the generic **Pairing expired** result; re-pair with a fresh code. The app does not reveal whether an unknown token belonged to a removed device.

Automatic recovery tries to retain an already mounted DSH document after renewal. Renderer loss or a failed boot may require reopening, so unsaved state cannot always be recovered. Supported rotation, window and keyboard changes retain the WebView; system theme/font/language changes, process termination and renderer failure may recreate it.

## Files, camera and input

### Standard attachments

App 0.6.4+ uses the system Photo Picker on Android 13+ for supported image filters. It preserves the webpage's MIME and multiple-selection settings within system limits. Other filters, capture requests, older Android or an unavailable picker use Documents. No storage permission is added and no manufacturer's gallery is guaranteed.

Standard file callbacks belong to the current WebView, Origin and document. With navigation-listener support, pending requests are withdrawn before document replacement and new selection waits for navigation to finish. Older WebViews use available callbacks; if selection stops opening after changing pages, update WebView or return to the device list and reopen the computer, without clearing data.

DSH keeps its file action in **Add**; Mobile adds **Take photo** and **Gallery** when the active attachment owner accepts images. Only the dedicated Mobile page puts **Gallery → Take photo → File** first; all other official actions retain their upstream order, and stock/desktop menu ordering is unchanged. **Gallery** opens an image-only standard file selector without requesting camera capture, using the system picker described above in the App and the browser's file picker elsewhere. It does not require a new Bridge capability or App build. **Take photo** explicitly requests camera permission and returns a full-resolution JPEG. Both use DSH's existing draft attachment intake; cancelling selection adds nothing, and a result belonging to a previous conversation or disposed page is ignored. For troubleshooting, select one small JPEG/PNG and inspect the unsent draft preview. Files awaiting submission need not already exist as computer-side image objects; no model request is necessary to check selection.

### Keyboard and page space

System Back first dismisses supported webpage layers, then handles same-origin WebView history, and exits at the root. Model submenus return to their parent before closing. No extra native toolbar is shown above the WebView.

The native soft-keyboard adapter uses plain Enter for a line break only with a visible inset-backed keyboard, no reported hardware keyboard, and a focused active-session composer. The plugin's separate touch-browser rule also uses Enter for draft line breaks, including external keyboards on touch-primary browsers. Menus, composition and modified shortcuts remain DSH-owned; non-touch desktop behavior is unchanged. Use Send for multiline messages or Shift+Enter where DSH's normal keyboard policy applies.

System bars, cutouts and keyboard occupancy are reserved once. A WebView that supports `HTTP_CACHE_MANAGER` and `MULTI_PROFILE` receives a minimum 64 MiB HTTP-cache quota for reusable versioned DSH resources; older engines retain their default quota. A Chromium-below-100 reminder is advisory, not a promise that every DSH API is supported on that engine.

A successful App connection does not establish that its engine can execute the page. The DSH 0.2.1-rc.2 frontend contains syntax Chromium 92 cannot parse. If system WebView cannot be updated, use a browser confirmed to work without clearing pairings. See the [old-engine notes](../../README.en.md#app-or-mobile-browser) for the plugin's startup feedback and support limits.

### Voice

DSH records audio through `getUserMedia` and sends it to the configured computer-side speech provider, not browser SpeechRecognition or the extension bridge. Android asks for microphone permission and accepts audio-only capture from the paired HTTPS Origin. Provider components, models and network access must work; granting recording permission does not verify transcription. Same-origin frontend plugins share that page permission.

## Notifications and extensions

Task reminders use Host completion events and pending-input cards. While the page is alive it sends notifications through the native bridge; **Settings → General → Task notifications** can explicitly enable **background reminders**, a foreground service that can be turned off in Settings and keeps the active paired-computer connection alive after Android suspends the page. The service remains subject to foreground-service time limits, battery policy and connectivity, displays a persistent notification, does not yet support iroh pairings, and does not replay events across disconnection. A tap may carry a bounded same-origin `dsh-session` route, which opens the matching conversation after a cold or warm start; any other target falls back to the app root. Cloudflare Quick Tunnels do not support the event stream; see [channel limits](../../docs/CLOUDFLARE_TUNNEL.en.md#quick-tunnel-feature-limits).

Android's own battery management can still stop delivery, and the persistent notification does not prove the stream is alive: it stays while the service runs, whatever the connection is doing. Settings → General reports the service's real phase — connected, not connected, or the bounded failure stage it last recorded — and a `DshMobileBg` logcat line records the same transitions for `adb logcat` diagnosis. On an OEM build that freezes a background process (for example Xiaomi HyperOS's app battery saver), no App-side change keeps the stream open: allow battery use without restriction for this App, or accept that reminders arrive when the App is next foregrounded. iOS is unaffected because it uses the Web Push path instead.

The authenticated page may use the `dshMobile` bridge for `files.pick`, `camera.capture`, `share`, clipboard read/write, task notifications/settings, background reminders (`notification.background.get`/`set`), computer switching and page scaling. The separate extension `files.pick` returns one file, follows its requested MIME types and limits bridge-returned file bytes to 8 MiB. This is not the standard DSH attachment selector's limit.

Bridge file/camera operations are serialized with a five-minute deadline. Cancellation, document/session changes or WebView teardown reject stale results and clean up owned resources. Browser media selection waits for an actual result, explicit cancellation, abort or deadline; returning focus is not itself cancellation. Unsupported capabilities return `unsupported`.

Computer-side `host.mjs` extensions are trusted Node.js code, separate from this native bridge; the bridge cannot edit or upload their source. Computer-managed frontend assets and extension activation are documented in the [project guide](../../README.en.md), and optional Worker execution in the [Worker guide](../../docs/EXTENSION_WORKERS.en.md).

## Security properties

| Control | Android behavior |
| --- | --- |
| Transport | HTTPS only; Manifest cleartext traffic is disabled. |
| Trust | Exact-Origin platform trust or a privately pinned pairing CA. User-installed system CAs are not broadly trusted. |
| Navigation | Same-origin main frames remain inside; explicit external HTTPS links open in the system browser. |
| Permissions | Camera for explicit scanning/capture, microphone for DSH recording, notifications through a foreground permission/settings action, and an explicitly enabled `dataSync` foreground service for background reminders; standard file selection needs no storage permission. |
| Bridge | WebMessage listener validates exact top-level Origin and main frame; no `addJavascriptInterface` or arbitrary Android API. |
| Limits | Inbound message 1 MiB, clipboard 256 KiB, binary bridge result 8 MiB, reply 12 MiB. |
| Credentials | Bridge replies do not automatically include stored pairing credentials; there is no direct bridge API for reading the credential store or private keys. Clipboard contents and selected files may contain sensitive data: use only trusted extensions. |
| Downloads | Foreground GET from the exact Origin only; authentication-control paths are excluded. |
| Storage | Keystore-encrypted pairings and sandboxed web data; cloud backup and device transfer are disabled. Signing/TLS private keys must stay outside the repository. |

## Build

Use Android Studio or Android SDK 36 and JDK 17. The repository includes the Gradle 9.8.2 Wrapper.

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

The Debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Official releases use the established signing key stored only in repository Secrets. A local unsigned Release build or a Debug install is not official-signer evidence.

Every build ships the experimental iroh transport by default. It requires Rust 1.99.1 with the `aarch64-linux-android` and `x86_64-linux-android` targets plus an explicitly selected NDK:

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:assembleDebug -PirohNdk=C:/Android/Sdk/ndk/25.2.9519653 -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

Pass `-PirohNative=false` for a fast toolchain-free lane that builds the original HTTPS shell without iroh transport; `IrohNative` reports itself unavailable. Using iroh requires the full build. The transport libraries are generated under `app/build/generated/iroh/jniLibs/` and never committed. A native-enabled build does not change the package identity or the established signer; the independent alpha signer from the iroh experiment is not used here.

Native builds also include the JVM TLS verifier matching `native/Cargo.lock`, from the revision-pinned official Maven archive. Preserve its JNI/Proguard rules: compiling and packaging the `.so` alone is insufficient. The APK verifier checks the retained JVM classes and native entry names in both Debug and minified Release builds.

Current-source Debug builds use package `io.github.sayach.dshmobile.debug` with a `-debug` version suffix. They install beside the official App with separate storage and pairings. They do not upgrade or migrate an older unsuffixed Debug installation; preserve that app and its data rather than uninstalling or clearing it to switch packages. Release builds keep `io.github.sayach.dshmobile` and the established signer.

The verified stable release is [Android 0.7.4](https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.7.4), build 89. The compatibility and full APKs each have a matching `.sha256` asset. Both public downloads retain the established release signer and package `io.github.sayach.dshmobile`. Earlier release history belongs in [CHANGELOG](../../CHANGELOG.md).

## Acceptance and known limits

- Both public App 0.7.4 APKs passed checksum, manifest, established-signer and size checks; the compatibility APK contains no native libraries and the full APK carries only the two iroh transport ABIs. There is no new physical-device or public-network run for 0.7.4: the device cache, background-reminder status and in-place notification tap paths are covered by the Android unit tests and CI release builds only, and the Debug-device evidence below belongs to 0.7.3.

- A current-source Debug build (0.7.3/build 88) paired over a cloudflared remote origin received a real completed-turn notification while the app was backgrounded and the screen locked, and tapping it opened the `dsh-session` route to the matching conversation; disabling the opt-in stopped the service and removed the notification. This was the Debug signer on one test device over a public tunnel; it does not establish the published APK, iroh, or every network and OEM behavior.

- Both public App 0.7.1 APKs passed checksum, manifest, established-signer, notice and alignment checks. The full APK additionally passed ABI and retained JVM TLS/JNI entry checks; compatibility contains no native libraries. There is no new physical-device or public-relay run for 0.7.1. Earlier arm64 development traffic remains historical evidence, not proof that a current connection uses the relay.

- A current-source Debug build was installed beside the official App on TB710FU (Android API 36) and paired to an isolated DSH 0.2.2-rc.1 gateway with a pinned local CA. The DSH page opened, system Back returned to the launcher, the task-notification permission flow opened, and enabling then disabling background reminders started and stopped a `dataSync` foreground service with its persistent notification. This was an isolated Debug package, not the official signer, and did not deliver a real task-completion event through a model run.

- App 0.6.8's public APK passed identity, checksum and established-signer verification. A matching-signer Debug upgrade opened DSH and retained the saved device; controlled slow-link fault injection was interrupted before pairing and is not counted as passed.

- App 0.6.7 Debug builds were checked on PJW110, Android 16 and WebView 153 with isolated DSH 0.2.1-rc.2 over USB-reversed pinned HTTPS. Actual automatic staged adoption retained a same-Session Unicode draft and kept target native zoom/renewal working without another page load. Confirmation cancellation, held-target Back cancellation and late responses, native renewal cancellation, keyboard Back and picker cancellation also passed; QA pairings and mappings were removed afterward. This was not a real Wi-Fi/cellular transition or an installation of the formally signed APK.
- Connection-control development builds used Debug metadata 0.6.4/build 80 on PJW110, Android 16 and Google WebView 153.0.8010.36. Against an isolated DSH 0.2.0-rc.2/plugin 0.6.10 instance over USB and pinned HTTPS, checks covered pairing/startup/saved-connection cancellation, Back, failed manual connections and return from a failed page after stopping native recovery. Held module responses also verified early webpage display, touch-through outside compact cancellation, cancellation and later completion. Pairings were retained and owned QA records removed.
- Debug builds of App 0.6.4 retained one WebView across document replacement/reload, rejected an old selection, and received controlled PNG bytes with a decoded DSH draft preview. A held navigation and HTTP 204 also checked selector availability. Earlier checks covered model-menu Back, rotation with draft/reference/image retention, known revocation, re-pairing, icon choices and list ordering. None required a model prompt.
- These observations do not establish final official-signer APK device acceptance, every public provider, remote 60-second timing, every outage/recovery sequence, HyperOS/older WebViews or every screen/gesture configuration. Self-signed FRP still lacks a recorded real-VPS-plus-phone end-to-end check. Permission grants alone do not establish voice transcription, and process-death restoration is not guaranteed.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
