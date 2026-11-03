# Password-protected posts

Give any post a password gate: the body is encrypted at build time and readers
must enter the password in the browser before the content decrypts. The site
stays fully static; nothing changes about hosting or deploys.

This is soft gating, not privacy. The markdown source of a protected post and
the CDN URLs of its images are public in this repository and its history; only
the rendered site is gated. Truly private posts must stay out of the repo.

## How to protect a post

1. Add the flag to the post's frontmatter:

   ```yaml
   protected: true
   ```

   Bilingual posts must carry the flag in **both** files: the primary
   (`<slug>.md`) and the sibling translation (`<slug>.en.md` or `<slug>.zh.md`).
   The build fails with a clear error if only one of the pair is flagged.

2. Make sure the password is configured:
   - **Locally**: `POST_PASSWORD=...` in `.env.local` (git-ignored).
   - **Deploys**: a `POST_PASSWORD` repository secret in GitHub Actions
     (`gh secret set POST_PASSWORD`, or Settings, Secrets and variables,
     Actions). It must hold the same value as `.env.local`, otherwise locally
     reviewed pages and deployed pages unlock with different passwords.

   The build fails when a protected post exists and no password is set, so a
   missing secret can never publish plaintext.

3. Build and review as usual (`npm run preview-posts`, `npm run ship`). The
   post page shows a bilingual unlock form instead of the body.

To unprotect a post, remove the flag from both files and rebuild.

## What readers see

The post page loads with the title, date, description, and hero image visible,
and a small unlock form in place of the body. A correct password decrypts the
body in place (both language bodies at once for bilingual posts); a wrong one
shows an inline error. The password is kept in `sessionStorage` for the tab, so
reloading or returning to the post in the same tab does not re-prompt.

## What is protected, and what is not

Protected:

- The full post body, including image URLs, headings, and galleries. The
  built HTML contains only an AES-256-GCM ciphertext (key derived with
  PBKDF2-SHA256, 600k iterations). The reading rail and page source see
  ciphertext only.

Not protected (choose them accordingly):

- The title, description, publication date, category, and hero image. They
  stay visible on the post page, home page, archive, RSS, and social
  previews. Do not put anything private in them.
- Giscus comments on the post, if any.
- The images themselves. CDN image URLs are public and unauthenticated, and
  they appear in the markdown source.
- **The markdown source itself.** This repository is public, so the body of a
  protected post is readable in the repo and its git history by anyone who
  looks. The password gates the rendered site (casual readers, search
  engines, link previews), not the source. Content that must stay truly
  private does not belong in this repo at all.

Changing `POST_PASSWORD` re-encrypts every protected post on the next build;
old passwords stop working everywhere at once. All protected posts share the
one password.

## How it works

- `scripts/rehype/protected-content.mjs` runs last in the rehype chain
  (registered in `astro.config.mjs`). For a file whose frontmatter has
  `protected: true`, it serializes the fully processed tree to HTML, encrypts
  it, and replaces the tree with one empty `<div data-protected-content>`
  whose attributes carry salt, IV, ciphertext, and iteration count. Salt and
  IV are derived deterministically (path and plaintext), so unchanged posts
  produce byte-identical builds.
- `src/components/ProtectedGate.astro` (rendered by `PostLayout` when the
  post is protected) shows the unlock form; `src/scripts/protected-post.ts`
  derives the key with Web Crypto and swaps the decrypted HTML back in, then
  fires a `protected-post:unlocked` event so the image lightbox, image
  loading states, and the reading rail bind the late-added content.
- `src/pages/posts/[...slug].astro` fails the build when a bilingual pair
  disagrees on the flag. Each file declares its own flag so the Astro content
  cache invalidates correctly; the guard catches the half-flagged state.
- Tests: `npm run test:rehype` covers encryption, the client decrypt path,
  determinism, and the failure modes.

## Limitations

- Plain `.md` only; a protected `.mdx` post fails the build (its body can
  contain components that cannot be serialized ahead of time).
- Code blocks in protected posts lose Expressive Code's page-level assets in
  some cases, since the page cannot see the code block at build time. Not a
  concern for photo and journal posts.
- Readers need JavaScript and a modern browser (Web Crypto) to unlock.
