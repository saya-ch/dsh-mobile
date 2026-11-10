# Contributing

Keep pull requests focused on observable behavior. Explain the change, cover new failure/rejection paths, and update the relevant English and Chinese guides together. Preserve contributor history and keep real credentials out of fixtures.

Agent-assisted maintainers should start with [AGENTS.md](AGENTS.md) and the [DSH Mobile maintenance skill](.agent/skills/dsh-mobile-maintenance/SKILL.md). Its references cover compatibility/packaging, runtime/ADB, test-fixture reliability and collaboration/releases; load only the route needed for the task. Update demonstrated reusable guidance alongside the owning change, without turning transient release state into permanent instructions.

## Report a problem

Use the GitHub problem-report form for a specific failure, or the feature-request form for a proposed behavior. Include DSH and plugin versions, App/browser versions where applicable, the affected entry and connection type, reproduction steps, expected behavior and the actual result. Mark the affected area in screenshots. For third-party plugin or skin combinations, name the packages and versions and compare with the optional module disabled; do not uninstall plugins or clear pairing data for this check. A compatibility request is not a guarantee that every plugin combination will be supported. Redact pairing codes, Tokens, Cookies, API keys and private conversations before posting.

## Local setup and baseline

Use the Node engine range in [package.json](package.json). From this repository:

```sh
npm ci
npm run verify
```

`verify` checks version alignment, documentation links/structure, the embedded companion component, bundled licenses and third-party notices (`npm run check:notices`), mobile assets, TypeScript, tests and build/package output. `npm run check:docs` is the quick documentation-only check; it does not judge prose accuracy, external services or rendered appearance. `node scripts/check-dsh-compatibility.mjs <dsh-source-directory>` runs the same upstream contract check that CI reports as the required **Current DSH frontend contract** status ([.github/workflows/ci.yml](.github/workflows/ci.yml)); it reads a local DSH source checkout and needs no plugin installation.

`npm run check:attribution` is a separate, network-dependent check that compares every credited contributor handle with the actual author of the issue or pull request it cites, in the tracked Markdown. It caches the issue index under `local/`, needs the `gh` CLI or a `GITHUB_TOKEN`, and is a pre-release step rather than part of `verify`. `npm run check:attribution -- --self-test` proves the check still detects a wrong author, an unknown reference and a clause boundary without using the network. Run it after editing contributor credits in the changelog, the contributor table or a release note.

## Select behavior checks

Browser checks consume built client files. Run `npm run build` and `npx playwright install chromium --only-shell`, then choose the affected checks:

