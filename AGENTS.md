# Agent maintenance

DSH Mobile is a standalone community plugin and Android App. Keep plugin work in this repository; changing or upgrading a user's DSH installation is a separate operation.

For implementation, DSH compatibility, PR/issue review, device debugging or release work, read [dsh-mobile-maintenance](.agent/skills/dsh-mobile-maintenance/SKILL.md), then only the references relevant to the task. [CONTRIBUTING.md](CONTRIBUTING.md) owns the check commands and release procedure; the skill supplies maintenance-specific decision guidance. For a documentation-only edit, consult the affected guide and run the documentation check.

Preserve original contributor commits, unrelated local changes, stored pairings and the established Android signer. A request to inspect does not authorize merging, replying, closing issues, replacing a user's installed software/profile or publishing; preparation is not publication. Owned isolated test installations are diagnostic fixtures, not changes to the user's normal installation.

Maintain the skill when demonstrated behavior invalidates its guidance or reveals a reusable maintenance lesson. Link the owning source, test or guide; replace superseded advice rather than accumulating contradictory rules. Keep current versions, pending tasks and one-off test results in their existing owners, not in the skill. Do not add a new rule for a purely local or mechanical edit.

Agents that do not read `AGENTS.md` automatically should load the skill explicitly. This repository entrypoint does not install global agent settings or authorize background actions.
