# AGENTS.md

Guidance for AI agents and new contributors working in this repository.

## What this is

Personal blog "NeVeRtheLeSs" (2005 to present, bilingual zh/en). Astro 7 + the astro-tone theme. Deploys to GitHub Pages via `.github/workflows/deploy.yml` on every push to `main` once its checks pass (see Safety); served at https://theneverless.com (DNS on Cloudflare, registration at GoDaddy; anping.us 301-redirects here but will be allowed to expire, so nothing may reference it; images are on https://cdn.theneverless.com).

## Start with the relevant guidance

- This file is the canonical repository entry point. `CLAUDE.md` refers here; maintained skills live in `.agents/skills/`, with `.claude/skills/` aliases. Edit the canonical files, not separate copies.
- Read [completion criteria](docs/completion-criteria.md) for page, collection, image, and publishing work. Match the current accepted result and all applicable criteria together before calling a revision ready.
- For writing, critique, dictated edits, or translation, read [.agents/skills/writing-posts/SKILL.md](.agents/skills/writing-posts/SKILL.md). For image-pipeline mechanics, read [docs/images.md](docs/images.md).
- **Model-car work only** (gallery records, car images, redraws): read the car docs below only for that work; posts and other tasks skip them.
  - Gallery criteria (identity, source, finished card, accepted choices): [docs/model-car-criteria.md](docs/model-car-criteria.md).
  - For explicitly authorized model-car AI redraws and background variants, follow [docs/model-car-redraws.md](docs/model-car-redraws.md), including reference preservation, per-model prompts, actual gallery inspection and scoped publication.
  - **Official-source checks are mandatory for every new or replaced model-car image, including AI generation inputs.** Read the exact manufacturer's official website and full product gallery, inspect the actual photographs, and retain the check before selecting a reference. A convenient retailer image, a search result, or a failed request does not satisfy this gate. See the source requirements in [model-car criteria](docs/model-car-criteria.md#identity-and-source).
- The owner's latest explicit direction takes precedence. A correction changes its stated scope; carry forward other accepted choices. A treatment approved for one image is not a general treatment policy.
- The website workspace's `../drafts/current-work.md` is a dated local handoff, not authority over newer messages, files, or deployment evidence. Keep public repository documentation free of private records and conversation transcripts.

## Commands

| Command                                          | Action                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `preview`              | Standard Astro workflow (build also runs Pagefind); dev server also serves the local post editor at /\_edit; under an agent, Astro 7 `dev` detaches unless given `--ignore-lock` (stop with `npx astro dev stop`) |
| `npm run preview-posts`                          | Build and serve the site for owner review of changed posts; `-- --approve` records the approval (see Safety)                                                                                                      |
| `npm run check` / `lint` / `lint:css` / `format` | Type check, ESLint, Stylelint, Prettier                                                                                                                                                                           |
| `npm run images`                                 | Daily image pipeline: optimize + upload staged photos (see below)                                                                                                                                                 |
| `npm run images:migrate`                         | One-time backfill CLI, already executed; dry-run by default                                                                                                                                                       |
| `npm run test:images`                            | Image pipeline test suite (`node:test`); the R2 live test runs only with `R2_LIVE=1` (it writes to the production bucket), which release-check never sets                                                         |
| `npm run test:rehype`                            | Rehype plugin test suite (image gallery detection)                                                                                                                                                                |
| `npm run test:drafts`                            | Draft rendering test: production builds have no draft page, review builds render it marked Draft and noindex (real Astro builds, about a minute)                                                                  |
| `npm run test:editor`                            | Post editor API test suite (`node:test`)                                                                                                                                                                          |
| `npm run test:library`                           | Library script test suite (car variants)                                                                                                                                                                          |
| `npm run library:car-variants`                   | 480/800 px WebP car variants on R2; required for every new or replaced car image (`-- --verify` checks the CDN)                                                                                                   |
| `npm run checkpoint`                             | Working-tree snapshots: `save` / `list` / `diff` / `restore` (see Safety)                                                                                                                                         |
| `npm run release-check`                          | Pre-push checklist, `-- --full` adds CDN + link verification (see Safety)                                                                                                                                         |
| `npm run check:content`                          | Content checks on changed posts: translation pairs, alt text, em dashes (release-check check 13)                                                                                                                  |
| `npm run check:links`                            | Internal links in the built site (`dist/`)                                                                                                                                                                        |
| `npm run ship`                                   | One-command publish for changed posts and library data: review, approve, release checks, commit, push (see Safety)                                                                                                |
| `npm run test:safety`                            | Test suite for checkpoint, release-check, preview-posts, ship, and content-check                                                                                                                                  |

