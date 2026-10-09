# Collaboration and releases

## PR and issue work

Read the current issue/PR body, comments, changed files, exact head SHA and checks. A reported symptom can come from the plugin, DSH, the App, a remote provider or another frontend module. Reproduce or trace the concrete path before attributing it to user error or upstream version changes.

A request to inspect is review-only. When integration is authorized, preserve original author commits, normally by merging the tested head and appending focused maintainer corrections. Local integration does not mean the GitHub PR is merged. Recheck a moved remote head before final integration; avoid an unreviewed rewrite of published history.

Do not accept a draft replacement just because it has more features. Check available upstream seams, loss of existing fallbacks, input/Stop/Send reachability, desktop behavior, theme tokens and new responsibility for hardcoded third-party classes. A missing slot, inaccessible controls or unsupported runtime is a concrete reason to defer it. Larger proposals such as worker-isolated extension execution need their own lifecycle/resource/recovery design; a timeout is not synchronous isolation.

Issue replies must match actual evidence and publication state. A local fix is not a released fix; a simulated keyboard test is not device verification. Keep replies concise and thank useful reports/contributions. Do not reply, close issues or alter PR state without authority for those external actions. If closure is authorized, distinguish shipped fixes, superseded duplicates, upstream ownership, requests awaiting reproduction and unimplemented ideas.

Credit code authors and issue reporters by actual participation in `CONTRIBUTORS.md`. GitHub's Contributors graph follows commits in default-branch history; it cannot be populated by falsely attributing code to every reporter. Preserve contribution history even when a PR is incorporated with later corrections rather than directly merged on GitHub.

## Documentation

`README.md` and `README.en.md` describe the current user experience and working download links. Keep the opening concise; full historical updates belong in `CHANGELOG.md`. The App manuals, provider guides, module-management guide, `SECURITY.md`, third-party notices and `CONTRIBUTING.md` each own their subject. Avoid copying the same changing fact into many files.

Check the implemented behavior before writing an instruction: does the entry exist, which App capability is required, does saving require restart or page reopening, and is this a native function or a community-plugin example? Captions should describe the image simply. Do not imply that phone and tablet are different Apps or that a compatible community sidebar is a native feature.

Maintain paired English/Chinese guides together and product dictionaries for their supported locales. Use actual relative asset paths and compare against current original screenshots. Remove obsolete QR examples when replaced; do not silently rewrite historical release evidence. Run `npm run check:docs`, but also inspect facts and rendered structure: link validation does not prove prose, HTML grouping, captions or image layout.

## Independent versions

The npm plugin and Android App have independent versions/releases. Do not advance the App version or create a new signed App release merely because plugin web UI or gateway code changed. Android validation builds, including applicable CI Debug builds, still run when needed. Native changes require an App version and a monotonically increasing versionCode; the embedded component version belongs to the plugin artifact, not the App.

Read current values from `package.json`, `package-lock.json`, the Android build file and `apps/mobile/release.json`. The descriptor names an already published and verified APK. Keep it and stable App links unchanged for an unpublished candidate. Promote new App metadata only after checking the downloaded APK's identity, versionCode, checksum and established signer.

## Prepare, then publish only when authorized

Follow the current procedure in `CONTRIBUTING.md` and the actual workflows rather than copying remembered commands or an old version number. Preparation leaves notes marked unreleased and retains public working downloads. Separate plugin `v<version>`, native `android-v<version>` and optional-component releases; a component distribution must not become the latest plugin/App release.

Choose checks based on the outgoing diff: source/type/behavior, real packed installation and upgrades, mounted browser consumers, relevant ADB paths and platform-specific component tests. Validate the final candidate in CI before publication; a contributor's green PR is not evidence for the maintainer's later corrections. Do not describe local Windows evidence as Linux/macOS CI.

Before a real release, verify cleanly scoped changes, original contributor ancestry, metadata, package contents, changelog/date, signer continuity, applicable checks and exact tested commit. Never publish from a tree containing unrelated work or bump the App download pointer before its release exists.

After authorized publication, independently check npm metadata and dist-tag, downloaded npm artifact/integrity, GitHub non-draft release/tag/commit/assets, package byte equality/checksum and any new APK's manifest/signer. A successful workflow dispatch, green job or skipped upload is not proof that users can download/install the intended artifact. An existing version may not be overwritten; reconcile what actually published before any retry.

Public npm/plugin releases, signed APKs, optional component binaries and source promotion can complete independently. Report partial success accurately and stop where new authority or a real unresolved failure is required; do not delete a release, unpublish, force-push or activate a component catalog merely to make the process appear complete.

## Maintain the guidance

Update the skill after a reusable failure or an architectural change, with links to the source/tests that now own the behavior. Delete superseded workarounds. Do not copy a conversation, all past PR numbers, local machine paths or a running task list into it. Preserve flexible judgment for ordinary maintenance; fixed ordering is justified for fragile publication, signing, installation and teardown operations, not for every small change.
