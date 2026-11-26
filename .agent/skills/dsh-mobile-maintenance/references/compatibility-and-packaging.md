# Compatibility and packaging

## Identify the loaded implementation

Locate the profile that belongs to the failing application. Official Desktop, community Desktop and DSH Web can have different binaries, profiles and running listeners. Inspect effective patches and installed package resolution rather than assuming the source checkout or most recent build is active. Never free a port by killing every Node process; identify its owning command and use normal shutdown for a user's active DSH.

Typical evidence chains:

| Observation | What to inspect |
| --- | --- |
| A new feature is missing | Runtime plugin version/path, effective bundle entries, served client bytes, frontend module selection and App capability |
| Webpage opens but models/workspaces/logs fail | Host service composition, actual API/WS requests, current upstream consumers and plugin gateway forwarding |
| `directoryPicker` or `mobileAccess` already registered | Duplicate providers and their scopes; reuse/select the existing seam instead of silently forcing a replacement |
| Package installation succeeds but runtime activation fails | Live plugin-manager operation stage/result, loader diagnostics and persisted profile, not only the package-manager exit code; do not assume completed installation was rolled back |
| Component imports from source but not the package | Actual tarball contents, installed Host entry, client package discovery and independently switchable component identity |

Read `src/plugin.ts`, `cordis.patch.yml`, `src/gateway.ts`, `src/client.ts` and the owning tests as appropriate; follow their imports rather than loading the entire tree.

DSH profile overrides replace an entry's whole `config`, not individual keys. Configuration examples must preserve required paths and access settings, and users with custom settings must retain their complete current config. The [cpolar guide smoke](../../../../scripts/smoke-cpolar-config.mjs) executes the shipped bilingual YAML through the real Loader and rejects an incomplete replacement for its missing required field; a parser-only or deep-merge fixture cannot establish this behavior.

Identify the missing feature's owner before deciding that the App needs updating. Ordinary web UI, a separately switchable client component and a new native capability have different loading requirements. The gateway's `/mobile-access/metadata` helps identify the running plugin; `/mobile-access/discovery` helps identify the computer instance and Origin. Compare the relevant fields with listener/profile ownership, without dumping complete pairing payloads. Neither route proves the target client code loaded.

For failed plugin imports, capture the actual entry/batch mapping, the first failed script's HTTP status and content type, and execution or module-registration errors. HTTP 200 does not establish that a script executed or registered; many dependent failures can repeat one underlying resource failure. Use the [boot diagnostics helper](../../../../scripts/mobile-boot-diagnostics.mjs) and [existing behavior-check guidance](../../../../CONTRIBUTING.md#select-behavior-checks) for redacted evidence and negative-control acceptance, including evidence and cleanup failures.

## Adapt to upstream behavior

Inspect the official release/channel and the exact source or published packages corresponding to it. An npm `latest`, an alpha tag and a source branch may name different releases. Do not upgrade a dirty user checkout with an unconditional pull or replace a running Desktop profile as a diagnostic shortcut.

When an existing installation passes but a fresh install or CI fails at the same DSH version, compare the resolved Cordis, Loader, include and application-boot packages. Semver ranges can admit a changed dependency while the application version stays fixed. Reproduce the affected public operation in an isolated official DSH profile without Mobile and retain an older dependency graph as a separate control. A confirmed upstream failure is not permission to patch installed bundles or global hooks, silently pin older dependencies, or skip the failing compatibility lane. The [packed settings smoke](../../../../scripts/smoke-mobile-settings.mjs) records settings RPC failures separately from HTTP status; a successful HTTP response does not establish that the settings write succeeded.

Use `scripts/check-dsh-compatibility.mjs` as a source-contract check, then exercise the affected published paths with an isolated supported DSH launch. A new version number alone is neither proof of incompatibility nor permission to weaken dependency checks. Conversely, broad peer ranges do not prove that moved services, frontend slots, API methods or settings consumers still work.

