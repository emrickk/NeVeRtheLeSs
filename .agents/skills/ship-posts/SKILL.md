---
name: ship-posts
description: Publish the owner's post edits and their referenced local hero covers through the full gate chain with one owner approval. Use when the owner asks to push, ship, or publish their post edits, for example "push my edits", "ship my posts", or "publish what I changed in the editor". Unrelated assets and all other changes fall back to the normal session workflow.
---

# Ship posts

One conversation-driven publish of the owner's post edits. The machinery is
`npm run ship` (scripts/ship.mjs); this skill is the runbook for driving it.
The approval is digest-bound: ship refuses to publish content the owner did
not review.

## Workflow

1. Run `npm run ship -- --preflight`. If it aborts (wrong branch, origin
   moved, unrelated files changed), surface its message to the owner and fall
   back to the normal session workflow; do not improvise around it. On
   success, note the printed file list and the `changeset digest` value. A
   changed file under `src/assets/hero/` is allowed only when one of the
   selected changed posts references it through `heroImage`.
2. Run `npm run preview-posts` on an explicit free port. Use
   `-- --port N --no-open` in headless sessions. Give the owner the review link
   along with the file list from step 1. This is the production build, not the
   dev render.
3. Wait for the owner's explicit approval in chat ("approved", "push",
   "ship it") given AFTER they have the link. The initial "push my edits"
   request is the request, not the approval; never treat it as both.
4. Stop the preview server, then run `npm run ship -- --yes --digest <d>`
   with the digest from step 1. If it aborts with "tree changed since the
   review", something (likely another session) edited posts meanwhile: start
   over from step 1 so the owner reviews the new state. Never retry with a
   fresh digest the owner has not seen.
5. Report the release-check results and the live post URLs that ship prints.

## Rules

- `--yes` may only ever follow an owner approval message in this
  conversation, given after step 2's link. No approval message, no ship.
- A digest abort always restarts from step 1; the digest exists precisely so
  approvals cannot drift onto unreviewed content.
- Referenced hero covers are part of the printed change set, digest, approval,
  explicit-path commit, and freshness check. Never add an unrelated asset to
  the scope to get around a purity failure.
- A changed cover shared with an unselected post is blocked because it would
  change a page outside the review scope.
- Pushing stays the owner's decision (AGENTS.md rule 5); this flow just
  compresses the mechanics after they make it.
