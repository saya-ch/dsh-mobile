# Local workspace hygiene

Use this reference before deleting anything on disk to reclaim space — stale git worktrees, copied build output, old runtime directories. The repository is an npm workspace with `packages/question-fixes` linked and a large `node_modules`; a careless delete here damages the main checkout, not just the thing you meant to remove.

The rule that matters most: **never delete a directory inside this tree with a mirror/recursive copy tool.** `robocopy <empty> <target> /MIR` and equivalents follow directory junctions and symlinks, and an npm workspace tree is full of them. On Windows a known failure is `git worktree remove` aborting with `Filename too long` and the workaround being `robocopy /MIR` — that traversal reached the **main** checkout and removed its `node_modules/` and the `packages/question-fixes/` source. The same risk applies to any tool that recurses without excluding reparse points.

## Remove a worktree safely

1. Resolve and check the absolute target first: it must be the worktree directory, not the repository root, and not the main worktree. Print it and read it before acting.
2. Use `git worktree remove --force <path>`. If it fails on path length, delete the *leaf* contents through `git`/`Remove-Item` on that resolved path, or use `robocopy <empty> <target> /MIR /XJ` (the `/XJ` excludes junctions) — never without `/XJ`.
3. After any bulk delete, confirm the main checkout is intact: `git status`, `git ls-files -d` must be empty, and `git worktree list` shows only the intended worktrees.

## Recover from a junction-traversal delete

A mirror delete that crossed a junction leaves tracked files deleted in the main checkout. Restore tracked paths with `git checkout -- <path>` (for example `packages/question-fixes`), then reinstall dependencies with `npm ci`. Verify before continuing: `git ls-files -d` empty, working tree clean, and `npm run verify` passes.

## Size accounting

When measuring what a worktree or directory actually costs, exclude the main worktree from the total and normalize path separators before comparing (`C:/` and `C:\` are the same directory). A total that includes the main checkout is meaningless and hides which worktree is the real hog.

## Keep this reference accurate

This documents a demonstrated destructive failure ([`AGENTS.md`](../../../../AGENTS.md) requires recording reusable lessons); replace it if the tooling or layout changes rather than appending contradictory advice.
