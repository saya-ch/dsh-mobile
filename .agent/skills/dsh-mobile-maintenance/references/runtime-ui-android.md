# Runtime, UI and Android

## Connection ownership and security

LAN and remote access have separate lifecycles and pairing authorization. Android unifies saved computers in its device list; it does not make the underlying authorizations interchangeable. Read `src/access.ts`, `src/gateway.ts`, `src/remote.ts` and the selected provider/controller before changing state transitions.

Use generation and ownership checks for asynchronous start/stop, provider switching, component download, retries and late process exits. An old callback must not stop a newer tunnel, overwrite its Origin or update a disposed UI. Reconcile prior effects after cancellation; retrying is not rollback.

Preserve precise Origin checks, HTTPS trust, LAN/private CA pinning, device token handling, CSRF and targeted revocation. Never fix a connection by ignoring certificate errors globally, sending credentials to a discovered arbitrary address, exposing the DSH loopback port publicly or weakening third-party WS policy.

Distinguish network unavailability, changed address, expired credentials, authentication failure and computer-side revocation. A timeout is not evidence that the computer removed the device. Verify the active discovery identity before merging a changed cpolar Origin into a saved computer. App credentials stay Keystore-protected; display names and addresses must not expose Tokens.

Optional downloaded components belong to a private managed directory derived from the user's actual DSH state. Preserve fixed-source/size/hash checks, archive extraction limits and parent-directory ownership. No hidden service installation, PATH edits or startup registration. Cleanup must distinguish plugin-owned components from a user's external proxy or system installation. A bounded Windows filesystem retry must not weaken path checks or destroy the rollback copy.

Managed Caddy build/review/distribution and runtime installation are separate states. Consult `docs/CADDY_MANAGED.md` and its English counterpart; a successful build or release does not enable an unpinned production catalog, prove certificate renewal or authorize component publication.

## Connectivity and remote performance

Check the chain that matters: actual computer process → local gateway → public Origin → static boot resources → authenticated API → WebSocket Workspace reads. A health response, TLS handshake or screenshot of a login page is not full remote acceptance. If the same public URL is slow on the computer, separate provider/network limits from App rendering.

For cellular/public-route tests, use the phone's real network. Mark USB reverse, loopback routing, local reverse proxies and simulated TLS as isolated evidence. If temporarily switching providers is authorized, record and restore the selected provider; do not silently abandon a working tunnel.

For LAN failures, distinguish wrong interface/address, listener binding, firewall policy and network isolation with checks from both ends. Sharing a Wi-Fi name does not guarantee routing between clients or campus subnets. The plugin cannot bypass a router's client isolation; do not prescribe globally disabling the firewall or exposing all interfaces as a universal fix. Use the existing diagnostics and an appropriate remote route when the network cannot provide LAN reachability.

For self-hosted FRP or a reverse proxy, follow the owning provider guide: the local remote Gateway and the public HTTPS terminator have different responsibilities. FRP HTTPS forwarding does not itself terminate TLS for an HTTP backend. Preserve the single-purpose mobile Gateway rather than adding an unrestricted TCP/UDP proxy. Approved custom HTTPS Origins are valid remote addresses; do not recognize remote connections only by a cpolar or Tailscale hostname suffix.

Preserve revision-aware asset caching, compression and bounded history pagination. Do not replay API writes or model operations while retrying transient static requests. Long API operations must not be cut off by an ordinary static-transport timeout. Automatic recovery should renew trust and restore transport while retaining the existing WebView/document when possible, not repeatedly reload the homepage and discard draft/scroll/menu state.

Attach error handling to both WebSocket peers. Reserved close codes such as 1005, 1006 and 1015 describe local conditions and must not be transmitted as close frames. Test invalid peer input and teardown without allowing an unhandled socket error to terminate DSH. Third-party terminal/realtime routes require exact-path approval; do not replace that with an unrestricted WS proxy.

## Mobile presentation

Reuse DSH's existing frontend semantics and theme tokens. Keep plugin-owned selectors narrow, preserve desktop behavior and support light/dark modes. The Android top native toolbar stays hidden; computer switching belongs in the DSH web page's General settings, not in the native device-list settings where it is redundant.

Inspect parent layout, viewport ownership and the actual consumer before changing CSS. Conversation components must not change the detection of the entire mobile page. Optional module selection is a whole-module loading choice with required/dependency checks; it cannot hide every arbitrary toolbar component or fix arbitrary community-plugin layouts.

Measure portrait/landscape, small CSS viewports, larger text, keyboard shown/hidden, drawers, model menus, settings, dock entries, Stop/Send and scrolling. Check touch targets and hit testing after generic settings rules apply. A declared 48px size can still be shrunk by flexbox or overridden by a broader selector.

Keep mobile typography local to the current Origin instead of writing Host settings unintentionally. Whole-page App zoom is a separate preference. Verify paragraphs, code blocks and their real styles after adjustment/reset; a terminal canvas requires its own supported consumer. Show an App-only control only when the native bridge advertises the required actions.

Preserve DSH's composition, menu selection, modifiers and send handling when changing Enter behavior. Browser events cannot reliably distinguish every soft and external keyboard; use the existing policy and native evidence rather than a UA guess. Switching sessions should not focus the composer and summon the keyboard. Reuse native DSH file upload instead of adding a duplicate chooser; camera actions remain explicit user actions.

Async settings/forms need disposed-view and stale-result checks. A saved preference must actually affect rendering, and a failed operation should retain the last confirmed value with a short localized retry path. Do not capture microphone audio automatically or call speech recognition verified without a physical recording/recognition test.

## Android and ADB

Read `apps/mobile/README.md`, its Chinese counterpart, the manifest, `MainActivity.kt`, `NativeBridge.kt`, `WindowInsets.kt` and the affected policy tests. Before operating a device, identify the selected serial, package, versionCode, signer, WebView provider and current screen. A different connected device is not interchangeable evidence.

Preserve application identity, Keystore data and existing pairings. A matching-signer upgrade may use an in-place install; an official/debug signer mismatch is not a reason to uninstall or clear data. Use a separately authorized test package when needed. Do not grant unrelated permissions, bypass a lock screen or expose WebView debugging on public interfaces. `MainActivity.kt` enables CDP only for `BuildConfig.DEBUG`; absence of a debug socket on a formal App is not a connection failure or permission to replace its signer. Debug CDP forwards stay on loopback and are removed afterward.

Native-safe margins own system bars, cutouts and keyboard occupancy per edge. Use the maximum overlapping inset, not summed navigation plus IME, and consume margins already handled by native layout so CSS does not add them again. Keep status/navigation backgrounds and icon contrast aligned with the page. A system resource overlay on an OEM device may change a mode value without exposing a real three-button bar; inspect the actual Insets/screen before claiming that test.

Retain the WebView across supported rotation/window/keyboard changes. Test actual document/editor identity, an unsent draft, scroll/menu state, reference chips and images as applicable. Do not infer preservation merely from saved Origin. Record platform-required Activity recreation or render-process loss separately.

System Back should first dismiss keyboard and webpage layers according to existing DSH Escape/back handling, then perform the agreed App-root behavior. Android predictive Back and older callback paths require device evidence; do not test only by dispatching a browser Escape event.

Use the existing Android unit tests, Debug/release builds and lint for source changes. ADB acceptance should avoid sending model requests, clearing sessions, revealing pairing URLs/Cookies or recording unrelated screen content. Restore temporary zoom, rotation, navigation settings and test drafts; uninstall only an explicitly owned temporary test App when authorized. Leave concise local evidence without publicizing the user's conversations.
