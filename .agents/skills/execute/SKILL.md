---
name: execute
description: Implement one backlog item for Mystery Menu in an isolated worktree, verify it, and commit.
schedule: "When backlog items are ready for implementation."
---

# Execute

Your order prompt names the backlog item. `docs/DESIGN.md` is the product spec — read it first, and treat its locked decisions as constraints. `todos.md` shows what is already done.

## Worktree workflow

Never work on the main branch.

1. `noodle worktree create <short-name>` — the name is derived from the order, lowercase and hyphenated.
2. Do all work inside that worktree directory.
3. Commit there. Do not push.
4. `noodle worktree merge <short-name>` when the verification commands below pass.

If you cannot get the work to a verified state, leave the worktree uncommitted and report exactly what is blocked and what you tried. A clean stop beats a broken merge.

## Verification

Run every command that exists; skip missing scripts rather than inventing them.

- `npm install` (or `npm ci` when a lockfile is present)
- `npm run typecheck`
- `npm test`
- `npm run build`
- boot check: start the server and confirm `curl -sf localhost:$PORT/healthz` returns 200, then stop it

The web client must be usable at a 360px viewport with touch input only. Mobile is the target platform, not an afterthought.

## Conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`.
- TypeScript everywhere on both server and client. No `any` in new code without a comment justifying it.
- The Venice API key is read from the environment and only ever used server-side. A key, a token or a secret must never appear in client code, logs, fixtures or commits.
- Third-party network calls go behind the service layer, never inline in a route handler or a component.
- New dependencies need one line in the report saying why the standard library or an existing dependency would not do.

## Scope

Implement the ordered item and nothing else. Do not refactor unrelated code, do not rename things for taste, do not add features that were not asked for. If you find an unrelated bug, note it in your report instead of fixing it.

## Report

End with: what changed, the exact verification commands you ran and their results, anything you could not do, and any follow-up work that should become a backlog item.
