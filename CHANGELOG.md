# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.

## 0.5.0 - 2026-09-26

- Recognize the official DSH Desktop `dsh-app://app` page as a Mobile administration surface, while requiring its signed DSH browser session for forwarded management requests (thanks @Sanksu for [PR #118](https://github.com/saya-ch/dsh-mobile/pull/118) and @up-and-down-0618 for [#115](https://github.com/saya-ch/dsh-mobile/issues/115)).
- Send paired-page file uploads through the authenticated Mobile transport so PDF and other binary attachments reach DSH without bypassing the gateway's CSRF checks (thanks @ayiejosh for [PR #116](https://github.com/saya-ch/dsh-mobile/pull/116)).
- Enable voice input on the paired page and in the Android App. App 0.5.0 asks for microphone permission on first use and grants audio-only capture to the paired HTTPS Origin (thanks @ayiejosh for [PR #119](https://github.com/saya-ch/dsh-mobile/pull/119)).
- Let narrow phone headers reveal hidden controls by touch, tap or keyboard focus while keeping menus accessible (thanks @ayiejosh for [PR #117](https://github.com/saya-ch/dsh-mobile/pull/117)).
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

- Support the document-relative plugin URLs introduced in DSH 0.1.7 without weakening the same-origin `/plugins/` check. This fixes mobile boot batches returning `502 upstream_unavailable`; local and remote gateways were verified against DSH 0.1.7-alpha.2 (thanks @azri57806-design for [#97](https://github.com/saya-ch/dsh-mobile/issues/97)).
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
- Detect plugin-market installations that have not completed LAN setup, prevent the loopback-only `127.0.0.1` fallback from being presented as phone access, and provide a localized in-panel network picker that creates private TLS material and LAN-only Windows firewall rules after explicit confirmation. The configured gateway starts after one DSH restart (thanks @cangming99 for #72).
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
