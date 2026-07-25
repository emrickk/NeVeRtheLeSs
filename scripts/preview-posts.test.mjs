// Tests for the post preview gate. Fixture repos live in the OS tmpdir via
// test-helpers.mjs; nothing here touches the real repo.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  checkPostPreview,
  classifyPath,
  computeChangeSet,
  hashChangeSet,
  isDraftPost,
  manifestDiff,
  parseFrontmatterScalars,
  primaryPostPath,
  readManifest,
  renderReviewPage,
  REPRESENTATIVE_POST,
  resolveBaseRef,
  resolveDiffBase,
  reviewTargets,
  slugForPostFile,
  writeManifest,
} from './preview-posts.mjs'
import { cleanup, makeFixtureRepo, run, write } from './test-helpers.mjs'

const FM = '---\ntitle: T\ndescription: D\npubDate: 2026-01-01\n---\n'

test('classifyPath: post content files', () => {
  assert.equal(classifyPath('src/content/posts/venice.md'), 'post')
  assert.equal(classifyPath('src/content/posts/venice.en.md'), 'post')
  assert.equal(classifyPath('src/content/posts/2008-04-03-p960.mdx'), 'post')
})

test('classifyPath: site-wide files', () => {
  assert.equal(classifyPath('src/styles/prose.css'), 'site')
  assert.equal(classifyPath('src/components/LangTitle.astro'), 'site')
  assert.equal(classifyPath('src/content.config.ts'), 'site')
  assert.equal(classifyPath('public/favicon.svg'), 'site')
  assert.equal(classifyPath('astro.config.mjs'), 'site')
  assert.equal(classifyPath('package.json'), 'site')
  assert.equal(classifyPath('package-lock.json'), 'site')
})

test('classifyPath: build inputs imported by astro.config.mjs are site-wide', () => {
  assert.equal(classifyPath('astro-theme-config.ts'), 'site')
  assert.equal(classifyPath('scripts/rehype/image-gallery.mjs'), 'site')
  assert.equal(classifyPath('scripts/rehype/image-gallery.test.mjs'), 'site')
})

test('classifyPath: note content files', () => {
  assert.equal(classifyPath('src/content/notes/20140724-093000.md'), 'note')
  assert.equal(classifyPath('src/content/notes/20140724-093000-2.md'), 'note')
  // Nested or non-markdown paths fall back to the site-wide bucket.
  assert.equal(classifyPath('src/content/notes/nested/x.md'), 'site')
})

test('classifyPath: irrelevant files', () => {
  assert.equal(classifyPath('docs/images.md'), null)
  assert.equal(classifyPath('scripts/release-check.mjs'), null)
  assert.equal(classifyPath('.github/workflows/deploy.yml'), null)
  assert.equal(classifyPath('README.md'), null)
})

test('slugForPostFile strips extension and language suffix', () => {
  assert.equal(slugForPostFile('src/content/posts/venice.md'), 'venice')
  assert.equal(slugForPostFile('src/content/posts/venice.en.md'), 'venice')
  assert.equal(slugForPostFile('src/content/posts/venice.zh.mdx'), 'venice')
  assert.equal(slugForPostFile('src/content/posts/2013-02-15111954.md'), '2013-02-15111954')
})

test('primaryPostPath maps siblings to the primary file', () => {
  assert.equal(primaryPostPath('src/content/posts/venice.en.md'), 'src/content/posts/venice.md')
  assert.equal(primaryPostPath('src/content/posts/venice.zh.mdx'), 'src/content/posts/venice.mdx')
  assert.equal(primaryPostPath('src/content/posts/venice.md'), 'src/content/posts/venice.md')
})

test('parseFrontmatterScalars strips inline comments outside quoted values', () => {
  const parsed = parseFrontmatterScalars(
    "---\ndraft: true # hidden\nheroImage: 'cover#one.webp' # local cover\n---\n"
  )
  assert.equal(parsed.draft, 'true')
  assert.equal(parsed.heroImage, 'cover#one.webp')
})

test('draft detection accepts YAML boolean casing', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: TRUE # hidden\n---\nv1\n')
  run(root, ['add', 'src/content/posts/wip.md'])
  run(root, ['commit', '-q', '-m', 'mixed-case draft'])
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: True # hidden\n---\nv2\n')
  assert.equal(isDraftPost(root, 'src/content/posts/wip.md'), true)
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), [])
})

