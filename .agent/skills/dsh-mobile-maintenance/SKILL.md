---
name: dsh-mobile-maintenance
description: Maintain the standalone DSH Mobile plugin and Android App through code changes, upstream compatibility, PR and issue review, packed installation, ADB regression, and release preparation. Use source and runtime evidence; this is not a DSH core development workflow.
---

# DSH Mobile maintenance

Deliver a scoped, tested change that preserves existing users, contributor history and the separation between DSH, the plugin, and the Android App. The repository root contains `package.json`, `cordis.patch.yml`, `src/`, and `apps/mobile/`; resolve paths from that root, not from a previous maintainer's computer.

## Establish the real starting point

Read Git status, current branch and relevant diffs before changing files. Determine what the user requested: inspection, implementation, integration, local testing, preparation or publication. Keep unrelated work intact. Separate a user-requested local repair from an external reply, merge, issue closure, push or release.

For runtime/device claims, identify both the checked-out source and the relevant running artifact: DSH version/channel, loaded plugin path/version, active profile/process owner, or Android package/versionCode/signer/WebView as needed. Collect the facts that distinguish the actual failure; a repository-only edit does not require surveying every live device or profile. A build, npm install, open webpage or QR code alone does not identify the loaded plugin. Read current remote metadata when the task concerns new PRs, issues or upstream releases.

Use [CONTRIBUTING.md](../../../CONTRIBUTING.md) for commands and [package.json](../../../package.json), workflows and the relevant source/tests for current facts. Do not turn a past version, local path, temporary workaround or old test result into a permanent requirement.

## Choose the relevant maintenance route

| Task | Read next |
| --- | --- |
| DSH upgrade, startup failure, installation or client discovery | [Compatibility and packaging](references/compatibility-and-packaging.md) |
| Mobile layout, reconnection, remote providers, Android or ADB | [Runtime, UI and Android](references/runtime-ui-android.md) |
| PR/issue integration, documentation, versioning or publication | [Collaboration and releases](references/collaboration-and-releases.md) |

Read multiple references only when the change crosses those systems. Prefer existing repository scripts and test fixtures to rebuilding an alternative maintenance toolchain.

## Cross-layer decisions

- Keep DSH source unchanged for plugin features unless an upstream change is explicitly in scope. Inspect upstream frontend consumers when necessary; CSS, service names or slot IDs cannot be inferred from a screenshot or remembered release.
- Reuse DSH's existing uploads, command handling, menus, theme tokens and capability seams before adding another implementation. Mobile-only controls belong to the authenticated web page or App that owns them; they should not alter the desktop unintentionally.
- Treat paired devices and local extension hosts as trusted operators, not a sandbox. Preserve exact-Origin, authentication, CSRF, certificate and revocation checks. Hiding a frontend module is not revoking authorization or disabling a Host plugin.
- Optional frontend modules can be excluded as whole modules, subject to required/dependency checks. This is not arbitrary per-widget hiding or a promise to adapt every third-party plugin combination.
- Trace behavior to its actual consumer. Saved preferences, CSS variables and visible controls do not prove a feature affects a canvas, editor or native API. Withdraw a nonworking control rather than claiming support or introducing a speculative service patch.
- Keep product text locale-owned and update Chinese, English and Italian where the feature has those dictionaries. App language follows the system; plugin copy follows the supported DSH locale. Developer instructions do not need to become user-facing UI.

## Match evidence to the claim

Select checks for the changed behavior, including rejection and teardown paths. Source tests, packed installation, mounted browser behavior, physical Android behavior, public-route traffic and final CI are different evidence. Report which were executed and which remain unverified.

Use actual npm tarballs for published loading paths and the real DSH loader/client registry. Verify final `lib/` output after changing client source. Use allocated ports and owned temporary profiles/processes; await disposal before removing their directories. Keep real profiles, credentials and conversations out of fixtures.

For UI, measure visibility, hit targets, overflow, focus and state retention. A selector assertion or synthetic stylesheet alone is insufficient. For long-running operations, inspect cancellation and late results; a timeout does not stop synchronous code or roll back completed effects.

Hand off with the outcome, affected client/Host/App, relevant checks, limitations and publication state. Do not claim no bugs, full device coverage, cross-platform CI, voice recognition, certificate renewal or public-route readiness without the corresponding evidence.

## Keep this skill useful

When a demonstrated failure teaches a reusable lesson, update the relevant reference with the symptom, owning implementation and evidence that distinguishes it from similar failures. When architecture changes, replace or remove the obsolete guidance in the same task. Prefer a link to an existing guide over copying its commands or policy.

Keep version numbers, open issue lists, candidate hashes, temporary paths and ongoing tasks in release metadata, the changelog or local test evidence. They are not skill content. Do not add hardcoded maintainer machines, credentials, universal plugin whitelists, fixed task templates or an approval checklist for ordinary local edits. Preserve the user's explicit choices and require authority at the action that actually changes external state.

Review substantial skill changes with a realistic task and an independent Agent when available. Check the Agent's decisions and evidence, not whether it repeats this document's wording. Maintaining this skill does not create a scheduled monitor or grant permission to publish.
