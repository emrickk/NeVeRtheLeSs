# Local post editor

A dev-only editing page for quick post edits during review. It exists only
while the dev server runs; production builds contain nothing from it.

## Using it

1. `npm run dev` (pick your own free port when sessions share this checkout:
   `npm run dev -- --port 4567`)
2. Open `http://localhost:<port>/_edit`

The sidebar lists changed posts first (relative to origin/main, same
detection as the preview gate, so drafts never appear there), then all posts
newest first with a filter box. Opening a post loads the raw file,
frontmatter included, with a tab for the sibling translation when one
exists. The right pane is the real rendered post from the same dev server;
it follows the language of the file you are editing.

Save with the button or Cmd+S. The preview reloads as soon as the dev server
serves the new content, usually within a second or two. Frontmatter mistakes
show up as Astro's own error overlay in the preview, which is the same error
the build would give.

If a banner says the preview has not picked up a change after 8 seconds, the
save is safely on disk but the dev server's file watcher is wedged (a known
gotcha when several sessions run dev servers against this checkout). Restart
your own dev server to get live previews back.

## Conflicts

Saves are hash-guarded. If another session changed the file after you loaded
it, the save returns a conflict banner instead of overwriting: "Reload from
disk" replaces your editor text with the file on disk (it warns first; your
text is not kept anywhere), "Overwrite" saves your text over the newer file.

## Shipping your edits

Three entry points share the same guarded Git scope:

- **Nevertheless Editor**: Publish saves the open post, selects it and its
  existing translation sibling, and uses the scoped fast lane. If that post
  references a changed local hero cover under `src/assets/hero/`, the cover is
  included automatically. The exact post and cover bytes are digest-bound,
  validated, committed with explicit paths, pushed, and watched through the
  deploy. An unrelated image, a cover shared with an unselected post, or any
  changed non-post file stops the publish.
- **Terminal**: `npm run ship`. It builds the production site and opens the
  review page, asks one `approve these N file(s) and ship? [y/N]`, then runs
  the release checklist, commits the posts and any directly referenced changed
  hero covers, pushes, and watches the deploy.
- **Conversation**: open any Claude Code session and say "push my edits". The ship-posts
  skill walks the same gates: you get the production review link, you say
  "approved" (or "push"), and it ships.

Every entry point binds its decision to the exact file bytes printed by
preflight. If anything changes in between, ship aborts instead of publishing a
different tree. The editor fast lane is deliberately scoped and automated; it
does not record a production-preview approval or run the whole-tree release
check. Use the terminal or conversation flow whenever you want the full
production review, and always for templates, config, notes, or unrelated
assets. Manual fallback: `npm run preview-posts`, then
`npm run preview-posts -- --approve`, then `npm run release-check`, then commit
explicit paths and push.

## Interaction with the preview gate

Saving a post changes its content hash, which invalidates any preview-posts
approval covering that file. That is the intended gate behavior: edited
posts need a fresh review before release-check goes GO.

The Nevertheless Editor fast lane does not write `.preview/manifest.json`.
Its safety boundary is the selected post pair plus its referenced changed hero,
strict local/remote synchronization, a content digest, focused validators, and
the GitHub Actions production build.

## Troubleshooting (for owners and agents)

Learned the hard way on 2026-07-17; read this before debugging a "stale
preview" report.

- **Editor saves do not depend on the OS file watcher.** The save API emits a
  synthetic watcher event for its own writes, so an editor save syncs the
  content store even when macOS fsevents has died. If the editor still shows
  the 8-second warning banner, something worse than a wedged watcher is going
  on: check that the dev server process is actually alive.
- **The dev server watcher can die silently under multi-session load.**
  Symptom: pages serve fine but changes made OUTSIDE the editor (shell, git,
  another session) stop appearing, and the server log shows no reload or sync
  lines for them. Only fix: restart your own dev server. Editor saves keep
  working through it (see above).
- **Run the dev server as a plain process.** `npm run dev -- --port 4321` in
  a terminal (or the `blog-editor` launch.json entry). Do not use an
  autoPort launch entry: the Browser-pane preview tool misreports its port
  and has silently killed such servers mid-session (the old `blog-dev-auto`
  entry was removed for this). If port 4321 is taken, pick a free one; the
  editor works on any port.
- **"Save failed" or a connection error in the editor tab** means the dev
  server died, not that the edit was lost: every successful save is already
  on disk, and an unsaved buffer stays in the browser tab. Restart the
  server and save again.
- **Conflict banner (file changed on disk)** is the cross-session guard
  working: another session or agent wrote the file after you loaded it.
  Reload from disk to take theirs, or Overwrite to keep yours.

## Where things live

- `scripts/post-editor/integration.mjs`: dev-server middleware (the only
  Astro hook used is astro:server:setup, which never fires in builds)
- `scripts/post-editor/api.mjs`: file API, unit-tested by
  `npm run test:editor`
- `scripts/post-editor/ui/`: the page itself (plain HTML, CSS, JS)
