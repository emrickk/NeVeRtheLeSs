import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, write } from './test-helpers.mjs'
import {
  checkBuiltLinks,
  extractRefs,
  internalPath,
  pageUrlFor,
  resolvesTo,
} from './check-built-links.mjs'

const CLI = fileURLToPath(new URL('./check-built-links.mjs', import.meta.url))

function makeDist(files) {
  const root = mkdtempSync(join(tmpdir(), 'built-links-'))
  for (const [rel, content] of Object.entries(files)) write(root, join('dist', rel), content)
  return { root, dist: join(root, 'dist') }
}

test('extractRefs reads href, src and srcset, skipping scripts, styles and comments', () => {
  const html = `
    <a href="/posts/a/">a</a><img src='/_astro/x.webp' srcset="/_astro/x-400.webp 400w, /_astro/x-800.webp 800w">
    <a href="/q?x=1&amp;y=2">q</a><div data-href="/not-an-attr-match"></div>
    <!-- <a href="/commented-out/"> -->
    <script>const t = '<a href="/from-script/">'</script>
    <style>.x { background: url("/from-style.png") }</style>`
  assert.deepEqual(extractRefs(html), [
    '/posts/a/',
    '/_astro/x.webp',
    '/_astro/x-400.webp',
    '/_astro/x-800.webp',
    '/q?x=1&y=2',
  ])
})

test('internalPath keeps site links and drops external, CDN and non-http refs', () => {
  const page = pageUrlFor('posts/a/index.html')
  assert.equal(page, 'https://theneverless.com/posts/a/')
  assert.equal(internalPath('/about/#team', page), '/about/')
  assert.equal(internalPath('/posts/?lang=en', page), '/posts/')
  assert.equal(internalPath('https://theneverless.com/rss.xml', page), '/rss.xml')
  assert.equal(internalPath('https://www.theneverless.com/', page), '/')
  assert.equal(internalPath('//theneverless.com/library/', page), '/library/')
  assert.equal(internalPath('../b/', page), '/posts/b/')
  assert.equal(internalPath('/%E6%96%87/', page), '/文/')
  assert.equal(internalPath('https://cdn.theneverless.com/2020/02/foo.webp', page), null)
  assert.equal(internalPath('https://example.com/', page), null)
  assert.equal(internalPath('//example.com/x', page), null)
  assert.equal(internalPath('mailto:someone@example.com', page), null)
  assert.equal(internalPath('data:image/png;base64,AAAA', page), null)
  assert.equal(internalPath('javascript:void(0)', page), null)
  assert.equal(internalPath('#top', page), null)
})

test('resolvesTo handles index pages, files, extensionless pages and case', () => {
  const files = new Set(['index.html', 'posts/a/index.html', 'rss.xml', '404.html'])
  assert.ok(resolvesTo('/', files))
  assert.ok(resolvesTo('/posts/a/', files))
  assert.ok(resolvesTo('/posts/a', files))
  assert.ok(resolvesTo('/rss.xml', files))
  assert.ok(resolvesTo('/404', files))
  assert.ok(!resolvesTo('/posts/b/', files))
  assert.ok(!resolvesTo('/rss.xml/', files))
  assert.ok(!resolvesTo('/Posts/a/', files))
})

test('checkBuiltLinks groups broken targets by the pages that reference them', (t) => {
  const { root, dist } = makeDist({
    'index.html': '<a href="/posts/a/">a</a><a href="/missing/">x</a><a href="https://example.com/">e</a>',
    'posts/a/index.html':
      '<a href="https://theneverless.com/">home</a><a href="/missing/#frag">x</a><img src="https://cdn.theneverless.com/a.webp">',
  })
  t.after(() => cleanup(root))
  const { pages, checked, broken } = checkBuiltLinks(dist)
  assert.equal(pages, 2)
  assert.equal(checked, 4)
  assert.deepEqual([...broken.keys()], ['/missing/'])
  assert.deepEqual([...broken.get('/missing/')].sort(), ['index.html', 'posts/a/index.html'])
})

test('CLI exits 0 on a clean dist, 1 on broken links, 2 when dist is missing', (t) => {
  const clean = makeDist({ 'index.html': '<a href="/">home</a>' })
  const bad = makeDist({ 'index.html': '<a href="/gone/">gone</a>' })
  t.after(() => {
    cleanup(clean.root)
    cleanup(bad.root)
  })
  const exitCode = (dist) => {
    try {
      execFileSync('node', [CLI, dist], { stdio: 'pipe' })
      return 0
    } catch (err) {
      return err.status
    }
  }
  assert.equal(exitCode(clean.dist), 0)
  assert.equal(exitCode(bad.dist), 1)
  assert.equal(exitCode(join(clean.root, 'nope')), 2)
})
