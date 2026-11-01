---
name: preview-posts
description: Serve the production build so the owner can review changed posts in their own browser before anything ships. Use whenever post or template work is heading toward a push to main; release-check check 12 is NO-GO when preview-relevant files changed without an approval from this flow.
---

# Post preview

The owner reviews every preview-relevant change in a real browser against the real production build before it can ship. Approval is recorded as content hashes in `.preview/manifest.json` (git-ignored); any later edit voids it automatically. Changed notes under src/content/notes/ review at /notes/ (the timeline is their only page).

## Workflow

1. Run `npm run preview-posts`. It builds into a private temporary directory (never the shared `dist/`), serves it on port 4322, and opens a review page listing every page to review (its path is printed). Stopping the server removes the build. Use `npm run preview-posts -- --host` to print a LAN URL for review on a real phone, `-- --port N` to avoid a collision, `-- --no-open` in headless sessions. This builds the whole working tree, including other sessions' uncommitted edits; to review exactly what `npm run ship` would publish, use `npm run ship -- --review` (ship-posts skill).
2. First complete the [completion criteria](../../../docs/completion-criteria.md) yourself. Inspect the actual affected views, both languages where applicable, dark mode, and narrow width. The generated link list is a routing aid, not proof that all affected UI was reviewed. For car work, open `/library/#cars`; show the finished page, not an obligatory comparison report.
3. Hand the owner the finished review link(s). Apply requested edits and rebuild. Carry forward accepted decisions; do not use repeated owner review as a substitute for finding obvious defects yourself.
4. With explicit owner approval of the same reviewed scope and bytes (for example "approved", "push", or "ship it"), run `npm run preview-posts -- --approve`. Reuse a recoverable earlier approval instead of requesting it again. Never approve unprompted or cover newly unreviewed changes. An initial publication request without a reviewed result does not satisfy this gate.
5. Release-check check 12 verifies every current preview-relevant change is covered by the approval with matching content hashes. It SKIPs when nothing preview-relevant changed. Approved files that have since left the change set (committed with the approved bytes, or reverted) do not void the approval; only editing a file after approval does.

## Rules

- Approval is the owner's decision. The tool never self-approves and neither do you.
- The approval covers every preview-relevant change in the tree at approve time, not just the pages you showed the owner. Approve mode prints the full file list: read it, and if it contains changes from another session that the owner has not reviewed, stop and surface that instead of approving.
- `.preview/manifest.json` is shared across concurrent sessions. Writes are locked and merged: an approval adds or replaces entries for its own files and keeps other sessions' entries, so approving post B never voids an approval of post A. Entries expire after 30 days. An approval only ever covers exact bytes, so concurrent edits void it naturally.
- This gate does not replace the release checklist or owner publication authorization. Once the owner has authorized the reviewed scope, finish the release and verify deployment without another permission loop.
- `npm run ship` (skill: ship-posts) records the same manifest-based approval for its selected
  files as part of its one-command flow, so `.preview/manifest.json` has two writers; both bind
  approval to exact content hashes and merge into the same manifest.