test('computeChangeSet: modified, untracked, deleted, and irrelevant paths', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', FM + 'v1\n')
  write(root, 'src/content/posts/gone.md', FM + 'v1\n')
  run(root, ['add', 'src/content/posts/alpha.md', 'src/content/posts/gone.md'])
  run(root, ['commit', '-q', '-m', 'posts'])
  write(root, 'src/content/posts/alpha.md', FM + 'v2\n') // modified tracked
  write(root, 'src/content/posts/beta.md', FM + 'new\n') // untracked
  write(root, 'src/styles/x.css', 'body{}\n') // untracked site-wide
  write(root, 'docs/notes.md', 'irrelevant\n') // untracked irrelevant
  write(root, 'tracked.md', 'changed\n') // modified tracked irrelevant
  rmSync(join(root, 'src/content/posts/gone.md')) // deleted tracked
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), [
    'src/content/posts/alpha.md',
    'src/content/posts/beta.md',
    'src/content/posts/gone.md',
    'src/styles/x.css',
  ])
})

test('computeChangeSet: draft posts and their siblings are excluded', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: true\n---\nbody\n')
  write(root, 'src/content/posts/wip.en.md', 'english body\n')
  write(root, 'src/content/posts/live.md', FM + 'body\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), ['src/content/posts/live.md'])
})

test('computeChangeSet: a post edited while draft at the base ref stays excluded', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: true\n---\nv1\n')
  run(root, ['add', 'src/content/posts/wip.md'])
  run(root, ['commit', '-q', '-m', 'draft'])
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: true\n---\nv2\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), [])
})

test('computeChangeSet: inline-comment drafts are detected in current and base content', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: true # hidden\n---\nv1\n')
  run(root, ['add', 'src/content/posts/wip.md'])
  run(root, ['commit', '-q', '-m', 'inline-comment draft'])
  write(root, 'src/content/posts/wip.md', '---\ntitle: T\ndraft: true # still hidden\n---\nv2\n')
  assert.equal(isDraftPost(root, 'src/content/posts/wip.md'), true)
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), [])
})

test('computeChangeSet: a published post flipped to draft stays in the change set and reviews at /', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/live.md', FM + 'body\n')
  run(root, ['add', 'src/content/posts/live.md'])
  run(root, ['commit', '-q', '-m', 'publish'])
  write(root, 'src/content/posts/live.md', '---\ntitle: T\ndraft: true\n---\nbody\n')
  const changeSet = computeChangeSet(root, { baseRef: 'HEAD' })
  assert.deepEqual(changeSet, ['src/content/posts/live.md'])
  assert.deepEqual(reviewTargets(root, changeSet), ['/'])
})

// Deploys run npm ci && npm run build, so npm script edits other than
// "build" cannot change the deployed site and need no preview.
function commitPackageJson(root, pkg) {
  write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n')
  run(root, ['add', 'package.json'])
  run(root, ['commit', '-q', '-m', 'pkg'])
}

const BASE_PKG = {
  name: 'x',
  scripts: { build: 'astro build', dev: 'astro dev' },
  dependencies: { astro: '^6.0.0' },
}

test('computeChangeSet: package.json with only npm script edits is not preview-relevant', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  commitPackageJson(root, BASE_PKG)
  const pkg = structuredClone(BASE_PKG)
  pkg.scripts['preview-posts'] = 'node scripts/preview-posts.mjs'
  write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), [])
})

test('computeChangeSet: package.json dependency changes stay preview-relevant', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  commitPackageJson(root, BASE_PKG)
  const pkg = structuredClone(BASE_PKG)
  pkg.dependencies.astro = '^7.0.0'
  write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), ['package.json'])
})

test('computeChangeSet: package.json build script changes stay preview-relevant', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  commitPackageJson(root, BASE_PKG)
  const pkg = structuredClone(BASE_PKG)
  pkg.scripts.build = 'astro build && pagefind --site dist'
  write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), ['package.json'])
})

test('computeChangeSet: unparseable package.json fails closed as preview-relevant', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  commitPackageJson(root, BASE_PKG)
  write(root, 'package.json', '{ not json\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), ['package.json'])
})

