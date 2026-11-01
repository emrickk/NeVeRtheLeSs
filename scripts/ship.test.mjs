// Tests for the ship CLI. Fixture repos (with a local bare origin) live in
// tmpdirs; the real checkout is never touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changeSetDigest,
  commitApproved,
  commitMessageFor,
  createShipWorkspace,
  main,
  originStatus,
  partitionPaths,
  postPathsFor,
  preflight,
  pushCommit,
  rawDiffPaths,
  recheckApprovedChangeSet,
  removeShipWorkspace,
} from './ship.mjs'
import { checkPostPreview, hashChangeSet, readManifest, writeManifest } from './preview-posts.mjs'
import {
  cleanup,
  freePort,
  installFakeAstro,
  makeFixtureRepo,
  run,
  waitForOutput,
  write,
} from './test-helpers.mjs'

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

// Commit, push, and fetch so the change is part of origin/main.
function publishBaseline(root, paths, message = 'baseline') {
  run(root, ['add', ...paths])
  run(root, ['commit', '-q', '-m', message])
  run(root, ['push', '-q', 'origin', 'main'])
  run(root, ['fetch', '-q', 'origin'])
}

function worktreeCount(root) {
  return run(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length
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

test('commitMessageFor names posts, library collections, and included extras', () => {
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
  assert.equal(commitMessageFor(['src/data/library/model-cars.json']), 'library: update model-cars')
  assert.equal(
    commitMessageFor(['src/content/posts/alpha.md', 'src/data/library/books.json']),
    'post: update alpha; library: update books'
  )
  assert.equal(
    commitMessageFor(['src/components/X.astro', 'src/content/posts/alpha.md'], {
      includes: ['src/components/X.astro'],
    }),
    'post: update alpha\n\nAlso includes: src/components/X.astro'
  )
  assert.deepEqual(postPathsFor(['src/assets/hero/alpha.webp', 'src/content/posts/alpha.md']), [
    'src/content/posts/alpha.md',
  ])
})

test('partitionPaths splits posts, hero covers, library data, and everything else', () => {
  const { posts, heroes, library, other } = partitionPaths([
    'src/content/posts/a.md',
    'docs/x.md',
    'astro.config.mjs',
    'src/assets/hero/2026/07/a.webp',
    'src/data/library/books.json',
    'src/data/library/nested/x.json',
    'src/content/posts/a.zh.md',
  ])
  assert.deepEqual(posts, ['src/content/posts/a.md', 'src/content/posts/a.zh.md'])
  assert.deepEqual(heroes, ['src/assets/hero/2026/07/a.webp'])
  assert.deepEqual(library, ['src/data/library/books.json'])
  assert.deepEqual(other, ['astro.config.mjs', 'docs/x.md', 'src/data/library/nested/x.json'])
})

test('rawDiffPaths sees worktree, untracked, and committed-then-reverted changes', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', 'untracked post\n')
    write(root, 'tracked.md', 'worktree edit\n')
    const originalDocs = 'v1\n'
    write(root, 'docs/x.md', originalDocs)
    publishBaseline(root, ['docs/x.md'], 'docs v1')
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

test('originStatus reports missing origin, remote-ahead, and local-ahead counts', () => {
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

test('preflight aborts off main, when origin is ahead, and on unpushed local commits', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    run(root, ['checkout', '-q', '-b', 'topic'])
    const offMain = preflight(root, { fetch: false })
    assert.equal(offMain.status, 'abort')
    assert.match(offMain.detail, /branch topic/)
    const dry = preflight(root, { fetch: false, dryRun: true })
    assert.equal(dry.status, 'ok')
    assert.match(dry.notes.join('\n'), /dry run on branch topic/)
    run(root, ['checkout', '-q', 'main'])
    write(root, 'tracked.md', 'remote-only\n')
    run(root, ['add', 'tracked.md'])
    run(root, ['commit', '-q', '-m', 'remote-only'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['reset', '-q', '--hard', 'HEAD~1'])
    const behind = preflight(root)
    assert.equal(behind.status, 'abort')
    assert.match(behind.detail, /origin\/main has 1 commit/)
    run(root, ['merge', '-q', '--ff-only', 'origin/main'])
    write(root, 'src/content/posts/committed.md', POST_BODY)
    run(root, ['add', 'src/content/posts/committed.md'])
    run(root, ['commit', '-q', '-m', 'local only'])
    const ahead = preflight(root, { fetch: false })
    assert.equal(ahead.status, 'abort')
    assert.match(ahead.detail, /1 unpushed commit/)
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
    assert.equal(res.baseSha, run(root, ['rev-parse', 'origin/main']))
  } finally {
    cleanupWithOrigin(fx)
  }
})

const POST_WITH_HERO =
  "---\ntitle: 'New post'\npubDate: '2026-07-16'\nheroImage: '../../assets/hero/2026/07/new.webp'\n---\n\nbody\n"
const POST_WITH_INLINE_HERO = POST_WITH_HERO.replace(
  "heroImage: '../../assets/hero/2026/07/new.webp'",
  "heroImage: '../../assets/hero/2026/07/new.webp' # local cover"
)

test('preflight ignores unrelated dirty and untracked files instead of aborting', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'docs/notes.md', 'committed docs\n')
    run(root, ['add', 'docs/notes.md'])
    run(root, ['commit', '-q', '-m', 'docs'])
    run(root, ['push', '-q', 'origin', 'main'])
    run(root, ['fetch', '-q', 'origin'])
    write(root, 'src/content/posts/new.md', POST_BODY)
    write(root, 'docs/notes.md', 'another session is editing this\n')
    write(root, 'scripts/discovery.test.mjs', "import '../src/utils/discovery.ts'\n")
    write(root, 'src/assets/hero/2026/07/unrelated.webp', 'unrelated hero')
    const res = preflight(root)
    assert.equal(res.status, 'ok', res.detail)
    assert.deepEqual(res.changeSet, ['src/content/posts/new.md'])
    assert.deepEqual(res.ignored, [
      'docs/notes.md',
      'scripts/discovery.test.mjs',
      'src/assets/hero/2026/07/unrelated.webp',
    ])
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

test('preflight leaves a changed hero that no selected post references out of the change set', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/new.md', POST_BODY)
    write(root, 'src/assets/hero/2026/07/unrelated.webp', 'unrelated hero')
    const res = preflight(root, {
      fetch: false,
      only: ['src/content/posts/new.md'],
    })
    assert.equal(res.status, 'ok')
    assert.deepEqual(res.changeSet, ['src/content/posts/new.md'])
    assert.deepEqual(res.ignored, ['src/assets/hero/2026/07/unrelated.webp'])
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

test('preflight never ships a changed hero referenced only by an excluded draft', () => {
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
    assert.equal(res.status, 'empty')
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight ships a published-to-draft flip without its changed hero', () => {
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
    assert.equal(withHero.status, 'ok')
    assert.deepEqual(withHero.changeSet, ['src/content/posts/existing.md'])
    assert.deepEqual(withHero.ignored, ['src/assets/hero/2026/07/new.webp'])

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

test('preflight rejects a changed hero shared with an unselected post', () => {
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

test('preflight --only scopes the change set and brings the changed translation sibling', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/alpha.md', 'alpha v2\n')
    write(root, 'src/content/posts/alpha.zh.md', 'alpha zh v2\n')
    write(root, 'src/content/posts/beta.md', 'beta v2\n')
    const full = preflight(root, { fetch: false })
    assert.equal(full.status, 'ok')
    assert.equal(full.changeSet.length, 3)
    const scoped = preflight(root, { fetch: false, only: ['src/content/posts/alpha.md'] })
    assert.equal(scoped.status, 'ok')
    assert.deepEqual(scoped.changeSet, [
      'src/content/posts/alpha.md',
      'src/content/posts/alpha.zh.md',
    ])
    assert.deepEqual(scoped.ignored, ['src/content/posts/beta.md'])
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
    assert.match(res.detail, /selection/)
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

// ---------------------------------------------------------------------------
// Library data selection

const LIBRARY = 'src/data/library/books.json'

test('preflight selects changed library data by default and with --only', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, LIBRARY, '[{"id":1}]\n')
    publishBaseline(root, [LIBRARY])
    write(root, LIBRARY, '[{"id":1},{"id":2}]\n')
    write(root, 'src/data/library/games.json', '[]\n')
    write(root, 'src/content/posts/alpha.md', POST_BODY)
    const all = preflight(root, { fetch: false })
    assert.equal(all.status, 'ok')
    assert.deepEqual(all.changeSet, [
      'src/content/posts/alpha.md',
      LIBRARY,
      'src/data/library/games.json',
    ])
    const onlyBooks = preflight(root, { fetch: false, only: [LIBRARY] })
    assert.deepEqual(onlyBooks.changeSet, [LIBRARY])
    assert.deepEqual(onlyBooks.ignored, ['src/content/posts/alpha.md', 'src/data/library/games.json'])
    const before = onlyBooks.digest
    write(root, LIBRARY, '[{"id":1},{"id":3}]\n')
    assert.notEqual(preflight(root, { fetch: false, only: [LIBRARY] }).digest, before)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight rejects library data reached through a symlink and nested --only paths', () => {
  const fx = makeFixtureWithOrigin()
  const target = mkdtempSync(join(tmpdir(), 'ship-lib-target-'))
  try {
    const { root } = fx
    write(target, 'books.json', '[]\n')
    mkdirSync(join(root, 'src/data/library'), { recursive: true })
    symlinkSync(join(target, 'books.json'), join(root, LIBRARY))
    const res = preflight(root, { fetch: false })
    assert.equal(res.status, 'abort')
    assert.match(res.detail, /symlink/)
    const nested = preflight(root, { fetch: false, only: ['src/data/library/x/books.json'] })
    assert.equal(nested.status, 'abort')
    assert.match(nested.detail, /--only accepts post paths and src\/data\/library/)
  } finally {
    cleanupWithOrigin(fx)
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// --include

test('preflight --include adds an explicit changed file and binds it into the digest', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/alpha.md', POST_BODY)
    write(root, 'src/components/Gallery.astro', '<div>v1</div>\n')
    const without = preflight(root, { fetch: false })
    assert.deepEqual(without.changeSet, ['src/content/posts/alpha.md'])
    assert.deepEqual(without.ignored, ['src/components/Gallery.astro'])
    const withInclude = preflight(root, { fetch: false, include: ['src/components/Gallery.astro'] })
    assert.equal(withInclude.status, 'ok', withInclude.detail)
    assert.deepEqual(withInclude.changeSet, [
      'src/components/Gallery.astro',
      'src/content/posts/alpha.md',
    ])
    assert.deepEqual(withInclude.includes, ['src/components/Gallery.astro'])
    assert.notEqual(withInclude.digest, without.digest)
    write(root, 'src/components/Gallery.astro', '<div>v2</div>\n')
    assert.equal(
      recheckApprovedChangeSet(root, withInclude.digest, {
        include: ['src/components/Gallery.astro'],
      }).status,
      'abort'
    )
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('preflight --include refuses unchanged, dependency, secret, workflow, post, and symlink paths', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'src/content/posts/alpha.md', POST_BODY)
    write(root, 'package.json', '{"name":"x"}\n')
    write(root, '.github/workflows/deploy.yml', 'on: push\n')
    write(root, 'src/real.css', 'a{}\n')
    symlinkSync('real.css', join(root, 'src/link.css'))
    const cases = [
      ['tracked.md', /not changed against origin\/main/],
      ['package.json', /dependency changes/],
      ['.env.local', /env file must never be committed/],
      ['.github/workflows/deploy.yml', /workflow changes/],
      ['src/content/posts/alpha.md', /with --only, not --include/],
      ['src/assets/hero/x.webp', /selected automatically/],
      ['src/link.css', /symlink/],
      ['../outside.md', /not a canonical/],
    ]
    for (const [path, pattern] of cases) {
      const res = preflight(root, { fetch: false, include: [path] })
      assert.equal(res.status, 'abort', path)
      assert.match(res.detail, pattern, path)
    }
  } finally {
    cleanupWithOrigin(fx)
  }
})

// ---------------------------------------------------------------------------
// Temporary worktree

const ALPHA = 'src/content/posts/alpha.md'
const ALPHA_POST =
  "---\ntitle: 'Alpha'\ndescription: 'About alpha'\npubDate: '2026-07-16'\n---\n\nalpha body\n"

function addNodeModules(root) {
  write(root, 'node_modules/pkg/index.js', 'module.exports = 1\n')
}

function shipTempDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('blog-ship-')).sort()
}

test('createShipWorkspace holds only the approved bytes and removal leaves the shared checkout intact', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, 'docs/notes.md', 'baseline\n')
    write(root, 'src/content/posts/gone.md', POST_BODY)
    publishBaseline(root, ['docs/notes.md', 'src/content/posts/gone.md'])
    addNodeModules(root)
    write(root, 'docs/notes.md', 'dirty edit from another session\n')
    write(root, 'scripts/discovery.test.mjs', "import '../src/utils/discovery.ts'\n")
    write(root, ALPHA, ALPHA_POST)
    rmSync(join(root, 'src/content/posts/gone.md'))
    const pre = preflight(root, { fetch: false })
    assert.deepEqual(pre.changeSet, [ALPHA, 'src/content/posts/gone.md'])
    const ws = createShipWorkspace(root, pre)
    try {
      assert.equal(readFileSync(join(ws.tree, ALPHA), 'utf8'), ALPHA_POST)
      assert.equal(existsSync(join(ws.tree, 'src/content/posts/gone.md')), false)
      assert.equal(readFileSync(join(ws.tree, 'docs/notes.md'), 'utf8'), 'baseline\n')
      assert.equal(existsSync(join(ws.tree, 'scripts/discovery.test.mjs')), false)
      assert.ok(lstatSync(join(ws.tree, 'node_modules/pkg')).isSymbolicLink())
      assert.deepEqual(hashChangeSet(ws.tree, pre.changeSet), pre.files)
      assert.equal(run(ws.tree, ['rev-parse', 'HEAD']), pre.baseSha)
      assert.equal(worktreeCount(root), 2)
    } finally {
      removeShipWorkspace(root, ws)
    }
    assert.equal(existsSync(ws.dir), false)
    assert.equal(worktreeCount(root), 1)
    assert.equal(readFileSync(join(root, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 1\n')
    assert.equal(readFileSync(join(root, 'docs/notes.md'), 'utf8'), 'dirty edit from another session\n')
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('createShipWorkspace refuses bytes that drifted from the approval and cleans up', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    addNodeModules(root)
    write(root, ALPHA, ALPHA_POST)
    const pre = preflight(root, { fetch: false })
    write(root, ALPHA, ALPHA_POST.replace('alpha body', 'edited after the review'))
    const before = shipTempDirs()
    assert.throws(() => createShipWorkspace(root, pre), /tree changed since the review/)
    assert.deepEqual(shipTempDirs(), before)
    assert.equal(worktreeCount(root), 1)
  } finally {
    cleanupWithOrigin(fx)
  }
})

// ---------------------------------------------------------------------------
// Commit

test('commitApproved commits exactly the approved paths and pushCommit publishes it', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root, bare } = fx
    write(root, ALPHA, ALPHA_POST)
    write(root, 'src/assets/hero/2026/07/new.webp', 'hero bytes')
    write(root, 'src/content/posts/other.md', POST_BODY)
    const files = hashChangeSet(root, ['src/assets/hero/2026/07/new.webp', ALPHA])
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    const sha = commitApproved(root, { baseSha, files }, { message: 'post: update alpha', trailer: false })
    pushCommit(root, sha)
    assert.equal(run(bare, ['rev-parse', 'main']), sha)
    const committed = run(root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committed, ['src/assets/hero/2026/07/new.webp', ALPHA])
    assert.match(run(root, ['status', '--porcelain']), /other\.md/)
    assert.doesNotMatch(run(root, ['log', '-1', '--format=%B']), /Co-Authored-By/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('commitApproved adds the agent trailer when asked', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, ALPHA, ALPHA_POST)
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    commitApproved(root, { baseSha, files: hashChangeSet(root, [ALPHA]) }, {
      message: 'post: update alpha',
      trailer: true,
    })
    assert.match(run(root, ['log', '-1', '--format=%B']), /Co-Authored-By: Claude Fable 5/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('commitApproved refuses when local main is not origin/main', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    write(root, 'tracked.md', 'local commit\n')
    run(root, ['commit', '-q', '-am', 'local'])
    write(root, ALPHA, ALPHA_POST)
    assert.throws(
      () => commitApproved(root, { baseSha, files: hashChangeSet(root, [ALPHA]) }, { message: 'm' }),
      /local main must equal origin\/main/
    )
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('commitApproved undoes a commit whose bytes differ from the approval', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    write(root, ALPHA, ALPHA_POST)
    write(root, 'tracked.md', 'tracked edit\n')
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    const files = { [ALPHA]: 'f'.repeat(64), 'tracked.md': hashChangeSet(root, ['tracked.md'])['tracked.md'] }
    assert.throws(
      () => commitApproved(root, { baseSha, files }, { message: 'm', trailer: false }),
      /undone and nothing was pushed[\s\S]*alpha\.md: committed bytes differ/
    )
    assert.equal(run(root, ['rev-parse', 'HEAD']), baseSha)
    assert.equal(run(root, ['diff', '--cached', '--name-only']), '')
    assert.equal(readFileSync(join(root, ALPHA), 'utf8'), ALPHA_POST)
    assert.equal(readFileSync(join(root, 'tracked.md'), 'utf8'), 'tracked edit\n')
    assert.match(run(root, ['status', '--porcelain']), /\?\? src\//)
  } finally {
    cleanupWithOrigin(fx)
  }
})

// ---------------------------------------------------------------------------
// main(): the whole flow with fake checks (no Astro in fixtures)

async function captured(fn) {
  const lines = []
  const log = console.log
  const error = console.error
  console.log = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const code = await fn()
    return { code, output: lines.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

const GO = async () => [{ num: 1, name: 'fake', status: 'PASS' }]

function dirtySharedCheckout(root) {
  write(root, 'docs/notes.md', 'baseline\n')
  publishBaseline(root, ['docs/notes.md'])
  addNodeModules(root)
  write(root, 'docs/notes.md', 'another session is editing\n')
  write(root, 'scripts/discovery.test.mjs', "import '../src/utils/discovery.ts'\n")
  write(root, 'src/components/Unrelated.astro', '<p>wip</p>\n')
  write(root, ALPHA, ALPHA_POST)
}

test('main ships only the selected post from a dirty shared checkout and cleans up', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root, bare } = fx
    dirtySharedCheckout(root)
    const pre = preflight(root, { fetch: false })
    assert.deepEqual(pre.changeSet, [ALPHA])
    let seen = null
    const checks = async (tree, opts) => {
      seen = {
        tree,
        opts,
        discovery: existsSync(join(tree, 'scripts/discovery.test.mjs')),
        unrelated: existsSync(join(tree, 'src/components/Unrelated.astro')),
        docs: readFileSync(join(tree, 'docs/notes.md'), 'utf8'),
        post: readFileSync(join(tree, ALPHA), 'utf8'),
      }
      return GO()
    }
    const { code, output } = await captured(() =>
      main({ yes: true, digest: pre.digest, port: '4322' }, { root, checks, watch: async () => 'success' })
    )
    assert.equal(code, 0, output)
    assert.match(output, /ignoring 3 other changed or untracked path/)
    assert.equal(seen.discovery, false)
    assert.equal(seen.unrelated, false)
    assert.equal(seen.docs, 'baseline\n')
    assert.equal(seen.post, ALPHA_POST)
    assert.equal(seen.opts.previewStateRoot, root)
    assert.deepEqual(seen.opts.previewChangeSet, [ALPHA])
    assert.ok(seen.opts.skipCheckpoint)
    const sha = run(root, ['rev-parse', 'HEAD'])
    assert.equal(run(bare, ['rev-parse', 'main']), sha)
    assert.deepEqual(run(root, ['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean), [ALPHA])
    assert.equal(run(root, ['log', '-1', '--format=%s']), 'post: update alpha')
    const status = run(root, ['status', '--porcelain', '--untracked-files=all'])
    assert.match(status, /M docs\/notes\.md/)
    assert.match(status, /\?\? scripts\/discovery\.test\.mjs/)
    assert.ok(readManifest(root).files[ALPHA])
    assert.equal(existsSync(dirname(seen.tree)), false)
    assert.equal(worktreeCount(root), 1)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('main ships library data alone with a library commit message', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root, bare } = fx
    write(root, LIBRARY, '[1]\n')
    publishBaseline(root, [LIBRARY])
    addNodeModules(root)
    write(root, LIBRARY, '[1,2]\n')
    const pre = preflight(root, { fetch: false })
    const { code, output } = await captured(() =>
      main({ yes: true, digest: pre.digest }, { root, checks: GO, watch: async () => 'success' })
    )
    assert.equal(code, 0, output)
    assert.equal(run(bare, ['log', '-1', '--format=%s', 'main']), 'library: update books')
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('main aborts without committing when a selected file changes during the checks', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root, bare } = fx
    dirtySharedCheckout(root)
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    const pre = preflight(root, { fetch: false })
    let tree = null
    const checks = async (t) => {
      tree = t
      write(root, ALPHA, ALPHA_POST.replace('alpha body', 'concurrent edit'))
      return GO()
    }
    const { code, output } = await captured(() =>
      main({ yes: true, digest: pre.digest }, { root, checks, watch: async () => 'success' })
    )
    assert.equal(code, 1)
    assert.match(output, /tree changed since the review/)
    assert.equal(run(root, ['rev-parse', 'HEAD']), baseSha)
    assert.equal(run(bare, ['rev-parse', 'main']), baseSha)
    assert.equal(existsSync(dirname(tree)), false)
    assert.equal(worktreeCount(root), 1)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('main removes the temporary worktree when the checks fail or throw', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    dirtySharedCheckout(root)
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    const pre = preflight(root, { fetch: false })
    const trees = []
    const nogo = async (t) => {
      trees.push(t)
      return [{ num: 6, name: 'build', status: 'FAIL', detail: 'boom' }]
    }
    const failed = await captured(() => main({ yes: true, digest: pre.digest }, { root, checks: nogo }))
    assert.equal(failed.code, 1)
    assert.match(failed.output, /VERDICT: NO-GO/)
    const throwing = async (t) => {
      trees.push(t)
      throw new Error('checks crashed')
    }
    await assert.rejects(
      captured(() => main({ yes: true, digest: pre.digest }, { root, checks: throwing })),
      /checks crashed/
    )
    for (const t of trees) assert.equal(existsSync(dirname(t)), false)
    assert.equal(worktreeCount(root), 1)
    assert.equal(run(root, ['rev-parse', 'HEAD']), baseSha)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('main --dry-run runs everything except the commit and push', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root, bare } = fx
    dirtySharedCheckout(root)
    const baseSha = run(root, ['rev-parse', 'origin/main'])
    const pre = preflight(root, { fetch: false })
    let ran = false
    const checks = async () => {
      ran = true
      return GO()
    }
    const { code, output } = await captured(() =>
      main({ yes: true, digest: pre.digest, 'dry-run': true }, { root, checks })
    )
    assert.equal(code, 0, output)
    assert.ok(ran)
    assert.match(output, /dry run: would commit 1 file\(s\) as "post: update alpha"/)
    assert.equal(run(root, ['rev-parse', 'HEAD']), baseSha)
    assert.equal(run(bare, ['rev-parse', 'main']), baseSha)
    assert.equal(worktreeCount(root), 1)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('main stops at the content check before building anything', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    addNodeModules(root)
    write(root, ALPHA, ALPHA_POST.replace('alpha body', 'alpha \u2014 body'))
    const pre = preflight(root, { fetch: false })
    const { code, output } = await captured(() =>
      main({ yes: true, digest: pre.digest }, { root, checks: GO })
    )
    assert.equal(code, 1)
    assert.match(output, /src\/content\/posts\/alpha\.md:7 \[em-dash\]/)
    assert.equal(worktreeCount(root), 1)
  } finally {
    cleanupWithOrigin(fx)
  }
})

// ---------------------------------------------------------------------------
// CLI

const SHIP = fileURLToPath(new URL('./ship.mjs', import.meta.url))

function runShip(root, args) {
  try {
    const stdout = execFileSync('node', [SHIP, ...args], { cwd: root, encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

test('cli: the removed --fast lane is an unknown option', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const res = runShip(fx.root, ['--fast', '--only', ALPHA])
    assert.equal(res.code, 1)
    assert.match(res.stderr, /Unknown option '--fast'/)
  } finally {
    cleanupWithOrigin(fx)
  }
})

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
    write(root, ALPHA, ALPHA_POST)
    write(root, 'docs/notes.md', 'unrelated\n')
    const res = runShip(root, ['--preflight'])
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /src\/content\/posts\/alpha\.md/)
    assert.match(res.stdout, /ignoring 1 other changed or untracked path/)
    assert.match(res.stdout, /changeset digest: [0-9a-f]{12}/)
    assert.equal(existsSync(join(root, '.preview', 'manifest.json')), false)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('cli: --yes with a stale digest aborts before creating a worktree or manifest', () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    addNodeModules(root)
    write(root, ALPHA, ALPHA_POST)
    const res = runShip(root, ['--yes', '--digest', '000000000000'])
    assert.equal(res.code, 1)
    assert.match(res.stderr, /tree changed since the review/)
    assert.doesNotMatch(res.stdout, /temporary worktree/)
    assert.equal(existsSync(join(root, '.preview', 'manifest.json')), false)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('cli: Ctrl+C at the approval prompt stops the server and removes the temporary worktree', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    addNodeModules(root)
    const calls = installFakeAstro(root)
    write(root, ALPHA, ALPHA_POST)
    const port = await freePort()
    const child = spawn('node', [SHIP, '--no-open', '--port', String(port)], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    const stdout = await waitForOutput(child, /approve these 1 file\(s\) and ship\?/)
    const tree = stdout.match(/temporary worktree: (.+)/)[1].trim()
    assert.ok(existsSync(tree))
    const outDir = join(dirname(tree), 'dist')
    const log = readFileSync(calls, 'utf8')
    assert.match(log, new RegExp(`astro build --outDir ${outDir}`))
    assert.match(log, new RegExp(`pagefind --site ${outDir}`))
    assert.match(log, new RegExp(`astro preview --outDir ${outDir} --port ${port}`))
    // the review build renders drafts (marked, noindex); release checks build without
    assert.equal(readFileSync(join(dirname(calls), 'env.log'), 'utf8'), 'SHOW_DRAFTS=1\n')
    assert.equal(existsSync(join(root, 'dist')), false)
    assert.equal((await fetch(`http://localhost:${port}/`)).status, 200)
    child.kill('SIGINT')
    assert.equal(await exited, 130)
    assert.equal(existsSync(dirname(tree)), false)
    assert.equal(worktreeCount(root), 1)
    await assert.rejects(fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) }))
    assert.equal(existsSync(join(root, '.preview', 'manifest.json')), false)
  } finally {
    cleanupWithOrigin(fx)
  }
})

test('cli: --review serves the selection build, prints the --yes command, records nothing', async () => {
  const fx = makeFixtureWithOrigin()
  try {
    const { root } = fx
    addNodeModules(root)
    installFakeAstro(root)
    write(root, ALPHA, ALPHA_POST)
    write(root, 'src/components/Wip.astro', '<p>another session</p>\n')
    const port = await freePort()
    const child = spawn('node', [SHIP, '--review', '--no-open', '--port', String(port), '--only', ALPHA], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    const stdout = await waitForOutput(child, /npm run ship -- --yes --digest [0-9a-f]{12}/)
    const digest = stdout.match(/changeset digest: ([0-9a-f]{12})/)[1]
    assert.match(stdout, new RegExp(`--yes --digest ${digest} --only ${ALPHA}`))
    const tree = stdout.match(/temporary worktree: (.+)/)[1].trim()
    assert.equal(existsSync(join(tree, 'src/components/Wip.astro')), false)
    assert.equal((await fetch(`http://localhost:${port}/`)).status, 200)
    child.kill('SIGTERM')
    assert.equal(await exited, 130)
    assert.equal(existsSync(dirname(tree)), false)
    assert.equal(worktreeCount(root), 1)
    assert.equal(existsSync(join(root, '.preview', 'manifest.json')), false)
    assert.equal(runShip(root, ['--review', '--yes', '--digest', digest]).code, 1)
  } finally {
    cleanupWithOrigin(fx)
  }
})
