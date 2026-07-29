# CLAUDE.md

Guidance for AI agents and new contributors working in this repository.

## What this is

Personal blog "NeVeRtheLeSs" (2005 to present, 343 posts, bilingual zh/en). Astro 6 + the astro-tone theme. Deploys to GitHub Pages via `.github/workflows/deploy.yml` on every push to `main`; served at https://theneverless.com (DNS on Cloudflare, registration at GoDaddy; anping.us 301-redirects here but will be allowed to expire, so nothing may reference it; images are on https://cdn.theneverless.com).

## Commands

| Command | Action |
| --- | --- |
| `npm run dev` / `build` / `preview` | Standard Astro workflow (build also runs Pagefind); dev server also serves the local post editor at /_edit |
| `npm run preview-posts` | Build and serve the site for owner review of changed posts; `-- --approve` records the approval (see Safety) |
| `npm run check` / `lint` / `lint:css` / `format` | Type check, ESLint, Stylelint, Prettier |
| `npm run images` | Daily image pipeline: optimize + upload staged photos (see below) |
| `npm run images:migrate` | One-time backfill CLI, already executed; dry-run by default |
| `npm run test:images` | Image pipeline test suite (`node:test`); the R2 live test self-skips without credentials |
| `npm run test:rehype` | Rehype plugin test suite (image gallery detection) |
| `npm run test:editor` | Post editor API test suite (`node:test`) |
| `npm run checkpoint` | Working-tree snapshots: `save` / `list` / `diff` / `restore` (see Safety) |
| `npm run release-check` | Pre-push checklist, `-- --full` adds CDN + link verification (see Safety) |
| `npm run ship` | One-command publish for post edits and directly referenced changed hero covers: review, approve, release-check, commit, push (see Safety) |
| `npm run test:safety` | Test suite for the three safety CLIs |

## Architecture

