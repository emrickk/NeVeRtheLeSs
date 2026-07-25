# One-command publish for post edits (npm run ship)

Date: 2026-07-16
Status: Approved by owner (design conversation), pending spec review

## 2026-07-24 amendment: scoped editor publishing

The standalone Nevertheless Editor now invokes `ship` with `--fast --only`
for a one-click publish of the open post and its existing translation sibling.
This fast lane is deliberately narrower than the interactive flow: local
`main` must exactly match `origin/main`, the selected bytes are digest-bound,
focused validators run, and the GitHub Actions production build is the final
deploy gate. It does not write a production-preview approval or run the
whole-tree release checklist.

`ship` may also include a changed file under `src/assets/hero/` when, and only
when, one of the selected posts directly references that exact file through
`heroImage`. The referenced cover participates in purity, digest, freshness,
validation, explicit-path commit, and push. Unreferenced hero files and every
other non-post path still abort. Every lane also refuses a changed cover that
is shared with an unselected post, because that would alter an unreviewed page.
This amendment supersedes the original post-only and no-partial-shipping limits
below for these two narrow cases.

## Purpose

After editing posts (typically in the /\_edit editor), the owner publishes with a single
memorable command instead of the four-step manual sequence (preview, approve, release-check,
commit and push). `npm run ship` chains the existing gates in order with one human
confirmation in the middle. It automates the sequence, not the judgment: the owner still
looks at the production build and still says yes.

There are two entry points sharing one implementation:

- **Terminal**: the owner runs `npm run ship` and answers the interactive prompt.
- **Conversation**: the owner opens any Claude Code session and says "push my edits" (or
  similar). A repo skill, `ship-posts`, encodes the runbook: the session gives the owner the
  production-build review link, waits for their approval in chat, then drives the same
  pipeline via a `--yes` flag.

Explicitly out of scope (YAGNI): shipping anything other than post files (no hero images,
notes, templates, config, or dependency changes), auto-rebase or merge when origin/main has
moved, fully unattended operation (cron, CI; `--yes` still requires a human approval
recorded in the conversation that invokes it), partial shipping (choosing a subset of
changed posts).

## Constraints

- Rule 5: pushing to main is a human decision. In interactive mode that decision is the
  explicit `y` on stdin; in `--yes` mode it is an explicit owner approval message in the
  invoking conversation, as governed by the ship-posts skill. Ship never runs unattended,
  and in both modes the approval binds to the exact reviewed content via the digest check
  below.
- The preview gate's meaning is preserved: the owner reviews the real production build in a
  browser before approving, exactly like `npm run preview-posts`.
- Reuse the existing safety tooling as libraries; do not fork their logic. Everything needed
  is already exported: `computeChangeSet`, `reviewTargets`, `renderReviewPage`,
  `hashChangeSet`, `writeManifest`, `slugForPostFile` (scripts/preview-posts.mjs),
  `runChecks`, `verdict` (scripts/release-check.mjs), `save` and `repoRoot`
  (scripts/checkpoint.mjs).
- Repo rules: explicit-path staging only, no em-dashes anywhere, scripts/ code style
  (no semicolons, single quotes).
- Several agent sessions share this checkout; ship must never sweep up their work.

## The command

`npm run ship` runs `node scripts/ship.mjs`. Flags: `--message <msg>` overrides the commit
message; `--port <n>` overrides the review server port (default 4322, matching preview-posts);
`--no-open` skips opening the browser (prints the URL instead); `--preflight` runs step 1
only, prints the change set and its digest, and exits (agent sessions use it to fail fast
before involving the owner); `--yes --digest <d>` skips step 2 entirely (no build-and-serve,
no stdin prompt) and treats the approval as already given for the reviewed state identified
by `<d>`, running steps 1, 3, and 4 straight through. `--yes` without `--digest` is a usage
error. `--yes` exists solely for the ship-posts skill flow, where the owner's approval is a
chat message; the policy guard for obtaining that approval lives in the skill text, and the
digest binds it to content in code.

