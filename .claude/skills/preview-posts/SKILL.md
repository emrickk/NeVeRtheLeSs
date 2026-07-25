---
name: preview-posts
description: Serve the production build so the owner can review changed posts in their own browser before anything ships. Use whenever post or template work is heading toward a push to main; release-check check 12 is NO-GO when preview-relevant files changed without an approval from this flow.
---

# Post preview

The owner reviews every preview-relevant change in a real browser against the real production build before it can ship. Approval is recorded as content hashes in `.preview/manifest.json` (git-ignored); any later edit voids it automatically. Changed notes under src/content/notes/ review at /notes/ (the timeline is their only page).

## Workflow

1. Run `npm run preview-posts`. It builds, serves `dist/` on port 4322, and opens `.preview/review.html` listing every page to review. Use `npm run preview-posts -- --host` to print a LAN URL for review on a real phone, `-- --port N` to avoid a collision, `-- --no-open` in headless sessions.
2. Hand the owner the review link(s). They browse the actual site: both languages, dark mode, narrow width.
3. Apply any edits the owner requests, then run the preview again (rebuild picks up the changes). Repeat until the owner is satisfied.
4. Only after the owner explicitly approves (for example says "approved" in chat), run `npm run preview-posts -- --approve`. Never approve unprompted, and never approve changes the owner has not seen.
5. Release-check check 12 verifies every current preview-relevant change is covered by the approval with matching content hashes. It SKIPs when nothing preview-relevant changed. Approved files that have since left the change set (committed with the approved bytes, or reverted) do not void the approval; only editing a file after approval does.

## Rules

- Approval is the owner's decision. The tool never self-approves and neither do you.
- The approval covers every preview-relevant change in the tree at approve time, not just the pages you showed the owner. Approve mode prints the full file list: read it, and if it contains changes from another session that the owner has not reviewed, stop and surface that instead of approving.
- `.preview/` is shared across concurrent sessions, last writer wins; an approval only ever covers the current bytes, so concurrent edits void it naturally.
- This gate does not replace the release checklist or the push rule: pushing stays a human decision after a GO verdict.
- `npm run ship` (skill: ship-posts) records the same manifest-based approval as part of its
  one-command flow, so `.preview/manifest.json` has two writers; both bind approval to exact
  content hashes. The Nevertheless Editor `--fast --only` lane is the explicit exception:
  it binds its scoped bytes to the publish digest but does not write this manifest.
