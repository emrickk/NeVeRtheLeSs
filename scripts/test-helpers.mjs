// Test fixtures for the safety tooling suites. Creates throwaway git repos
// and dist trees under the OS tmpdir; never touches the real repo.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function run(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

export function write(root, rel, content) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

export function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'blog-safety-fixture-'))
  run(root, ['init', '-q', '-b', 'main'])
  run(root, ['config', 'user.email', 'test@local'])
  run(root, ['config', 'user.name', 'test'])
  write(root, '.gitignore', 'ignored.txt\nnode_modules/\n')
  write(root, 'tracked.md', 'original\n')
  run(root, ['add', '.gitignore', 'tracked.md'])
  run(root, ['commit', '-q', '-m', 'init'])
  return root
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

// Minimal valid dist tree for release-check output tests. Pass overrides to
// plant violations or omit required files.
export function makeFixtureDist(root, { omit = [], extraHtml = {} } = {}) {
  const dist = join(root, 'dist')
  const files = {
    'index.html': '<html><body><a href="/posts/a/">a</a></body></html>',
    'posts/a/index.html':
      '<html><body><img src="https://cdn.theneverless.com/2020/02/foo.webp"><a href="/">home</a></body></html>',
    'rss.xml': '<rss><channel><title>t</title></channel></rss>',
    'sitemap-index.xml': '<sitemapindex></sitemapindex>',
    'pagefind/pagefind.js': '// pagefind stub',
    ...extraHtml,
  }
  for (const [rel, content] of Object.entries(files)) {
    if (omit.includes(rel)) continue
    write(root, join('dist', rel), content)
  }
  return dist
}

// Stand-ins for node_modules/.bin/astro and pagefind, so CLI tests can drive
// the build and preview steps without a real Astro project. `astro build`
// writes one page into --outDir and records its argv, plus its SHOW_DRAFTS
// value in env.log; `astro preview` serves --outDir on --port; pagefind
// records its argv.
const FAKE_ASTRO = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const [cmd, ...rest] = process.argv.slice(2)
const arg = (k) => rest[rest.indexOf(k) + 1]
fs.appendFileSync(path.join(__dirname, 'calls.log'), 'astro ' + process.argv.slice(2).join(' ') + '\\n')
if (cmd === 'build') {
  fs.appendFileSync(path.join(__dirname, 'env.log'), 'SHOW_DRAFTS=' + (process.env.SHOW_DRAFTS ?? '') + '\\n')
  fs.mkdirSync(arg('--outDir'), { recursive: true })
  fs.writeFileSync(path.join(arg('--outDir'), 'index.html'), '<html>fake</html>')
} else if (cmd === 'preview') {
  http.createServer((req, res) => res.end('fake preview')).listen(Number(arg('--port')))
}
`
const FAKE_PAGEFIND = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
fs.appendFileSync(path.join(__dirname, 'calls.log'), 'pagefind ' + process.argv.slice(2).join(' ') + '\\n')
`

export function installFakeAstro(root) {
  write(root, 'node_modules/.bin/astro', FAKE_ASTRO)
  write(root, 'node_modules/.bin/pagefind', FAKE_PAGEFIND)
  chmodSync(join(root, 'node_modules/.bin/astro'), 0o755)
  chmodSync(join(root, 'node_modules/.bin/pagefind'), 0o755)
  return join(root, 'node_modules/.bin/calls.log')
}

export async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// Resolves once `pattern` appears in the child's stdout; returns everything
// read so far.
export function waitForOutput(child, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}:\n${out}\n${err}`)),
      timeoutMs
    )
    child.stderr?.on('data', (d) => (err += d))
    child.stdout.on('data', (d) => {
      out += d
      if (pattern.test(out)) {
        clearTimeout(timer)
        resolve(out)
      }
    })
  })
}