| Change | Check |
| --- | --- |
| Question cards | `npm run smoke:question-fixes` |
| Layout, drawers and panels | `npm run smoke:native-layout` |
| Mobile root geometry under broad skin rules | `npm run smoke:layout-ownership` |
| Opaque drawer, details panel and return bar under translucent skin tokens | `npm run smoke:opaque-chrome` |
| Fullscreen right panel owns the viewport instead of the docked track | `npm run smoke:rightbar-fullscreen` |
| Conversation scrollport and older viewport units | `node scripts/smoke-conversation-scroll.mjs` |
| History auto-load stability (Playwright Chromium required) | `npm run smoke:history-scroll` |
| Composer focus and keyboard | `npm run smoke:composer-keyboard` |
| Composer controls, typography and wrapping | `npm run smoke:composer-overflow` |
| Real InputBar with optional left/right/activity controls | `npm run smoke:composer-toolbar` |
| Push settings geometry/interaction (provider-free, contract Switch stand-in) | `npm run smoke:push-settings` |
| Dictation lifecycle and focus | `npm run smoke:voice-session` |
| Browser authentication Cookies | `npm run smoke:browser-auth-cookies` |
| Passive public question/approval/goal lifetimes for Web Push | `npm run smoke:push-contract` |
| Packed Declarative Web Push settings, protocol and tap navigation | `npm run smoke:web-push` |
| Real HTTP/mux recovery and retained document/draft | `npm run smoke:transport-recovery` |
| Real cross-client pending questions and explicit answer retry | `npm run smoke:transport-recovery -- --interactions` |
| API fallback on older WebViews | `npm run smoke:mobile-compat` |
| Async access-panel forms, layered diagnostic scope and localized report parity | `npm run smoke:control-state` |
| Module-selection recovery | `npm run smoke:module-recovery` |
| Module grouping/search, read/write recovery and a published optional skin | `npm run smoke:module-settings` |
| Gallery menu, locale labels, picker cancellation and stale/disposed results | `npm run smoke:gallery` |
| Image handoff into actual DSH draft state and decoded previews | `npm run smoke:attachments` |
| Limited same-session plain-text transfer between paired Origins | `npm run smoke:draft-transfer` |
| Local extension Worker execution and explicit recovery | `npm run smoke:extension-workers` |
| Real sidebar rows, short drawers and additive panel/footer/overlay slots | `npm run smoke:mobile-sidebar` |
| Paired customization, stock ownership and retained-page failure recovery | `npm run smoke:custom-assets` |
| Host restart, authentication renewal and visible customization failure | `npm run smoke:session-restart` |
| Upstream picker composition and dedicated Mobile folder selection | `npm run smoke:directory-picker` |
| Browse-capable host keeps DSH's own picker and its folder creation | `npm run smoke:directory-picker-browse` |
| Same-origin/Blob media and external-source CSP rejection | `npm run smoke:blob-media` |
| Body-portal plugin menu stays clickable under the drawer | `npm run smoke:plugin-portal-layers` |

These fixtures do not submit a model request or read the normal DSH home. Browser evidence does not establish physical Android keyboard, camera or device-lifecycle behavior.

Web Push's public-contract smoke requires explicit `DSH_BOOT_SMOKE_BIN`; its reviewed runtimes are listed in `scripts/smoke-mobile-push-contract.mjs`, with the same list in `scripts/smoke-mobile-push.mjs`. The CI matrix selects which versions run the public-contract or complete packed checks. The packed `smoke:web-push` additionally requires the exact `DSH_BOOT_SMOKE_MOBILE_TARBALL`; it uses a marked synthetic page-level PushManager and an owned child-only push-provider transport, not a live Apple subscription or receipt. Keep the normal DSH/profile untouched. General Mobile boot checks alone do not establish push coverage; real iPhone/iPad installation, permission, locked/closed delivery, private-origin/VPN reachability and warm-navigation effects remain separate acceptance. See the [Web Push guide](<docs/WEB_PUSH.en.md>) and [Chinese guide](<docs/WEB_PUSH.md>).

`smoke:blob-media` serves the current source security headers and generates a small valid silent VP8 WebM in an owned Chromium page. It requires actual decoding and playback for same-origin and Blob sources without user activation, while Gateway-owned pages still reject Blob media and external media/connect attempts never reach their targets. It does not run a community media plugin, bypass autoplay policy or establish physical WebView/codec support.

`smoke:history-scroll` uses the isolated packed DSH runtime described below through `DSH_BOOT_SMOKE_BIN`, preferring `DSH_BOOT_SMOKE_MOBILE_TARBALL` when supplied. A test-only Host plugin appends and flushes completed Turns through DSH's public Session services without invoking an Agent/model. A real single-contact drag must not start `/api/session/page` until the contacts end and the conversation scrollport settles; reversing out of the top zone cancels that loading intent. Holding and releasing the first response checks busy/enabled geometry and absence of chained loading across a second gesture; keyboard paging checks viewport preservation after prepend. Two Chromium CDP contacts away from the top threshold must not load history; Chromium treats that gesture as a pinch, so it is not evidence of two-finger scrolling. After 1600ms without input or scroll, scripted movement must not reuse the expired loading intent. Keyboard Enter loads the second page and a pointer click on the original button loads the third. Controlled default/24px button measurements check wrapping and visible manual access. This is real DSH pagination over generated test history, not an inserted imitation loader, Safari/iOS execution, physical multi-touch or screen-reader acceptance.

