// Tests for the ship CLI. Fixture repos live in tmpdirs; the real checkout
// is never touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changeSetDigest,
  commitAndPush,
  commitMessageFor,
  originStatus,
  partitionPurity,
  postPathsFor,
  preflight,
  rawDiffPaths,
  recheckApprovedChangeSet,
} from './ship.mjs'
import { checkPostPreview, hashChangeSet, writeManifest } from './preview-posts.mjs'
import { cleanup, makeFixtureRepo, run, write } from './test-helpers.mjs'

// Fixture repo with a local bare origin, pushed and fetched, so origin/main
// exists and push works.
function makeFixtureWithOrigin() {
  const root = makeFixtureRepo()
  const bare = mkdtempSync(join(tmpdir(), 'ship-origin-'))
  run(bare, ['init', '-q', '--bare', '-b', 'main', '.'])
  run(root, ['remote', 'add', 'origin', bare])
  run(root, ['push', '-q', 'origin', 'main'])
  run(root, ['fetch', '-q', 'origin'])
  return { root, bare }
}

function cleanupWithOrigin({ root, bare }) {
  cleanup(root)
  rmSync(bare, { recursive: true, force: true })
}

test('changeSetDigest is stable, order-independent, and 12 hex chars', () => {
  const a = changeSetDigest({ 'src/content/posts/a.md': 'h1', 'src/content/posts/b.md': 'h2' })
  const b = changeSetDigest({ 'src/content/posts/b.md': 'h2', 'src/content/posts/a.md': 'h1' })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{12}$/)
})

test('changeSetDigest changes when any entry changes', () => {
  const base = changeSetDigest({ 'src/content/posts/a.md': 'h1' })
  assert.notEqual(changeSetDigest({ 'src/content/posts/a.md': 'h2' }), base)
  assert.notEqual(
    changeSetDigest({ 'src/content/posts/a.md': 'h1', 'src/content/posts/b.md': 'h2' }),
    base
  )
})

test('commitMessageFor dedupes primary and sibling into one slug', () => {
  assert.equal(
    commitMessageFor([
      'src/assets/hero/2026/07/alpha.webp',
      'src/content/posts/alpha.md',
      'src/content/posts/alpha.zh.md',
    ]),
    'post: update alpha'
  )
  assert.equal(
    commitMessageFor(['src/content/posts/alpha.md', 'src/content/posts/beta.md']),
    'post: update alpha, beta'
  )
  assert.deepEqual(postPathsFor(['src/assets/hero/alpha.webp', 'src/content/posts/alpha.md']), [
    'src/content/posts/alpha.md',
  ])
})

test('partitionPurity splits posts, hero covers, and everything else', () => {
  const { posts, heroes, other } = partitionPurity([
    'src/content/posts/a.md',
    'docs/x.md',
    'astro.config.mjs',
    'src/assets/hero/2026/07/a.webp',
    'src/content/posts/a.zh.md',
  ])
  assert.deepEqual(posts, ['src/content/posts/a.md', 'src/content/posts/a.zh.md'])
  assert.deepEqual(heroes, ['src/assets/hero/2026/07/a.webp'])
  assert.deepEqual(other, ['astro.config.mjs', 'docs/x.md'])
})

