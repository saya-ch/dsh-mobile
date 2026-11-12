# Collaboration and releases

## PR and issue work

Read the current issue/PR body, comments, changed files, exact head SHA and checks. A reported symptom can come from the plugin, DSH, the App, a remote provider or another frontend module. Reproduce or trace the concrete path before attributing it to user error or upstream version changes.

Before replying, merging or pushing, verify the active account in the tool that will perform the write and preserve the identity the user selected. CLI and connector sessions can use different accounts even for the same repository. Do not silently switch identities as a fallback; ask when the authorized identity is unavailable.

A request to inspect is review-only. When integration is authorized, preserve original author commits, normally by merging the tested head and appending focused maintainer corrections. Local integration does not mean the GitHub PR is merged. Recheck a moved remote head before final integration; avoid an unreviewed rewrite of published history.

Author commits appearing in history or a PR showing merged do not establish that its entire proposal shipped. Verify the final tree and actual package, then distinguish retained, reworked and deferred functionality. Reconcile PR descriptions and release notes with those decisions instead of carrying forward claims from an earlier implementation.

Do not accept a draft replacement just because it has more features. Check available upstream seams, loss of existing fallbacks, input/Stop/Send reachability, desktop behavior, theme tokens and new responsibility for hardcoded third-party classes. A missing slot, inaccessible controls or unsupported runtime is a concrete reason to defer it. Larger proposals such as worker-isolated extension execution need their own lifecycle/resource/recovery design; a timeout is not synchronous isolation.

Issue replies must match actual evidence and publication state. A local fix is not a released fix; a simulated keyboard test is not device verification. Keep replies concise and thank useful reports/contributions. Do not reply, close issues or alter PR state without authority for those external actions. If closure is authorized, distinguish shipped fixes, superseded duplicates, upstream ownership, requests awaiting reproduction and unimplemented ideas.

Do not post issue or PR replies announcing unreleased fixes or candidate progress. Keep that work in local verification records and the draft PR description; after publication, reply only with shipped behavior and its actual verification. This does not authorize posting replies or closing issues by itself.

Credit code authors and issue reporters by actual participation in `CONTRIBUTORS.md`. GitHub's Contributors graph follows commits in default-branch history; it cannot be populated by falsely attributing code to every reporter. The [maintenance invariant](../SKILL.md) to preserve contributor history also applies when a PR is incorporated with later corrections rather than directly merged on GitHub.

## Documentation

`README.md` and `README.en.md` describe the current user experience and working download links. Keep the opening concise; full historical updates belong in `CHANGELOG.md`. The App manuals, provider guides, module-management guide, `SECURITY.md`, third-party notices and `CONTRIBUTING.md` each own their subject. Avoid copying the same changing fact into many files.

Check the implemented behavior before writing an instruction: does the entry exist, which App capability is required, does saving require restart or page reopening, and is this a native function or a community-plugin example? Captions should describe the image simply. Do not imply that phone and tablet are different Apps or that a compatible community sidebar is a native feature.