`smoke:layout-ownership` captures the built layout stylesheet and checks an owned display-contents/virtualized-view fixture under broad unlayered skin overrides. It observes visible, scrollable and clickable content, narrow/wide geometry and an unchanged stock-layout control. Its controlled collapse case removes only the ownership layer and requires a zero-height ledger before reporting success. This is CSS regression evidence, not full compatibility with any particular skin.

The same smoke checks panel touch-size overrides, complete root/nested opt-out, unchanged fine-pointer geometry, native switch/range sizes, real action clicks and content scrolling. It also executes the baseline guide's CSS against an owned labeled-checkbox/icon-action fixture; string-presence assertions alone do not establish hit testing or accessible names.

Transport recovery uses the same isolated packed DSH runtime described below and a loopback-only fault proxy. It requires healthy HTTP during an actual mux interruption, a new 101 handshake and fresh Workspace baseline, and an unchanged document/editor/draft. `--interactions` adds a test-only Host question through the real Loader, checks desktop/mobile delivery and reconnection, and rejects one answer request before an explicit retry. It does not simulate an approval audit or establish a reporter's Cloudflare deployment. `--negative-control-mux` deliberately leaves the mux unavailable and must fail with `Mux recovery negative control detected`; another setup error is not a passing negative control.

`npm run smoke:prompt-failure` uses the same explicit runtime and packed-tarball inputs. It rejects two real Send requests with HTTP 400 at the browser route, verifies restored text/images and a visible stock error, and requires zero forwarded prompts and no automatic retry. `--stock` omits Mobile entirely for a direct DSH control. Optional `--check-navigation` adds held sends followed by Session navigation and remains a strict failing diagnostic where upstream discards recovery state; it is not part of the passing default lane. No model request is allowed. Keep DSH code and artifacts unchanged, and distinguish a navigation cancellation from an HTTP 400 actually delivered to the page.

`--negative-control-import` makes the owned classic-script client fail at its top level before registering its module. The script must download successfully, fail during initial mobile boot, and be identified by its module and resource mapping; only completed cleanup permits the `Module evaluation negative control detected` marker. Both negative controls refuse their marker if diagnostic collection, evidence persistence or cleanup also fails. Startup failures retain bounded boot, response, request-failure and execution evidence under `local/mobile-boot-diagnostics/`. HTTP success alone does not prove that a module executed or registered.

## Test the packed plugin in DSH

Use an isolated DSH installation rather than replacing the plugin's development dependencies. This PowerShell example selects one version from the checked CI matrix; use the target DSH version when validating an upgrade:

```powershell
$dshMobileTestRuntime = Join-Path $env:TEMP ('dsh-mobile-test-runtime-' + [Guid]::NewGuid().ToString('N'))
npm install --prefix $dshMobileTestRuntime --no-save --package-lock=false @deepseek-ai/dsh@0.2.0-rc.2
$env:DSH_BOOT_SMOKE_BIN = Join-Path $dshMobileTestRuntime 'node_modules/@deepseek-ai/dsh/lib/bin.js'
npx playwright install chromium --only-shell
npm run smoke:dsh-boot
npm run smoke:dsh-composer
```

The smoke installs the actual npm tarball into an owned temporary profile before pairing. It does not substitute checkout files for bundled components. CI owns the complete version/platform matrix in [.github/workflows/ci.yml](.github/workflows/ci.yml).

`npm run smoke:dsh-boot -- --diagnostics` additionally reads the real authenticated desktop diagnostic API and requires explicit computer/configuration scope and unverified phone coverage. It does not assert public ingress, change system DNS or run phone acceptance.

