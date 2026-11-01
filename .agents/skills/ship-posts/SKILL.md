---
name: ship-posts
description: Publish the owner's post edits, their referenced local hero covers, and library data changes through the full gate chain with one owner approval. Use when the owner asks to push, ship, or publish their post or library edits, for example "push my edits", "ship my posts", or "publish what I changed in the editor".
---

# Ship posts

One conversation-driven publish of the owner's post and library edits. The
machinery is `npm run ship` (scripts/ship.mjs); this skill is the runbook for
driving it. The approval is digest-bound: ship refuses to publish content the
owner did not review.

## What ship publishes

- Changed, non-draft posts in `src/content/posts/`, each with its changed
  translation sibling.
- Changed covers under `src/assets/hero/` that a selected post references
  through `heroImage` (never a cover shared with an unselected post).
- Changed `src/data/library/*.json` collections.
- Explicit extras named with `--include <path>`, for a post that needs a
  component or style change. Not allowed: posts, library data, or covers
  (use `--only` or let ship select them), `package.json`,
  `package-lock.json`, `.github/`, env files, and other never-commit paths.

By default ship selects every changed post and library file. `--only <path>`
(repeatable) narrows the selection to the named posts or library files.

Everything else in the shared checkout (other sessions' edits, untracked
files) is listed as ignored and never reaches the build, the checks, or the
commit: ship builds and checks a temporary git worktree at `origin/main` that
contains only the selected files, verified byte for byte against the digest.
The temporary worktree is removed when ship exits, including on failure and
Ctrl+C.

## Workflow

1. Run `npm run ship -- --preflight` with the selection flags you intend to
   use (`--only ...`, `--include ...`). It aborts when the checkout is not on
   `main`, when local `main` differs from `origin/main` (behind, or with
   unpushed commits), on invalid paths, on a cover shared with an unselected
   post, or when the content check fails (translation title or description,
   image alt text, em dashes; fix the printed `file:line` items). Surface any
   abort to the owner; do not improvise around it. On success, note the
   printed file list, the ignored count, and the `changeset digest`.
2. Run `npm run ship -- --review --no-open --port N` with the same selection
   flags, in the background. It builds the temporary worktree into a private
   directory and serves exactly the build that would ship. Give the owner the
   review link and the file list from step 1.
3. Use the owner's explicit approval ("approved", "push", "ship it") of the
   reviewed scope and bytes. Recoverable approval of an earlier review of the
   identical result remains valid; do not require a new exchange just because
   this command generated another link. The initial "push my edits" request
   without a reviewed result does not satisfy the preview gate.
4. Stop the review server (Ctrl+C or SIGTERM), then run the command it
   printed: `npm run ship -- --yes --digest <d>` plus the same selection
   flags. It records the preview approval, runs the release checklist in a
   fresh temporary worktree, re-verifies the digest, commits only the selected
   paths in the shared checkout, verifies every committed blob against the
   approved bytes, pushes that commit, and watches the deploy. If it aborts
   with "tree changed since the review", something (likely another session)
   edited a selected file meanwhile: start over from step 1 so the owner
   reviews the new state. Never retry with a fresh digest the owner has not
   seen.
5. Verify the deployment and the live affected pages, then report the result
   and live URLs. Retain the release-check evidence.

`--dry-run` runs everything except the commit and push (and allows a non-main
branch or unsynced `main`, reporting them as notes); use it to rehearse.

The owner can also run `npm run ship` interactively: it builds, serves the
review page, and asks `approve these N file(s) and ship? [y/N]`.

## Rules

- `--yes` requires explicit owner approval of the reviewed scope and bytes,
  recoverable from the session or trusted evidence. Do not treat an agent's
  summary or a new digest as owner approval.
- A digest abort always restarts from step 1; the digest exists precisely so
  approvals cannot drift onto unreviewed content.
- `--include` is for files the reviewed post actually needs. Name each one
  explicitly, tell the owner it is part of the scope, and never use it to
  sweep unrelated work into a post publish.
- Covers, library files, and `--include` paths are part of the printed change
  set, digest, approval, explicit-path commit, and freshness check.
- Pushing stays the owner's decision (AGENTS.md rule 5); this flow just
  compresses the mechanics after they make it.
