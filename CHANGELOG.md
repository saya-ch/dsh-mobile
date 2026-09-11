# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.


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

- Fix the Windows DSH Desktop startup failure reported in [#22#22](https://github.com/saya-ch/dsh-mobile/issues/22): capture subprocess output through the callback API instead of relying on `execFile` promisify metadata that a host wrapper may omit. Thanks @XChen446 for the precise 0.3.6 stack trace.
- Apply the same output handling to Windows SID resolution, private-file ACLs, route selection, and firewall diagnostics/setup. Invalid SID output and ACL failures still reject the operation; a failed SID lookup can be retried and Windows permission commands have bounded execution time.
- Retain the 0.3.6 removal of the exact DSH version allowlist. Existing 0.3.3-0.3.6 Android apps and paired devices remain compatible; the 0.3.7 APK updates version metadata only.

## 0.3.6 - 2026-09-02

- Remove the fixed DeepSeek Harness version allowlist from plugin startup and npm peer metadata. A compatible future DSH release can now load without waiting for DSH Mobile to enumerate its exact prerelease version.
- Verify the mobile frontend and trust contracts against DSH 0.1.2-alpha.3 and 0.1.2-alpha.4, while retaining the upstream-source CI gate that rejects actual interface changes instead of version-number changes.
- Keep the pairing protocol and Android behavior unchanged; existing 0.3.3-0.3.5 apps and paired devices remain compatible.

## 0.3.5 - 2026-09-01

- Fix [#26#26](https://github.com/saya-ch/dsh-mobile/issues/26): prevent mobile startup from remaining on “Loading plugins” over LAN or remote access when DSH sends the WebSocket upgrade response and initial snapshot together. The gateway now preserves that snapshot without relaxing its 16 KiB response-header limit. Thanks @oliverwan97 for the detailed report.

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

- Special thanks to @JackRushante for [#16#16](https://github.com/saya-ch/dsh-mobile/pull/16): the secure Android media bridge, image attachments, localization foundation, bounded extension requests, and Funnel lifecycle hardening. This release retains all four original commits and their author metadata.
- Move image selection and camera capture into a dedicated top row of the composer command menu, without focusing the message editor.
- Push extension and `/mobile` changes to authenticated phones immediately, while retaining bounded polling as a network-recovery fallback.
- Bind each mobile UI to its matching Host, script, style, and asset generation; retain the previous Host through a bounded refresh window, fail closed on client activation errors, and tighten scoped requests against encoded path traversal.
- Bound long-running Android picker and camera interactions, release temporary provider grants across success, cancellation, timeout, rotation, and Activity teardown, and retain compatibility with supported WebView releases.
- Split mobile language dictionaries into dedicated modules; make native Android screens follow the system locale in Simplified Chinese, English, or Italian; make plugin-owned Web UI follow DSH's selected locale; and retain Italian resources for future DSH support.
- Correct the mobile extension and Funnel documentation, and record the Android runtime libraries shipped with the app.

## 0.3.1 - 2026-08-28

- Credit @BlueandwhiteXD ([#15#15](https://github.com/saya-ch/dsh-mobile/pull/15)) for the Android keyboard inset report and fix incorporated into the 0.3 mobile layout.

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
