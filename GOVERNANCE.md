# Governance

This repository is a community plugin for DeepSeek Harness (DSH), with an Android app and a portable Windows client released from the same tree. It is not part of DSH, it is not maintained by DeepSeek, and nothing here speaks for that project.

This document says who decides what. It exists so a contributor can tell whether a change is waiting on review, on a maintainer decision, or on upstream — three different answers that all look like silence otherwise.

[CONTRIBUTING.md](CONTRIBUTING.md) owns how to build, test and prepare a release. [SECURITY.md](SECURITY.md) owns vulnerability reporting. [AGENTS.md](AGENTS.md) owns what an automated agent may do here. Behavior expectations are in [Reports and community conduct](CONTRIBUTING.md#reports-and-community-conduct).

## Decision authority

The project has one maintainer, [@saya-ch](https://github.com/saya-ch), who holds merge and release rights. Every change that reaches `main` is merged by the maintainer, and contributors work from their own branches: merging is a maintainer action, not a shared one. There is no voting body, no election process and no `CODEOWNERS` file. A commit that appears to merge inside a contributed branch is that contributor synchronizing with `main`, not a merge into it.

The maintainer decides:

- **Merging or closing a pull request.** Review comments explain the decision; a closed request is not a judgement of effort.
- **Versions and release contents.** Which track advances, what number it takes, and what a release notes entry claims.
- **Scope.** Whether a request belongs to this repository, to DSH upstream, or to a third party.
- **Breaking changes.** Whether existing users can be required to act, and how they are told.
- **Adopting an external convention** as normative here (see below).

Everything else is open. Anyone may report a defect, propose a change, review a pull request in public, or publish their own fork under its own name.

## How a change is accepted

A pull request is merged when all of the following hold. This is not a checklist for its own sake; each line exists because its absence caused a regression at some point in this repository's history.

- **The relevant checks pass**, on the final commit and not an earlier one. [CONTRIBUTING.md](CONTRIBUTING.md) names them per area. A green earlier commit is not evidence about the candidate.
- **The claim matches the evidence.** A fix that says "verified on a device" carries device evidence; one verified by unit tests says so. Neither is presented as the other.
- **Tests accompany behavior changes**, including the rejection and teardown paths, not only the happy path.
- **Documentation is updated in the same change** when a version, a path, an interface or a command changes. Documentation drifting from code is treated as a defect, because the bundled skill is executed by agents that cannot tell it is out of date.
- **Contributor commits are preserved.** Community work is merged, not squashed into an unattributed commit.
- **No unrelated work rides along.** A change that mixes an unrelated refactor with a fix is split, not waved through.

## Release authority

Preparation is not publication. [CONTRIBUTING.md](CONTRIBUTING.md#prepare-and-publish-a-release) separates the two, and the distinction is enforced rather than advisory: a release note marked unreleased, a version bumped locally or a green build publishes nothing.

Publishing requires the maintainer to tag and let the release workflow run. Three tracks advance independently, and a request to change one is not a request to change the others:

| Track | Tag | What it means |
| --- | --- | --- |
| Plugin | `v<version>` | npm package and GitHub release |
| Android app | `android-v<version>` | signed APKs, both variants, with a monotonic `versionCode` |
| Windows client | `windows-v<version>` | prerelease archive and installer |

The established Android signer is part of the contract. A change that would alter the package identity or require re-pairing existing users is a decision for the maintainer, not a side effect of a fix.

## Upstream relationship

DSH source and installed frontend artifacts are read-only. A defect that belongs to DSH is reported as a reproduction rather than patched from here, and a host behavior this plugin cannot repair through a documented extension point is stated as a limit instead of worked around with a private patch or a rewritten bundle. Where the host moves, this plugin adapts; it does not fork the host.

The same applies in reverse: this repository does not accept changes whose real fix belongs upstream merely to make a local symptom disappear.

## External conventions

Community conventions such as [dsh-plugin-ui-conventions](https://github.com/abworks-dev/dsh-plugin-ui-conventions) may be cited as design rationale. Citing is not adopting: a convention becomes normative here only when a document in this repository references it, and that reference is what a contributor should read. Adopted sections are named individually rather than by pointing at the whole collection, because a convention can be reasonable in one section and wrong for this project in another.

A convention authored by the same person who opens the pull request is welcome and still needs the ordinary evidence: the code, the tests, and a reason this project specifically should follow it.

## Automated agents

Agents may inspect, implement, test and prepare releases, subject to [AGENTS.md](AGENTS.md). Two boundaries are decisions rather than etiquette:

- **Inspection is not consent.** Reading an issue or a pull request authorizes no reply, no merge, no close and no release. Each of those is a separate instruction.
- **An agent's green run is not the maintainer's acceptance.** The agent integrating a change reviews the final diff and runs the checks, because adjacency in a shared working tree is not merge safety.

## Disagreement

A rejected proposal can be argued with in the pull request or issue thread. If the maintainer's answer stands, the outcome is a closed request, not a stalled one, and a fork under another name is a legitimate response. Technical disagreement is expected; the conduct expectations in [CONTRIBUTING.md](CONTRIBUTING.md#reports-and-community-conduct) apply to maintainer and contributor alike.

## Changing this document

This file describes how the project is actually run, so it changes when the practice changes, not ahead of it. Adding a second maintainer, introducing shared ownership, or delegating a release track means editing this document and [AGENTS.md](AGENTS.md) in the same change that grants the permission.