A healthy gateway and a successful pairing do not prove the dedicated layout survives. DSH 0.2.3 moved the launch URL to the public `webserver/entry-url` event and request identity to the Peer WebServer admits, so a plugin reading the removed `connection.authenticatedUrl` answers `502 upstream_unavailable` on the paired document while health stays 200 ([plugin](../../../../src/plugin.ts), [tests](../../../../tests/plugin.test.ts)). The same release replaced `GET /plugins/events` with the authenticated Remote stream `pluginEvents/follow`, whose opening baseline carries the raw Host graph: a gateway that adapts only the old route mounts the dedicated page and then loses its layout, with pairing and Workspace traffic still healthy. On a packed host, wait for that baseline before asserting the dedicated shell and a later live change ([`observePluginEvents`](../../../../scripts/mobile-boot-fixture.mjs), `smoke:dsh-boot -- --live-graph`); a missing drawer toggle after mount is a graph-transport symptom, not a sidebar selector change. The [document graph refresh](../../../../src/gateway.ts), the [Mobile follower](../../../../packages/mobile-graph-follower/src/client.ts) and [their tests](../../../../tests/gateway-event-stream.test.ts) own the adaptation.

Directory picking has separate Host and Client owners. Keep DSH's selected Host backend and desktop flow intact; a remote page cannot operate a chooser on the host display. The [dedicated Mobile flow](../../../../src/mobile-directory-picker.ts) uses the public workspace slots and an authenticated folder-listing route without composing a second `directoryPicker` service. Check the [real patch/Loader regressions](../../../../tests/desktop-picker.test.ts) and `smoke:directory-picker` before replacing this separation with platform-marker guards or disabling the upstream default. Verify both workspace entry points, independent cancellation, editable absolute paths and body-level modal ownership, not only the presence of a registration.

Inspect the actual frontend package for DOM ownership, slots, keyboard/menu behavior, theme tokens and settings writes. Client slots can be absent in a new or old release; do not remove a working fallback before verifying the replacement exists. Trace preferences to the renderer: Markdown and code fonts can be CSS-driven while xterm reads a ThemeRuntime snapshot. A control that changes only storage is not a completed adaptation.

A settings launcher may replace a direct button with an account menu while retaining the same sidebar seat and settings panel. Check the mounted launcher and its actual menu action before treating a missing old selector as a product failure. Browser fixtures must follow the supported navigation and dismiss only recognized onboarding actions; never skip arbitrary authentication or approval dialogs. Host-backed native settings and Mobile's Origin-local typography are separate owners: verify both instead of assuming a removed memory-only settings branch changes the plugin preference's scope.

The settings dialog may also move from a navigation/content pair to four direct grid seats. Identify the mounted settings owner and its structure before applying legacy column overrides. Keep the upstream grid and responsive navigation when present; sharing a close-button target does not require importing the old container, form or navigation rules. The [surface marker](../../../../src/native-mobile.ts) and [mounted settings smoke](../../../../scripts/smoke-mobile-settings.mjs) check both structures, close hit testing and non-overlapping navigation/content placement.

A newer stock shell can retain a hidden, inert desktop sidebar while a public opener controls a separate modal drawer. Nonzero row geometry does not establish visibility or ownership. Let that shell keep its layout, focus and scrim instead of forcing the desktop column visible; retain the dedicated Mobile layout and older stock fallback separately. The [surface adaptation](../../../../src/native-mobile.ts) and [sidebar smoke](../../../../scripts/smoke-mobile-sidebar.mjs) check the actual opener, modal Session selection, Escape and the hidden desktop column without forced clicks.

For skin conflicts, inspect the attached images as well as the installed package bytes: a missing background, unreadable drawer, shadowed header and blank trace are separate observations. A fix in the skin repository does not establish that the same-version npm package includes it. Reproduce the reported artifact before widening compatibility claims; [skin guidance](../../../../docs/SKIN_COMPATIBILITY.en.md) distinguishes existing semantic markers and per-device module selection from recreating a skin's private layout.

