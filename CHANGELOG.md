# Changelog

Notable changes are recorded here. GitHub Releases provide the downloadable packages and generated commit notes.

## Unreleased

- Recognize the four-seat settings grid introduced in DSH 0.2.2-alpha.2. Preserve upstream navigation and grid placement while retaining Mobile's accessible close-button target; older two-column settings keep their existing mobile layout.
- Extend upstream compatibility checks to DSH 0.2.1-rc.5 and 0.2.2-alpha.2, including settings, directory selection, attachments, sidebar, compressed Workspace traffic and public push lifecycle checks. No Android App update is needed for this web-page adjustment.
- Give plugin panels a host-provided touch floor on coarse pointers (44px hit region, pane scroll containment, opt-out via `data-dsh-adapt="off"`), and stop WebView font boosting from breaking plugin line boxes. Thanks @LUgABeEEE for [#319](https://github.com/saya-ch/dsh-mobile/pull/319).
- Add a bilingual **plugin mobile baseline** (L1/L2/L3 levels, number provenance, copy-paste stylesheet) as informative project guidance, not an official DSH standard. Thanks @LUgABeEEE for [#316](https://github.com/saya-ch/dsh-mobile/pull/316).
- Android: reuse revalidated `mobile-boot` batches from a device-side content-addressed cache to cut cold-start re-downloads (~3.8 MB on the measured device); every hit revalidates by ETag and 401/403 still falls through to the WebView. Thanks @LUgABeEEE for [#314](https://github.com/saya-ch/dsh-mobile/pull/314).
- Local network: add **Change network** in the desktop LAN panel — re-scans interfaces, keeps the private CA and paired devices, re-signs the server certificate for the new address, updates the listen address and allowed subnet, and restarts the listener when running (connected phones reconnect with a new pairing QR). [#317](https://github.com/saya-ch/dsh-mobile/issues/317)
- Add **three opt-in cache groups**, all off by default. The API read cache (`contentCacheTtlMs: 0`) serves an explicit path allowlist (`contentCachePaths`, default `/api/sessions`), clears itself on any non-GET/HEAD request, and replays an expired entry only after `If-None-Match` revalidation when the upstream supplied an ETag. The static resource cache (`contentCacheAssetTtlMs: 0`) covers plugin bundles and owned files (`contentCacheAssetPaths`, default `/plugins`, `/assets`, `/mobile-access`) with a longer window, revalidating the same way, and is never dropped by a write. Replays carry `Age` and `X-DSH-Mobile-Cache`; browser responses keep `Cache-Control: no-store`, and uploads, writes, event streams, range requests, `Set-Cookie` responses and oversized bodies are never cached. Each group is bounded by both `contentCacheMaxBytes` and an entry count (`contentCacheMaxEntries`, default 256). A third group (`contentCacheHistoryTtlMs: 0`) covers POST read methods — by default only `session/page` on `/api/session` — keyed by the request body, with a short window and the same clear-on-write rule, because Session history cannot use the GET path. See [slow connections](docs/SLOW_CONNECTIONS.md#可选的缓存数据读静态资源与历史页090-起).

## 0.8.0 - 2026-10-30

- **iPhone / iPad Web Push:** add opt-in notifications for capable Safari Home Screen web apps on trusted HTTPS, targeting iOS/iPadOS 18.4+. Choose Questions, Plans, Approvals, Responses, Goals and Failures in **DSH Settings → General → Web push notifications**, and send a test without submitting a model request. No native iOS app, service worker or notification SaaS account is required. Thanks @chintoleung for [#297](https://github.com/saya-ch/dsh-mobile/pull/297).
- Add a complete Safari pairing → Add to Home Screen → notification setup guide in Chinese and English. Explain separate Home Screen login state and generating a fresh pairing code without clearing existing data. Thanks @chintoleung for [#302](https://github.com/saya-ch/dsh-mobile/pull/302).
- Keep notification consent scoped to the paired device and exact Origin, with generic lock-screen text, encrypted Apple-only delivery, bounded retries, revocation checks and restart recovery. Notification taps never answer or approve a request. Delivery is best effort; this release accepts the contributor's iPhone testing, not independent maintainer Apple-device verification. See the [Web Push guide](docs/WEB_PUSH.en.md).
- Refuse to report browser logout as completed when optional push services are unavailable but this device still has enabled persistent notification consent; retain authentication for an explicit retry instead of silently leaving notifications enabled.
- Apply private-file permissions before writing push keys or subscriptions to a replacement file; permission failure removes the empty candidate and leaves the previous state intact.
- Remember the mobile sidebar's session-list position within the current page, with separate search positions. Sessions behind DSH's **More** control are not automatically expanded; reloading clears this position memory. Thanks @abworks-dev for [#307](https://github.com/saya-ch/dsh-mobile/pull/307).
- Style Mobile's injected Gallery and Take photo actions consistently at every viewport, including when DSH supplies no native button class. Thanks @LUgABeEEE for [#312](https://github.com/saya-ch/dsh-mobile/pull/312).
- Keep in-shell dialogs above the wide navigation rail through scoped layout changes, without maintaining a third-party plugin's private class names. Thanks @LUgABeEEE for [#309](https://github.com/saya-ch/dsh-mobile/pull/309).
- Enable compression on the live `/api/remote.mux` path by default; an explicit `websocketCompression.paths: []` opts out. Savings depend on the data and network. Thanks @LUgABeEEE for [#292](https://github.com/saya-ch/dsh-mobile/pull/292).
- Compress owned static assets with explicit encoding negotiation and `Vary`, keeping 304 responses bodyless. Request the compatibility bundle by its current content digest to avoid a stale shim after updates. API responses and authenticated HTML are not added to a new offline cache. Thanks @LUgABeEEE for [#310](https://github.com/saya-ch/dsh-mobile/pull/310) and [#311](https://github.com/saya-ch/dsh-mobile/pull/311).
- Upgrade React development tooling to 19 while retaining the host-provided React runtime, with no second copy bundled. Thanks Dependabot for [#140](https://github.com/saya-ch/dsh-mobile/pull/140).
- Restore the explicit contributor credit for @qzyqmzn's [#284](https://github.com/saya-ch/dsh-mobile/pull/284), which introduced the integrated iroh transport in 0.7.0.

## Android 0.7.1 - 2026-10-30

- Update the build toolchain to AGP 9.4.1 / Gradle 9.8.2 and WebKit integration to 1.18.0, retaining `core-ktx` 1.15.0 for compileSdk 36. Thanks Dependabot for [#304](https://github.com/saya-ch/dsh-mobile/pull/304).
- Keep the compatibility and full iroh APK variants, the established application ID and signer, and existing pairing data. This is App build 86; plugin 0.8.0's iOS Web Push does not require an Android update.
## 0.7.1 - 2026-10-29

- Reorganize **Mobile access** into a compact channel list and configuration pane, stacked on narrow screens. Device management has its own LAN/remote tabs beside Diagnostics; keyboard focus and Escape follow the open panel.
- Keep the three main actions in one row, including iroh link copying. Copy remains visible but disabled without valid pairing data; component-dependent actions stay hidden before installation.
- Improve cloudflared quick/named tunnel switching, expandable settings and tunnel notes. **Save and connect** saves and enables the selected provider in one queued operation; connection readiness remains visible separately. Protect pending edits from duplicate actions and stale reads, and keep incomplete named settings editable.
- Show the server-issued expiry for LAN and HTTPS remote pairing codes, remove expired QR codes, and reuse the displayed code when copying its link. Generating another code still invalidates the previous one. Thanks @jackfocus15-spec for [#285](https://github.com/saya-ch/dsh-mobile/issues/285).
- Keep the collapsed navigation rail clear of the conversation between the phone and wide-layout breakpoints, without taking 56 px away from phone content. A collapsed phone drawer no longer leaves a transparent strip intercepting conversation input. Thanks @wintekk for [#306](https://github.com/saya-ch/dsh-mobile/issues/306).
- Allow removal of the plugin-downloaded iroh component after remote access is turned off. The authenticated Host route also refuses removal while enabled; identities, pairings and external companion installations are retained.
- Display published APK sizes when available. This optional lookup runs independently of release status and package installation and is cancelled when the plugin stops.
- Add practical Android VPN/proxy troubleshooting for iroh, including per-app bypass and the limits of domain-only rules. Thanks @ZinChl for [#308](https://github.com/saya-ch/dsh-mobile/issues/308).

## 0.7.0 - 2026-10-28

- Distribute the iroh sidecar from this plugin. **Install official component** downloads the pinned `dsh-mobile-iroh 0.1.0-alpha.1` release per platform, verifies byte length and SHA-256, and promotes it into the plugin private directory with backup and rollback; a verified companion copy is reused without downloading during the transition, and switching the channel on alone never downloads. The panel names the download size, reports verification progress, and identifies the exact missing/invalid/offline failure instead of a generic not-ready message.
- Add the experimental iroh remote provider with its own endpoint-pinned gateway TLS identity (stable CA, 90-day DNS leaf with 30-day renewal headroom, no silent regeneration) and a five-minute one-time pairing window that binds the sidecar code to a one-time gateway token, redeemable through the ordinary pair endpoint over the iroh transport. Drain buffered sidecar startup events before minting, so a stale code is never offered.
- Vendor the iroh transport host Rust source (`native/iroh-host`, shared core `native/iroh-core`, MIT with preserved dsh-tether attribution) with per-platform build lanes for the host and both Android ABIs.
- Integrate Android's experimental iroh connection through a JNI-backed HTTPS CONNECT transport, pairing parsing, connection/status controllers and optional pairing-record fields. App 0.7.0's full APK includes arm64-v8a and x86_64; the compatibility APK retains existing HTTPS channels without native libraries. Thanks @qzyqmzn for [#284](https://github.com/saya-ch/dsh-mobile/pull/284), based on the independent dsh-mobile-iroh experiment.

- Retain iroh probe and sidecar ownership until cleanup succeeds; concurrent shutdown waits for admitted startup, and failed termination remains visible and retryable.
- Keep the shell chrome opaque under translucent skins. The navigation drawer, the right detail panel and the panel return bar composite their theme token over the CSS `Canvas` system colour, so a skin that makes those tokens translucent — or leaves them unresolvable — no longer lets conversation text show through the sidebar labels. Thanks @LUgABeEEE for [#286](https://github.com/saya-ch/dsh-mobile/pull/286).
- Isolate the dedicated mobile shell's stacking context so positioned, positive-z-index menus attached to `document.body` can appear above its drawer. Preserve the existing stock-adapter layer values; see the [overlay guidance](docs/MOBILE_PLUGIN_ADAPTATION.en.md#overlay-layering-and-portals) for limits and modal behavior. Thanks @LUgABeEEE for [#295](https://github.com/saya-ch/dsh-mobile/pull/295) and @eeeggplant for [#288](https://github.com/saya-ch/dsh-mobile/issues/288).
- Document using an existing cloudflared tunnel instead of a plugin-managed component. The own-reverse-proxy provider already accepts a public HTTPS origin in front of the plugin's authenticated backend, so a user who already runs a named tunnel can point it at that backend and keep owning DNS, the certificate and the tunnel Token; the plugin neither installs a second copy nor stores the Token. The [self-hosted origin guide](docs/SELF_HOSTED_ORIGIN.en.md#when-you-already-run-cloudflared-yourself) now covers the ingress snippet, the reload step and the two caveats (port 3444 overlap with the managed component, and never targeting 3080/3443). Thanks @yuyang0 for [#300](https://github.com/saya-ch/dsh-mobile/issues/300).
- Show a localized, dismissible notice when mobile customization cannot authenticate or load. A Gateway authentication rejection can request the existing native renewal owner even if transport appears connected; transient failure retains explicit **Retry loading**, and confirmed renewal refreshes read-only custom assets without reloading the page. Stop further renewal after an explicit credential rejection. Browser-only pages retain actionable guidance instead of silently hiding the failure. Thanks @eeeggplant for [#298](https://github.com/saya-ch/dsh-mobile/issues/298).
- Restore the conversation when leaving DSH's native detail-panel fullscreen view. Preserve the active panel and normal toggle behavior instead of leaving the mobile conversation hidden. Thanks @LUgABeEEE for [#299](https://github.com/saya-ch/dsh-mobile/pull/299).
- Update the Android build toolchain and development-only YAML tooling. Thanks @LUgABeEEE for [#296](https://github.com/saya-ch/dsh-mobile/pull/296), [#293](https://github.com/saya-ch/dsh-mobile/pull/293) and [#294](https://github.com/saya-ch/dsh-mobile/pull/294).

## Android 0.7.0 - 2026-10-28

- Add optional experimental iroh pairing and transport in the full 64-bit APK. Existing HTTPS pairings, device management and WebView behavior remain available in both builds; standalone dsh-mobile-iroh App records do not migrate automatically.
- Publish a full `-iroh.apk` and a smaller compatibility `.apk`, with the same application ID, versionCode 85 and established signer. The legacy update/download filename continues to serve the compatibility build, including for 32-bit devices; install the full build explicitly to use iroh. Installing an official build over another retains local data, but the compatibility build cannot connect iroh records.
- Bundle native third-party notices and verify native ABI packaging, 16 KB alignment, compatibility-library exclusion and both signatures in the release workflow.

## 0.6.18 - 2026-10-26

- Preserve DSH's adaptive directory-picker composition. The dedicated Mobile page reuses an available upstream browse picker, including its **New folder** action; a host using the system chooser keeps that chooser on Desktop and gets a separate web directory flow on the remote page. Thanks @OranImp for [#271](https://github.com/saya-ch/dsh-mobile/issues/271).
- Add **New folder** to the Mobile-owned directory flow. Create one child under a confirmed existing directory, report duplicate names and permission errors, and enter the new directory on success. Reject drive-relative and invalid names, fence cancelled results, prevent duplicate submissions and retain cancellation while admitted work settles. Escape and Back first close the creation step; writes are never automatically replayed.
- Give the folder list more room: use one compact path/navigation row, icon controls, a taller picker and smaller header/footer spacing, while retaining touch-sized targets and localized accessible labels.
- Offer the device-scoped module recovery page for stale profile defaults as well as saved computer/device selections. Recovery changes only the current device's selection, not computer defaults, other devices or installed plugins. Thanks @LUgABeEEE for [#276](https://github.com/saya-ch/dsh-mobile/issues/276).
- Add optional `adminAllowedCidrs` for controlled NAS administration. The default remains loopback-only; extra direct peers also require active DSH authentication, with existing Host/Origin and cross-site restrictions. Forwarded IP headers do not grant access. See [trusted networks](docs/TRUSTED_NETWORKS.en.md#accessing-the-nas-administration-page). Thanks @LzBsA for [#272](https://github.com/saya-ch/dsh-mobile/issues/272).
- Refresh only the legacy `upstreamOrigin` snapshot in managed setup when DSH's active WebServer port changes. Runtime forwarding already follows that port; this prevents misleading stale configuration, rather than establishing the cause of every connection timeout. Thanks @LUgABeEEE for [#274](https://github.com/saya-ch/dsh-mobile/pull/274).
- Add a bilingual [mobile adaptation guide for plugin authors](docs/MOBILE_PLUGIN_ADAPTATION.en.md), covering container layout, touch targets, keyboard/focus, safe areas and measured browser acceptance. Thanks @LUgABeEEE for [#280](https://github.com/saya-ch/dsh-mobile/pull/280).

## Android 0.6.8 - 2026-10-26

- Let the existing overall connection deadline govern the first page download, instead of interrupting it with the shorter page timer and automatically restarting the download after renewal. A real first-load failure retains explicit manual retry; already running pages retain their recovery behavior. Existing TLS verification, cancellation and renderer-crash handling remain. Thanks @LUgABeEEE for [#275](https://github.com/saya-ch/dsh-mobile/issues/275).
- App 0.6.8/build 84 is released independently of plugin 0.6.18, retaining the established package identity and signer. Existing pairings remain in place when upgrading the officially signed App.

## 0.6.17 - 2026-10-25

- Keep DSH's own directory-picker composition instead of registering a second Host service and Client surface. Official Desktop retains its native chooser, **Add workspace** action and `Ctrl+O` shortcut independently of Mobile's in-page picker. Thanks @ChaoPhone for [#257](https://github.com/saya-ch/dsh-mobile/issues/257) and @bvbhu for [#258](https://github.com/saya-ch/dsh-mobile/issues/258).
- Keep a familiar in-page folder browser on the dedicated, paired Mobile page, with editable paths, parent navigation, retry and cancellation while browsing or loading. Late responses cannot replace a newer selection, and Back closes the picker before the page underneath. Once a directory is submitted, DSH owns workspace creation; it is not reported as cancelled. The mobile flow does not open an OS dialog on the remote computer or change the desktop's picker.
- Add an authenticated, read-only workspace-directory listing route for the Mobile picker. It lists folders without creating them and rejects unauthorized requests; the existing photo picker and its routes are unchanged.
- Improve slow-link loading with compression for complete text responses and the assembled start page, smaller merged script batches, and revalidation of owned static resources. Keep Session-bound HTML non-storable and preserve streaming and write behavior. Large valid module graphs fall back to individual resources rather than failing only because the optimization reached its batch count. Thanks @LUgABeEEE for [#259](https://github.com/saya-ch/dsh-mobile/pull/259), [#260](https://github.com/saya-ch/dsh-mobile/pull/260) and [#262](https://github.com/saya-ch/dsh-mobile/pull/262).
- Add explicit module transfer-size measurement, partial-size feedback and a required-modules preset without applying choices until saved. Measurement must not delay ordinary catalog reads or saving. Thanks @LUgABeEEE for [#261](https://github.com/saya-ch/dsh-mobile/pull/261).
- Keep fresh API reads and the existing backpressured proxy. The generic short API-cache proposal in [#263](https://github.com/saya-ch/dsh-mobile/pull/263) is not enabled in this release; the author's original contribution remains in the integration history. Thanks @LUgABeEEE for [#263](https://github.com/saya-ch/dsh-mobile/pull/263).

## 0.6.16 - 2026-10-22

- Support App 0.6.7's optional same-computer LAN/remote switching with authenticated installation grouping and limited same-Session plain-text draft transfer through public DSH APIs. Independently paired endpoints keep separate credentials and CA pins; conflicts and unsupported editor state are not silently migrated. Stop disposed draft observers from subscribing again. Thanks @abworks-dev for [#252](https://github.com/saya-ch/dsh-mobile/pull/252).
- Let browser pairing and reconnect pages remember the last supported language displayed by DSH on that gateway hostname. With no usable preference, retain browser-language negotiation. Native Android screens still follow the system language. Thanks @chintoleung for [#253](https://github.com/saya-ch/dsh-mobile/pull/253).
- Add **Gallery** beside **Take photo** and DSH's existing **File** action in the dedicated mobile attachment menu. Gallery opens the standard image-only picker, preserves cancellation and ignores results belonging to an old composer or document. Android App 0.6.4+ already supports this picker path; this plugin shortcut does not itself require a new APK. Thanks @abworks-dev for [#249](https://github.com/saya-ch/dsh-mobile/pull/249).
- Nudge DSH's public connection service when a disconnected page returns to the foreground. App 0.6.7 can also renew authentication once per continuous outage through its advertised native capability, without automatically replaying requests or refreshing the page. Older Apps retain browser-side reconnection. Thanks @ayiejosh for [#241](https://github.com/saya-ch/dsh-mobile/pull/241); original contributor commits are retained alongside maintainer corrections, without upstream bundle rewriting or broader immutable caching.
- Show field-specific FRP configuration errors in Chinese, English and Italian, focus the first invalid field and clear corrected errors. Keep the existing HTTPS, public-address and port checks rather than guessing a scheme or changing the server configuration. Thanks @chenyxuan for [#250](https://github.com/saya-ch/dsh-mobile/issues/250).

## Android 0.6.7 - 2026-10-22

- Add **Manual**, **Detect and ask**, and **Automatic switch and notify** under device-list Settings → Automatic same-computer connection. Manual remains the default. LAN and remote entries must be independently paired with the same computer; enabling this option does not authorize another computer or share endpoint credentials. Thanks @abworks-dev for [#252](https://github.com/saya-ch/dsh-mobile/pull/252).
- With plugin 0.6.16, automatic switching can retain the current Session's eligible plain-text draft while authenticating and staging the target. Keep the source on failed or cancelled migration, and retain native settings, zoom and renewal after adoption without another reload. Attachments, references, queued or in-flight operations, scroll and open panels are not full-page state migration; unsupported source state requires confirmation.
- Add page-requested native authentication renewal with existing cancellation and connection deadlines. Serialize Session Cookie writes by host across Activity replacement, await actual platform callbacks and reject stale results. An already displayed document keeps its compact **Stop reconnecting** action and keyboard state; Back still exits at the root. Thanks @ayiejosh for the renewal contribution in [#241](https://github.com/saya-ch/dsh-mobile/pull/241).
- Refresh pairing instructions in English, Chinese and Italian with the current Mobile Access entry and provider-neutral remote guidance.
- Give Debug builds the separate package `io.github.sayach.dshmobile.debug` and a `-debug` version suffix. They coexist with the official App but do not inherit its data or older unsuffixed Debug data. Official App identity and signing remain unchanged; this release is App 0.6.7/build 83.

## 0.6.15 - 2026-10-21

- Keep the dedicated Mobile page's plugin-update notifications connected during idle periods, without gzip buffering. Live module updates retain the mobile layout and the page's selected modules instead of replacing them with the desktop layout. Upgrade and reload the dedicated page to use the corrected stream; stock and older pages keep their existing behavior.
- Retain authentication, expiry, revocation and cancellation checks for module notifications. A page view does not migrate to a new authentication Session: after native renewal, an old view can return `409 mobile_document_view_invalid` until the page is loaded again. This does not clear pairings or automatically refresh the current conversation. See [connection troubleshooting](docs/SLOW_CONNECTIONS.en.md#keep-event-streams-distinct).
- Allow same-origin audio/video fetched into Blob URLs on the proxied DSH page. External media remains blocked, Gateway-owned pages retain their policy, and Android's media user-gesture requirement stays enabled.
- Fix computer-side JSON management actions when Firefox privacy settings omit Origin. Keep local connection and Host checks, cross-origin rejection and official Desktop authentication. Thanks @axlrose for [#246](https://github.com/saya-ch/dsh-mobile/issues/246).
- Add limited, credential-free diagnostics for the Gateway's authentication exchange with local DSH, separate from phone-side authorization failures.
- Update development bundler dependencies to address Windows editor-launch security advisories; runtime authentication and model routing are unchanged.
- Thanks @Void-LifeStream for the startup and reload report in [#243](https://github.com/saya-ch/dsh-mobile/issues/243). This release improves module updates and diagnostics; the complete reported symptom sequence remains unconfirmed.

## Android 0.6.6 - 2026-10-21

- Prevent repeated automatic recovery while renewal or Cookie installation is already pending, and serialize background restore work for the same credential until the previous worker exits.
- Keep cancellation and the overall connection deadline effective for queued work and late results, without clearing existing pairing data.
- Publish independently as App 0.6.6 (build 82). The pairing protocol and package identity remain unchanged; these native fixes require an App update and are not installed by updating the npm plugin.

## 0.6.14 - 2026-10-21

- Defer touch-triggered history loading until the gesture settles, cancel pending loading when the reader leaves the top zone, and scope movement/settle events to the conversation scrollport. Withdraw an older refused loading intent when a new gesture begins. Retain @chintoleung's three original commits from [#239](https://github.com/saya-ch/dsh-mobile/pull/239) alongside maintainer regression fixes.
- Keep Mobile Access usable beside other sidebar-footer actions: use a compact icon button when the row is shared, retain its accessible name, and restore the full label when it is alone. Thanks @gugubb5 for [#237](https://github.com/saya-ch/dsh-mobile/issues/237).
- Support explicit IPv6 loopback and ULA listeners and same-family private proxy-source CIDRs for an existing HTTPS reverse proxy. Display bracketed IPv6 backend URLs and clarify the difference between the phone-to-proxy and proxy-to-backend connections. Public frontend IPv6 does not require an IPv6 backend; exposing the plain HTTP backend publicly remains unsupported. Thanks @faruzanCN for [#238](https://github.com/saya-ch/dsh-mobile/issues/238).
- Add separate bug-report and feature-request forms with environment, reproduction, expected/actual behavior and third-party plugin comparison prompts.
- Link the independent experimental [dsh-mobile-iroh](https://github.com/saya-ch/dsh-mobile-iroh) project and summarize its local implementation progress without enabling a new provider in the stable plugin or App.
- Android App remains independently published as 0.6.5 (build 81); no native changes or new APK are included.

## 0.6.13 - 2026-10-19

- Distinguish inbound HTTP receive timeouts (408 `request_timeout`) and oversized request headers (431 `headers_too_large`) from other malformed HTTP requests (400 `bad_request`). Preserve the existing receive limits, authentication checks and single-attempt POST forwarding; do not automatically retry messages.
- Add sampled HTTP rejection diagnostics that distinguish parser errors, invalid targets and authenticated upstream prompt rejections without recording request contents, raw packets, Cookies or arbitrary URLs. Connect diagnostic sinks for all Gateway factories, including own-origin and self-signed FRP entries.
- Add packed real-page prompt-failure checks for restored text/images and visible errors on DSH 0.2.0-rc.2 and 0.2.1-rc.2. Separately reproduce a DSH lifecycle defect: leaving a Session during a pending send cancels that request and discards its recovery state, including in pure stock profiles without Mobile installed. The optional navigation diagnostic records that upstream Session-lifecycle failure but is not a passing regression lane. DSH source remains unchanged; this upstream defect and the exact cause of the reported #234 rejection are not claimed fixed. Thanks @Void-LifeStream for [#234](https://github.com/saya-ch/dsh-mobile/issues/234).
- Keep DSH source and installed frontend artifacts read-only. The proposed iroh P2P channel in [#235](https://github.com/saya-ch/dsh-mobile/issues/235) is intentionally outside this repository and this release; it requires a separate host-side proof of concept.

## 0.6.12 - 2026-10-18

- Send explicit non-navigation Fetch Metadata during the Gateway's internal DSH cookie exchange. This avoids the HTML navigation bounce produced by community authentication plugins without accepting arbitrary HTTP 200 pages, following redirects, or forwarding the upstream Cookie to the phone. Thanks @jamorzzz for [#230](https://github.com/saya-ch/dsh-mobile/issues/230).
- Separate invalid pairing/renewal/probe attempts from valid credentials behind a shared proxy. Invalid requests retain direct-peer limits; valid pairing secrets receive bounded admission, while renewal and probe budgets belong to the authenticated device. Keep operations accounted for until they settle even when the caller disconnects, and recheck credentials inside serialized writes. Forwarded IP headers remain untrusted. Thanks @Akiyuki1130 for [#231](https://github.com/saya-ch/dsh-mobile/issues/231).
- Extend the pre-boot compatibility script with identified missing array, string, object and structured-clone APIs. Add Chinese, English and Italian startup-failure feedback with explicit reload/wait actions when DSH has not rendered; mounted DSH and its own loader are not replaced, and no automatic reload is added.
- Identify unsupported class static-block syntax in DSH 0.2.1-rc.2's published frontend: Chromium 92 cannot parse that bundle. API shims and the existing old-engine advisory do not establish support for that engine. The feedback script itself targets Chromium 92; it does not transpile DSH. Thanks @yunyunlyk for the detailed engine and entry-mode comparison in [#232](https://github.com/saya-ch/dsh-mobile/issues/232).
- Add DSH 0.2.1-rc.2 to the packed-browser CI matrix and distinguish plugin-update SSE from conversation transport in troubleshooting. Android App 0.6.5 (build 81) remains independently published; no native change or new APK is part of this release.

## 0.6.11 - 2026-10-17

- Stabilize earlier-history loading by requiring fresh touch or wheel input before an automatic load near the top. DSH's own scroll-position compensation cannot re-arm loading; switching sessions or scroll containers withdraws the previous input. Track only touch contacts started on the owned scroller so another finger elsewhere cannot keep an old loading intent active.
- Keep the original localized Load earlier button visible and keyboard-accessible as a manual fallback, without the previous enabled/disabled collapse and expansion. Preserve usable button geometry and larger text. Thanks @chintoleung for [#228](https://github.com/saya-ch/dsh-mobile/issues/228) and [#229](https://github.com/saya-ch/dsh-mobile/pull/229); the author's five original commits are retained.
- Add bounded HTTP authentication and CSRF rejection diagnostics to the plugin log: rejection type/status, request method, a safe route or route category, credential presence/counts, normalized Origin and recognized fetch-site metadata. Credential values, query strings and arbitrary request paths are not logged.
- Rate-limit each Gateway's authorization and CSRF diagnostic categories separately, recording the first rejection immediately and aggregating suppressed repeats within a 30-second window. Keep the diagnostic callback from changing the HTTP rejection response if logging fails. This improves evidence collection; it does not repair an underlying 401/403 or cover every WebSocket/native-pairing failure.
- Retain @ayiejosh's original [#226](https://github.com/saya-ch/dsh-mobile/pull/226) contribution alongside maintainer privacy, rate-limit, cookie-counting and failure-containment corrections. Existing authorization, CSRF enforcement and remote-provider behavior remain unchanged; this plugin change does not require a new Android APK.
- Reorganize bilingual guides around installation, device settings and troubleshooting; clarify module selection, remote-channel prerequisites and the scope of compatibility checks. Link the independently released Android App 0.6.5 (build 81).

## Android 0.6.5 - 2026-10-17

- Keep an immediate Cancel connection action available during LAN/remote startup, saved-computer connection and pairing. Stop reconnecting keeps a usable DSH page; a blank or failed document returns to the device list. Preserve existing local pairings and prevent cancelled attempts or their queued retries from navigating later.
- End transient connection failures visibly instead of leaving a saved-computer row indefinitely at Connecting. Apply an overall 30-second LAN or 60-second remote budget through initial page loading; retries do not reset it. A cached unreachable status still permits a manual retry, and failure does not silently select a different computer.
- Retain the whale-girl connection background with a centered loading indicator and a cancellation button instead of a separate modal dialog. Reveal the trusted DSH page at its first visible commit while components continue loading; retain only a small cancellation button until usable controls appear. Keep the overall deadline during boot, discard stale readiness results and stop the completed document's loading timer instead of later reconnecting an already usable page.
- Request native HTTP cancellation and keep physical work accounted for until it exits. Computer-side pairing already accepted is not rolled back; a consumed one-time code must be replaced explicitly. Add Chinese, English and Italian cancellation and timeout copy. Thanks @Void-LifeStream for [#225](https://github.com/saya-ch/dsh-mobile/issues/225).
- Release build 81 with the existing package identity, permission list, pairing protocol and established signing certificate. Official installations can upgrade in place while retaining pairing data.

## 0.6.10 - 2026-10-16

- Preserve the first Funnel failure and its validated official authorization URL instead of replacing them with a later process-exit error. Discard queued events from the failed connection while allowing an explicit reconnect to start a new one. Failed resource cleanup remains visible and can be retried without discarding owned resources.
- Keep unmapped remote-controller error codes visible in localized diagnostics instead of rendering an empty error description. Thanks @Anyways366 for the detailed report and reproduction in [#223](https://github.com/saya-ch/dsh-mobile/issues/223).
- Clarify that custom file drops need iterable file items as well as files, and that successful event dispatch is not confirmation that DSH added the attachment. Thanks @Void-LifeStream for the extension findings and follow-up verification in [#205](https://github.com/saya-ch/dsh-mobile/issues/205).
- Android App remains independently published as 0.6.4 (build 80); these plugin changes do not require another APK.

## 0.6.9 - 2026-10-15

- Enable optional managed Caddy installation on Windows/Linux x64 with independently verified official component URLs, lengths and SHA-256 pins. Tencent Cloud DNSPod credentials, a domain and reachable public ingress are required; existing Cloudflared tunnels and external proxies remain available. Thanks @abworks-dev for the original managed-Caddy contributions in [#176](https://github.com/saya-ch/dsh-mobile/pull/176), [#184](https://github.com/saya-ch/dsh-mobile/pull/184), [#185](https://github.com/saya-ch/dsh-mobile/pull/185) and [#190](https://github.com/saya-ch/dsh-mobile/pull/190).
- Refresh managed Caddy component inputs to Caddy 2.11.7, Go 1.26.9 and an explicit golang.org/x/net 0.60.0 pin, retaining exact source, checksum and embedded dependency checks.
- Use explicit single-maintainer manual component publication instead of mandatory second-person approval. Preserve exact tag/source binding, same-run Windows/Linux native gates, draft/public asset verification and occupied-release protection; component publication does not publish npm or Android automatically.
- Cancel and drain accepted Caddy component work during plugin unload, retain recoverable files on failure, and wait for the owned Caddy process's actual close event before releasing it. Failed cleanup remains visible and retryable.
- Cover native CaddyController startup/shutdown and HTTP/1.1/HTTP/2 POST responses that remain quiet for more than 60 seconds, including exact response bytes and one upstream request per operation. These isolated checks do not establish public DNS-01 issuance or certificate renewal for the fixed component.
- Document scoped custom CSS selectors and same-page comparisons before applying older overrides. Current header behavior is retained rather than hiding working actions. Thanks @Void-LifeStream for [#219](https://github.com/saya-ch/dsh-mobile/issues/219).
- Android App remains the independently published 0.6.4 (build 80); these changes do not require another APK.

## 0.6.8 - 2026-10-15

- Fix remote pairing on computers with the same default state path overwriting one another in the Android device list. Automatically identified entries without a pairing CA use their persisted random installation identifier for new pairings; explicit operator IDs, LAN CA fingerprints and self-signed FRP CA fingerprints remain unchanged.
- Read both device-state versions and write version 2 on the next mutation, preserving each new credential's pairing identity. Existing credentials keep their previous native renewal/probe identity during ordinary upgrades with the same state path and gateway configuration, with no wire-protocol change or required Android App update. See [upgrade and downgrade precautions](SECURITY.md#installation-identity-and-device-state-upgrades).
- Publish the complete installation identifier atomically without replacing an existing one, avoiding a concurrent starter reading an empty file. Refuse invalid identity files and unsupported initial publication rather than silently changing the identity.
- Keep working pairings without re-pairing. A local App credential already overwritten by the collision cannot be recovered automatically: update and restart the plugin, then pair each affected computer again. Usable old rows remain valid; any duplicate local row can be removed explicitly without computer-side revocation.
- Adapt compatibility checks to DSH 0.2.1-alpha.3's authenticated Host-backed settings while retaining the Remote/Connection dependency checks and earlier settings policies. Mobile typography remains local to its Origin. Extend the browser test matrix to alpha.3 and recognize its first-run account dialog without submitting credentials.
- Add bilingual remote-channel selection notes distinguishing the maintainer's long-term network experience from provider limits and conditional self-hosted deployment characteristics.
- At this plugin release, Android App 0.6.3 was still the published native version; Android 0.6.4 was published independently later on the same day. Its file-picker changes are not part of this plugin fix. Thanks @Yurzi for reporting [#213](https://github.com/saya-ch/dsh-mobile/issues/213).

## Android 0.6.4 - 2026-10-15

- Prefer the system Photo Picker on Android 13+ for supported image requests, with document selection for other requests or an unavailable picker. Preserve multi-selection, MIME filtering and selected URI results without adding storage permission or forcing a vendor gallery.
- Bind standard file callbacks to the active WebView, Origin and document. Cancel them on navigation or teardown and prevent old results from consuming a newer request. This native update is released independently from plugin 0.6.8 and preserves existing paired records.
- On WebViews with navigation-listener support, settle file requests before replacing their document and pause new selection until all in-flight document navigations finish, including cancelled and non-committing navigations. This prevents a late cancellation from disabling the new page's file input. Older providers retain their available callbacks; update WebView or reopen the paired computer if selection still fails after changing pages.
- Retain the package identity, established release signer, permission list and native pairing protocol. Thanks @Void-LifeStream for the attachment report in [#205](https://github.com/saya-ch/dsh-mobile/issues/205), and @xhwxt for the document-picker proposal in [#203](https://github.com/saya-ch/dsh-mobile/pull/203).

## 0.6.7 - 2026-10-14

- Add optional `cpolarSubdomain` and `cpolarRegion` profile settings for a reserved cpolar address. Omitted or blank values keep provider defaults; only the validated HTTPS origin reported by cpolar is used. Existing pairing and authorization checks are unchanged. [Configuration guide](docs/CPOLAR_SUBDOMAIN.en.md).
- Include complete profile override examples and regressions for configuration-to-process arguments, invalid settings and provider startup failures. This feature does not require an Android App update.
- Improve narrow-screen sidebar interaction and scrolling with larger panel/footer content. Keep the Workspace list usable and footer actions reachable without enabling the shell overlay as a full-page click target.
- Load mobile customizations only on their authenticated Gateway entry, including the stock diagnostic page. Add deduplicated Chinese, English and Italian failure/recovery messages, pause unauthorized extension streams, and retain loaded styles and page state through temporary failures without weakening authentication.
- Ignore a cancelled manifest request before it can clear newer extensions. Preserve the existing custom-file and extension size limits, and keep preview Back handling separate from Gateway API loading.
- Clarify `/mobile` and both READMEs: detected files are not proof of page activation; ordinary DSH login or phone-sized preview does not establish mobile pairing. Thanks @Dantezcx for the detailed reports in [#209](https://github.com/saya-ch/dsh-mobile/issues/209) and [#210](https://github.com/saya-ch/dsh-mobile/issues/210).
- Thanks @GavinQiEr for the request in [#207](https://github.com/saya-ch/dsh-mobile/issues/207) and implementation in [#208](https://github.com/saya-ch/dsh-mobile/pull/208); the original author commit is retained alongside maintainer corrections.

## 0.6.6 - 2026-10-14

- Fix captured images not reaching DSH's attachment draft. Supply both files and iterable file items, with compatible drag-and-drop objects for browsers whose constructed objects are incomplete.
- Improve browser camera and extension file selection: returning to the page no longer discards a pending selection after one second. Handle explicit cancellation, late results, aborted requests and timeouts while preserving the current draft.
- Add packed DSH regressions for multiple images, decoded previews, cancellation and superseded requests. The Android App remains independently published as 0.6.3; this plugin update does not replace its system file chooser.
- Thanks @Void-LifeStream for the detailed report in [#205](https://github.com/saya-ch/dsh-mobile/issues/205), and @xhwxt for the document-picker proposal in [#203](https://github.com/saya-ch/dsh-mobile/pull/203).

## 0.6.5 - 2026-10-13

- Make mobile module selection easier to navigate: optional extensions first, collapsed DSH and boot-required groups, name/ID search, loading filters, and exact IDs and dependencies in details. Keep close and save actions outside the scrolling list, show unsaved changes, and confirm before discarding them.
- Retry failed module reads in place and retain choices after a failed save without replaying writes automatically. Outdated exclusions can be explicitly removed while preserving other choices and required-module protection. [Module guide](docs/CLIENT_MODULES.en.md).
- Show advanced mobile typography controls only when the active DSH theme consumes their public font variables. Retain unsupported saved values without a version allowlist, computer-wide settings writes or page reloads; body font-size controls remain available on older DSH versions.
- Improve mobile settings close targets in portrait and landscape. Prevent stale or duplicate notification-settings/computer-switch bridge calls and retain explicit failure retry without changing native navigation or timeout behavior.
- Read the pinned Windows cpolar ZIP with .NET and its embedded CAB through Unicode Windows APIs, extracting only the executable from a read-only MSI database instead of running `msiexec /a`. Retain ZIP/executable size and SHA-256 checks, rollback and staging cleanup; no installer action, elevation, service, registry or PATH change is requested. Thanks @WalkerJay666 for [#201](https://github.com/saya-ch/dsh-mobile/issues/201).
- Distinguish cpolar extraction-tool, ZIP, MSI-read, CAB and output-file failures in Chinese, English and Italian, with redacted diagnostic details. Add native Windows extraction and cleanup checks, including paths with spaces and non-ASCII characters.
- Protect the plugin-owned mobile root layout from broad skin overrides, fixing a populated Trajectory view collapsing to zero height. Missing skin backgrounds, decorations and text contrast still require skin adaptation; optional skins can be excluded on a phone without uninstalling them on the computer. Thanks @fishdivinity for [#202](https://github.com/saya-ch/dsh-mobile/issues/202). [Skin guide](docs/SKIN_COMPATIBILITY.en.md).
- Update settings, module and skin guides and correct stale App release descriptions. Android App 0.6.3 (build 79) remains the current native release; this plugin-only update does not require a new APK.

## 0.6.4 - 2026-10-12

- Release 0.6.4 improves the mobile composer, Windows Desktop startup composition and connection/data reliability. The Android App remains independently versioned; Android 0.6.3 (build 79) is published separately at `android-v0.6.3`.
- Integrate the focused composer overflow fix from [PR #200](https://github.com/saya-ch/dsh-mobile/pull/200): public-slot wrappers around compact non-switch buttons reserve the mobile 44px touch target without resizing switches, dialogs, menus, nested controls or wide layouts. The packed real-slot smoke covers the new geometry and activation cases; optional third-party services remain outside this presentation check. Thanks @abworks-dev.
- Detect the Windows Desktop profile service as well as its later runtime marker before enabling the in-page directory picker, avoiding competing picker providers during early Windows Desktop boot while retaining the portable picker on macOS/Linux. This covers an early-boot composition risk relevant to [#199](https://github.com/saya-ch/dsh-mobile/issues/199); the reported community Desktop 2.0.17 failure and remote timeout still require acceptance in that environment.
- Preserve custom Caddy sites during VPS deployment and cleanup. Recognize the complete stock file rather than matching a few default-site lines or a legacy comment; other configurations require an explicit manual merge.
- Persist remote enable/disable settings before changing the running provider, so a failed save retains the confirmed state and can be retried. Repair missing or mismatched FRP leaf keys under the pinned CA, stage certificate/key replacements with rollback, and use the shared pinned downloader for FRP response cleanup.
- Stop an owned Funnel process and gateway even when its private state directory becomes invalid, keep the failure retryable, and apply the same durable-before-stop rule to Managed Origin reconnects and disables. Reuse quoted extension-script ETags separately from local content digests and retain them across 304 responses.
- Honor configured Worker activation budgets through public loading and recovery while retaining cancellation. Match root prefix extension routes correctly without widening other path prefixes.
- Distinguish task notifications using complete session/question IDs and per-turn tags, including long and non-ASCII identifiers. Reuse the existing maintained SHA-256 dependency in the browser bundle; update the development source-map parser to its patched release.
- Android App 0.6.3 (build 79), published separately: keep authentic expired-CA records readable for per-device repair while TLS still rejects expiry, share a pairing owner across button/IME/scanned submissions, deduplicate slow device probes without consuming all connection capacity, improve dark primary-button contrast, update English/Chinese/Italian TLS recovery guidance, and exclude encrypted data from cloud backup and device transfer.
- Require administrator approval bypass to be disabled before official Caddy component distribution. Reconcile an occupied npm version with the candidate tarball integrity before continuing publication, and require final cleanup receipts for legacy negative browser checks.
- Explain browser pairing-code input next to the field in Chinese, English and Italian. Recognize Android App keys locally without submitting them as codes, retain entered values, prevent duplicate one-time submissions, and distinguish invalid/expired codes, rate limits, device limits and connection failures. Thanks @sznyhgm for [#96](https://github.com/saya-ch/dsh-mobile/issues/96).
- Correct authenticated resource ETag syntax, GET/HEAD weak/list/wildcard matching and 304 metadata. Preserve usable upstream validators across streaming gzip and keep encoding variants distinct. Upstream resources without validators and actual WebView cache reuse remain separate checks; this does not establish a complete fix for [#107](https://github.com/saya-ch/dsh-mobile/issues/107).
- Report Windows private-file permission failures by SID-query or ACL-apply stage and full wait duration, without logging raw command output, SID arguments or private paths. Hand freshly prepared inactive-provider state to initialization rather than reading and applying its ACL twice. Secure control-state temporary files before replacement and await every startup preparation write before reporting failure. Keep permission-before-use, existing timeout and retry behavior; the reported long startup contention in [#128](https://github.com/saya-ch/dsh-mobile/issues/128) remains under investigation.
- Add isolated real-DSH transport recovery and cross-client question regression checks, distinguishing healthy HTTP from a ready WebSocket and retaining the existing document and draft. These checks do not establish acceptance of a reporter's public tunnel or original device.
- Capture redacted module, batch and script-response evidence for browser startup failures, including HTTP-successful scripts that fail during execution or registration. Copy package files in isolated test profiles so another pnpm import cannot change their shared file metadata and trigger a DSH resource revision. Negative checks require the intended fault and completed cleanup; failed evidence capture or persistence cannot count as passing.
- Release discarded component-download response bodies before returning a rejection or following a validated redirect, and release reader locks after completion or failure. Keep the original validation error when cleanup fails instead of treating it as a retryable transport fault. Pinned sources, size/hash checks and redirect restrictions are unchanged; this does not establish the original cause of [#114](https://github.com/saya-ch/dsh-mobile/issues/114).
- Close extension response streams when invalid HTTP metadata or a response-header write fails before pipeline ownership. Preserve normal streaming, HEAD and client-disconnection cleanup.
- Android App 0.6.3 cancels previous automatic-recovery ownership when opening LAN, remote or pairing configuration. Late renewal/cookie callbacks and queued retries cannot replace the user's form or take over a newer retry. This native correction ships in the separate App release, not through a plugin update. Thanks @sznyhgm for [#96](https://github.com/saya-ch/dsh-mobile/issues/96).
- Plugin and native App releases remain independent. The signed Android 0.6.3 release is available separately and is not required for plugin-only updates.

## 0.6.3 - 2026-10-10

- Add opt-in, per-local-extension Worker execution with bounded threads/V8/IPC, cooperative cancellation followed by termination, fair streaming credit and explicit recovery without replay. The default remains in-process; Workers expose a logger-only context and are not a security sandbox. Retain @chintoleung's three original prototype commits from [#189](https://github.com/saya-ch/dsh-mobile/issues/189), with integration and lifecycle corrections. [Guide](docs/EXTENSION_WORKERS.en.md).
- Integrate @abworks-dev's [PR #192](https://github.com/saya-ch/dsh-mobile/pull/192) with plugin-only compact/overflow corrections. Keep native InputBar ownership, model width observation, original handlers, menus and live activity nodes; Send/Stop remain reachable. This is not the proposed shared upper scrollport, which still requires an upstream parent-toolbar seam. [Layout scope](docs/MOBILE_COMPOSER_TOOLBAR.en.md).
- Protect Android paired-record writes and legacy migration from unreadable encrypted data; retain old ciphertext rather than treating it as an empty list. Prevent cancelled SDK calls from starting queued Native operations after disposal.
- Correct audit regressions: preserve third-party HTML/iframe routes, reject unknown raw TLS modes, guard managed parent links and cleanup ownership, retain rollback backups, contain file-log failures and stop unverified authenticated SSH fallback before fingerprint confirmation. Await owned process/cleanup completion and align the guides with actual logging, permissions and independent versioning.
- Fix fresh installation and upgrades through DSH's plugin manager, including hoisted pnpm profiles. The question-card component remains inside the plugin package and independently switchable, without a separate package installation or user workaround. Thanks @MLYR for [#193](https://github.com/saya-ch/dsh-mobile/issues/193).
- Follow DSH 0.2.1-alpha.2 typography: mobile General settings retain device-local body size and add collapsed body/code font controls and a reset action. Preferences do not change the computer or other devices; existing mobile font settings are retained. Terminal fonts remain owned by DSH.
- Add Android App 0.6.2 (build 78), separately from plugin 0.6.3. Keep web content inside the native system-bar, cutout and keyboard area; add native-only page zoom in General settings, with 80–125% scaling and a 100% reset, without reloading the conversation. Older App versions and browsers do not show this control.
- Add a nonblocking update reminder for WebViews reporting Chromium below 100. Users may continue; unknown engine versions are not treated as obsolete, and each detected build is warned about once. This does not promise full compatibility with unsupported old engines.
- Improve bounded Windows retries and rollback for managed Caddy preparation while keeping official managed installation disabled. Thanks @abworks-dev for [PR #190](https://github.com/saya-ch/dsh-mobile/pull/190).
- Hide the duplicate passive pin marker on narrow mobile session lists while retaining pin actions and desktop presentation. Thanks @abworks-dev for [PR #191](https://github.com/saya-ch/dsh-mobile/pull/191).
- Add a repository-local Agent maintenance skill and discovery entrypoint covering compatibility, packaging, runtime/ADB, collaboration and independent releases, with guidance for updating demonstrated reusable lessons.

## 0.6.2 - 2026-10-08

- Supply missing `AbortSignal.throwIfAborted()` and cancellation reasons before DSH starts on older WebViews. Preserve native implementations, cancellation and the first supplied reason, fixing the reported model/provider and other client API failures caused by the missing method. Thanks @luoyangshovel for [#187](https://github.com/saya-ch/dsh-mobile/issues/187).
- Keep the mobile shell within the viewport when the browser does not support `dvh`, so DSH's existing conversation area retains a scroll range. Portrait/landscape touch checks cover this missing-feature case; the Android 13 devices in #187 still need confirmation from their actual WebViews.
- Release the npm plugin and Android App independently. Plugin updates retain the existing signed APK when native code is unchanged; App downloads use the published App descriptor, and plugin update notes follow the npm version. Android remains 0.6.1 (build 77) for this plugin update.
- Keep release history in this changelog, simplify both project READMEs and clarify which component needs updating.

## 0.6.1 - 2026-10-08

- Reorganize the remote HTTPS origin, external proxy and managed Caddy forms with native radio groups, responsive fields, separate actions and matching Chinese, English and Italian labels. Thanks @abworks-dev for [#184](https://github.com/saya-ch/dsh-mobile/pull/184).
- Add pinned, reproducible Caddy review builds: Go 1.26.6, xcaddy 0.4.7, Caddy 2.11.6 and Tencent Cloud DNS 0.4.3, with locked source/dependency inputs, fresh private caches, two-build byte comparison and complete artifact checks. Isolated native Windows/Linux tests cover installation, restart, rollback, TLS, pairing, API, WebSocket and cleanup. Thanks @abworks-dev for [#185](https://github.com/saya-ch/dsh-mobile/pull/185); original author commits are retained alongside maintainer fixes.
- Find Windows Git Bash from the active Git installation rather than a fixed path. Keep missing-shell, timeout and signal failures distinct from expected nonzero command exits, and prevent shell startup environment variables from changing test behavior.
- Keep official managed Caddy installation disabled. Review builds and optional TEST prereleases do not enable the production component table or establish public DNS-01/ACME issuance and public-route readiness. Existing external proxies and remote providers are unchanged. See [Caddy status](docs/CADDY_MANAGED.en.md).
- Synchronize Android release metadata to 0.6.1 (build 77). Native features and the pairing/renewal protocol are unchanged from 0.6.0; the official APK uses the established package and signer, preserving pairings on same-signer upgrades.

## 0.6.0 - 2026-10-07

Add mobile page module management, Android launcher choices, fixed device ordering and improved scanning, alongside connection, layout and WebView compatibility fixes. Update the plugin and Android app together. Original community commits are preserved alongside maintainer fixes; see [Contributors](CONTRIBUTORS.md).

### Connection reliability and compatibility

- Retry bodyless plugin/static GETs after transient upstream disconnects, only before response headers reach the client. API/write requests and actual HTTP error responses are not replayed; errors are not cached as immutable assets. Thanks @abworks-dev for the overlapping [#173](https://github.com/saya-ch/dsh-mobile/pull/173) and [#177](https://github.com/saya-ch/dsh-mobile/pull/177).
- Separate long-running authenticated API response waits from ordinary connection/upload/static timeouts. `upstreamApiTimeoutMs` defaults to `0` (no response-wait deadline), allowing operations such as `/compact` to finish without the former transport cutoff. Timeout/failure semantics are in the [slow-link guide](docs/SLOW_CONNECTIONS.en.md). Thanks @xhwxt for [#171](https://github.com/saya-ch/dsh-mobile/issues/171).
- Supply missing `Promise.withResolvers` and `AbortSignal.any` before dedicated mobile boot; the app also injects the Promise fallback at document start where supported, only for the paired Origin. This is not a guarantee for every older engine; Huawei WebView 114 has not been physically accepted. Thanks @fqf060420 for [#170](https://github.com/saya-ch/dsh-mobile/pull/170), @helan-1997 for [#168](https://github.com/saya-ch/dsh-mobile/issues/168) and @sanmaoAI1432 for [#169](https://github.com/saya-ch/dsh-mobile/issues/169).
- Check the actual public HTTPS host/port in FRP diagnostics. A successful TCP probe remains advisory, not device-identity proof. Thanks @sanmaoAI1432 for [#169](https://github.com/saya-ch/dsh-mobile/issues/169).

### Mobile layout and input

- Keep ordinary narrow composer controls compact, wrap only when needed and limit the scrollable draft in short viewports. Preserve references, images, standard plugin actions and primary touch targets.
- Add address-local **Mobile font size** (12–32px, default 16px), independent of the computer's font size. Editable inputs retain 16px minimum, and the color theme follows DSH. Thanks @rushpixy for [#165](https://github.com/saya-ch/dsh-mobile/issues/165).
- Use plain Enter for newlines in a nonempty main composer on touch-primary browsers; empty Enter does nothing. Retain IME composition, menus and modified shortcuts. Non-touch desktops are unchanged; external keyboards on touch-primary browsers follow the same newline rule. Thanks @chintoleung for [#161](https://github.com/saya-ch/dsh-mobile/pull/161).
- Close the narrow drawer after selecting a main panel and provide a reserved **Back to conversation** row without hiding actions or focusing the editor. Keep wide docked layouts unchanged, and avoid stale drawer state through navigation/rotation. Thanks @chintoleung for [#162](https://github.com/saya-ch/dsh-mobile/pull/162).

### Android app

- Add the mascot and six whale-mark launcher choices. Keep package/signing identity, explicit shortcuts, notification entry points and paired data; a failed switch retains an available launcher. Thanks @abworks-dev for [#175](https://github.com/saya-ch/dsh-mobile/pull/175).
- Fill the scanner preview without stretching, use supported continuous focus, and add pinch/double-tap zoom plus accessible 48dp zoom buttons. Ratios follow camera capabilities; closing releases the camera. Thanks @abworks-dev for [#179](https://github.com/saya-ch/dsh-mobile/pull/179).
- Keep a fixed paired-computer order, append new records and migrate the previously visible order. Add **Move up / Move to top** where useful; startup still chooses the last-used eligible computer, not the first row. Thanks @xhwxt for [#181](https://github.com/saya-ch/dsh-mobile/pull/181).
- Hold the dedicated page's top-left drawer toggle to return to the app's paired-computer list. Ordinary tap and **Settings → General → Switch computer** remain available; movement/cancellation/disposal cannot leave a delayed hold active. Browsers and apps without this native capability keep their existing action. Thanks @xhwxt for [#180](https://github.com/saya-ch/dsh-mobile/pull/180).

### Advanced settings and extensions

- Add **Mobile page modules** with computer defaults and authenticated device overrides, required/dependency checks and private atomic storage. Apply on the next manual open, never by automatically reloading a conversation or uninstalling plugins. If installed modules change, an explicit device-only recovery action loads all modules. Thanks @abworks-dev for [#174](https://github.com/saya-ch/dsh-mobile/issues/174). [Guide](docs/CLIENT_MODULES.en.md).
- Add explicit source CIDRs to managed LAN setup while retaining the current LAN subnet, certificate and identity. Restart is required; routes/VPN and Windows firewall are not changed automatically. Thanks @Quadrapole for [#178](https://github.com/saya-ch/dsh-mobile/issues/178). [Guide](docs/TRUSTED_NETWORKS.en.md).
- Give extension actions/routes a default 30-second asynchronous deadline, including input validation, with per-operation `timeoutMs` (1–300000ms). Release request slots when callers leave, abort timed-out invocations and discard late route streams. Detached unresolved work rejects further dispatch with `extension_busy` until settled; synchronous blocking code cannot be terminated by this deadline. Thanks @chintoleung for [#167](https://github.com/saya-ch/dsh-mobile/pull/167). [Timeout details](docs/SLOW_CONNECTIONS.en.md).

### Component availability and documentation

- Integrate managed Caddy as an upstream mode of Own reverse proxy, with separate private process/Gateway ownership. External mode remains the default and retains its settings and paired devices. **Managed installation is still disabled**: trusted pinned binaries have not been distributed, despite a fixed build and isolated TLS/authentication/API/WebSocket validation. Thanks @abworks-dev for [#176](https://github.com/saya-ch/dsh-mobile/pull/176). [Status](docs/CADDY_MANAGED.en.md).
- Reorganize setup, connection and developer guides; clarify component availability, cleanup scope and Cloudflare Quick Tunnel notification limits. Add local documentation checks and release guards for stale Android manuals.

## 0.5.5 - 2026-10-04

- Extend the mobile editable font floor to body-level model-search portals and the pairing page, while keeping desktop text and composer-dock spacing unchanged. Thanks @chintoleung for [PR #158](https://github.com/saya-ch/dsh-mobile/pull/158).
- Let Android Back return from the model list to its root menu, then close that menu through DSH's existing Escape handling, without selecting a model or submitting the draft.
- Keep the live Android WebView through rotation, window resizing and keyboard-availability changes, preserving the page, reference chips and unsent images. Locale, font-scale and system-theme changes retain Android's normal Activity recreation.
- Preserve a known **Removed on computer** status through automatic or manual reachability checks. Discard late results from an older credential so they cannot overwrite a revoked or re-paired device.
- Support on-demand cloudflared installation on macOS x64 and arm64. Verify the official compressed artifact and extracted executable separately, retain the pinned Windows/Linux files, and add isolated installation, reinitialization, and cleanup checks. Thanks @cjxh21 for [PR #155](https://github.com/saya-ch/dsh-mobile/pull/155).
- Keep an unfocused narrow-screen composer as a scrollable 72px draft preview and enlarge existing touch controls without changing DSH's draft or submission handlers. Expand browser coverage for focus, portaled menus, references, attachments, and keyboard states. Thanks @abworks-dev for [PR #152](https://github.com/saya-ch/dsh-mobile/pull/152).
- Add a real packed-profile screenshot tool for pairing, conversation, drawer, and settings surfaces. Mask pairing credentials and share isolated startup, readiness, and cleanup with browser checks. Thanks @cjxh21 for [PR #154](https://github.com/saya-ch/dsh-mobile/pull/154).
- Release Android 0.5.5 (build 75) with the same established signing certificate and compatible pairing protocol. Update the plugin and app together to receive all fixes; official same-signer upgrades retain paired devices.

## 0.5.4 - 2026-10-02

- Allow authenticated `PUT`, `PATCH`, and `DELETE` requests to ordinary DSH plugin routes, fixing mobile settings saves that returned `method_not_allowed`. Preserve same-origin, Session, CSRF, body-size, and request limits; document that paired devices operate through the gateway with local DSH privileges. Thanks @Ann-luo for [#150](https://github.com/saya-ch/dsh-mobile/issues/150).
- Resolve pairing and renewal conflicts from same-name Cookies on a shared hostname. Handle authentication Cookies individually, use protected Host-session/CSRF Cookies and a non-secret device binding, and keep the persistent device credential restricted to its renewal path. Android 0.5.4 (build 74) writes matching session/CSRF aliases so stale WebView Cookies can be replaced; the native pairing and renewal protocol remains compatible. Thanks @snailium for [#144](https://github.com/saya-ch/dsh-mobile/issues/144).
- Set a 16px minimum for mobile editables, including empty `contenteditable` attributes, while retaining larger inherited text and DSH font preferences on narrow and wide layouts. Thanks @chintoleung for [PR #147](https://github.com/saya-ch/dsh-mobile/pull/147).
- Dismiss the software keyboard after a trusted touch Send, Queue, or Steer consumes the active draft, including references, attachments, and asynchronous commands. Preserve keyboard, menu, Stop, and IME composition handling; cancel pending checks when input, focus, Session, or layout changes. Thanks @chintoleung for [PR #148](https://github.com/saya-ch/dsh-mobile/pull/148).
- Add optional WebSocket compression on exact, already authorized paths. The default remains an uncompressed relay; enabled paths negotiate stateless compression with the browser while keeping the DSH side uncompressed and relaying real Ping/Pong frames. Bound message and queue sizes; see the [configuration guide](docs/SLOW_CONNECTIONS.en.md#optional-websocket-compression). Thanks @xhwxt for [#145](https://github.com/saya-ch/dsh-mobile/issues/145).
- Add a [slow-link and reconnection guide](docs/SLOW_CONNECTIONS.en.md) covering WebSocket failures, DSH heartbeat and initialization settings, and the tradeoffs of longer deadlines. Thanks @xhwxt for [#146](https://github.com/saya-ch/dsh-mobile/issues/146).
- Verify the question-card component from a real npm tarball installed in an isolated DSH profile, using DSH's own dependency resolver and boot discovery. Preserve the bundled component distribution and strengthen installation checks. Thanks @fengfanfan-max for [PR #143](https://github.com/saya-ch/dsh-mobile/pull/143).
- Remove the obsolete `session.history` HTTP request clamp and endpoint-specific gzip handling. DSH versions in the current compatibility matrix use `session.follow` and `session.page` over WebSocket; DSH controls their history window and page budgets. Correct the README's 10-message paging claim. Thanks @xhwxt for [#149](https://github.com/saya-ch/dsh-mobile/issues/149).

## 0.5.3 - 2026-10-01

- Add a default-enabled, separately switchable question-card component: long questions, options, and footer actions share one bounded scroll area, while collapsed titles show up to two lines. Keep touch Enter as a newline without intercepting desktop shortcuts or IME composition; Android applies it only with an active software keyboard and no hardware keyboard. Answers remain in DSH's existing draft store rather than browser localStorage. Thanks @ayiejosh for [PR #133](https://github.com/saya-ch/dsh-mobile/pull/133).
- Fix large blank gaps after folded process sections by using DSH's message-flow spacing, which skips its hidden search-expandable sections. Thanks @xhwxt for [PR #134](https://github.com/saya-ch/dsh-mobile/pull/134).
- Let composer-dock entries wrap when community plugins add statistics or actions. Keep static statistics readable, limit context-ring ordering to the dock's direct children, and prevent adjacent entries from overlapping.
- During DSH voice input, request an available screen wake lock while the page is visible and dismiss mobile text focus only in the active composer. Release locks when capture ends, the page is hidden, or the plugin unloads; keep keyboard handling available without the wake-lock API. Thanks @ayiejosh for [PR #136](https://github.com/saya-ch/dsh-mobile/pull/136).
- Include the question-card component's built runtime in npm packages and add packed-installation and browser layout checks, covering long cards, keyboard modes, component disablement, folded sections, and additional composer-dock entries.
- Expand settings-save troubleshooting for Host/Origin rejection, a missing root Include, and file or lock errors, based on [#132](https://github.com/saya-ch/dsh-mobile/issues/132). This is diagnostic guidance, not a fix for DSH's reported duplicate-module problem; connection diagnostics do not attempt a settings write.
- Synchronize Android version metadata to 0.5.3 (build 73). Native behavior and the pairing protocol are unchanged from 0.5.2; existing paired devices do not need to pair again.
- Update the build and test development tools to tsdown 0.23 and Vitest 5 after Windows, Linux, Android, and DSH browser-startup checks.

## 0.5.2 - 2026-09-29

- Give each DSH Mobile installation a stable FRP proxy name on a shared frps and report proxy-name or entry-port conflicts directly instead of waiting for a generic timeout (thanks @liudasheng for [PR #130](https://github.com/saya-ch/dsh-mobile/pull/130)). Keep that name through first-time setup and restarts, and use it in copied attach instructions.
- Keep the four DSH peer names for host-side module resolution, but remove their per-release version ranges so a newly published DSH prerelease is not rejected solely by plugin metadata. Source-contract and isolated browser-startup checks now include DSH `0.2.0-rc.2`.
- Synchronize Android App version metadata with the plugin; native behavior and the pairing protocol are unchanged from 0.5.1.

## 0.5.1 - 2026-09-29

- Restore the Android system Back key on devices that deliver the legacy Activity callback even on Android 13 and later. The DSH page still uses its WebView history when available and exits the app at the root.
- On the dedicated mobile page, route Android Back through visible extension pages, supported DSH dialogs and menus, the details panel, narrow-screen drawer, and selected main panel before WebView navigation or app exit. Unknown dialogs stay in place instead of exposing a lower layer.
- Keep Android soft-keyboard Enter as a draft newline when an active conversation temporarily lacks a mobile-layout session ID. Camera results still require a matching session and composer origin, and a late result is discarded after navigation (thanks @ayiejosh for [PR #124](https://github.com/saya-ch/dsh-mobile/pull/124)).
- Declare Android's normal `MODIFY_AUDIO_SETTINGS` permission for WebView communication audio setup (thanks @ayiejosh for [PR #125](https://github.com/saya-ch/dsh-mobile/pull/125)). Microphone capture still requires the user's `RECORD_AUDIO` approval; recognition also depends on the device WebView and speech service.
- Accept DSH `0.2.0-rc.1` in the plugin's peer ranges and browser-startup checks. The paired mobile page and Workspace baseline were verified against the released runtime while retaining the tested `0.1.7` series.
- Avoid creating disabled control files for remote providers that have never been enabled, removing unnecessary file-permission work on first configuration. Existing private files retain their previous ACL-before-use handling; this does not remove the `whoami.exe`/`icacls.exe` waits reported in [#128](https://github.com/saya-ch/dsh-mobile/issues/128).
- Guide `/mobile` to inspect the running DSH page and, when available, matching frontend source before changing built-in controls, and to disclose when the result could not be checked on a phone. Shorten its command-menu description and refine the bilingual setup and remote-access guides.

## 0.5.0 - 2026-09-26

- Recognize the official DSH Desktop `dsh-app://app` page as a Mobile administration surface, while requiring its signed DSH browser session for forwarded management requests (thanks @Sanksu for [PR #118](https://github.com/saya-ch/dsh-mobile/pull/118) and @up-and-down-0618 for [#115](https://github.com/saya-ch/dsh-mobile/issues/115)).
- Send paired-page file uploads through the authenticated Mobile transport so PDF and other binary attachments reach DSH without bypassing the gateway's CSRF checks (thanks @ayiejosh for [PR #116](https://github.com/saya-ch/dsh-mobile/pull/116)).
- Allow the paired page to request microphone access for DSH voice input. App 0.5.0 asks for Android microphone permission on first use and grants audio-only capture to the paired HTTPS Origin (thanks @ayiejosh for [PR #119](https://github.com/saya-ch/dsh-mobile/pull/119)).
- Let narrow phone headers reveal hidden controls by horizontal drag or keyboard focus while keeping menus accessible; remove the redundant header arrow (thanks @ayiejosh for [PR #117](https://github.com/saya-ch/dsh-mobile/pull/117)).
- Keep composer statistics readable beside the context ring on narrow screens instead of clipping the values (thanks @ayiejosh for [PR #120](https://github.com/saya-ch/dsh-mobile/pull/120)).
- On touch devices, switching sessions no longer opens the soft keyboard automatically; tapping the composer still opens it normally.
- Explain cpolar download, extraction and private-storage failures more clearly and preserve the previous component if replacement fails ([#114](https://github.com/saya-ch/dsh-mobile/issues/114)). Diagnostics also flag an active, competing third-party remote pairing channel without modifying its traffic ([#111](https://github.com/saya-ch/dsh-mobile/issues/111)).

## 0.4.7 - 2026-09-25

- Expose `panelInfo` on the mobile layout service for DSH `0.1.7-rc.2`, so built-in panels such as Plugin Manager can mount without breaking the dedicated mobile frontend (thanks @chintoleung for [PR #104](https://github.com/saya-ch/dsh-mobile/pull/104) and [#103](https://github.com/saya-ch/dsh-mobile/issues/103)).
- Derive mobile boot batches in a canonical entry order. The same module set now produces stable batch URLs, response bodies and ETags when upstream entry order changes, avoiding unnecessary new cache entries (thanks @xhwxt for [PR #105](https://github.com/saya-ch/dsh-mobile/pull/105)).
- Remove the original application-batch preload when the dedicated mobile page replaces that batch, preventing a duplicate multi-megabyte transfer. On WebView 151+, raise this app's HTTP cache quota to at least 64 MiB so large versioned scripts can be reused after a cold start; older WebViews retain their default policy (thanks @xhwxt for [#107](https://github.com/saya-ch/dsh-mobile/issues/107)).
- Extend source-contract and isolated browser-startup checks to DSH `0.1.7-rc.2`, alongside `0.1.7-alpha.2` and `0.1.7-rc.1`.
- Add opt-in `excludedClientModules` for mobile-only boot slimming. Exact package ids are checked against the live graph; boot-critical entries and modules still required by retained entries are refused. The default graph, desktop page, and stock frontend remain unchanged (thanks @xhwxt for [#108](https://github.com/saya-ch/dsh-mobile/issues/108)).
- Let the right sidebar fill the phone viewport instead of clipping file and plugin panels behind a narrow overlay edge; keep the wide-screen column layout and a reachable collapse control.
- Keep the on-screen keyboard closed when opening the composer Add menu, without affecting other listbox controls (thanks @ayiejosh for [PR #109](https://github.com/saya-ch/dsh-mobile/pull/109)).
- In the Android App, use plain Enter to add a draft line when the on-screen keyboard is visible and no hardware keyboard is attached; retain DSH's original Enter behavior for browsers, unknown keyboard state, menus and IME composition (thanks @ayiejosh for [PR #110](https://github.com/saya-ch/dsh-mobile/pull/110)).
- Clear the Android page-load timer when WebView reports the same root document with a normalized URL, preventing a completed load from becoming a delayed false timeout. After native session renewal, keep a live DSH WebView instead of rebuilding it; reload only when the document is unavailable, and bound repeated renderer-crash recovery.

## 0.4.6 - 2026-09-24

- Use the configured HTTP proxy as a second, bounded remote-health probe only when the direct probe fails. The diagnostic respects `NO_PROXY`, reports proxy-only reachability as a warning rather than proof that a phone can connect, and retains the direct result if both routes fail (thanks @abworks-dev for [PR #99](https://github.com/saya-ch/dsh-mobile/pull/99)).
- Add a zero-SSH path for attaching to an existing frps without installing, changing, or restarting it. Users can choose a publicly trusted Caddy HTTPS entry through a loopback-only HTTP vhost, or a raw TCP entry whose self-signed gateway CA the 0.4.6 Android app pins during pairing. The latter uses a public IPv4 address and a finite-lived CA and leaf; older apps cannot use this entry (thanks @liudasheng for [PR #100](https://github.com/saya-ch/dsh-mobile/pull/100)).
- Require a CA-bound `dsh2` pairing key for self-signed ingress, prevent saved FRP tokens from being returned to page scripts, retain the CA identity across restarts, and renew the ingress leaf without replacing its CA.
- Keep Node-only imports out of the built mobile client so DSH can activate the App frontend; add a build check for this regression.
- Resolve Windows `whoami.exe` and `icacls.exe` from the system directory rather than `PATH`, fixing activation when Git for Windows places GNU tools first (thanks @jueruibo for [#101](https://github.com/saya-ch/dsh-mobile/issues/101)).
- Restore provider-specific recovery guidance in remote diagnostics for the supported error codes across all three languages; remove an unused Android restore-target ordering path without changing paired-device startup.
- Add an isolated DSH browser check for both 0.1.7-alpha.2 and 0.1.7-rc.1 that pairs a test client, mounts the mobile layout, and requires a workspace baseline over the authenticated `/api/remote.mux` WebSocket.
- Bound FRP discovery probes through the complete response body and reject bodyless HTTP statuses, so stalled or malformed public endpoints cannot leave startup pending indefinitely or throw from the response callback.

## 0.4.5 - 2026-09-23

- Support the document-relative plugin URLs introduced in DSH 0.1.7 without weakening the same-origin `/plugins/` check. This fixes mobile boot batches returning `502 upstream_unavailable`; local and remote gateways were verified against DSH 0.1.7-alpha.2 (thanks @miqian-nomad for [#97](https://github.com/saya-ch/dsh-mobile/issues/97)).
- Keep failed revisioned plugin scripts and hashed assets on `no-store` instead of caching their 404 responses as immutable for a year (thanks @abworks-dev for [PR #98](https://github.com/saya-ch/dsh-mobile/pull/98)).
- Guard WebSocket upgrade sockets before asynchronous authentication so disconnects during reconnect cannot emit an unhandled socket error (follow-up to [#95](https://github.com/saya-ch/dsh-mobile/issues/95)).
- Give Android connection restoration an exit after a short wait: direct-start Retry stays bound to that paired computer, while manual and legacy flows offer the Device list without retrying a different computer. Existing credentials remain intact (thanks @sznyhgm for [#96](https://github.com/saya-ch/dsh-mobile/issues/96)).
- Restore the task-notification permission entry in the Android App's DSH General settings without bringing back the hidden native toolbar; the action uses the exact-origin, main-frame native bridge and has Chinese, English, and Italian copy.
- Align development dependencies and optional peer ranges with DSH 0.1.7-alpha.2, and use the producer-owned message source for `/mobile` guidance.

## 0.4.4 - 2026-09-20

- Keep DSH running if mDNS response callbacks, the multicast-dns emitter, or the already-bound UDP discovery socket reports a network error. LAN discovery records the degraded channel and logs the error code while the authenticated HTTP and WebSocket gateway remains available (thanks @KMGTPEZY for [#95](https://github.com/saya-ch/dsh-mobile/issues/95)).
- Accept pinned cpolar and cloudflared component downloads when a proxy omits `Content-Length`, and stop reading as soon as the response exceeds the pinned size.
- Credit community PR authors, including work adapted after a PR was closed, and every historical issue author by contribution type in [CONTRIBUTORS.md](CONTRIBUTORS.md), separately from GitHub's commit-based Contributors panel.

## 0.4.3 - 2026-09-19

- Support Linux for the Funnel, cpolar and cloudflared remote providers, including x64 and arm64 Funnel host binaries.
- Stay compatible with DSH 0.1.6-alpha.2 (plan-review without scroll marker).
- Split oversized mobile boot batches so profiles with heavy client bundles (e.g. a 21 MB office viewer) boot on phones again: the layout batch is chunked under a 16 MiB budget, single bundles at or above the per-entry cap pass through on their own `/plugins` row, and pass-through fetches get the same bounded transient retry the merged assembly already has (thanks @abworks-dev for PR #91).
- A saved LAN interface that is not connected (e.g. after switching from Wi-Fi to Ethernet) no longer fails the whole DSH boot: mobile access logs a warning, stays dormant with its refresh poller armed, and recovers on its own when the adapter returns. Genuine config/TLS errors still fail loudly (thanks @1624318455 for PR #93).
- Correct the merged boot-batch separator accounting and mark the Linux Funnel binaries executable so the license/binary check passes in CI.

## 0.4.2 - 2026-09-16

- Add an Own reverse proxy provider under Remote → Self-hosted for an existing user-managed HTTPS proxy. It provides a separate authenticated private HTTP origin (default 3444), strict private bind/source-CIDR validation, custom public HTTPS ports, local configuration and safe settings-only purge (thanks @xingleiwu for PR #84).
- Distinguish backend listening from unverified public HTTPS/certificate/WebSocket reachability, with localized setup, errors and diagnostics; retain the existing LAN gateway, remote pairing and Android protocol.
- Cover the HTTPS proxy → private HTTP origin → DSH path with real loopback pairing, authenticated HTTP and WebSocket tests, including Host/Origin/forwarded-header rejection and LAN independence.
- Permanently remove revoked devices from durable storage and the desktop list, terminate their active Sessions, and compact legacy `revokedAt` rows on startup. Deleted credentials are rejected as `authentication_failed`; no revocation tombstones are retained. An offline revoked device is therefore re-paired rather than shown as revoked when it reconnects (thanks @xingleiwu for PR #85).
- Load a bundled Iterator compatibility script before DSH boot on the dedicated mobile frontend, preventing `Iterator is not defined` on WebViews without Iterator helpers. The script is served locally behind the existing gateway authentication and uses feature detection to preserve or repair native helpers without weakening CSP or dropping script nonces (thanks @xingleiwu for PR #86).
- Add a cloudflared remote provider (Windows x64) in two modes. The pinned official client is downloaded from the official release page and SHA-256 verified only after confirmation, is launched with automatic updates disabled, and does not add a system service, startup item, registry entry, or PATH entry. **Quick mode** needs no account, token, or DNS record: cloudflared allocates a temporary `*.trycloudflare.com` address, which the gateway validates before adopting it — including rejecting the reserved control-plane hosts the banner can print first, such as `api.trycloudflare.com`, which would otherwise have put Cloudflare's API in the pairing QR code. **Named mode** uses a connector token, a public hostname, and a local forward port: the hostname stays the same across restarts, the token is stored only in the DSH Mobile private directory and handed to cloudflared through `TUNNEL_TOKEN` rather than the command line, and it is never returned to any client. Because Cloudflare routes the hostname to that exact port, the port is bound as configured and a taken port is reported as a hard failure instead of silently moving; readiness comes from the connector's own `Registered tunnel connection` line, since a named tunnel prints no banner. Switching back to a quick tunnel removes the stored token.
- Let the Android app classify `*.trycloudflare.com` as a supported remote tunnel host, so a scanned cloudflared pairing link selects remote access on its own instead of being rejected while no flow has been chosen yet. A named tunnel uses a domain the operator owns, which the app cannot classify by itself, so it is accepted only while the Remote flow is active. Both require an app build that includes this change; earlier builds still pair from the Remote access flow.
- Keep the mobile gateway usable when its broadcast discovery socket cannot bind the UDP port: Windows keeps separate TCP and UDP port-exclusion tables, so the port the operating system handed the TCP listener can be refused for UDP, and another process may already hold it. Discovery now degrades on its own while mDNS, HTTP and WebSocket service continue, instead of failing the whole listener.
- Make the remote provider chooser readable now that it offers three providers: the cards list one per row instead of leaving the third orphaned in half a row, the card description — the copy that decides the choice — is no longer the smallest text in the panel, and the destructive inline actions are no longer its smallest targets.
- Fix the on-demand component download, so the cloudflared component can actually install: a pinned GitHub release URL answers with a redirect, and the downloader refused every redirect, which failed the install in under a second with `TypeError: fetch failed` and no bytes transferred. One redirect hop is now followed after validating its scheme and a release-asset host, and a transport failure is retried once, because a 55 MB transfer through a TUN proxy can reset mid-stream.
- Keep a failed provider action readable: the status line now holds its message through the repaint that follows, instead of being replaced by the server snapshot within a frame, which made a failed download look like a click that did nothing.
- Replace the panel's hardcoded colours and its smallest type with DSH tokens and one 11px floor, and reduce interactive targets to two tiers (36px inline, 44px primary). An earlier attempt at the colour work referenced four DSH aliases that do not exist, so every var() fell back to its light literal and the dark theme never adapted; the panel now uses the real border-l1/l2/l3 and state tokens, and a guard test parses the stylesheet so a stray brace can no longer silently drop declarations.
- Show a failed provider request in the user's own language. A rejection carries its error code, and the panel stringified the whole error, so a rejected tunnel hostname or a failed component download printed the raw code in every locale while the translated sentence sat unreachable; provider failures now resolve through one code-to-copy table.
- Keep broadcast discovery observable when its UDP port cannot be bound: the failure is reported through the management status and logged once at startup, instead of vanishing while the phone simply cannot find the computer. A missing bundled mobile asset is reported the same way rather than appearing only as a failed subresource.
- Never let the compatibility bundle break the mobile frontend. An index without a script tag used to fail the whole page, markup inside an HTML comment was accepted as the injection point (so the fix silently never ran), and an already-injected bundle went unrecognised when the document used single quotes.
- Reserve DSH's own WebServer port (3080) for the reverse-proxy backend and keep that port in the unprivileged range, matching the LAN gateway reservation that already refused 3443.
- Export the cloudflared tunnel configuration surface so installation tooling can pre-seed a named tunnel through the same validated path instead of writing JSON by hand.
- Document that a named tunnel must be scanned from inside the app's Remote flow, and that device credentials are bound to their exact origin, so moving a remote channel to a fixed hostname requires pairing the phone again.
- Reorganize the shipped guides into a bilingual index and remove their broken relative links.

## 0.4.1 - 2026-09-15

- Allow the desktop Mobile access admin API and sidebar control on RFC1918 and IPv4 link-local Host values when the TCP peer remains loopback, so headless Linux hosts and LAN reverse proxies can open DSH Web without a localhost-only browser. Public IPs, CGNAT, and arbitrary DNS names stay rejected. The dedicated Mobile HTTPS listener remains the phone surface (thanks @xingleiwu for PR #79).
- Let the proxied DSH GUI frame its own same-origin surfaces and embed external http(s) and blob: pages, so the right-sidebar browser tab, the HTML/diff previews, and the PDF preview work over LAN and remote access; gateway-owned login, pairing, and JSON responses keep refusing every frame (thanks @idoall for PR #77).
- Bound advisory operating-system route inspection so a slow Windows network query falls back to explicit network selection instead of holding the local setup page open.
- Keep Android CI and release setup limited to currently available SDK packages so APK verification is not blocked by the retired `tools` package.
- Require a same-origin `Origin` header on every mutating desktop management request, including clients that omit Fetch Metadata, so private-Host reverse proxies cannot bypass the browser CSRF check.
- Accept the DSH conversation scroll marker wherever it lives under the conversation skeleton, keeping the compatibility gate valid when upstream extracts the body into a separate component.
- Allow HTTP iframe sources for compatibility while showing a localized warning that unencrypted pages can be altered and should not be used for sensitive work.
- Fix mobile extension Host actions that sent JSON without an explicit content type, which caused every `api.host.invoke()` call to return `415 unsupported_media_type`.
- Accept callable Schemastery input schemas as well as existing `parse(value)` adapters for extension actions, so documented `api.schema.object(...)` inputs are validated and normalized before `run()`.
- Update the development peers and source compatibility gate for DeepSeek Harness `0.1.6-alpha.1`: the checker follows extracted conversation/composer markers and the named global transport hook without weakening the Host-trust or authenticated RPC checks.
- Correct bilingual navigation and historical issue links, clarify Android task-reminder versus browser-notification behavior, and add a complete English self-hosted FRP guide without changing runtime behavior.

## 0.4.0 - 2026-09-14

- Add multi-device management to the Android app: migrate existing LAN and remote credentials, show each paired computer with its Origin and HTTPS reachability state, connect the most recently used valid device on direct startup, and provide list, rename, re-pair, delete, and launch-behavior controls.
- Complete plugin-side localization for Chinese, English, and Italian, including diagnostic report copy, browser pairing pages, and reauthentication guidance selected from `Accept-Language`; Android resources remain key-complete across all three supported locales.
- Use a bounded session-free native probe for list reachability checks, with a renewal fallback for older plugins so status refreshes cannot evict an active DSH session.
- Preserve a local row after computer-side revocation, stop automatic retries for revoked credentials, and expose a short-lived undo action for local deletion without restoring a computer-side authorization.
- Follow the DSH conversation's actual nested scroll container when showing or hiding the Android toolbar, keeping task-notification settings reachable on current DSH Web layouts.
- Let cpolar choose its default route instead of forcing `cn`: the plugin no longer passes `-region`, so cpolar selects its own tunnel server. No profile or environment setting exposes an explicit region.
- Add Android task-completion and pending-input reminders through authenticated Host events and the exact-origin native bridge; notification permission is enabled explicitly from the foreground app menu, lock-screen text stays generic, and each completed turn keeps a separate reminder (thanks @qzyqmzn for PR #75).
- Show and re-copy remote pairing links without invalidating the QR code's active one-time pairing window (thanks @qzyqmzn for PR #75).
- Detect plugin-market installations that have not completed LAN setup, prevent the loopback-only `127.0.0.1` fallback from being presented as phone access, and provide a localized in-panel network picker that creates private TLS material and LAN-only Windows firewall rules after explicit confirmation. The configured gateway starts after one DSH restart (thanks @cangming99 for the report).
- Keep native DSH file selection in the composer Add group, add only camera capture there, and reuse the native menu-row styling for the mobile action.
- Add a native-app-only Switch computer action to the WebView's DSH General settings page, keeping the Android device-list settings and DSH content toolbar focused on their own controls.
- Hide the Android shell toolbar above the WebView so DSH occupies the full safe viewport; the system status-bar color continues to follow the page background.

## 0.3.16 - 2026-09-12

- Provide legacy dsh-web community pane markers and a collapsed-rail marker on the dedicated layout so DOM-mounting plugins such as `@linxin666/dsh-client-ui-task-board` can inject their sidebar entry and panel (thanks @idoall for PR #67).
- Preserve native rightbar track/fullscreen requests while shrinking or overlaying the panel whenever docking would leave less than 400 px for the conversation. The dedicated layout no longer consumes the retired Better Sidebar width variable (thanks @idoall for PR #66).
- Follow the active DSH WebServer port for LAN and remote proxy authentication, including managed and legacy setup files that saved an older 3080 upstream. The independently configurable Mobile HTTPS listener remains unchanged (thanks @CharlesLueng for #68).
- Limit the full-width question and plan-review adaptations to screens at most 600 px wide so desktop remote browsers retain DSH's native card width (thanks @idoall for #64).

### Contributors

- @idoall contributed PRs #66 and #67 and reported #64: responsive rightbar docking, legacy dsh-web community pane compatibility, and the question-card reproduction.
- @CharlesLueng reported #68 and identified the custom DSH Web port path that still targeted the saved default upstream.

## 0.3.15 - 2026-09-11

- Support the DeepSeek Harness 0.1.5 keyed `main` panel, root `panelInfo` hook, navigation lifecycle, and root right sidebar while retaining the earlier `conversation` and `details` paths.
- Recover mobile boot batches from transient upstream resets with bounded retry, lower concurrency, and one request-independent assembly shared by concurrent clients; proxy DSH installations that disable browser launch-token authentication (thanks @longisland-icetea for PRs #59 and #60).
- Synchronize Mobile drawer dismissal with the DSH 0.1.5 right-Sidebar state, and keep the wide-screen right panel non-modal so its scrim cannot cover the composer (thanks @idoall for reporting #62).
- Keep the injected drawer backdrop and transient toasts out of wide desktop document flow while preserving the narrow overlay behavior (thanks @longisland-icetea for PR #63).
- The gateway now proxies the DSH desktop UI's sidebar terminal by default: its upgrade path (`/sidebar/ws/terminal`, first-party DSH surface, renderer-v2) joins the built-in WebSocket allow-list, so pairing no longer fails with repeated `1006` when the terminal connects. Third-party plugin paths still require one-click approval in the connection diagnostics.
- Let the mobile-access entry share the desktop footer-action row, preserve the compact rail target, and separate folded or expanded reasoning from the reply (thanks @IvyC-zz for reporting #58).
- Declare DSH 0.1.5 prerelease peers, align the development toolchain with rc.2, and update `js-yaml` to the compatible security fix 4.3.2.
- Follow cpolar public-origin rotations by rebuilding the authenticated gateway on the existing loopback port. Android identifies an expired temporary cpolar address, opens the remote scanner directly, and never sends a stored device token to a different QR-provided Origin; the new Origin is accepted only through one-time pairing.
- Allow up to 120 seconds for an authenticated cpolar page to finish its first load while retaining the 15-second LAN and 30-second other-remote budgets. ADB and Chrome DevTools reproduced a valid 200 response whose 4.41 MB compressed DSH 0.1.5 boot module needed 88 seconds over the free route; the App now lets that transfer finish instead of misreporting the healthy tunnel as unreachable.
- The 0.1.5 LAN path was first verified on rc.1 by @idoall; current compatibility checks target rc.2. See [the verification record](docs/DSH_0.1.5_LAN.md).

### Contributors

- @longisland-icetea contributed PRs #59, #60, and #63: browser-auth-disabled proxying, the DSH 0.1.5 layout and boot-batch adaptation, and the wide-screen scrim fix.
- @idoall contributed PR #61's LAN verification and documentation, and provided the detailed right-Sidebar state report in #62.
- @IvyC-zz provided the terminal and mobile UI reproductions in #58.

## 0.3.14 - 2026-09-08

- The panel's “Update plugin” action now shows a preview card first: the latest release notes (fetched from the GitHub releases API, graceful fallback when unavailable) plus fixed upgrade notices (restart DSH after installing; apps and paired devices need no re-pairing; check the README compatibility table when unsure about the desktop version), then explicit Update now / Not now buttons. Notes are served from the release itself, so a user on any older plugin version sees the current guidance before updating.
- Fixed a regression in 0.3.13: its layout adaptation tracked the harness master branch (which renamed the right details seat to `rightbar`), but the published 0.1.3-alpha.2 host still exposes `details` — so on real hosts the mobile right panel rendered empty. The layout now registers and renders both seat names (`details` with the legacy empty owner share, `rightbar` with resolved column geometry), so the right panel works on 0.1.3-alpha.1, the published 0.1.3-alpha.2, and the master contract alike. The compatibility check still asserts the master (`rightbar`) contract.

## 0.3.13 - 2026-09-08

- Third-party WebSocket approval is interception-driven and generic: whenever a plugin's WebSocket connection is blocked, the diagnostics view groups the rejected paths by directory with attempt counts and offers per-path or allow-all approval, behind the same local-admin trust as pairing, and both the sidebar entry and the in-panel diagnostics button carry a red badge until reviewed. Manual path entry is tucked under an “advanced” disclosure that most users never need to open (thanks @idoall for reporting #47). Badge changes are announced to screen readers and the disclosure has a visible focus ring.
- Panel polish: number the FRP VPS deployment group as step 2, restyle its deploy-changes list, align the path input with sibling fields, and auto-expand the VPS group until FRP is configured.
- Adapted to DeepSeek Harness 0.1.3-alpha.2: the front-end layout contract renamed the right details slot from `details` to `rightbar` and now hands the occupant resolved column geometry; the mobile layout registers and renders the slot under its new name with the real width, viewport, and eligibility values. The mobile page requires a host exposing the `rightbar` seat — 0.1.3-alpha.2 or later.

## 0.3.12 - 2026-09-07

- Document remote notification limits: browser permission is per origin, OS toasts stay on the computer, and server-side channels (e.g. dsh-messager webhooks) are the reliable push path to the phone (thanks @idoall for reporting #46). No code change since 0.3.11.

## 0.3.11 - 2026-09-07

- Sync the browser tab title with the current session on the dedicated layout, matching the stock behavior (thanks @idoall for reporting #45).
- Allow installed plugins' WebSocket endpoints through the gateway via admin-approved exact paths (e.g. `/sidebar/ws/terminal`), managed in the remote panel behind local-admin trust; built-in DSH paths keep working and everything else stays blocked (thanks @idoall for reporting #47).
- Document remote notification limits: browser permission is per origin, OS toasts stay on the computer, and server-side channels (e.g. dsh-messager webhooks) are the reliable push path to the phone (thanks @idoall for reporting #46).

## 0.3.10 - 2026-09-07

- Keep the workspace sidebar open on desktop-sized viewports (≥900px): the dedicated layout docks it as a persistent panel that survives reconnects and no longer auto-closes after selecting a session, and the dimming scrim only covers the narrow overlay drawer and details panel. Narrow screens keep the overlay drawer behavior unchanged (thanks @idoall for reporting #42).
- Declare storefront screenshots (`screenshots.json`) so plugin markets show a curated order: repository hero, LAN pairing, remote access, and two mobile UI shots.
- Verify the mobile frontend, connection, and trust contracts against DeepSeek Harness 0.1.3-alpha.1 through the existing upstream-source CI gate; no compatibility code change was required.

## 0.3.9 - 2026-09-04

- Add one-click VPS deployment for self-hosted FRP (PR #38, thanks @qzyqmzn): fill in the SSH user, port, and key in the control panel and the plugin installs frps, Caddy, firewall rules, and a Let's Encrypt IP certificate over pinned SSH with user-confirmed host fingerprints. Server-side cleanup removes only DSH Mobile-owned artifacts through a reviewable uninstall script. Public IPv4 origins are accepted on both the panel and the Android app.
- Improve the `/mobile` customization command: inject the current mobile customization state (whether `mobile.css` / `mobile.js` exist and which extensions are installed) into the agent guide so earlier work is not overwritten blindly, teach the agent how to restore the built-in default appearance by removing those files, and require syntax and schema self-checks before it reports completion.
- Verify the mobile frontend, connection, and trust contracts against DeepSeek Harness 0.1.2-alpha.5, 0.1.2-rc.1, and 0.1.3-alpha.1 through the existing upstream-source CI gate; no plugin code change was required. Extend the DSH peer ranges with the `^0.1.3-0` family so fresh installs resolve against 0.1.3 prereleases.
- Shrink the composer dock stats strip on phones and link the community WeChat Mini-Program client in the README (thanks @StrawberryAO). Existing 0.3.3-0.3.8 Android apps and paired devices remain compatible.

## 0.3.8 - 2026-09-03

- Preserve the WeChat Mini-Program compatibility changes contributed in PR #34 by @StrawberryAO while deriving an unset upstream from the active DSH WebServer port. Standalone Web defaults, Desktop's configured port, and Desktop's bind-conflict retry port therefore use the same proxy target.
- Accept the observed `allowed-origin,undefined` WebSocket Origin form while rejecting mixed values that include an untrusted Origin.

## 0.3.7 - 2026-09-02

- Fix the Windows DSH Desktop startup failure reported in [#22](https://github.com/saya-ch/dsh-mobile/issues/22): capture subprocess output through the callback API instead of relying on `execFile` promisify metadata that a host wrapper may omit. Thanks @XChen446 for the precise 0.3.6 stack trace.
- Apply the same output handling to Windows SID resolution, private-file ACLs, route selection, and firewall diagnostics/setup. Invalid SID output and ACL failures still reject the operation; a failed SID lookup can be retried and Windows permission commands have bounded execution time.
- Retain the 0.3.6 removal of the exact DSH version allowlist. Existing 0.3.3-0.3.6 Android apps and paired devices remain compatible; the 0.3.7 APK updates version metadata only.

## 0.3.6 - 2026-09-02

- Remove the fixed DeepSeek Harness version allowlist from plugin startup and npm peer metadata. A compatible future DSH release can now load without waiting for DSH Mobile to enumerate its exact prerelease version.
- Verify the mobile frontend and trust contracts against DSH 0.1.2-alpha.3 and 0.1.2-alpha.4, while retaining the upstream-source CI gate that rejects actual interface changes instead of version-number changes.
- Keep the pairing protocol and Android behavior unchanged; existing 0.3.3-0.3.5 apps and paired devices remain compatible.

## 0.3.5 - 2026-09-01

- Fix [#26](https://github.com/saya-ch/dsh-mobile/issues/26): prevent mobile startup from remaining on “Loading plugins” over LAN or remote access when DSH sends the WebSocket upgrade response and initial snapshot together. The gateway now preserves that snapshot without relaxing its 16 KiB response-header limit. Thanks @oliverwan97 for the detailed report.

## 0.3.4 - 2026-08-31

- Support DeepSeek Harness 0.1.2-alpha.2, including its remote-backed settings dependencies. Initialize authenticated mobile trust before the API gateway caches Host facts, while retaining support for earlier declared DSH versions.
- Reuse the in-page directory picker supplied by Windows DSH Desktop, avoiding duplicate `directoryPicker` registration while retaining mobile workspace selection in the standalone Web profile and on other platforms.
- Align the Mobile Access sidebar action with the native Settings row, including spacing, theme-aware vector icons, keyboard focus, and expanded-state accessibility.
- Resolve plugin updates against the active Desktop profile instead of falling back to the Web profile; disable updates when the Desktop profile cannot be identified.
- Keep the pairing protocol and Android behavior unchanged; existing 0.3.3 apps remain compatible with this plugin update.

## 0.3.3 - 2026-08-30

- Add an advanced self-hosted FRP provider for users who already operate a VPS and public domain, without modifying DeepSeek Harness or expanding the default remote setup.
- Generate one restricted frps and Caddy template, manage only a pinned official `frpc` binary, and expose no arbitrary FRP configuration, TCP/UDP proxy, service installation, PATH entry, or startup task.
- Keep the FRP HTTP vhost on VPS loopback, reject a publicly reachable plaintext vhost, and mark the connection ready only after the public HTTPS discovery endpoint returns this computer's exact DSH Mobile installation identity.
- Add an accessible four-step desktop setup, localized status and diagnostics, complete local cleanup, and Android support for explicitly paired custom HTTPS remote domains. Older supported apps remain usable with LAN, cpolar, and Tailscale; custom domains require app 0.3.3 or later.
- Pin FRP 0.70.1 downloads for Windows, Linux, and macOS on x64 and arm64, with official-origin, exact-size, SHA-256, archive-path, executable-version, and private-storage checks.
- Add version-aware plugin update and Android download entries, while rejecting non-registry update sources and preserving the current DSH process on update failure.
- Reorganize remote setup, keep settings in mobile layout when session content contains lookalike panels, and correct dark-mode action and remote-card contrast.
- Serialize remote-provider changes, complete process-tree cleanup, and harden Android authentication, same-origin downloads, dark-theme surfaces, release signing, and package-size checks.

## 0.3.2 - 2026-08-29

- Special thanks to @JackRushante for [#16](https://github.com/saya-ch/dsh-mobile/pull/16): the secure Android media bridge, image attachments, localization foundation, bounded extension requests, and Funnel lifecycle hardening. This release retains all four original commits and their author metadata.
- Move image selection and camera capture into a dedicated top row of the composer command menu, without focusing the message editor.
- Push extension and `/mobile` changes to authenticated phones immediately, while retaining bounded polling as a network-recovery fallback.
- Bind each mobile UI to its matching Host, script, style, and asset generation; retain the previous Host through a bounded refresh window, fail closed on client activation errors, and tighten scoped requests against encoded path traversal.
- Bound long-running Android picker and camera interactions, release temporary provider grants across success, cancellation, timeout, rotation, and Activity teardown, and retain compatibility with supported WebView releases.
- Split mobile language dictionaries into dedicated modules; make native Android screens follow the system locale in Simplified Chinese, English, or Italian; make plugin-owned Web UI follow DSH's selected locale; and retain Italian resources for future DSH support.
- Correct the mobile extension and Funnel documentation, and record the Android runtime libraries shipped with the app.

## 0.3.1 - 2026-08-28

- Credit @BlueandwhiteXD ([#15](https://github.com/saya-ch/dsh-mobile/pull/15)) for the Android keyboard inset report and fix incorporated into the 0.3 mobile layout.

## 0.3.0 - 2026-08-28

- Add one-click connection diagnostics for versions, LAN gateway, network interface, Windows firewall, and the selected remote provider, with a sanitized report for support requests.
- Publish compatibility metadata separately from the stable discovery protocol so the Android app can distinguish app, plugin, and protocol mismatches.
- Keep the connection chooser interactive during background restoration, race saved LAN and remote trust, reuse trust after remote address changes, apply remote-aware timeouts and single-flight refresh backoff, and privately cache revisioned assets for faster reopening.
- Preserve fallback discovery when Android 13+ nearby Wi-Fi permission is declined, and provide concise guidance for QR, pairing, session, rate-limit, and service failures.
- Forward authenticated DSH and plugin mutations with CSRF protection, restoring mobile plugin-market and other non-GET actions.
- Coordinate Android and Web status-bar and safe-area behavior, keep settings actions readable on narrow screens, and refresh the app icon.
- Support DeepSeek Harness 0.1.2-alpha.1, including its `/api/remote.mux` state channel and batched renderer boot, so Workspaces, model selection, sessions, and community plugins remain available on mobile.
- Compress dedicated mobile boot batches and harden Android WebView origin checks, reducing remote startup transfer while avoiding background-thread WebView access.

## 0.2.2 - 2026-08-27

- Detect LAN and remote pairing links automatically after a QR scan, independent of the currently selected connection page.
- Clarify QR, network, firewall, certificate, and pairing failures so users can identify the shortest recovery path.

## 0.2.1 - 2026-08-25

- Add a stable Android app download entry to the desktop Mobile Access panel.

## 0.2.0 - 2026-08-24

- Add independent LAN and remote access flows with separate paired-device stores.
- Add optional Tailscale Funnel and managed cpolar remote providers.
- Restore saved Android connections automatically and improve mobile loading over limited links.
- Page older session history on demand and compress eligible gateway responses.
- Build the pinned Funnel host from source and publish checksums, an SBOM, and third-party notices.

## 0.1.4 - 2026-08-23

- Keep the plugin compatible with DeepSeek Harness 0.1.1.
- Continue mobile layout, safe-area, composer, settings, and interaction improvements.
- Restore bounded native response reads on Android 10 through 12.
- Publish Android releases as reproducible, signed release builds instead of temporary debug builds.
- Preserve the existing mobile protocol so older app builds can continue using the updated plugin; switching from the previous temporary Android signature requires one uninstall and re-pair.
- Refresh CI actions, Android lint coverage, build tooling, and maintenance documentation.

## 0.1.3 - 2026-08-23

- Added DeepSeek Harness 0.1.1 compatibility.
- Improved mobile layout and interaction behavior.