**The digest**: the first 12 hex characters of a sha256 over the sorted
`path:content-hash` entries of `hashChangeSet(root, changeSet)`, joined with newlines.
Identical trees produce identical digests; any post edit, addition, or deletion after
review changes it. It is a freshness token, not a security boundary.

### Step 1: preflight (abort early, change nothing)

1. Checkpoint: `save(root, { trigger: 'ship' })`.
2. Branch must be `main`, else abort.
3. `git fetch origin`. If origin/main is ahead of or diverged from local main, abort with:
   the count of remote commits and the advice to reconcile in a Claude session (or
   `git pull --rebase` when comfortable). Ship never rewrites history.
4. Purity check, on the RAW diff, not the filtered change set: collect
   `git diff --no-renames --name-only -z origin/main` plus untracked files
   (`git ls-files --others --exclude-standard -z`) plus the committed-only view
   `git diff --no-renames --name-only -z origin/main...HEAD` (this last one catches an
   unpushed commit whose working-tree content was reverted without resetting the commit;
   the push would still carry it), with no classification filter. If any
   path in that union falls outside `src/content/posts/`, abort listing those paths and
   naming the fallback (a Claude session). This is the guarantee that ship only ever
   publishes post content. `computeChangeSet` cannot serve here: its `classifyPath` filter
   drops docs/, scripts/, .github/, CLAUDE.md and similar paths entirely, and rule 5 makes
   unpushed commits touching such paths a routine state of this repo; `git push` would
   publish them regardless of any filter, so the purity check must see everything the push
   would carry.
5. Change set for review and approval: `computeChangeSet(root)` (vs origin/main). This is
   the preview-gate view of the same diff; note it deliberately excludes draft posts
   (nothing renders, nothing to review), so a draft-only edit yields an empty set here.
   - Empty: print "nothing to ship" and exit 0 (the purity check has already passed, so
     anything excluded was posts-only, such as draft edits).
6. Print the change-set file list and its digest. In `--preflight` mode, exit 0 here.

### Step 2: review (build, serve, look)

1. Build: run `npm run build` (production build including Pagefind); abort on failure.
   The build runs again later inside release-check (check 6); that duplication is the
   accepted cost of reusing the gates unmodified, do not optimize it away.
2. Serve `dist/` on the chosen port exactly the way preview-posts does: spawn
   `npx astro preview --port <n>` as a child process (no hand-rolled static server).
3. Write the review page via `reviewTargets` + `renderReviewPage` to `.preview/review.html`
   and open it (macOS `open`), unless `--no-open`.
4. Prompt on stdin: `approve these N file(s) and ship? [y/N]` after printing the exact file
   list and digest. Any answer except `y` stops the server and exits 0 with nothing
   recorded.

### Step 3: gate

1. Freshness check, both modes: recompute the change set and digest from the tree now.
   Interactive mode compares against the digest displayed at the prompt; `--yes` mode
   compares against the `--digest` argument. On mismatch, abort with a plain message (the
   tree changed since the review, likely another session; re-run the flow) and record
   nothing. This closes the window in which a concurrent session's post edit could ride
   along self-approved and unseen, and it is the same rule the preview-posts skill states
   for approvals ("stop if the list contains changes the owner has not seen"), enforced in
   code.
2. Record the approval, `writeManifest(root, hashChangeSet(root, changeSet), { baseRef })`,
   identical to `npm run preview-posts -- --approve`.
3. Stop the review server if one is running (there is none in `--yes` mode), then run
   `runChecks(root)` (quick mode) and print the per-check table like the release-check CLI
   does. If `verdict(results)` is not GO, print the failing checks and abort. Nothing has
   been committed at this point; the recorded approval is harmless (it voids itself on the
   next file change).

### Step 4: ship

1. Stage and commit exactly the post files from the change set, in one command, explicit
   paths only. Default message: `post: update <slug>` for one post (slug via
   `slugForPostFile`), `post: update <slug1>, <slug2>, ...` for several, deduplicated when a
   primary and its sibling both changed. `--message` overrides. The commit body carries the
   standard Co-Authored-By trailer only when ship is driven by an agent, detected via the
   `CLAUDECODE` environment variable Claude Code sets in its shell; when the owner runs it
   directly there is no trailer (plain authored commit).
