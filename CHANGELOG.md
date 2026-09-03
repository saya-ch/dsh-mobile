# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.


## Unreleased

- Verify the mobile frontend, connection, and trust contracts against DeepSeek Harness 0.1.2-alpha.5 and 0.1.2-rc.1 through the existing upstream-source CI gate; no plugin code change was required.

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