test('rawDiffPaths sees worktree, untracked, and committed-then-reverted changes', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', 'untracked post\n')
    write(root, 'tracked.md', 'worktree edit\n')
    const originalDocs = 'v1\n'
    write(root, 'docs/x.md', originalDocs)
    run(root, ['add', 'docs/x.md'])
    run(root, ['commit', '-q', '-m', 'docs v1'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['fetch', '-q', 'origin'])
    write(root, 'docs/x.md', 'v2\n')
    run(root, ['add', 'docs/x.md'])
    run(root, ['commit', '-q', '-m', 'docs v2'])
    write(root, 'docs/x.md', originalDocs)
    const paths = rawDiffPaths(root, 'origin/main')
    assert.ok(paths.includes('src/content/posts/new.md'), 'untracked file seen')
    assert.ok(paths.includes('tracked.md'), 'worktree edit seen')
    assert.ok(paths.includes('docs/x.md'), 'committed-then-reverted change seen')
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('originStatus reports missing origin and remote-ahead counts', () => {
  const noOrigin = makeFixtureRepo()
  try {
    assert.equal(originStatus(noOrigin).hasOrigin, false)
  } finally {
    cleanup(noOrigin)
  }
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    assert.deepEqual(originStatus(root), { hasOrigin: true, ahead: 0, localAhead: 0 })
    write(root, 'tracked.md', 'about to be remote-only\n')
    run(root, ['add', 'tracked.md'])
    run(root, ['commit', '-q', '-m', 'remote-only commit'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['reset', '-q', '--hard', 'HEAD~1'])
    run(root, ['fetch', '-q', 'origin'])
    assert.deepEqual(originStatus(root), { hasOrigin: true, ahead: 1, localAhead: 0 })
  } finally {
    cleanupWithOrigin(fx)
  }
})

const POST_BODY = "---\ntitle: 'New post'\npubDate: '2026-07-16'\n---\n\nbody\n"
const POST_WITH_HERO =
  "---\ntitle: 'New post'\npubDate: '2026-07-16'\nheroImage: '../../assets/hero/2026/07/new.webp'\n---\n\nbody\n"
const POST_WITH_INLINE_HERO = POST_WITH_HERO.replace(
  "heroImage: '../../assets/hero/2026/07/new.webp'",
  "heroImage: '../../assets/hero/2026/07/new.webp' # local cover"
)

test('preflight aborts off main and when origin is ahead', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    run(root, ['checkout', '-q', '-b', 'topic'])
    const offMain = preflight(root, { fetch: false })
    assert.equal(offMain.status, 'abort')
    assert.match(offMain.detail, /branch topic/)
    run(root, ['checkout', '-q', 'main'])
    write(root, 'tracked.md', 'remote-only\n')
    run(root, ['add', 'tracked.md'])
    run(root, ['commit', '-q', '-m', 'remote-only'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['reset', '-q', '--hard', 'HEAD~1'])
    const behind = preflight(root)
    assert.equal(behind.status, 'abort')
    assert.match(behind.detail, /origin\/main has 1 commit/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight aborts on non-post changes, listing them', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    write(root, 'docs/notes.md', 'not a post\n')
    const res = preflight(root)
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /docs\/notes\.md/)
    assert.doesNotMatch(res.detail, /new\.md/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight returns empty on a clean tree and ok with digest on post changes', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    assert.equal(preflight(root).status, 'empty')
    write(root, 'src/content/posts/new.md', POST_BODY)
    const res = preflight(root)
    assert.equal(res.status, 'ok')
    assert.deepEqual(res.changeSet, ['src/content/posts/new.md'])
    assert.match(res.digest, /^[0-9a-f]{12}$/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight auto-includes a changed hero referenced by the selected post', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_WITH_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes v1')
    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'ok')
    assert.deepEqual(res.postSet, ['src/content/posts/new.md'])
    assert.deepEqual(res.changeSet, [
      'src/assets/hero/2026/07/new.webp',
      'src/content/posts/new.md',
    ])
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight resolves a quoted heroImage with an inline YAML comment', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_WITH_INLINE_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes')
    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'ok')
    assert.deepEqual(res.changeSet, [
      'src/assets/hero/2026/07/new.webp',
      'src/content/posts/new.md',
    ])
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects a changed hero that the selected post does not reference', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    write(root, 'src/assets/hero/2026/07/unrelated.webp', 'unrelated hero')
    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /not referenced by the selected post set/)
    assert.match(res.detail, /unrelated\.webp/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects missing and escaping hero references', () => {
  const missing = makeFixtureWithOrigin()
  try {
    write(missing.root, 'src/content/posts/new.md', POST_WITH_HERO)
    const res = preflight(missing.root, { fetch: false })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /heroImage not found on disk/)
  } finally {
    cleanupWithOrigin(missing)
  }

  const escaping = makeFixtureWithOrigin()
  try {
    write(
      escaping.root,
      'src/content/posts/new.md',
      POST_WITH_HERO.replace('../../assets/hero/2026/07/new.webp', '../../../tracked.md')
    )
    const res = preflight(escaping.root, { fetch: false })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /heroImage escapes src\/assets\/hero/)
  } finally {
    cleanupWithOrigin(escaping)
  }
})

test('preflight rejects a referenced hero symlink', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_WITH_HERO)
    mkdirSync(join(root, 'src/assets/hero/2026/07'), { recursive: true })
    symlinkSync('../../../../../tracked.md', join(root, 'src/assets/hero/2026/07/new.webp'))
    const res = preflight(root, { fetch: false })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /heroImage must not be a symlink/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects a referenced hero reached through a symlink directory', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(
      root,
      'src/content/posts/new.md',
      POST_WITH_HERO.replace('2026/07/new.webp', 'linked/tracked.md')
    )
    mkdirSync(join(root, 'src/assets/hero'), { recursive: true })
    symlinkSync('../../..', join(root, 'src/assets/hero/linked'))
    const res = preflight(root, { fetch: false })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /symlink path components/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects a changed post that is a symlink', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    mkdirSync(join(root, 'src/content/posts'), { recursive: true })
    symlinkSync('../../../tracked.md', join(root, 'src/content/posts/new.md'))
    const res = preflight(root, { fetch: false })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /post must not be a symlink/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects a selected post reached through a symlinked posts directory', () => {
  const fx = makeFixtureWithOrigin()
  const target = mkdtempSync(join(tmpdir(), 'ship-post-target-'))
  try {
    const { root } = fx
    write(target, 'new.md', POST_BODY)
    mkdirSync(join(root, 'src/content'), { recursive: true })
    symlinkSync(target, join(root, 'src/content/posts'))
    run(root, ['add', 'src/content/posts'])
    run(root, ['commit', '-q', '-m', 'symlinked posts fixture'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['fetch', '-q', 'origin'])

    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /symlink path components/)
  } finally {
    cleanupWithOrigin(fx)
    rmSync(target, { recursive: true, force: true })
  }
})