The shared mobile-profile fixture imports package files with pnpm's `packageImportMethod: copy`. Independent profile directories otherwise can share a content-store hardlink: another import changes its `ctime` while preserving the client bytes, and DSH's metadata-based HMR can publish a different revision during boot. Copies isolate the installed file identities and metadata; this is a development-fixture setting, not a change to user profiles. `node scripts/probe-pnpm-client-metadata.mjs` requires explicit `DSH_BOOT_SMOKE_BIN` and `DSH_BOOT_SMOKE_MOBILE_TARBALL` files and compares `auto` with `copy` in an owned private store. It records dev/inode/link counts, source hashes and live registry revisions; resource reads use `cache: no-store` so a browser's immutable cache cannot establish a server response.

For installation changes, run `npm run smoke:plugin-installation` against the same isolated DSH runtime, with `pnpm` available on PATH as required by DSH's plugin manager. CI installs the pinned pnpm version explicitly. The smoke uses DSH's live plugin-manager API and real pnpm installation, verifies Host and Client discovery, and toggles the question-card component independently. Set `DSH_BOOT_SMOKE_NODE_LINKER=isolated` to cover pnpm's isolated layout, or `DSH_BOOT_SMOKE_PREVIOUS_MOBILE_TARBALL` to a verified older plugin tarball to test upgrading. The component is embedded in the main tarball and loaded relative to `cordis.patch.yml`; do not publish it separately or restore a nested `file:` dependency.

`npm run smoke:mobile-settings` checks the mounted DSH General settings, local typography and narrow-screen controls. Its native bridge is simulated; physical WebView zoom, keyboard and system-bar behavior require ADB evidence.

`npm run smoke:module-settings` uses the isolated DSH runtime above through `DSH_BOOT_SMOKE_BIN`; the plugin's own `npm ci` does not install the DSH CLI. Set `DSH_BOOT_SMOKE_MOBILE_TARBALL` to fix the candidate tarball instead of packing the checkout. The smoke checks the real module modal, failed-read/write recovery, device-only exclusions, retained drafts and a pinned published skin combination. This combination regression does not establish full visual skin compatibility.

`npm run smoke:attachments` uses that same isolated runtime and tarball. It reads DSH's public per-session draft state and requires decoded previews after actual native file-input, browser-camera and Gallery intake, with no prompt/model submission. Gallery additionally requires an image-only input without capture, cancellation and superseded-result isolation. `--negative-control-items` removes the transfer item list; `--expect-legacy-items-failure` checks an older affected bundle. Both negative lanes require missing item metadata, the actual consumer's iterator failure, unchanged attachment state and completed cleanup before the terminal receipt. Host object-directory counts are not attachment-selection evidence; this browser fixture does not operate the Android picker or camera.

`npm run smoke:draft-transfer` uses the same explicit runtime and packed-tarball inputs. It exercises the public composer state across two owned browser Origins: Unicode/multiline text, matching Session, target conflicts, source changes, IME refusal, conditional rollback and attachment rejection, with no prompt submission. This is limited plain-text protocol evidence, not physical Android network switching, native TLS or complete migration of hidden/in-flight editor state.

`smoke:mobile-sidebar` and `smoke:custom-assets` require explicit `DSH_BOOT_SMOKE_BIN` and `DSH_BOOT_SMOKE_MOBILE_TARBALL` paths. The sidebar fixture uses the real Workspace consumer and additive slots, tests stock/dedicated touch geometry, and verifies a clipped-list negative control with `--negative-control-drawer`. The customization fixture observes executed scripts, computed styles, retained document/editor/draft and event-stream recovery after an injected manifest 401. It distinguishes a paired stock page from an ordinary DSH preview. These are isolated Chromium checks, not arbitrary community-plugin, public reverse-proxy or physical Android acceptance.