Keep implementation changes within the plugin; the read-only rule for DSH source and installed artifacts is owned by the [cross-layer decisions](../SKILL.md#cross-layer-decisions). Prefer an existing optional capability or version-independent feature detection to a brittle version allowlist. When the documented DSH seam cannot provide the requested behavior, explain the limitation and retain an isolated upstream reproduction rather than patching private implementation or bundles.

### Bundled binaries and the package they live in

A native helper shipped inside the main tarball costs every user the size of every
platform: three Funnel helpers made the plugin 74.6 MB unpacked, and adding macOS
would have taken it past 110 MB. They are now one optional package per target
(`dsh-mobile-funnel-<platform>-<arch>`) listed in `optionalDependencies`, so npm reads
`os`/`cpu` and installs only the one this machine runs. Two consequences matter when
touching this:

- The main package must never name a platform package that is not published yet, so
  the release publishes all of them before `dsh-mobile` itself; [check-mobile-release.mjs](../../../../scripts/check-mobile-release.mjs) asserts that
  `optionalDependencies`, each package's `name`/`version`/`os`/`cpu`/`files`, and the
  binary's executable header all agree, and refuses binaries left in the main tarball.
- A binary unpacked from a Windows working tree keeps mode 644, which Linux and macOS
  cannot execute; the POSIX files are committed `100755` and `funnel.ts` restores the
  bit before spawning, because a package published without it fails only on the
  platforms whose users cannot easily rebuild it.

Verify a cross-built executable by its header, not by its name: the Funnel build
rejects a Mach-O whose CPU type is the other architecture, since a swapped pair would
otherwise publish a package that cannot run on the machine it names. `bin/` is a
development fallback kept for a checkout that builds there; it is no longer published.

## Client props and the host's React version

Plugin client code renders into DSH's React tree, and `react` is an optional peer dependency: the installed major belongs to the host, not to this repository. A prop whose DOM effect differs between React 18 and 19 must be written in the form both accept.

`inert` is the concrete case. React 18 does not know the property, so a boolean value is dropped as a non-boolean attribute and the panel stays interactive; React 19 knows it as a boolean attribute and treats an empty string as false. Only the non-empty string (`inert: 'true'`) sets the attribute under both, which is why the layout passes it as a literal ([mobile-layout](../../../../src/mobile-layout.ts)). Values that only mean "on" can otherwise ride on the `data-*`/`aria-*` prefixes: React's DOM branch stringifies their booleans to `"true"` and removes a boolean value from every other attribute, so a boolean `data-*`/`aria-*` prop is safe while a boolean custom attribute is not.

Acceptance: the mounted DOM carries `inert="true"`, and the prop's source form is a string literal. A DOM assertion under the installed major alone cannot catch the React 18 drop, because React 19 renders a boolean `true` as `"true"` as well; review the source form, and read the installed `react-dom` property branch before relying on this for a third major.

### Scoped optional services

If a service works in a root mock or sibling plugin but fails inside Mobile, check the actual scoped Context before declaring the runtime unsupported. A direct `ctx.service` getter can throw `cannot get property "service" without inject`; optional chaining still invokes that getter. Static plugin-export and Loader-entry `inject` declarations are required dependencies, not optional capability flags: adding a newer service there can prevent ordinary Mobile from starting when it is absent.

Use public `ctx.get(name)` for an instantaneous, exact-name, isolation-scoped lookup of an active provider; it does not wait for readiness. If an optional feature must follow provider activation, removal or replacement, use a public `ctx.inject(dependencies, callback)` child lifecycle while keeping the base plugin operational. Initialize and dispose feature resources within that lifecycle, and keep long-lived consumers from capturing an initial absent service. The child awaits its async callback; its `.await()` settles current lifecycle work and can resolve while dependencies are still missing, so resolution alone does not prove feature activation. Parent teardown owns the child. Provider loss does not cancel an arbitrary pending initialization promise: invalidate that attempt, let supported cancellation or completion settle it, then drain cleanup before a replacement opens the same single-writer state.

The [plugin composition](../../../../src/plugin.ts) and [scoped lifecycle tests](../../../../tests/plugin.test.ts) own this boundary. Verify real scoped sibling providers, genuine absence, late activation, provider loss/replacement and disposal during initialization; root-provided mocks or dependency-array assertions alone cannot establish compatibility. Follow with the affected packed consumer, not just a successful base-plugin boot.

### Passive request observers and persisted-source checks

When a public request is known to dispatch but an observer never enters, distinguish listener ordering from a missing API. Compare an observer installed before Agent setup with a pass-through probe prepended after setup; a later setup answerer can preempt an earlier prepend. If that is the cause, keep one plugin-owned global observer pair (`user-questions/request` and `approval/request`) and refresh its prepend position after every public `agent/created`, including runtime children, rather than accumulating per-Agent handlers. Delegate `next()` exactly once and preserve its return, throw and cancellation; claiming a wait is not passive observation. The [push adapter](../../../../src/mobile-push/host.ts), [lifetime tests](../../../../tests/mobile-push-host.test.ts) and [real public-contract smoke](../../../../scripts/smoke-mobile-push-contract.mjs) own the ordering and teardown evidence. A unit event bus with only an initial prepend does not reproduce later setup answerers; required observer-registration failure must fail the optional feature closed rather than silently drop a category.

When checking an already-persisted notification source after restart, verify its original identity/freshness through public live state or a disposable public Session observation; do not create an Agent or turn historical replay into new alerts. If standard projections cannot prove a terminal reason, a plugin-owned public projection can retain strict, bounded, text-free lifecycle metadata, with required registration and observation disposal. The [reconciler](../../../../src/mobile-push/reconcile.ts) and [cold/live tests](../../../../tests/mobile-push-reconcile.test.ts) own these boundaries. Keep request answerability distinct from outcome freshness: a timed question publicly `open`/`continued` can survive a later turn or unrelated inbox activity, while a matching full-callId queued answer in either inbox lane suppresses it; newer work can still invalidate an obsolete completion/failure. Test that distinction with both live and cold projections, not an always-eligible restart stub.

## Source, package and live installation are separate

`npm ci` workspace links can hide a distribution defect. Test `npm pack` output installed into an owned profile, and verify the actual Host and Client selected by DSH. Preserve the question-card component's identity and independent off/on behavior; disabling it must dispose listeners/styles rather than leave hidden state behind.

Node can resolve an installed npm dependency that the browser's DSH module loader cannot supply. Bundle browser-used runtime libraries explicitly, keep DSH-supplied peers external, and inspect the final imports. [The client bundle gate](../../../../scripts/check-client-bundle.mjs) rejects unbundled runtime imports; a source unit test alone cannot validate module registration in the packed browser.

The embedded `packages/question-fixes` component is private and belongs to the main plugin artifact. The relative file entry in `cordis.patch.yml` is anchored by DSH to the installed bundle directory. Keep the component manifest, Host, Client and license inside the tarball. Do not restore a private `file:` dependency plus nested `bundledDependencies` that depends on pnpm's linker layout, or assume a public package subpath is discoverable as a DSH client module.

Use `scripts/packed-profile.mjs`, `scripts/check-packed-profile.mjs`, `scripts/check-companion-package.mjs` and `scripts/smoke-plugin-installation.mjs`. The live smoke covers the plugin-manager operation, persisted bundle, DSH-selected Host/Client and component toggle. An upgrade can legitimately return `restart-required`; restart only the owned fixture before completing acceptance. Keep a fresh-install failure distinct from that upgrade result.

For installation/upgrade fixes, cover hoisted and isolated pnpm, a fresh install and an existing published installation. Old nested files may remain after an upgrade; verify the new artifact is selected rather than deleting user installation directories. For a market-install report, test a registry package spec as well as a local tarball; the loopback registry fixture supplies the same real artifact without publishing it.

When converting an existing `link:` dependency to an archive, a successful `pnpm add` can update the manifest specifier while retaining the old link resolution. Inspect the lockfile resolution, selected filesystem target and installed manifest together; a targeted `pnpm update` can re-resolve the requested archive without changing unrelated dependencies. A package-manager store-format mismatch is a separate installation failure: preserve recoverable dependencies and align the profile's toolchain rather than changing the global store, clearing user data or granting an incompatibility exemption.

## Native components ship from their own repositories

The iroh host binary is not built from this repository. `native/iroh-host` and `native/iroh-core` here are a copy; the published `dsh-mobile-iroh` package is built from the separate `saya-ch/dsh-mobile-iroh` repository, whose `host/` and `tether-core/` sources are the ones compiled into the binaries the plugin downloads. An edit to `native/iroh-host` therefore changes nothing a user receives until it is also carried into that repository and a new component version is published and re-pinned.

This matters most for release notes. `CHANGELOG.md` for 0.8.15 credited `phone-sim` with reporting the rendezvous path discovery knew, but that change (`bf281bb`) only ever reached this repository's copy; the released alpha.1 and alpha.2 binaries still print the older message. Downloading the pinned artifact and searching it for the new string is what settled it. Before crediting a `native/iroh-host` change as shipped, confirm it is in the bytes the pin names — the pin is verified by size and SHA-256, so a component built from different source is otherwise undetectable.

The Funnel helper does not have this problem: `native/funnel-host` is the source `scripts/build-funnel-host.mjs` compiles into `packages/funnel-*`, and CI rebuilds it to prove the committed binaries reproduce. The distinction is which repository the published artifact is built from, not whether a component is vendored.

When a component changes, reconcile the two copies deliberately: decide which side owns the change, land it there, publish a component version, re-pin, and only then describe the behaviour as released. `scripts/check-iroh-component-pins.mjs` proves the pins match the published bytes but cannot tell which source produced them.

## Make a change take effect without restarting DSH

The base bundle enables HMR whenever the launcher supplies a profile context, so a stock Desktop profile already has it: `- id: hmr` with `disabled: !!js "!ctx.get('profileContext')"` and `config: { root: [] }`. `root: []` only turns off *source-directory* watching; it does not turn HMR off.

Editing anything in the profile's `cordis.patch.yml` — even appending a comment line — triggers a recomposition. The proof that the plugin reloaded is `logging initialized file=…` in `<state>/logs/dsh-mobile.log`, which is written from the plugin's `apply`. That is the cheapest way to make an installed-file change take effect during development; a real restart is not required.

The reload replaces plugins whose loaded files below the profile directory changed on disk, covering installed packages under `node_modules` and the targets of linked packages, **without** `root` watching. Two boundaries matter:

- A change confined to a `package.json` is not detected, and manifest notifications below `node_modules` are ignored. Altering `exports` or `files` needs the recomposition to be driven by something else, and a genuinely stuck case needs the process restarted.
- Changes that land in host modules — anything the process entry point imports statically, such as `dsh-app-boot`, the Loader or Cordis from a dsh checkout — stay pending, and Plugin Manager reports `restart-required` until the process restarts.

Configuring `root: ["."]` adds source watching but is not needed for the installed-package case, and a failed replacement stops the previous plugin rather than leaving it running, so a broken build is visible immediately instead of being masked.

## Nested components need a package specifier to show display metadata

The embedded components are inserted by file path and the plugin manager rendered their row titles as `file:///…/index.mjs`. The cause is the first line of `readPluginMeta` in `@deepseek-ai/dsh-app-boot`: `barePackageName(specifier)` returns `undefined` for any specifier beginning with `.`, `/`, `\`, `#` or containing `:`, and the function returns immediately — a file path can never carry package metadata, so the title falls back to the module specifier (`rowText` in `@deepseek-ai/dsh-client-ui-plugin-manager`).

Exporting `name` from the component module does **not** help. That identifier is the Cordis plugin name; the plugin manager never reads it. The bundled providers such as `@deepseek-ai/dsh-skill-badge` export `name` for Cordis, not for display.

**A subpath gives a readable title only to a component that ships no client module.** The client-modules registry keys each entry by the package it resolves to, so a `dsh-mobile/...` subpath resolves to `dsh-mobile` and a component's own `dsh.client` is never discovered — its bundle stops being served while the panel keeps reporting the plugin as running. This is not hypothetical: renaming the question-card entry to a subpath made every browser-boot lane fail with `DSH client discovery did not select the packed question-card component`.

Two shapes therefore coexist, and the choice is not a style preference:

| Component | Entry | Title |
| --- | --- | --- |
| Host-only, no `dsh.client` (the bundled skill) | package subpath, e.g. `dsh-mobile/mobile-skill` | readable, from its locale |
| Ships a client module (the question-card fix) | file path, e.g. `./packages/question-fixes/lib/index.mjs` | the module path |

For the subpath shape:

1. Main `package.json` exports the entry and **every** locale file (`./mobile-skill`, `./mobile-skill/locale/en.json`, `./mobile-skill/locale/zh.json`). `dictionariesOf` reads the whole locale directory with `readdirSync` and resolves each filename individually, so a partially exported locale directory throws and the row loses its metadata entirely.
2. The component ships `locale/{en,zh}.json` shaped `{"meta":{"title":…,"description":…}}`. `title` is required: the fallback is `manifest.name`, which is not read for a subpath specifier (`manifestPath` is only read when the specifier equals the package name), so a component without a locale title still shows the specifier.
3. `cordis.patch.yml` names the subpath for that component and the file for the other one.

The patch `id` is independent of the specifier, so activation keys, configuration and bookmarks survive a change of either. Before converting a row, check whether the component declares `dsh.client`; the packed browser-boot smoke is the gate that catches a wrong choice, so run it rather than only opening the panel.

## Configuration stores hold their file in memory

Every settings store (`FrpConfigStore`, `CloudflaredTunnelStore`, `OriginConfigStore`, `CaddyConfigStore`, the control stores) reads its file once in `initialize()` and keeps the parsed value in a private field. `settings()` returns that field; only `configure()` writes the file **and** the field. Editing `settings.json` directly therefore changes nothing observable: the panel keeps reporting `configured: false` (or the previous values) and the channel keeps using the old configuration. This is the plugin's design, not a lost-update bug.

Anything that changes configuration — an agent following the bundled skill, a script, a maintainer testing a fix — must go through the local management API. Those routes are loopback-only plus an `Origin` header equal to the DSH base URL (`assertLocalAdminTrust`); without the header a POST such as `/api/mobile-access/remote/frp/configure` answers `403 forbidden` before the body is examined, which reads like an authorization failure but is only the missing header. `$DSH_WEB_URL` carries the base URL into the agent shell. Verify a write by reading `providers.<channel>.configuration` back from `GET /api/mobile-access/remote/control`.

The bundled skill documents this contract; if a store stops caching, that section and this one are both wrong and must be updated together.

## A component download can fail in the antivirus

A Defender signature update can start flagging an official component binary as a heuristic trojan (`Trojan:Win32/Suschil!rfn`, the `!rfn` suffix marks a failed-report heuristic rather than a specific family). The symptom looks like a plugin bug: the installer reports `tar.exe: Error opening archive: Failed to open '…\frp.zip'`, the archive is present with the right byte count, and `File.ReadAllBytes` fails with "the file contains a virus".

The decisive evidence is *where* it failed: the installer verifies the downloaded SHA-256 before writing the archive and extracting it, so a `tar` or extraction failure means the bytes already matched the pin — the file is the one this repository pins, and the antivirus is rejecting it. Read the log for the stage rather than assuming a download or size mismatch.

Recovery needs an administrator: exclude `<state>/staging` and `<state>/components` in the antivirus, then reinstall from the panel or the management route. Do not treat this as a reason to relax the hash checks.

The related maintenance lesson: **purging a component is destructive and may not be reversible on the spot.** `POST /remote/<channel>/component/purge` deletes the binary and, for FRP, the configuration and the self-signed certificates too. Purging to clear test configuration cost an installed component that could not be reinstalled until the antivirus exclusion was added. Clear test state with a narrower operation where one exists, and confirm the environment can reinstall before removing a working component.

## Older WebViews

Check the actual WebView engine and missing feature, not only Android's OS version or the vendor's package-version naming. The compatibility entry is `src/mobile-compat.ts`; the helpers it installs live in `src/mobile-abort-signal.ts`, `src/mobile-boot-feedback.ts` and `src/mobile-url-authority.ts`, and the authenticated early-boot injection is served from `src/mobile-compat-bootstrap.ts`. Preserve native implementations, CSP/nonces, cancellation semantics and owned listener cleanup. A getter installed over a captured native getter must not reuse that name for the installed function: a named function expression binds its own name in scope, so `function hostname` would shadow the captured `hostname` and recurse until the stack overflows.

A compatibility script must run before code that needs its APIs. Pair a failing missing-feature fixture with a negative control that fails for the intended marker; an unrelated install or timeout failure is not a passing negative control. Height compatibility must preserve a real conversation scroll range, not merely replace `dvh` text in a stylesheet.

Use the existing old-WebView boot and conversation-scroll checks documented in `CONTRIBUTING.md`. Report a missing-API simulation separately from the reporter's physical device. A nonblocking obsolete-engine reminder is not a promise to support every old engine; unknown engine versions must not be falsely classified as obsolete.
