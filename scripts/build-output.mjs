// Per-run production builds for the safety tools. preview-posts, ship, and
// release-check used to share dist/, so two sessions building at once could
// serve or verify each other's half-written output. Each run now builds into
// its own temporary directory outside the repo (outside tsconfig's include
// glob, so astro check never sees it) and removes it when done.
// `npm run build` (dist/) stays the deploy workflow's command.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fresh, empty directory for one run. The caller owns cleanup through
// removeRunDir, normally in a finally block plus a signal handler.
export function makeRunDir(label) {
  return mkdtempSync(join(tmpdir(), `blog-${label}-`))
}

export function removeRunDir(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true })
}

function bin(root, name) {
  return join(root, 'node_modules', '.bin', name)
}

// Pagefind splits its index by each page's <html lang>, and the search UI
// loads only the index matching the page it runs on. English-primary posts
// carry lang="en" and the language toggle rewrites <html lang>, so the site
// is indexed as one language to keep every post searchable from every page.
// `npm run build` in package.json passes the same flag.
export const PAGEFIND_LANGUAGE_ARGS = ['--force-language', 'zh-cn']

// Environment for one build. Production builds (release-check) drop any
// SHOW_DRAFTS the calling shell exported; review builds (preview-posts,
// ship) set it so draft posts render at their own URLs, marked Draft and
// noindex (src/utils/drafts.ts).
export function buildEnv(env = process.env, { showDrafts = false } = {}) {
  const out = { ...env }
  delete out.SHOW_DRAFTS
  if (showDrafts) out.SHOW_DRAFTS = '1'
  return out
}

// astro build --outDir <outDir>, then pagefind --site <outDir>: the same two
// steps as `npm run build`, aimed at a private directory. Uses the project's
// own binaries (no npx resolution or network). `stdio: 'inherit'` streams
// output for interactive commands; 'pipe' returns it for check summaries.
// `showDrafts` makes it a review build; the default is the production output.
export function buildSite(
  root,
  outDir,
  { stdio = 'pipe', env = process.env, showDrafts = false } = {}
) {
  const buildEnvironment = buildEnv(env, { showDrafts })
  const steps = [
    ['astro', ['build', '--outDir', outDir]],
    ['pagefind', ['--site', outDir, ...PAGEFIND_LANGUAGE_ARGS]],
  ]
  let output = ''
  for (const [name, args] of steps) {
    const exe = bin(root, name)
    if (!existsSync(exe)) {
      return { ok: false, output: `${exe} not found; run npm ci in ${root}` }
    }
    const res = spawnSync(exe, args, {
      cwd: root,
      env: buildEnvironment,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (stdio !== 'inherit') output += `${res.stdout || ''}${res.stderr || ''}`
    if (res.error) return { ok: false, output: `${output}\ncould not run ${name}: ${res.error.message}` }
    if (res.status !== 0) {
      return { ok: false, output: `${output}\n${name} ${args.join(' ')} exited with ${res.status}` }
    }
  }
  return { ok: true, output }
}

// Arguments for `astro preview` serving a run directory. `--ignore-lock`
// keeps the server in the foreground: Astro 7 otherwise detaches it when an
// agent runs the command, and this tool would then delete the build it serves.
export function previewArgs(outDir, { port, host = false } = {}) {
  const args = ['preview', '--outDir', outDir, '--port', String(port), '--ignore-lock']
  if (host) args.push('--host')
  return args
}

export function astroBin(root) {
  return bin(root, 'astro')
}
