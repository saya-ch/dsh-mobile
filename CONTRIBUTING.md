# Contributing

Keep pull requests focused on observable behavior. Explain the change, cover new failure/rejection paths, and update the relevant English and Chinese guides together. Preserve contributor history and keep real credentials out of fixtures.

Agent-assisted maintainers should start with [AGENTS.md](AGENTS.md) and the [DSH Mobile maintenance skill](.agent/skills/dsh-mobile-maintenance/SKILL.md). Its references cover compatibility/packaging, runtime/ADB and collaboration/releases; load only the route needed for the task. Update demonstrated reusable guidance alongside the owning change, without turning transient release state into permanent instructions.

## Local setup and baseline

Use the Node engine range in [package.json](package.json). From this repository:

```sh
npm ci
npm run verify
```

`verify` checks version alignment, documentation links/structure, bundled licenses, mobile assets, TypeScript, tests and build/package output. `npm run check:docs` is the quick documentation-only check; it does not judge prose accuracy, external services or rendered appearance.

## Select behavior checks

Browser checks consume built client files. Run `npm run build` and `npx playwright install chromium --only-shell`, then choose the affected checks:

| Change | Check |
| --- | --- |
| Question cards | `npm run smoke:question-fixes` |
| Layout, drawers and panels | `npm run smoke:native-layout` |
| Conversation scrollport and older viewport units | `node scripts/smoke-conversation-scroll.mjs` |
| Composer focus and keyboard | `npm run smoke:composer-keyboard` |
| Composer controls, typography and wrapping | `npm run smoke:composer-overflow` |
| Real InputBar with optional left/right/activity controls | `npm run smoke:composer-toolbar` |
| Dictation lifecycle and focus | `npm run smoke:voice-session` |
| Browser authentication Cookies | `npm run smoke:browser-auth-cookies` |
| API fallback on older WebViews | `npm run smoke:mobile-compat` |
| Async access-panel forms | `npm run smoke:control-state` |
| Module-selection recovery | `npm run smoke:module-recovery` |
| Local extension Worker execution and explicit recovery | `npm run smoke:extension-workers` |

These fixtures do not submit a model request or read the normal DSH home. Browser evidence does not establish physical Android keyboard, camera or device-lifecycle behavior.

## Test the packed plugin in DSH

Use an isolated DSH installation rather than replacing the plugin's development dependencies. This PowerShell example uses the current checked version:

```powershell
$dshMobileTestRuntime = Join-Path $env:TEMP ('dsh-mobile-test-runtime-' + [Guid]::NewGuid().ToString('N'))
npm install --prefix $dshMobileTestRuntime --no-save --package-lock=false @deepseek-ai/dsh@0.2.0-rc.2
$env:DSH_BOOT_SMOKE_BIN = Join-Path $dshMobileTestRuntime 'node_modules/@deepseek-ai/dsh/lib/bin.js'
npx playwright install chromium --only-shell
npm run smoke:dsh-boot
npm run smoke:dsh-composer
```

The smoke installs the actual npm tarball into an owned temporary profile before pairing. It does not substitute checkout files for bundled components. CI owns the complete version/platform matrix in [.github/workflows/ci.yml](.github/workflows/ci.yml).

For installation changes, run `npm run smoke:plugin-installation` against the same isolated DSH runtime. It uses DSH's live plugin-manager API and real pnpm installation, verifies Host and Client discovery, and toggles the question-card component independently. Set `DSH_BOOT_SMOKE_NODE_LINKER=isolated` to cover pnpm's isolated layout, or `DSH_BOOT_SMOKE_PREVIOUS_MOBILE_TARBALL` to a verified older plugin tarball to test upgrading. The component is embedded in the main tarball and loaded relative to `cordis.patch.yml`; do not publish it separately or restore a nested `file:` dependency.

`npm run smoke:mobile-settings` checks the mounted DSH General settings, local typography and narrow-screen controls. Its native bridge is simulated; physical WebView zoom, keyboard and system-bar behavior require ADB evidence.

Compatibility changes also run `npm run smoke:dsh-boot -- --legacy-webview`. The `--negative-control-compat` variation must fail with its expected missing-API marker after the compatibility script is blocked; an installation or fixture failure is not a successful negative control.

The conversation scroll check uses the same isolated runtime and packed plugin. Its `--negative-control-viewport` variation removes the height fallback and must fail with `Viewport negative control detected`; it cannot substitute for testing the reporter's actual WebView.

`npm run capture:screenshots -- --out <directory>` produces credential-masked pairing, conversation, drawer and settings PNGs. `--overwrite` permits replacing existing captures; generated files are not committed automatically.

## Android and optional components