`npm run smoke:directory-picker` uses the isolated runtime above through `DSH_BOOT_SMOKE_BIN`; set `DSH_BOOT_SMOKE_MOBILE_TARBALL` to select an exact packed candidate. The stock DSH browser must keep one upstream picker without a competing Mobile picker. On the paired dedicated page, the real Hero and Sidebar actions exercise folder navigation, editable absolute paths, relative-path rejection, cancel/Escape/mask dismissal, routed native-Back events, full-viewport hit testing and real Workspace/Session creation without a model request. Narrow and landscape viewports check localized controls; `DSH_DIRECTORY_PICKER_EVIDENCE_DIRECTORY` optionally saves screenshots of the owned fixture. Held responses check cancellation and stale-result isolation; an injected listing failure checks cancellation and reopening. Folder reads stay inside owned temporary directories. This is packed Chromium evidence, not a native Desktop OS-dialog or physical Android test, a real cross-drive/UNC deployment, or arbitrary third-party skin compatibility.

`npm run smoke:directory-picker-browse` uses the same isolated runtime and tarball, and launches DSH with a non-loopback `--trusted-host` so the host resolves its browse directory-picker on a local machine. The stock and dedicated pages must then report exactly `@deepseek-ai/dsh-client-ui-directory-picker-browse`, the plugin's own picker and its styles must be absent, and the upstream "New folder" flow must create a real folder on the host from the paired phone. The launched process reads an owned temporary home, so no folder is created in the real user profile. This is packed Chromium evidence of the composition, not a physical Android test.

`npm run smoke:mobile-sidebar -- --footer-only` checks the mounted desktop footer with a controlled neighboring public-slot entry: lone/shared/lone label restoration, adjacent amount containment, both action hit targets and the collapsed rail. It does not run a third-party balance plugin's account or Host code.

Compatibility changes also run `npm run smoke:dsh-boot -- --legacy-webview`. The `--negative-control-compat` variation must fail with its expected missing-API marker after the compatibility script is blocked; an installation or fixture failure is not a successful negative control.

`npm run smoke:upstream-auth` pins the reported community authentication package on DSH 0.2.0-rc.2 and checks its real navigation bounce versus non-navigation cookie exchange, followed by packed Mobile pairing, static resources and Workspace WebSocket reads. Provide the exact isolated runtime and tarball through the same environment variables. This is not arbitrary authentication-plugin compatibility. Old-API simulations in modern Chromium do not exercise old JavaScript parsers; inspect the actual upstream bundle for unsupported syntax and keep physical-device acceptance separate from startup-feedback tests.

`npm run smoke:boot-feedback` checks the built compatibility script under nonce-restricted CSP, three supported languages, portrait/landscape and enlarged text. It runs the current App readiness expression against genuine recovery actions, verifies no notice over mounted DSH or its loader, and retains the document when DSH appears late. Explicit reload and wait actions are exercised without real credentials. This modern Chromium check does not execute Android Activity callbacks or establish old-parser support.

The conversation scroll check uses the same isolated runtime and packed plugin. Its `--negative-control-viewport` variation removes the height fallback and must fail with `Viewport negative control detected`; it cannot substitute for testing the reporter's actual WebView.

The compatibility, viewport and missing-companion negative lanes emit a final `DSH_MOBILE_EXPECTED_FAILURE` receipt only after observing the deliberate fault and completing cleanup. CI validates that exact receipt with `scripts/negative-control.mjs`; a matching error message inside an AggregateError is insufficient. Cleanup failures remain test failures.

`npm run capture:screenshots -- --out <directory>` produces credential-masked pairing, conversation, drawer and settings PNGs. `--overwrite` permits replacing existing captures; generated files are not committed automatically.

## Android and optional components

