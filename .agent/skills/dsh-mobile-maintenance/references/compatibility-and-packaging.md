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

Identify the missing feature's owner before deciding that the App needs updating. Ordinary web UI, a separately switchable client component and a new native capability have different loading requirements. The gateway's `/mobile-access/metadata` helps identify the running plugin; `/mobile-access/discovery` helps identify the computer instance and Origin. Compare the relevant fields with listener/profile ownership, without dumping complete pairing payloads. Neither route proves the target client code loaded.

## Adapt to upstream behavior

Inspect the official release/channel and the exact source or published packages corresponding to it. An npm `latest`, an alpha tag and a source branch may name different releases. Do not upgrade a dirty user checkout with an unconditional pull or replace a running Desktop profile as a diagnostic shortcut.

Use `scripts/check-dsh-compatibility.mjs` as a source-contract check, then exercise the affected published paths with an isolated supported DSH launch. A new version number alone is neither proof of incompatibility nor permission to weaken dependency checks. Conversely, broad peer ranges do not prove that moved services, frontend slots, API methods or settings consumers still work.

Inspect the actual frontend package for DOM ownership, slots, keyboard/menu behavior, theme tokens and settings writes. Client slots can be absent in a new or old release; do not remove a working fallback before verifying the replacement exists. Trace preferences to the renderer: Markdown and code fonts can be CSS-driven while xterm reads a ThemeRuntime snapshot. A control that changes only storage is not a completed adaptation.

Keep changes within the plugin when possible. Prefer an existing optional capability or version-independent feature detection to a brittle version allowlist. When the documented DSH seam cannot provide the requested behavior, explain the limitation and defer or explicitly propose the upstream change.

## Source, package and live installation are separate

`npm ci` workspace links can hide a distribution defect. Test `npm pack` output installed into an owned profile, and verify the actual Host and Client selected by DSH. Preserve the question-card component's identity and independent off/on behavior; disabling it must dispose listeners/styles rather than leave hidden state behind.

The embedded `packages/question-fixes` component is private and belongs to the main plugin artifact. The relative file entry in `cordis.patch.yml` is anchored by DSH to the installed bundle directory. Keep the component manifest, Host, Client and license inside the tarball. Do not restore a private `file:` dependency plus nested `bundledDependencies` that depends on pnpm's linker layout, or assume a public package subpath is discoverable as a DSH client module.

Use `scripts/packed-profile.mjs`, `scripts/check-packed-profile.mjs`, `scripts/check-companion-package.mjs` and `scripts/smoke-plugin-installation.mjs`. The live smoke covers the plugin-manager operation, persisted bundle, DSH-selected Host/Client and component toggle. An upgrade can legitimately return `restart-required`; restart only the owned fixture before completing acceptance. Keep a fresh-install failure distinct from that upgrade result.

For installation/upgrade fixes, cover hoisted and isolated pnpm, a fresh install and an existing published installation. Old nested files may remain after an upgrade; verify the new artifact is selected rather than deleting user installation directories. For a market-install report, test a registry package spec as well as a local tarball; the loopback registry fixture supplies the same real artifact without publishing it.

## Older WebViews

Check the actual WebView engine and missing feature, not only Android's OS version or the vendor's package-version naming. Current compatibility helpers live in `src/mobile-compat.ts` and the early authenticated boot path. Preserve native implementations, CSP/nonces, cancellation semantics and owned listener cleanup.

A compatibility script must run before code that needs its APIs. Pair a failing missing-feature fixture with a negative control that fails for the intended marker; an unrelated install or timeout failure is not a passing negative control. Height compatibility must preserve a real conversation scroll range, not merely replace `dvh` text in a stylesheet.

Use the existing old-WebView boot and conversation-scroll checks documented in `CONTRIBUTING.md`. Report a missing-API simulation separately from the reporter's physical device. A nonblocking obsolete-engine reminder is not a promise to support every old engine; unknown engine versions must not be falsely classified as obsolete.