## Architecture

- **Posts** live in `src/content/posts/*.md`, with language siblings resolved by `src/utils/translations.ts`. Keep each language's body, title, and description aligned with that language's file; shared metadata belongs to the primary post. Inspect the current resolver before bulk metadata changes.
- **Category keys are stable identifiers.** Change reader-facing names in `categoryLabels` in `astro-theme-config.ts`; do not mass-rename raw frontmatter keys or store display labels as keys.
- **Off Duty library**: the `/library/` overview plus one page per section at `/library/{movies,books,games,cars,hotels}/` (films/TV, books, games, model cars, hotels); old `/library/#section` links redirect. Data lives in `src/data/library/`; local movie entries override imported rows by ID. Import scripts are explicit operations, not permission to regenerate every collection. Private recordkeeping and destination publication are separate decisions; an internal field does not authorize a new public label.
- **Images are NOT in this repo.** They are served from Cloudflare R2 at `https://cdn.theneverless.com` (bucket `anping-blog-images`). Full-resolution originals are archived outside the repo (NAS or a local git-ignored `originals/` folder). The pipeline lives in `scripts/images/`; the complete runbook, including the daily authoring flow and Cloudflare setup, is [docs/images.md](docs/images.md).
- Exception: hero images in `src/assets/hero/` are Astro-optimized at build time and are deliberately outside the R2 pipeline. New covers must meet the minimum size spec in [docs/images.md](docs/images.md) (roughly 2400x1260 wide or 1600x1600 square, lightly compressed) or they render blurry in the home cards.
- Pipeline credentials go in `.env.local` (git-ignored); the variable names are documented in `.env.example`. Without credentials, dry-run modes and all tests still work.
- `scripts/migrate/` is finished WordPress-migration tooling (Python). Design history lives in `docs/`, including `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- **Local post editor**: `/_edit` on the dev server (dev-only Astro integration in `scripts/post-editor/`, zero build footprint). Runbook: [docs/post-editor.md](docs/post-editor.md).
- **Drafts**: `draft: true` posts render at their own `/posts/<slug>/` URL in `astro dev` and in the review builds (`preview-posts`, `ship --review`, which set `SHOW_DRAFTS=1`; CI refuses it and production builds strip it), marked Draft and noindex and kept out of lists, feeds and search. They never reach production. The old `src/pages/draft-preview` route is gone.
- **Protected posts**: `protected: true` in frontmatter (primary AND sibling translation) encrypts the post body at build time; the password comes from `POST_PASSWORD` (`.env.local` locally, GitHub Actions secret in deploys). Title, description, and hero stay public, and the markdown source is readable in this public repo. Runbook: [docs/protected-posts.md](docs/protected-posts.md).

## Safety

- **Checkpoints** (`npm run checkpoint`, skill: [.agents/skills/checkpoint/SKILL.md](.agents/skills/checkpoint/SKILL.md)): file-level snapshots in hidden local refs. Release checks save one. `.claude/settings.json` also defines a Claude SessionStart hook; do not assume a Codex session ran that hook. Save a labeled checkpoint before the risky operations listed in the skill.
- **Release checklist** (`npm run release-check`, skill: [.agents/skills/release-check/SKILL.md](.agents/skills/release-check/SKILL.md)): required before manual or agent-driven pushes to `main`. GO describes checked technical conditions, not visual acceptance or publication authorization. With the owner's authorization for the reviewed scope, finish the commit, push, and deployment verification without asking for the same permission again.
- **Preview gate** (`npm run preview-posts`, skill: [.agents/skills/preview-posts/SKILL.md](.agents/skills/preview-posts/SKILL.md)): finish and inspect the changed result before showing its actual production-preview page. Approval is hash-keyed in git-ignored `.preview/` and merges across sessions (locked, atomic writes, 30-day expiry); release-check check 12 is NO-GO when preview-relevant files changed without it. The safety tools build into private temporary directories, never `dist/`. A generic homepage or sample post does not establish review of the car gallery.
- **Ship** (`npm run ship`, skill: [.agents/skills/ship-posts/SKILL.md](.agents/skills/ship-posts/SKILL.md)): publishes changed posts with their translation siblings, their referenced changed hero covers, changed `src/data/library/*.json`, and explicit `--include` paths, with approval bound to the reviewed bytes. It builds and checks a temporary worktree of `origin/main` plus only those files, so unrelated dirty files are ignored, then commits explicit paths. Agent flow: `--preflight`, `--review`, the owner approves in chat, then `--yes --digest <d>`; `--dry-run` rehearses without committing or pushing. Other changes use the normal scoped commit and release flow.
- **Deploy gate**: a push to `main` deploys only after the workflow's checks (type check, lint, tests, build, internal links) pass. `main` is protected against force-push and deletion.
- **Post-deploy rollback**: `git revert` the bad commit(s) on `main` and push; the Pages workflow redeploys the previous good state.

## Established workflows

- **Image storage:** use the R2 pipeline and CDN for post images. `public/uploads/` is retired. Historical migration counts are not current inventory totals.
- **Bilingual toggle:** the `bilingual-toggle` branch was merged and deleted on 2026-07-14; do not recreate it. Verify changed posts and their siblings rather than assuming all archived entries have complete translations. Feeds: `/rss.xml` (Chinese where available) and `/rss.en.xml` (English); `?lang=en` or `?lang=zh` opens a page in that language.
- **Single-branch workflow.** All day-to-day work happens on `main` in this checkout. A long-running independent track gets its own branch in its own worktree (`git worktree add`), like `tweets-notes`; it never shares this checkout.

## Rules

### Completion and owner review

Follow [docs/completion-criteria.md](docs/completion-criteria.md), including the accepted collection, source, image, and book-cover decisions (car decisions are in [docs/model-car-criteria.md](docs/model-car-criteria.md)). A known unmet requirement stays unfinished unless the owner accepts that specific exception. For car-page changes, show the finished page first; keep source and comparison evidence available without making the owner work through another report. Requested audits still use HTML reports with relevant actual imagery.

1. Stage explicit paths only. Never `git add -A` or `git add .`.
2. No em-dashes in user-facing copy: posts, docs, console messages, commit messages. Use commas, colons, or parentheses.
3. Never commit: `.env.local`, `image-staging/`, `originals/`, `scripts/images/.manifest.json` (all git-ignored; keep them that way).
4. This is a public repository. No secrets, tokens, or personal data in commits. Blog content (posts, comments, media) is all-rights-reserved; only the theme code is MIT. See README.
5. Deploys are automatic on push to `main`. Do not push or merge to `main` without the owner's go-ahead.
6. Multiple agent sessions often work in this checkout at the same time. Stage and commit in a single step with explicit paths (`git commit -m "..." -- <paths>`); never leave files staged between commands, and re-verify the current branch before any HEAD-relative mutation.
7. Never move a branch that is checked out in any worktree from outside that worktree (no `git update-ref`, `git branch -f`, or `git reset` on it from elsewhere). To advance the checked-out branch, run `git merge --ff-only <commit>` inside its checkout, so the index and working tree move together with the ref. Compare-and-swap `git update-ref refs/heads/X <new> <expected-old>` remains the right tool for branches that are NOT checked out anywhere.
8. If `git status` suddenly shows mass staged deletions (or modifications) of files you did not touch, stop: that is the signature of rule 7 being violated (the checked-out branch was moved from outside; the index and working tree were left behind). It is not data loss. Confirm the files exist in HEAD (`git ls-tree HEAD -- <path>`), then repair with `git restore --source=HEAD --staged --worktree -- <paths>`. Never commit or "clean up" such a state.
