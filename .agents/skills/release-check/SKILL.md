---
name: release-check
description: Run the pre-push release checklist and deliver a go/no-go verdict before anything is pushed to main (which auto-deploys to theneverless.com). Use whenever a push or merge to main is being considered.
---

# Release checklist

Pushing to `main` deploys to https://theneverless.com. This checklist reports GO or NO-GO for the conditions it checks; invoking it alone does not authorize publication. If the owner already authorized publishing the reviewed scope, complete the scoped commit, push, and deployment verification after the required checks pass. Do not ask for the same permission again. A GO verdict does not establish visual quality; apply [completion criteria](../../../docs/completion-criteria.md) before presenting work as ready.

## Quick mode (default)

1. Run `npm run release-check` from the repo root. It saves a checkpoint, then runs git hygiene, secret scan, types, lint, build, image tests, rehype tests, and built-output verification (checks 1 to 9, plus check 12: post preview approval).
2. Report the per-check results and the verdict.

If check 12 fails, preview-relevant files changed without an owner-approved preview: run `npm run preview-posts`, let the owner review in the browser, then `npm run preview-posts -- --approve` once they approve (see the preview-posts skill).

## Full mode

1. Run `npm run release-check -- --full` (adds check 10: every cdn.theneverless.com URL in the built site must return HTTP 200, and check 11: every internal link must resolve).
2. After the script passes, smoke-test the production build in a browser. Serve `dist/` with `npm run preview` (never the dev server), then verify:
   - homepage renders with the post list
   - one image-heavy post loads and its images come from cdn.theneverless.com
   - search returns results (Pagefind)
   - the language toggle switches title and body
   - the giscus comment iframe is present on a post
   - dark mode renders correctly
3. Also inspect the actual affected pages and interactions, including `/library/#cars` for car changes. Capture relevant evidence. Show the finished page when that is the requested deliverable; keep the check log and comparison evidence available rather than requiring a separate report on every revision.

## Report format

Retain every check's PASS / FAIL / SKIP result and one-line detail in the release evidence. Summarize relevant outcomes in the requested deliverable, with one technical verdict:

- `VERDICT: GO, safe to push` (all checks passed)
- `VERDICT: NO-GO` with the blocking items listed first

## Choosing a mode

Full mode before anything that touches many posts, images, templates, or dependencies. Quick mode is acceptable for single-post edits and typo fixes.

## If a bad deploy reaches theneverless.com

`git revert <bad commit>` on `main`, push (with the owner's go-ahead), and the Pages workflow redeploys the previous good state in a few minutes. Checkpoints cover pre-push file state; `git revert` covers post-push history.