test('isDraftPost reads the primary frontmatter, missing file is not draft', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/wip.md', '---\ndraft: true\n---\n')
  write(root, 'src/content/posts/live.md', FM)
  assert.equal(isDraftPost(root, 'src/content/posts/wip.md'), true)
  assert.equal(isDraftPost(root, 'src/content/posts/wip.en.md'), true)
  assert.equal(isDraftPost(root, 'src/content/posts/live.md'), false)
  assert.equal(isDraftPost(root, 'src/content/posts/absent.md'), false)
})

test('resolveBaseRef falls back to HEAD without origin/main', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  assert.equal(resolveBaseRef(root), 'HEAD')
})

test('resolveBaseRef returns origin/main when it exists', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  run(root, ['remote', 'add', 'origin', root])
  run(root, ['fetch', '-q', 'origin'])
  assert.equal(resolveBaseRef(root), 'origin/main')
})

// Simulates a worktree branched before another session pushed: origin/main
// holds a post commit (remote-only.md) that HEAD does not have, while HEAD
// sits one commit back on a branch of its own. alpha.md exists on both sides
// so tracked local edits can be tested.
function makeBehindFixture(t) {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', FM + 'v1\n')
  run(root, ['add', 'src/content/posts/alpha.md'])
  run(root, ['commit', '-q', '-m', 'alpha'])
  write(root, 'src/content/posts/remote-only.md', FM + 'pushed by another session\n')
  run(root, ['add', 'src/content/posts/remote-only.md'])
  run(root, ['commit', '-q', '-m', 'remote post'])
  run(root, ['remote', 'add', 'origin', root])
  run(root, ['fetch', '-q', 'origin'])
  run(root, ['checkout', '-q', '-b', 'work', 'HEAD~1'])
  return root
}

test('resolveDiffBase: up to date with the base ref keeps it as-is', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  run(root, ['remote', 'add', 'origin', root])
  run(root, ['fetch', '-q', 'origin'])
  assert.deepEqual(resolveDiffBase(root, 'origin/main'), { ref: 'origin/main', headBehind: false })
  assert.deepEqual(resolveDiffBase(root, 'HEAD'), { ref: 'HEAD', headBehind: false })
})

test('resolveDiffBase: HEAD behind origin/main resolves to the merge-base', (t) => {
  const root = makeBehindFixture(t)
  const { ref, headBehind } = resolveDiffBase(root, 'origin/main')
  assert.equal(headBehind, true)
  assert.equal(ref, run(root, ['rev-parse', 'HEAD']))
})

test('computeChangeSet: commits only on origin/main are not local changes', (t) => {
  const root = makeBehindFixture(t)
  assert.deepEqual(computeChangeSet(root, { baseRef: 'origin/main' }), [])
})

test('computeChangeSet: local edits still count when HEAD is behind origin/main', (t) => {
  const root = makeBehindFixture(t)
  write(root, 'src/content/posts/alpha.md', FM + 'v2\n') // modified tracked
  write(root, 'src/content/posts/beta.md', FM + 'new\n') // untracked
  assert.deepEqual(computeChangeSet(root, { baseRef: 'origin/main' }), [
    'src/content/posts/alpha.md',
    'src/content/posts/beta.md',
  ])
})

test('computeChangeSet: local commits ahead of the merge-base stay in the change set', (t) => {
  const root = makeBehindFixture(t)
  write(root, 'src/content/posts/local-work.md', FM + 'committed locally\n')
  run(root, ['add', 'src/content/posts/local-work.md'])
  run(root, ['commit', '-q', '-m', 'local post'])
  assert.deepEqual(computeChangeSet(root, { baseRef: 'origin/main' }), [
    'src/content/posts/local-work.md',
  ])
})

test('checkPostPreview: clean tree behind origin/main is SKIP and says why', (t) => {
  const root = makeBehindFixture(t)
  const result = checkPostPreview(root)
  assert.equal(result.status, 'SKIP')
  assert.match(result.detail, /has commits not in HEAD/)
  assert.match(result.detail, /merge-base/)
  assert.doesNotMatch(result.detail, /\u2014/) // no em-dashes in user-facing copy
})