test('preflight blocks a changed hero referenced only by an excluded draft', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(
      root,
      'src/content/posts/new.md',
      POST_WITH_HERO.replace("pubDate: '2026-07-16'", "pubDate: '2026-07-16'\ndraft: TRUE # hidden")
    )
    write(root, 'src/assets/hero/2026/07/new.webp', 'draft hero')
    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /not referenced by the selected post set/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight blocks a changed hero when a published post transitions to draft', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/existing.md', POST_WITH_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'published hero')
    run(root, ['add', 'src/content/posts/existing.md', 'src/assets/hero/2026/07/new.webp'])
    run(root, ['commit', '-q', '-m', 'published post baseline'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['fetch', '-q', 'origin'])

    write(
      root,
      'src/content/posts/existing.md',
      POST_WITH_HERO.replace(
        "pubDate: '2026-07-16'",
        "pubDate: '2026-07-16'\ndraft: true # remove from the site"
      )
    )
    write(root, 'src/assets/hero/2026/07/new.webp', 'draft-only changed hero')
    const withHero = preflight(root, { fetch: false })
    assert.equal(withHero.status, 'abort')
    assert.match(withHero.detail, /not referenced by the selected post set/)

    write(root, 'src/assets/hero/2026/07/new.webp', 'published hero')
    const postOnly = preflight(root, { fetch: false })
    assert.equal(postOnly.status, 'ok')
    assert.deepEqual(postOnly.changeSet, ['src/content/posts/existing.md'])
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight digest changes when referenced hero bytes drift', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_WITH_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes v1')
    const before = preflight(root, { fetch: false })
    assert.equal(before.status, 'ok')
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes v2')
    const after = preflight(root, { fetch: false })
    assert.equal(after.status, 'ok')
    assert.notEqual(after.digest, before.digest)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('approval recheck fails after hero bytes change', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_WITH_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes v1')
    const approved = preflight(root, { fetch: false })
    assert.equal(approved.status, 'ok')
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes after checks')
    const final = recheckApprovedChangeSet(root, approved.digest)
    assert.equal(final.status, 'abort')
    assert.match(final.detail, /tree changed since the review/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects noncanonical --only paths', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    const invalidPaths = [
      '/src/content/posts/new.md',
      '.\\src\\content\\posts\\new.md',
      './src/content/posts/new.md',
      'src//content/posts/new.md',
      'src/content/posts/../posts/new.md',
      'src/content/posts/nested/new.md',
      'src/content/posts/new.md\0ignored',
    ]
    for (const onlyPath of invalidPaths) {
      const res = preflight(root, { fetch: false, only: [onlyPath] })
      assert.equal(res.status, 'abort', onlyPath)
      assert.match(res.detail, /--only accepts post paths/, onlyPath)
    }
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('normal and fast preflight reject a changed hero shared with an unselected post', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/existing.md', POST_WITH_INLINE_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'base hero')
    run(root, ['add', 'src/content/posts/existing.md', 'src/assets/hero/2026/07/new.webp'])
    run(root, ['commit', '-q', '-m', 'shared hero baseline'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['fetch', '-q', 'origin'])

    write(root, 'src/content/posts/new.md', POST_WITH_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'changed hero')
    for (const strictSync of [false, true]) {
      const res = preflight(root, {
        fetch: false,
        only: ['src/content/posts/new.md'],
        strictSync,
      })
      assert.equal(res.status, 'abort', `strictSync=${strictSync}`)
      assert.match(res.detail, /ship cannot change a hero cover/, `strictSync=${strictSync}`)
      assert.match(res.detail, /src\/content\/posts\/existing\.md/)
    }
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('shared hero scan uses HEAD when an unselected worktree post removes its reference', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/existing.md', POST_WITH_INLINE_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'base hero')
    run(root, ['add', 'src/content/posts/existing.md', 'src/assets/hero/2026/07/new.webp'])
    run(root, ['commit', '-q', '-m', 'shared hero baseline'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['fetch', '-q', 'origin'])

    write(root, 'src/content/posts/existing.md', POST_BODY)
    write(root, 'src/content/posts/new.md', POST_WITH_HERO)
    write(root, 'src/assets/hero/2026/07/new.webp', 'changed hero')
    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /ship cannot change a hero cover/)
    assert.match(res.detail, /src\/content\/posts\/existing\.md/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('commitAndPush commits exactly the given paths and pushes to origin', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root, bare } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes')
    write(root, 'src/content/posts/other.md', POST_BODY)
    const sha = commitAndPush(
      root,
      ['src/assets/hero/2026/07/new.webp', 'src/content/posts/new.md'],
      {
        message: 'post: update new',
        trailer: false,
      }
    )
    assert.equal(run(bare, ['rev-parse', 'main']), sha)
    const committed = run(root, ['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(committed, ['src/assets/hero/2026/07/new.webp', 'src/content/posts/new.md'])
    const status = run(root, ['status', '--porcelain'])
    assert.match(status, /other\.md/)
    assert.doesNotMatch(run(root, ['log', '-1', '--format=%B']), /Co-Authored-By/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('commitAndPush adds the agent trailer when asked', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    commitAndPush(root, ['src/content/posts/new.md'], {
      message: 'post: update new',
      trailer: true,
    })
    assert.match(run(root, ['log', '-1', '--format=%B']), /Co-Authored-By: Claude Fable 5/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

const SHIP = fileURLToPath(new URL('./ship.mjs', import.meta.url))

function runShip(root, args) {
  try {
    const stdout = execFileSync('node', [SHIP, ...args], { cwd: root, encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

test('cli: --yes without --digest is a usage error', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const res = runShip(fx.root, ['--yes'])
    assert.equal(res.code, 1)
    assert.match(res.stderr, /--yes requires --digest/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('cli: --preflight prints the change set and digest, writes no manifest', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    const res = runShip(root, ['--preflight'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /src\/content\/posts\/new\.md/)
    assert.match(res.stdout, /changeset digest: [0-9a-f]{12}/)
    assert.equal(existsSync(join(root, '.preview', 'manifest.json')), false)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('cli: --yes with a stale digest aborts before writing the manifest', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    const res = runShip(root, ['--yes', '--digest', '000000000000'])
    assert.equal(res.code, 1)
    assert.match(res.stderr, /tree changed since the review/)
    assert.equal(existsSync(join(root, '.preview', 'manifest.json')), false)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('cli: --preflight aborts with exit 1 on mixed changes', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    write(root, 'docs/notes.md', 'not a post\n')
    const res = runShip(root, ['--preflight'])
    assert.equal(res.code, 1)
    assert.match(res.stderr, /docs\/notes\.md/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight --only scopes the change set to the selected post pair', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/alpha.md', 'alpha v2\n')
    write(root, 'src/content/posts/alpha.zh.md', 'alpha zh v2\n')
    write(root, 'src/content/posts/beta.md', 'beta v2\n')
    const full = preflight(root, { fetch: false })
    assert.equal(full.status, 'ok')
    assert.equal(full.changeSet.length, 3)
    const scoped = preflight(root, {
      fetch: false,
      only: ['src/content/posts/alpha.md', 'src/content/posts/alpha.zh.md'],
    })
    assert.equal(scoped.status, 'ok')
    assert.deepEqual(scoped.changeSet, [
      'src/content/posts/alpha.md',
      'src/content/posts/alpha.zh.md',
    ])
    assert.notEqual(scoped.digest, full.digest)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight --only with no matching pending change is empty', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/beta.md', 'beta v2\n')
    const res = preflight(root, { fetch: false, only: ['src/content/posts/alpha.md'] })
    assert.equal(res.status, 'empty')
    assert.match(res.detail, /selected post/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('checkPostPreview with a scoped change set only needs the scoped approval', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/alpha.md', 'alpha v2\n')
    write(root, 'src/content/posts/beta.md', 'beta v2\n')
    const scoped = ['src/content/posts/alpha.md']
    writeManifest(root, hashChangeSet(root, scoped), { baseRef: 'origin/main' })
    const scopedRes = checkPostPreview(root, { changeSet: scoped })
    assert.equal(scopedRes.status, 'PASS')
    assert.match(scopedRes.detail, /scoped change set/)
    const fullRes = checkPostPreview(root)
    assert.equal(fullRes.status, 'FAIL')
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('originStatus counts localAhead and preflight strictSync aborts on it', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/committed.md', 'v2\n')
    run(root, ['add', 'src/content/posts/committed.md'])
    run(root, ['commit', '-q', '-m', 'local only'])
    const status = originStatus(root)
    assert.equal(status.ahead, 0)
    assert.equal(status.localAhead, 1)
    const strict = preflight(root, { fetch: false, strictSync: true })
    assert.equal(strict.status, 'abort')
    assert.match(strict.detail, /1 unpushed commit/)
    const relaxed = preflight(root, { fetch: false })
    assert.equal(relaxed.status, 'ok')
  } finally {
    cleanupWithOrigin(fx)
  }
})