Maintain paired English/Chinese guides together and product dictionaries for their supported locales. Use actual relative asset paths and compare against current original screenshots. Remove obsolete QR examples when replaced; do not silently rewrite historical release evidence. Run the documentation check described in [CONTRIBUTING](../../../../CONTRIBUTING.md#local-setup-and-baseline), but also inspect facts and rendered structure: link validation does not prove prose, HTML grouping, captions or image layout.

## Independent versions

The npm plugin and Android App have independent versions/releases. Do not advance the App version or create a new signed App release merely because plugin web UI or gateway code changed. Android validation builds, including applicable CI Debug builds, still run when needed. Native changes require an App version and a monotonically increasing versionCode; the embedded component version belongs to the plugin artifact, not the App.

Read current values from `package.json`, `package-lock.json`, the Android build file and `apps/mobile/release.json`. The descriptor names an already published and verified APK. Keep it and stable App links unchanged for an unpublished candidate. Promote new App metadata only after checking the downloaded APK's identity, versionCode, checksum and established signer.

## Prepare, then publish only when authorized

Follow the current procedure in `CONTRIBUTING.md` and the actual workflows rather than copying remembered commands or an old version number. Preparation leaves notes marked unreleased and retains public working downloads. Separate plugin `v<version>`, native `android-v<version>` and optional-component releases; a component distribution must not become the latest plugin/App release.

Choose checks based on the outgoing diff: source/type/behavior, real packed installation and upgrades, mounted browser consumers, relevant ADB paths and platform-specific component tests. Validate the final candidate in CI before publication; a contributor's green PR is not evidence for the maintainer's later corrections. Do not describe local Windows evidence as Linux/macOS CI.

Record the tested head and verify the merged tree before tagging. An identical tree links source evidence, but does not guarantee that a later independent CI run will pass. Read actual workflow dependencies; do not assume a concurrent CI run gates publication. If a new check fails while publication is running, stop dependent publication where still possible and reconcile its actual state. A cancellation request is not confirmed cancellation: inspect the response, terminal workflow state and public artifacts before reporting whether anything published. Keep the earlier passing candidate, later failure and publication outcomes separate.

Before a real release, verify cleanly scoped changes, original contributor ancestry, metadata, package contents, changelog/date, signer continuity, applicable checks and exact tested commit. Never publish from a tree containing unrelated work or bump the App download pointer before its release exists.

After authorized publication, independently check npm metadata and dist-tag, downloaded npm artifact/integrity, GitHub non-draft release/tag/commit/assets, package byte equality/checksum and any new APK's manifest/signer. A successful workflow dispatch, green job or skipped upload is not proof that users can download/install the intended artifact. An existing version may not be overwritten; reconcile what actually published before any retry.

Registry metadata can briefly lag a successful upload. Use bounded read-only propagation checks against the official version URL and retain initial failures; a temporary 404 or ETARGET is not permission to republish. Accept only complete downloaded files whose size, integrity and checksum match. EOF, TLS errors and partial files are failed observations, not usable artifacts. If an authorized existing proxy is needed, keep it command-local rather than changing global settings or disabling TLS verification.

Before preparing release notes, verify that the workflow-selected notes base is the previous stable plugin tag, not an App or component release; keep plugin and App notes separate, credit the actual contributions, and link the complete plugin-to-plugin changes.

Before continuing a partially published plugin release, compare the occupied npm version's integrity with the exact candidate tarball using [the reconciliation helper](../../../../scripts/check-npm-release-integrity.mjs). Only a matching artifact permits completion; network/metadata errors are not absence. Optional component publication follows the maintainer-authorized manual workflow. Do not invent a second-person approval requirement for this single-maintainer project. Retain exact tag/source, native test, size/hash, occupied-release and post-publication checks. Contributor real-world evidence can be accepted within its stated scope; do not relabel it as independent testing of another candidate or deployment.

Public npm/plugin releases, signed APKs, optional component binaries and source promotion can complete independently. Report partial success accurately and stop where new authority or a real unresolved failure is required; do not delete a release, unpublish, force-push or activate a component catalog merely to make the process appear complete.

For a post-publication test repair, inspect the real package contents before deciding whether another version is needed. An unpackaged fixture-only change does not require a new npm/APK release. Integrate it separately with its applicable checks, preserve the failed run, and do not claim the whole CI passed merely because the repaired cases passed. A separate unresolved failure still blocks that follow-up's integration. Keep that gate separate from public-artifact acceptance; call the public payload verified only after its own checks pass.

## Maintain the guidance

Update the skill when a demonstrated failure, changed architecture or durable user requirement would change another maintainer's decision. A resolved issue alone is not a reason to add a rule. Identify what a future Agent would otherwise misunderstand, and separate observed behavior from an unconfirmed explanation.

- Check the entrypoint and relevant references first. Strengthen the existing owner or replace obsolete guidance rather than append a competing rule.
- Put reusable decisions in the relevant reference; keep shared scope and routing in `SKILL.md`. Mechanically enforced behavior belongs in source/tests or a gate; current versions, open tasks, candidate hashes and one-off results belong in release or local evidence records.
- Describe the applicable condition, decision and observable acceptance, with links to the owning code/tests. Preserve the reason a tempting alternative fails, without copying the conversation or making a particular implementation the only permitted solution. One unsafe cache design does not forbid all API caching; slow optional probes do not make cached in-memory metadata require a new request.
- Validate changed links and instructions using the current repository checks. For a substantial or error-prone change, try a small realistic maintenance case without supplying the intended answer; include a case where the rule should not apply. Evaluate the resulting scope, decisions and evidence, not whether the Agent repeats the new wording.

Remove superseded workarounds and keep ordinary maintenance flexible. Fixed ordering is justified for fragile publication, signing, installation and teardown operations, not every small edit. Maintaining guidance does not authorize a push, release, account change or unrelated configuration edit.
