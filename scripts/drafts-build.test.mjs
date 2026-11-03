// End-to-end check of draft rendering (src/utils/drafts.ts): a production
// build has no page for a draft post, a review build (SHOW_DRAFTS=1, what
// preview-posts and ship use) renders it at its normal URL with noindex and
// a Draft marker, and neither build lists it anywhere else. Runs real Astro
// builds of a trimmed copy of this repo (a few posts plus one fixture draft)
// in the OS tmpdir; the repo itself is never written. About a minute.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildSite } from './build-output.mjs'
import { walkFiles } from './release-check.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const DRAFT_SLUG = 'fixture-draft-zz9'
const DRAFT_TITLE = 'Fixture draft zz9 title'
const PUBLISHED = ['1269.md', '1190-2.md', '1184-2.md']

function makeSite() {
  const site = mkdtempSync(join(tmpdir(), 'blog-drafts-test-'))
  for (const rel of ['astro.config.mjs', 'astro-theme-config.ts', 'package.json', 'tsconfig.json']) {
    cpSync(join(REPO, rel), join(site, rel))
  }
  // astro.config.mjs imports the rehype plugins and the dev-only editor,
  // which import other scripts; the migration tooling is not needed.
  cpSync(join(REPO, 'public'), join(site, 'public'), { recursive: true })
  cpSync(join(REPO, 'scripts'), join(site, 'scripts'), {
    recursive: true,
    filter: (p) => !p.startsWith(join(REPO, 'scripts/migrate')),
  })
  // src without the post collection and hero covers; the kept posts have no
  // hero image.
  cpSync(join(REPO, 'src'), join(site, 'src'), {
    recursive: true,
    filter: (p) => !p.startsWith(join(REPO, 'src/content/posts/')) && !p.startsWith(join(REPO, 'src/assets/hero')),
  })
  mkdirSync(join(site, 'src/content/posts'), { recursive: true })
  for (const f of PUBLISHED) cpSync(join(REPO, 'src/content/posts', f), join(site, 'src/content/posts', f))
  writeFileSync(
    join(site, 'src/content/posts', `${DRAFT_SLUG}.md`),
    `---\ntitle: '${DRAFT_TITLE}'\ndescription: 'Fixture draft description'\npubDate: '2099-01-01'\nlang: 'en'\ndraft: true\n---\n\nFixture draft body.\n`
  )
  symlinkSync(join(REPO, 'node_modules'), join(site, 'node_modules'))
  return site
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.CI
  return env
}

// Every built text file except the draft's own page.
function filesMentioningDraft(dist) {
  return walkFiles(dist, ['.html', '.xml', '.json'])
    .filter((p) => !p.startsWith(join(dist, 'posts', DRAFT_SLUG) + '/'))
    .filter((p) => {
      const text = readFileSync(p, 'utf8')
      return text.includes(DRAFT_SLUG) || text.includes(DRAFT_TITLE)
    })
    .map((p) => p.slice(dist.length + 1))
}

test('draft posts: absent from production builds, rendered and unlisted in review builds', { timeout: 600000 }, (t) => {
  const site = makeSite()
  t.after(() => rmSync(site, { recursive: true, force: true }))

  // Production, even with SHOW_DRAFTS exported by the calling shell.
  const prod = join(site, 'out-prod')
  const built = buildSite(site, prod, { env: cleanEnv({ SHOW_DRAFTS: '1' }) })
  assert.equal(built.ok, true, built.output)
  assert.equal(existsSync(join(prod, 'posts', DRAFT_SLUG)), false)
  assert.deepEqual(filesMentioningDraft(prod), [])
  for (const f of walkFiles(prod, ['.html'])) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /data-draft-page/, f)
  }
  assert.ok(readdirSync(join(prod, 'posts')).length >= PUBLISHED.length)

  // Review build: the draft renders at its normal URL, marked and noindex.
  const review = join(site, 'out-review')
  const reviewBuilt = buildSite(site, review, { env: cleanEnv(), showDrafts: true })
  assert.equal(reviewBuilt.ok, true, reviewBuilt.output)
  const page = readFileSync(join(review, 'posts', DRAFT_SLUG, 'index.html'), 'utf8')
  assert.match(page, /<meta name="robots" content="noindex">/)
  assert.match(page, /class="draft-marker"[^>]*>Draft/)
  assert.match(page, /data-draft-page/)
  assert.match(page, /<html lang="en"/)
  // Published pages keep normal indexing in the same build.
  const published = readFileSync(join(review, 'posts', '1269', 'index.html'), 'utf8')
  assert.match(published, /<meta name="robots" content="index, follow">/)
  assert.doesNotMatch(published, /data-draft-page/)
  // Lists, feeds, and other pages never mention it. The review
  // build's sitemap may list it (review builds are never deployed).
  assert.deepEqual(
    filesMentioningDraft(review).filter((f) => !f.startsWith('sitemap-')),
    []
  )

  // A review build refuses to run under CI.
  const ci = buildSite(site, join(site, 'out-ci'), {
    env: { ...cleanEnv(), CI: 'true' },
    showDrafts: true,
  })
  assert.equal(ci.ok, false)
  assert.match(ci.output, /SHOW_DRAFTS=1 is for local review builds only/)
})