Follow the [Android build instructions](apps/mobile/README.md#build) and keep both app manuals aligned. Preserve application identity, stable signing and stored pairings. Never uninstall or clear a user's app to bypass a signing mismatch. Ask before altering real device data; use a separate test package for destructive test flows.

Current Debug builds use `io.github.sayach.dshmobile.debug` and a `-debug` version suffix, with data separate from the official App and older unsuffixed Debug installs. Do not describe their pairings as migrated or remove the older app to install them. Release package identity and signing remain unchanged.

Review the internal [design reference](design-system/dsh-mobile/MASTER.md) for native screens and plugin-owned controls. DSH source and installed frontend artifacts stay read-only. Use documented extension points for plugin behavior; isolate and report an upstream defect rather than patching DSH code or bundles to make a Mobile check pass.

For macOS cloudflared changes, build and run `npm run smoke:cloudflared-component`. It verifies official archives and reinitialization in temporary state, then removes its owned files; it never executes downloaded Mach-O binaries. `-- --archive-dir <directory>` reuses independently verified official archives.

For Windows cpolar changes, build and run `npm run smoke:cpolar-component` on native Windows, optionally passing `-- --archive <fixed-official-zip>`. It verifies the pinned archive and executable, reads MSI tables/embedded CAB without installer actions, checks initialization and cleanup in an owned Unicode/space path, and never runs cpolar. Windows Node 24 CI owns this native smoke; source unit tests use controlled subprocess output. Opt-in `DSH_CPOLAR_TEST_MSI` and `DSH_CPOLAR_TEST_ZIP` run the real-data unit checks; without those fixtures they explicitly skip rather than establish native extraction evidence.

For cpolar profile configuration, run `npm run smoke:cpolar-config` with both `DSH_BOOT_SMOKE_BIN` and `DSH_BOOT_SMOKE_MOBILE_TARBALL` pointing to exact artifacts. It executes the bilingual guide's literal YAML through a private DSH profile, verifies that Mobile registers without starting a tunnel, and rejects a two-field `config` replacement for its missing required settings. DSH overrides replace the whole entry config, not individual keys. The [composition tests](tests/cpolar-plugin-options.test.ts) separately verify arguments reaching the real controller and controlled provider rejection; neither check establishes a paid account reservation or public-network reachability.

`tests/windows-msi-zip-native.test.ts` runs real .NET ZIP acceptance/rejection and cleanup on Windows without downloading components. Other platforms explicitly skip it. It verifies constructed ZIP metadata before exercising the reader; mocked subprocess tests alone do not establish ZIP payload rejection.

The optional Caddy workflow keeps one pinned Windows/Linux x64 double-build/native-test matrix and one generic publisher. PR/ordinary dispatch runs are read-only; both publication inputs default false and simultaneous opt-ins fail early. The fork-only review path remains a labelled TEST prerelease. The official path is restricted to public `saya-ch/dsh-mobile` and the existing exact non-v tag `caddy-component-2.11.7-tencentcloud-0.4.3-r1`; it publishes a non-prerelease, non-latest **component distribution**, never npm/plugin/APK or enabled installation. Existing tags are immutable; this publication-preparation correction uses the new fixed `-r1` tag rather than moving the original tag.

Official publication uses a single maintainer's explicit manual dispatch after candidate review. No second-person approval or GitHub Environment is required. Both inputs remain false by default; the exact version-bound non-v tag, public repository, successful same-run native builds, tag-SHA binding and main ancestry are checked before publication. Contributor real-world tests may be accepted within their documented scope; new candidate CI and artifact verification remain separate evidence. Never imply that an isolated CA fixture or a contributor's older build establishes public DNS-01/renewal of the new component.

The publisher refuses occupied releases, compares every draft asset, publishes with `--latest=false`, then independently checks every public asset's metadata/bytes through the installer HTTPS redirect validator and ensures the component is not latest. Failure after publication leaves the release public and emits no candidate; no rollback/delete retry. Both review and official candidates keep `productionCatalogEnabled: false`. A **separate reviewed catalog PR** then hardcodes the actual public source/size/hash pins in `CADDY_COMPONENT_RELEASES`; plugin 0.6.9 enables the Windows/Linux x64 catalog. Future component updates repeat these two stages, and remote JSON never writes runtime trust. Support is Windows/Linux x64 and Tencent Cloud DNS only. Human live evidence is not final-candidate CI or certificate-renewal verification. See [managed Caddy](docs/CADDY_MANAGED.en.md#maintainer-build-and-validation) and its matching Chinese guide.

The Caddy publisher shell test needs Bash on POSIX and Git for Windows on Windows. Windows resolves Bash from the Git installation selected by `git --exec-path`, including custom installation directories; it does not select WSL's `bash` from PATH or load inherited Bash startup hooks. Shell startup failures, timeouts and signals fail the test instead of counting as expected publication rejections.

## Prepare and publish a release

Release preparation is not publication. Keep the candidate marked unreleased and retain working stable APK links until publication is authorized.

1. Align the npm package and lockfile versions; use `npm run check:version`. Keep Android `versionName` and `versionCode` unchanged for plugin-only changes. The checker validates Android separately against the published App descriptor in [apps/mobile/release.json](apps/mobile/release.json).
2. Review release notes, app manuals, compatibility statements, contributors, third-party notices and package contents. Preserve original author commits when incorporating community PRs. Run `npm run check:attribution` before finalizing contributor credits.
3. After publication is authorized, finalize the CHANGELOG date and plugin stable version in both root READMEs before the final validation. Keep APK links and App manuals on the published App version. `check:release-tag` validates these independently and refuses unfinished plugin release documentation.
4. Pass relevant local checks and every applicable CI job for that final candidate, including its release-documentation changes, not only checks required by branch protection. Later changes require the checks relevant to their diff; do not use an earlier commit's green checks as the final candidate's evidence. Record device/network coverage without treating local probes as public-route evidence. When the release ships bundled host artifacts, run `npm run build:funnel-host` and `npm run build:iroh-host`, then confirm `npm run check:funnel-licenses:full`; the release workflow rebuilds the Funnel host and re-checks its full license set before `verify`, and `scripts/funnel-third-party-licenses.mjs` reports the missing build when the executable is absent.
5. Merge the tested candidate, tag that commit with `v<plugin-version>` and let [.github/workflows/release.yml](.github/workflows/release.yml) build and publish the plugin. Verify npm/GitHub package equality and checksums afterward. Link the current App download in the plugin release notes; an unchanged App does not get a new APK.

If npm already contains the tagged version after partial publication, the workflow compares its public `dist.integrity` with the candidate tarball before continuing GitHub publication. Matching bytes permit completion; a mismatch or registry error stops the workflow. Keep the already published package intact and reconcile the completed stages before retrying.

For native changes, increase Android `versionName` and `versionCode`, document the App changes, complete Android validation and use an `android-v<app-version>` tag. [The Android workflow](.github/workflows/android-release.yml) builds and publishes two signed APKs independently, without publishing npm or replacing GitHub's latest plugin release. `dsh-mobile-android-v<app-version>.apk` is the compatibility build without JNI libraries and remains the legacy update target; `dsh-mobile-android-v<app-version>-iroh.apk` is the full arm64-v8a/x86_64 build. Both retain the application identity and established signer. Preserve the full APK before rebuilding compatibility, then verify both signatures, sizes and checksums and reject leftover native libraries in compatibility. Run `npm run check:android-release-tag` with `GITHUB_REF_NAME=android-v<app-version>` before pushing the tag; [.github/workflows/android-release.yml](.github/workflows/android-release.yml) runs the same gate as its first step and stops before building when it fails.

After verifying the published APK's checksum, identity, versionCode and established signer, copy the generated `dsh-mobile-android-release.json` into `apps/mobile/release.json` in a reviewed commit and update the App manuals and root APK links. This descriptor names an already published APK; do not advance it for an unpublished candidate. Its legacy `v<app-version>` tags remain valid, so existing downloads do not move. The plugin checks the public descriptor and falls back to its bundled copy when that lookup is unavailable.

Stable Android releases require `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; npm publication requires `NPM_TOKEN`. Never copy their values into the repository. The Android workflow uses a temporary runner and validates the established single signer. Missing signing configuration fails the Android release; plugin-only publication does not require Android signing credentials.

## Reports and community conduct

Describe versions, connection type and reproducible steps in ordinary issues. Redact tokens, Cookies, QR pairing values and private paths. Use [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability) for suspected security flaws.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful and thank reports and code contributions without claiming unverified fixes or tests.