- **Posts** live in `src/content/posts/*.md` as pairs linked by `translationKey`: the primary `<slug>.md` owns the URL, the shared metadata (pubDate, hero, category, flags), and its own language's title, description, and body; the sibling `<slug>.en.md` / `<slug>.zh.md` holds the other language's title, description, and body. Each language's text lives only in that language's file (`src/utils/translations.ts` resolves display text).
- **Category keys are stable identifiers, decided 2026-07-23.** Frontmatter `category` holds a raw key (`Journal`, `Things`, `Prodigal`, `Words`, `Repost`); readers only ever see the bilingual display names mapped in `categoryLabels` in `astro-theme-config.ts` (Words shows as 随想/Musings, Things as 长考/Ponderings, Prodigal as 败家/Splurges). To rename a category, change its label in that map only; never mass-rename the raw keys across post frontmatter, and never write a display name into `category`.
- **Images are NOT in this repo.** They are served from Cloudflare R2 at `https://cdn.theneverless.com` (bucket `anping-blog-images`). Full-resolution originals are archived outside the repo (NAS or a local git-ignored `originals/` folder). The pipeline lives in `scripts/images/`; the complete runbook, including the daily authoring flow and Cloudflare setup, is [docs/images.md](docs/images.md).
- Exception: hero images in `src/assets/hero/` are Astro-optimized at build time and are deliberately outside the R2 pipeline. New covers must meet the minimum size spec in [docs/images.md](docs/images.md) (roughly 2400x1260 wide or 1600x1600 square, lightly compressed) or they render blurry in the home cards.
- Pipeline credentials go in `.env.local` (git-ignored); the variable names are documented in `.env.example`. Without credentials, dry-run modes and all but one test still work.
- `scripts/migrate/` is finished WordPress-migration tooling (Python). Design history lives in `docs/`, including `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- **Media library page** (`/library`, "没干正事 / Off Duty"): watched films/TV and played games as a poster grid. Data is a committed snapshot in `src/data/library/` regenerated manually by `node scripts/library/build-snapshot.mjs` from two owner-local sources (never wired into the site build): the douban-export folder (membership, titles, hours, covers) plus the newest media.db resolved export, whose `manual: true` rows overlay the owner's refreshed ratings and comments and can append brand-new works; `--covers` thumbnails cover art to R2 under `library/`. That script is the only gate deciding what library data goes public: books, wish lists, backlogs, non-manual rows from other watch sources, and owner-held entries stay out.
- **Local post editor**: `/_edit` on the dev server (dev-only Astro integration in `scripts/post-editor/`, zero build footprint). Runbook: [docs/post-editor.md](docs/post-editor.md).
- **Protected posts**: `protected: true` in frontmatter (primary AND sibling translation) encrypts the post body at build time; the password comes from `POST_PASSWORD` (`.env.local` locally, GitHub Actions secret in deploys). Title, description, and hero stay public, and the markdown source is readable in this public repo. Runbook: [docs/protected-posts.md](docs/protected-posts.md).

## Safety

- **Checkpoints** (`npm run checkpoint`, skill: `.claude/skills/checkpoint/`): file-level snapshots of the working tree in hidden local refs. Auto-saved at session start (hook in `.claude/settings.json`) and by every release check. Restore before push mistakes become deploy mistakes.
- **Release checklist** (`npm run release-check`, skill: `.claude/skills/release-check/`): required before manual or agent-driven pushes to `main`. Ends in GO / NO-GO; pushing remains a human decision (rule 5). The Nevertheless Editor scoped fast lane is the explicit exception described below.
- **Post preview gate** (`npm run preview-posts`, skill: `.claude/skills/preview-posts/`): the owner reviews every changed post in the browser against the production build; approval is hash-keyed in git-ignored `.preview/` and release-check check 12 is NO-GO when preview-relevant files changed without it.
- **Ship** (`npm run ship`, skill: `.claude/skills/ship-posts/`): one-command publish for changed posts plus changed local hero covers directly referenced by those posts. It chains checkpoint, preview review, approval, release-check, explicit-path commit, and push with the approval digest-bound to the reviewed bytes. Unrelated assets and every other path still require the full manual flow.
- **Nevertheless Editor fast lane** (`npm run ship -- --fast --only ...`): scoped to the open post, its existing translation sibling, and only their directly referenced changed hero cover. It requires local `main` to equal `origin/main`, binds every selected byte into the digest, runs focused post and image checks, commits explicit paths, and treats the GitHub Actions build as the final deploy gate. It intentionally does not create a production-preview approval or run the whole-tree release checklist.
- **Post-deploy rollback**: `git revert` the bad commit(s) on `main` and push; the Pages workflow redeploys the previous good state.

## Project status (last updated 2026-07-14)

- **Image storage on R2: complete.** All post images (217 objects) are on R2, every post references `cdn.theneverless.com`, and `public/uploads/` has been removed from the repo.
- **Bilingual toggle: complete and live.** Every post has zh/en titles and sibling bodies. The long-lived `bilingual-toggle` branch was merged and deleted on 2026-07-14; do not recreate it.
- **Single-branch workflow.** All day-to-day work happens on `main` in this checkout. A long-running independent track gets its own branch in its own worktree (`git worktree add`), like `tweets-notes`; it never shares this checkout.

## Rules

1. Stage explicit paths only. Never `git add -A` or `git add .`.
2. No em-dashes in user-facing copy: posts, docs, console messages, commit messages. Use commas, colons, or parentheses.
3. Never commit: `.env.local`, `image-staging/`, `originals/`, `scripts/images/.manifest.json` (all git-ignored; keep them that way).
4. This is a public repository. No secrets, tokens, or personal data in commits. Blog content (posts, comments, media) is all-rights-reserved; only the theme code is MIT. See README.
5. Deploys are automatic on push to `main`. Do not push or merge to `main` without the owner's go-ahead.
6. Multiple agent sessions often work in this checkout at the same time. Stage and commit in a single step with explicit paths (`git commit -m "..." -- <paths>`); never leave files staged between commands, and re-verify the current branch before any HEAD-relative mutation.
7. Never move a branch that is checked out in any worktree from outside that worktree (no `git update-ref`, `git branch -f`, or `git reset` on it from elsewhere). To advance the checked-out branch, run `git merge --ff-only <commit>` inside its checkout, so the index and working tree move together with the ref. Compare-and-swap `git update-ref refs/heads/X <new> <expected-old>` remains the right tool for branches that are NOT checked out anywhere.
8. If `git status` suddenly shows mass staged deletions (or modifications) of files you did not touch, stop: that is the signature of rule 7 being violated (the checked-out branch was moved from outside; the index and working tree were left behind). It is not data loss. Confirm the files exist in HEAD (`git ls-tree HEAD -- <path>`), then repair with `git restore --source=HEAD --staged --worktree -- <paths>`. Never commit or "clean up" such a state.
