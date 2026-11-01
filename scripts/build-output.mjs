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

// astro build --outDir <outDir>, then pagefind --site <outDir>: the same two
// steps as `npm run build`, aimed at a private directory. Uses the project's
// own binaries (no npx resolution or network). `stdio: 'inherit'` streams
// output for interactive commands; 'pipe' returns it for check summaries.
export function buildSite(root, outDir, { stdio = 'pipe', env = process.env } = {}) {
  const steps = [
    ['astro', ['build', '--outDir', outDir]],
    ['pagefind', ['--site', outDir]],
  ]
  let output = ''
  for (const [name, args] of steps) {
    const exe = bin(root, name)
    if (!existsSync(exe)) {
      return { ok: false, output: `${exe} not found; run npm ci in ${root}` }
    }
    const res = spawnSync(exe, args, {
      cwd: root,
      env,
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

// Arguments for `astro preview` serving a run directory.
export function previewArgs(outDir, { port, host = false } = {}) {
  const args = ['preview', '--outDir', outDir, '--port', String(port)]
  if (host) args.push('--host')
  return args
}

export function astroBin(root) {
  return bin(root, 'astro')
}