test('checkPostPreview: unapproved local change behind origin/main is FAIL and says why', (t) => {
  const root = makeBehindFixture(t)
  write(root, 'src/content/posts/beta.md', FM + 'new\n')
  const result = checkPostPreview(root)
  assert.equal(result.status, 'FAIL')
  assert.match(result.detail, /1 preview-relevant change\(s\) with no approval/)
  assert.match(result.detail, /has commits not in HEAD/)
})

test('isDraftPost handles CRLF frontmatter', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/crlf.md', '---\r\ntitle: T\r\ndraft: true\r\n---\r\nbody\r\n')
  assert.equal(isDraftPost(root, 'src/content/posts/crlf.md'), true)
})

test('reviewTargets: posts map to their pages, siblings to the primary page', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', FM)
  write(root, 'src/content/posts/beta.md', FM)
  write(root, 'src/content/posts/beta.en.md', 'english\n')
  assert.deepEqual(
    reviewTargets(root, ['src/content/posts/alpha.md', 'src/content/posts/beta.en.md']),
    ['/posts/alpha/', '/posts/beta/']
  )
})

test('reviewTargets: deleted primary goes to the homepage, deleted sibling to the post', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/beta.md', FM)
  // gone.md does not exist on disk; beta.en.md does not exist but beta.md does
  assert.deepEqual(
    reviewTargets(root, ['src/content/posts/gone.md', 'src/content/posts/beta.en.md']),
    ['/', '/posts/beta/']
  )
})

test('reviewTargets: site-wide changes add homepage and the representative post', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', FM)
  assert.deepEqual(reviewTargets(root, ['src/content/posts/alpha.md', 'src/styles/x.css']), [
    '/',
    '/posts/alpha/',
    `/posts/${REPRESENTATIVE_POST}/`,
  ])
})

test('reviewTargets: note changes map to the notes timeline', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', FM)
  assert.deepEqual(
    reviewTargets(root, ['src/content/notes/20100805-090000.md', 'src/content/posts/alpha.md']),
    ['/notes/', '/posts/alpha/']
  )
})

test('reviewTargets: a deleted note still reviews the timeline', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  assert.deepEqual(reviewTargets(root, ['src/content/notes/20100805-090000.md']), ['/notes/'])
})

test('hashChangeSet: sha256 per file, deleted sentinel for missing files', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', 'abc')
  const files = hashChangeSet(root, ['src/content/posts/alpha.md', 'src/content/posts/gone.md'])
  // sha256 of "abc"
  assert.equal(
    files['src/content/posts/alpha.md'],
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  assert.equal(files['src/content/posts/gone.md'], 'deleted')
})

test('manifest round-trip and exact-match comparison', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', 'v1')
  const files = hashChangeSet(root, ['src/content/posts/alpha.md'])
  writeManifest(root, files, { baseRef: 'HEAD' })
  const manifest = readManifest(root)
  assert.equal(manifest.baseRef, 'HEAD')
  assert.ok(manifest.approvedAt)
  assert.deepEqual(manifestDiff(files, manifest), [])
})

test('manifestDiff reports edits and additions, ignores settled approvals', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/alpha.md', 'v1')
  write(root, 'src/content/posts/beta.md', 'v1')
  writeManifest(
    root,
    hashChangeSet(root, ['src/content/posts/alpha.md', 'src/content/posts/beta.md']),
    { baseRef: 'HEAD' }
  )
  const manifest = readManifest(root)
  write(root, 'src/content/posts/alpha.md', 'v2')
  // beta.md is approved but absent from the current change set (committed or
  // reverted since approval); that must not be a problem on its own.
  const current = hashChangeSet(root, ['src/content/posts/alpha.md', 'src/content/posts/gamma.md'])
  const problems = manifestDiff(current, manifest)
  assert.deepEqual(problems.sort(), [
    'src/content/posts/alpha.md: changed since approval',
    'src/content/posts/gamma.md: not covered by the approval',
  ])
})

test('readManifest returns null when missing or invalid', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  assert.equal(readManifest(root), null)
  write(root, '.preview/manifest.json', 'not json')
  assert.equal(readManifest(root), null)
})

