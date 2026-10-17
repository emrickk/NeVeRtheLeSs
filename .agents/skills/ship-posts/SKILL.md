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
3. Use the owner's explicit approval ("approved", "push", "ship it") of
   the reviewed scope and bytes. Recoverable approval of an earlier preview
   of the identical result remains valid; do not require a new exchange just
   because this command generated another link. The initial "push my edits"
   request without a reviewed result does not satisfy the preview gate.
4. Stop the preview server, then run `npm run ship -- --yes --digest <d>`
   with the digest from step 1. If it aborts with "tree changed since the
   review", something (likely another session) edited posts meanwhile: start
   over from step 1 so the owner reviews the new state. Never retry with a
   fresh digest the owner has not seen.
5. Verify the deployment and the live affected pages, then report the result
   and live URLs. Retain the release-check evidence.

## Rules

- `--yes` requires explicit owner approval of the reviewed scope and bytes,
  recoverable from the session or trusted evidence. Do not treat an agent's
  summary or a new digest as owner approval.
- A digest abort always restarts from step 1; the digest exists precisely so
  approvals cannot drift onto unreviewed content.
- Referenced hero covers are part of the printed change set, digest, approval,
  explicit-path commit, and freshness check. Never add an unrelated asset to
  the scope to get around a purity failure.
- A changed cover shared with an unselected post is blocked because it would
  change a page outside the review scope.
- Pushing stays the owner's decision (AGENTS.md rule 5); this flow just
  compresses the mechanics after they make it.