2. Push `origin main`.
3. Watch the GitHub Pages deploy: poll `gh run list --workflow deploy.yml` for the pushed
   SHA until completed (timeout 5 minutes), then print the live URL of each shipped post
   (`https://theneverless.com/posts/<slug>/`) and exit 0. If `gh` is unavailable or the
   watch times out, print the Actions URL and exit 0 anyway; the push already succeeded and
   the deploy outcome is observable there.

## Conversational entry point: the ship-posts skill

A repo skill at `.claude/skills/ship-posts/SKILL.md`, following the format of the existing
checkpoint, release-check, and preview-posts skills. Its description triggers on requests
like "push my edits", "ship my posts", "publish what I changed in the editor". The skill is
a runbook for the session, not new machinery:

1. Run `npm run ship -- --preflight`. If it aborts (wrong branch, origin moved, non-post
   changes), surface the message and fall back to the normal session workflow; do not
   improvise around it. On success, note the printed file list and digest.
2. Run `npm run preview-posts` on an explicit free port and hand the owner the review link
   listing their changed posts (the production build, not the dev render), together with
   the file list from step 1.
3. Wait for the owner's explicit approval in chat ("approved", "push", "ship it") AFTER
   they have the link. The initial "push my edits" request is the request, not the
   approval; never treat it as both.
4. Stop the preview server, then run `npm run ship -- --yes --digest <d>` with the digest
   from step 1. Ship re-verifies the tree still matches and aborts otherwise (for example,
   another session edited a post meanwhile); on a digest abort, start over from step 1
   rather than retrying with a fresh digest the owner has not reviewed. On success it
   records the approval, runs release-check, commits the post files, pushes, and watches
   the deploy.
5. Report the per-check results and the live post URLs.

The skill also states the hard rule for agents: `--yes` may only ever follow an owner
approval message in the same conversation, given after step 2's link. This keeps the
preview gate's meaning identical across both entry points.

## Error handling

Every abort prints one plain-language paragraph: what was found, why ship stopped, what to
do next. Abort exit code is 1 for real failures (dirty preflight, stale digest, NO-GO,
build failure) and 0 for clean declines (nothing to ship, answered N). The review server always stops on exit
(try/finally). Ship never touches files outside `.preview/` and git state, and its only git
mutations are the single commit and the push in step 4.

## Testing

`scripts/ship.test.mjs` (`node:test`, fixture repos from scripts/test-helpers.mjs), added to
the `test:safety` suite, covering the pure decision logic:

- Purity check: posts-only sets pass; mixed sets abort with the offending paths; a
  committed non-post change that was reverted in the working tree still aborts (the
  origin/main...HEAD union catches it).
- Commit message generation: single post, multiple posts, primary + sibling deduplication,
  `--message` override.
- Preflight: non-main branch aborts; behind origin/main aborts; empty change set is a clean
  exit; `--preflight` stops after step 1 in both outcomes.
- Digest: stable across recomputation on an unchanged tree; changes when any post file
  changes; `--yes` with a stale digest aborts before writing the approval manifest;
  `--yes` without `--digest` is a usage error.

The interactive path (serve, prompt, push) is exercised manually; the components it chains
(preview approval hashing, release checks) already have their own suites.

## Documentation

- docs/post-editor.md: replace the manual publish description with a "Shipping your edits"
  section presenting both entry points: `npm run ship` in a terminal, or "push my edits" to
  any Claude Code session (keeping the manual steps as a fallback footnote).
- CLAUDE.md commands table: one row for `npm run ship`; the Safety section gains a line for
  the ship flow and its skill, alongside the existing checkpoint, release-check, and
  preview-gate entries.
- The ship-posts skill file itself (`.claude/skills/ship-posts/SKILL.md`) doubles as the
  agent-facing documentation.
- One cross-reference line in `.claude/skills/preview-posts/SKILL.md` noting that
  `npm run ship` records the same manifest-based approval, so readers know there are two
  writers of `.preview/manifest.json`.