test('computeChangeSet: non-ASCII filenames survive git path quoting', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(root, 'src/content/posts/停了一百年的船.md', FM + 'body\n')
  assert.deepEqual(computeChangeSet(root, { baseRef: 'HEAD' }), [
    'src/content/posts/停了一百年的船.md',
  ])
  assert.equal(checkPostPreview(root, { baseRef: 'HEAD' }).status, 'FAIL')
})

test('checkPostPreview: SKIP, FAIL without approval, PASS after, FAIL after edit', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  const opts = { baseRef: 'HEAD' }

  assert.equal(checkPostPreview(root, opts).status, 'SKIP')

  write(root, 'src/content/posts/alpha.md', FM + 'v1\n')
  const noManifest = checkPostPreview(root, opts)
  assert.equal(noManifest.status, 'FAIL')
  assert.match(noManifest.detail, /npm run preview-posts/)

  writeManifest(root, hashChangeSet(root, computeChangeSet(root, opts)), { baseRef: 'HEAD' })
  const approved = checkPostPreview(root, opts)
  assert.equal(approved.status, 'PASS')

  write(root, 'src/content/posts/alpha.md', FM + 'v2\n')
  const stale = checkPostPreview(root, opts)
  assert.equal(stale.status, 'FAIL')
  assert.match(stale.detail, /changed since approval/)
})

test('checkPostPreview truncates long problem lists', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  const opts = { baseRef: 'HEAD' }
  const names = []
  for (let i = 0; i < 12; i++) {
    const name = `src/content/posts/post-${String(i).padStart(2, '0')}.md`
    names.push(name)
    write(root, name, FM + 'v1\n')
  }
  writeManifest(root, hashChangeSet(root, computeChangeSet(root, opts)), { baseRef: 'HEAD' })
  for (const name of names) write(root, name, FM + 'v2\n')
  const stale = checkPostPreview(root, opts)
  assert.equal(stale.status, 'FAIL')
  assert.match(stale.detail, /and 2 more/)
})

// Committing approved files with identical content moves them out of the
// change set once the base ref advances (modeled here with baseRef HEAD).
// The owner-reviewed bytes are unchanged, so the approval must survive.
test('checkPostPreview: approval survives committing approved files unchanged', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  const opts = { baseRef: 'HEAD' }
  write(root, 'src/content/posts/alpha.md', FM + 'v1\n')
  write(root, 'src/content/posts/beta.md', FM + 'v1\n')
  writeManifest(root, hashChangeSet(root, computeChangeSet(root, opts)), { baseRef: 'HEAD' })

  run(root, ['add', 'src/content/posts/alpha.md'])
  run(root, ['commit', '-q', '-m', 'ship alpha'])
  const partial = checkPostPreview(root, opts)
  assert.equal(partial.status, 'PASS')
  assert.match(partial.detail, /1 changed file/)
  assert.match(partial.detail, /1 approved file\(s\) already committed or reverted/)

  run(root, ['add', 'src/content/posts/beta.md'])
  run(root, ['commit', '-q', '-m', 'ship beta'])
  assert.equal(checkPostPreview(root, opts).status, 'SKIP')
})

// Content drift stays conservative: an approved file edited after approval
// must fail, whether or not the approved version was committed in between.
test('checkPostPreview: edit after approval fails even when committed first', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  const opts = { baseRef: 'HEAD' }
  write(root, 'src/content/posts/alpha.md', FM + 'v1\n')
  writeManifest(root, hashChangeSet(root, computeChangeSet(root, opts)), { baseRef: 'HEAD' })
  run(root, ['add', 'src/content/posts/alpha.md'])
  run(root, ['commit', '-q', '-m', 'ship alpha'])
  write(root, 'src/content/posts/alpha.md', FM + 'v2\n')
  const res = checkPostPreview(root, opts)
  assert.equal(res.status, 'FAIL')
  assert.match(res.detail, /changed since approval/)
})