Follow the [Android build instructions](apps/mobile/README.md#build) and keep both app manuals aligned. Preserve application identity, stable signing and stored pairings. Never uninstall or clear a user's app to bypass a signing mismatch. Ask before altering real device data; use a separate test package for destructive test flows.

Review the internal [design reference](design-system/dsh-mobile/MASTER.md) for native screens and plugin-owned controls. Do not change DSH source to implement plugin features without a separately authorized upstream change.

For macOS cloudflared changes, build and run `npm run smoke:cloudflared-component`. It verifies official archives and reinitialization in temporary state, then removes its owned files; it never executes downloaded Mach-O binaries. `-- --archive-dir <directory>` reuses independently verified official archives.

The optional Caddy workflow keeps one pinned Windows/Linux x64 double-build/native-test matrix and one generic publisher. PR/ordinary dispatch runs are read-only; both publication inputs default false and simultaneous opt-ins fail early. The fork-only review path remains a labelled TEST prerelease. The official path is restricted to public `saya-ch/dsh-mobile` and the existing exact non-v tag `caddy-component-2.11.6-tencentcloud-0.4.3`; it publishes a non-prerelease, non-latest **component distribution**, never npm/plugin/APK or enabled installation.

This is two-stage preparation only. First maintainers must review this workflow PR on protected, reviewed `main`, configure the `caddy-component-release` environment with nonempty required reviewers and prevention of self-review, prohibit admin approval bypass, authorize publication, and dispatch the stable tag. The actual environment policy is fetched before any release mutation; environment naming is not authorization. The contents-write-only token relies on GitHub's documented public-resource exception for environment reads; authenticated 403/other API failures are fatal with no fallback, scope escalation or extra secret. Tag SHA must equal the same-run build SHA and main comparison must establish ancestry (not code review). Actual Actions approval and live authenticated endpoint capability are not proven by synthetic tests.

The publisher refuses occupied releases, compares every draft asset, publishes with `--latest=false`, then independently checks every public asset's metadata/bytes through the installer HTTPS redirect validator and ensures the component is not latest. Failure after publication leaves the release public and emits no candidate; no rollback/delete retry. Both review and official candidates keep `productionCatalogEnabled: false`. Later, independently verified official assets require a **separate reviewed catalog PR** with hardcoded source/size/hash pins before installation can be enabled; `CADDY_COMPONENT_RELEASES` remains exactly `Object.freeze({})` in this preparation. Remote JSON never writes runtime trust. Support is Windows/Linux x64 and Tencent Cloud DNS only; replacing a private preview with an empty-catalog official plugin does not promise managed restart. Human live evidence is not final-candidate CI or certificate-renewal verification. See [managed Caddy](docs/CADDY_MANAGED.en.md#maintainer-build-and-validation) and its matching Chinese guide.

The Caddy publisher shell test needs Bash on POSIX and Git for Windows on Windows. Windows resolves Bash from the Git installation selected by `git --exec-path`, including custom installation directories; it does not select WSL's `bash` from PATH or load inherited Bash startup hooks. Shell startup failures, timeouts and signals fail the test instead of counting as expected publication rejections.

## Prepare and publish a release

Release preparation is not publication. Keep the candidate marked unreleased and retain working stable APK links until publication is authorized.

1. Align the npm package and lockfile versions; use `npm run check:version`. Keep Android `versionName` and `versionCode` unchanged for plugin-only changes. The checker validates Android separately against the published App descriptor in [apps/mobile/release.json](apps/mobile/release.json).
2. Review release notes, app manuals, compatibility statements, contributors, third-party notices and package contents. Preserve original author commits when incorporating community PRs.
3. After publication is authorized, finalize the CHANGELOG date and plugin stable version in both root READMEs before the final validation. Keep APK links and App manuals on the published App version. `check:release-tag` validates these independently and refuses unfinished plugin release documentation.
4. Pass relevant local checks and every applicable CI job for that final candidate, including its release-documentation changes, not only checks required by branch protection. Later changes require the checks relevant to their diff; do not use an earlier commit's green checks as the final candidate's evidence. Record device/network coverage without treating local probes as public-route evidence.
5. Merge the tested candidate, tag that commit with `v<plugin-version>` and let [.github/workflows/release.yml](.github/workflows/release.yml) build and publish the plugin. Verify npm/GitHub package equality and checksums afterward. Link the current App download in the plugin release notes; an unchanged App does not get a new APK.

For native changes, increase Android `versionName` and `versionCode`, document the App changes, complete Android validation and use an `android-v<app-version>` tag. [The Android workflow](.github/workflows/android-release.yml) builds and publishes the signed APK independently, without publishing npm or replacing GitHub's latest plugin release. The APK name remains `dsh-mobile-android-v<app-version>.apk`.

After verifying the published APK's checksum, identity, versionCode and established signer, copy the generated `dsh-mobile-android-release.json` into `apps/mobile/release.json` in a reviewed commit and update the App manuals and root APK links. This descriptor names an already published APK; do not advance it for an unpublished candidate. Its legacy `v<app-version>` tags remain valid, so existing downloads do not move. The plugin checks the public descriptor and falls back to its bundled copy when that lookup is unavailable.

Stable Android releases require `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; npm publication requires `NPM_TOKEN`. Never copy their values into the repository. The Android workflow uses a temporary runner and validates the established single signer. Missing signing configuration fails the Android release; plugin-only publication does not require Android signing credentials.

## Reports and community conduct

Describe versions, connection type and reproducible steps in ordinary issues. Redact tokens, Cookies, QR pairing values and private paths. Use [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability) for suspected security flaws.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful and thank reports and code contributions without claiming unverified fixes or tests.