// Reverting an approved file removes it from the change set; nothing
// unreviewed can ship from it, so the rest of the approval stays valid.
test('checkPostPreview: reverting an approved file does not invalidate the rest', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  const opts = { baseRef: 'HEAD' }
  write(root, 'src/content/posts/alpha.md', FM + 'v1\n')
  run(root, ['add', 'src/content/posts/alpha.md'])
  run(root, ['commit', '-q', '-m', 'base alpha'])
  write(root, 'src/content/posts/alpha.md', FM + 'v2\n')
  write(root, 'src/content/posts/beta.md', FM + 'v1\n')
  writeManifest(root, hashChangeSet(root, computeChangeSet(root, opts)), { baseRef: 'HEAD' })

  write(root, 'src/content/posts/alpha.md', FM + 'v1\n') // revert to base
  const res = checkPostPreview(root, opts)
  assert.equal(res.status, 'PASS')
  assert.match(res.detail, /1 approved file\(s\) already committed or reverted/)

  rmSync(join(root, 'src/content/posts/beta.md')) // revert the rest
  assert.equal(checkPostPreview(root, opts).status, 'SKIP')
})

test('checkPostPreview: approved deletion passes until the file returns', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  const opts = { baseRef: 'HEAD' }
  write(root, 'src/content/posts/doomed.md', FM + 'body\n')
  run(root, ['add', 'src/content/posts/doomed.md'])
  run(root, ['commit', '-q', '-m', 'add doomed'])
  rmSync(join(root, 'src/content/posts/doomed.md'))
  const files = hashChangeSet(root, computeChangeSet(root, opts))
  assert.equal(files['src/content/posts/doomed.md'], 'deleted')
  writeManifest(root, files, { baseRef: 'HEAD' })
  assert.equal(checkPostPreview(root, opts).status, 'PASS')
  write(root, 'src/content/posts/doomed.md', FM + 'back from the dead\n')
  assert.equal(checkPostPreview(root, opts).status, 'FAIL')
})

test('checkPostPreview: an unapproved note change fails', (t) => {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  write(
    root,
    'src/content/notes/20100805-090000.md',
    "---\ndate: '2010-08-05T09:00:00.000Z'\ntweetId: '9001'\nsource: 'https://x.com/u/status/9001'\ntweetCount: 1\n---\n\nbody\n"
  )
  assert.equal(checkPostPreview(root, { baseRef: 'HEAD' }).status, 'FAIL')
})

test('release-check exposes post preview as quick-mode check 12', async () => {
  const { CHECKS } = await import('./release-check.mjs')
  const entry = CHECKS.find((c) => c.num === 12)
  assert.ok(entry, 'check 12 missing from CHECKS')
  assert.equal(entry.name, 'post preview')
  assert.notEqual(entry.full, true)
})

test('renderReviewPage links every target against the given host and port', () => {
  const html = renderReviewPage(['/', '/posts/alpha/'], { host: 'localhost', port: '4322' })
  assert.match(html, /href="http:\/\/localhost:4322\/"/)
  assert.match(html, /href="http:\/\/localhost:4322\/posts\/alpha\/"/)
  assert.match(html, /dark mode/i)
  assert.match(html, /language/i)
  assert.doesNotMatch(html, /\u2014/) // no em-dashes in user-facing copy
})

test('renderReviewPage escapes HTML metacharacters in targets', () => {
  const html = renderReviewPage(['/posts/x"><script>alert(1)</script>/'], {
    host: 'localhost',
    port: '4322',
  })
  assert.ok(!html.includes('<script>'), 'raw <script> must not appear')
  assert.ok(html.includes('&quot;'), 'quotes must be escaped')
  assert.ok(html.includes('&lt;script&gt;'), 'angle brackets must be escaped')
})

test('routeSlugForPostFile prefers the frontmatter slug and falls back to filename', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { routeSlugForPostFile } = await import('./preview-posts.mjs')
  const root = mkdtempSync(join(tmpdir(), 'route-slug-'))
  try {
    const write = (rel, content) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    write('src/content/posts/file-name.md', "---\ntitle: 'X'\nslug: 'custom-url'\n---\nBody.\n")
    write('src/content/posts/plain.md', "---\ntitle: 'Y'\n---\nBody.\n")
    assert.equal(routeSlugForPostFile(root, 'src/content/posts/file-name.md'), 'custom-url')
    // The sibling routes through its primary's slug
    assert.equal(routeSlugForPostFile(root, 'src/content/posts/file-name.zh.md'), 'custom-url')
    assert.equal(routeSlugForPostFile(root, 'src/content/posts/plain.md'), 'plain')
    assert.equal(routeSlugForPostFile(root, 'src/content/posts/gone.md'), 'gone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
