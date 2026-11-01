#!/usr/bin/env node
// Checkpoint CLI: snapshot and restore working-tree files via hidden git refs.
// Snapshots live under refs/checkpoints/ (local only, never pushed). Saving
// and restoring never move HEAD, branches, or the real index.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'

const REF_PREFIX = 'refs/checkpoints/'
const KEEP_COUNT = 50
const KEEP_DAYS = 30
const KEEP_FLOOR = 5
// Deterministic ident so commit-tree never depends on user git config
const IDENT = {
  GIT_AUTHOR_NAME: 'checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@local',
  GIT_COMMITTER_NAME: 'checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@local',
}

export function git(args, { cwd, env, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, '')
  } catch (err) {
    if (allowFail) return null
    const stderr = err.stderr ? String(err.stderr).trim() : err.message
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: err })
  }
}

export function repoRoot(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true })
  if (!root) throw new Error('not inside a git repository')
  return root
}

// Hash the full working tree (tracked + untracked, .gitignore respected)
// using a temporary index so the real index is never touched.
export function workingTreeHash(root) {
  const tmp = mkdtempSync(join(tmpdir(), 'checkpoint-'))
  try {
    const env = { ...IDENT, GIT_INDEX_FILE: join(tmp, 'index') }
    git(['add', '-A'], { cwd: root, env })
    return git(['write-tree'], { cwd: root, env })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function slug(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'checkpoint'
}

function timestampId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  )
}

export function listCheckpoints(root) {
  const out = git(
    ['for-each-ref', '--sort=-refname',
      '--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)', REF_PREFIX],
    { cwd: root },
  )
  if (!out) return []
  return out.split('\n').map((line) => {
    const [refname, sha, date] = line.split('\t')
    const body = git(['log', '-1', '--format=%B', sha], { cwd: root })
    const meta = {}
    for (const m of body.matchAll(/^(label|trigger|branch|head): (.*)$/gm)) meta[m[1]] = m[2]
    return { id: refname.slice(REF_PREFIX.length), refname, sha, date: new Date(date), ...meta }
  })
}

export function save(root, { label, trigger = 'manual', quiet = false } = {}) {
  const tree = workingTreeHash(root)
  const existing = listCheckpoints(root)
  if (existing.length > 0) {
    const latestTree = git(['rev-parse', `${existing[0].sha}^{tree}`], { cwd: root })
    if (latestTree === tree) {
      if (!quiet) console.log(`no changes since last checkpoint (${existing[0].id})`)
      return { id: existing[0].id, created: false }
    }
  }
  const head = git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, allowFail: true })
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFail: true }) || 'unknown'
  const cleanLabel = slug(label || trigger)
  const message = [
    `checkpoint: ${cleanLabel}`, '',
    `label: ${cleanLabel}`, `trigger: ${trigger}`, `branch: ${branch}`, `head: ${head || 'none'}`,
  ].join('\n')
  const args = ['commit-tree', tree, '-m', message]
  if (head) args.splice(2, 0, '-p', head)
  const sha = git(args, { cwd: root, env: IDENT })
  let id = `${timestampId()}-${cleanLabel}`
  let n = 2
  while (git(['rev-parse', '--verify', '-q', REF_PREFIX + id], { cwd: root, allowFail: true }) !== null) {
    id = `${timestampId()}-${cleanLabel}-${n++}`
  }
  git(['update-ref', REF_PREFIX + id, sha], { cwd: root })
  prune(root, { quiet: true })
  if (!quiet) console.log(`checkpoint saved: ${id}`)
  return { id, created: true }
}

export function resolveId(root, query) {
  if (!query) throw new Error('missing checkpoint id (run: npm run checkpoint list)')
  const all = listCheckpoints(root)
  const exact = all.find((c) => c.id === query)
  if (exact) return exact
  const matches = all.filter((c) => c.id.includes(query))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error(`no checkpoint matches "${query}" (run: npm run checkpoint list)`)
  throw new Error(`"${query}" is ambiguous, matches: ${matches.map((c) => c.id).join(', ')}`)
}

export function diffCheckpoint(root, query, { full = false, paths = [] } = {}) {
  const ckpt = resolveId(root, query)
  const cur = workingTreeHash(root)
  const args = ['diff', '--no-renames', ...(full ? [] : ['--stat']), `${ckpt.sha}^{tree}`, cur]
  if (paths.length) args.push('--', ...paths)
  return git(args, { cwd: root })
}

export function assertNoOperationInProgress(root) {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: root })
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(join(gitDir, marker))) {
      throw new Error(`refusing to restore: ${marker} present (finish or abort that operation first)`)
    }
  }
}

export function restorePlan(root, query, paths = []) {
  const ckpt = resolveId(root, query)
  const cur = workingTreeHash(root)
  const args = ['diff', '--no-renames', '--name-status', cur, `${ckpt.sha}^{tree}`]
  if (paths.length) args.push('--', ...paths)
  const out = git(args, { cwd: root })
  const changes = !out
    ? []
    : out.split('\n').map((line) => {
        const [status, ...rest] = line.split('\t')
        return { status: status[0], path: rest[rest.length - 1] }
      })
  return { ckpt, changes }
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function removeEmptyDirs(root, rel) {
  let dir = rel
  while (dir && dir !== '.' && dir !== '/') {
    try {
      rmdirSync(join(root, dir))
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export async function restore(root, query, { paths = [], yes = false, quiet = false } = {}) {
  assertNoOperationInProgress(root)
  const { ckpt, changes } = restorePlan(root, query, paths)
  if (changes.length === 0) {
    if (!quiet) console.log('working tree already matches the checkpoint')
    return { restored: 0 }
  }
  if (!quiet) {
    const counts = { M: 0, A: 0, D: 0 }
    for (const c of changes) counts[c.status] = (counts[c.status] || 0) + 1
    console.log(`restore from ${ckpt.id} (${ckpt.trigger}, branch ${ckpt.branch}):`)
    console.log(`  ${counts.M || 0} overwritten, ${counts.A || 0} recreated, ${counts.D || 0} deleted`)
    for (const c of changes.slice(0, 20)) console.log(`  ${c.status} ${c.path}`)
    if (changes.length > 20) console.log(`  ... and ${changes.length - 20} more`)
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new Error('refusing to restore without confirmation, re-run with --yes')
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`Restore ${changes.length} file(s)? [y/N] `)).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') {
      console.log('aborted')
      return { restored: 0, aborted: true }
    }
  }
  const pre = save(root, { label: 'pre-restore', trigger: 'pre-restore', quiet: true })
  const writeBack = changes.filter((c) => c.status !== 'D').map((c) => c.path)
  const remove = changes.filter((c) => c.status === 'D').map((c) => c.path)
  for (const batch of chunk(writeBack, 200)) {
    git(['restore', '--worktree', `--source=${ckpt.sha}`, '--', ...batch], { cwd: root })
  }
  for (const p of remove) {
    rmSync(join(root, p), { force: true })
    removeEmptyDirs(root, dirname(p))
  }
  if (!quiet) {
    console.log(`restored ${changes.length} file(s) from ${ckpt.id}`)
    console.log(`undo with: node scripts/checkpoint.mjs restore ${pre.id}`)
  }
  return { restored: changes.length, preRestoreId: pre.id }
}

export function prune(root, { keep = KEEP_COUNT, days = KEEP_DAYS, quiet = false } = {}) {
  const all = listCheckpoints(root)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const floor = Math.max(keep, KEEP_FLOOR)
  const doomed = all.filter((c, i) => i >= floor && c.date.getTime() < cutoff)
  for (const c of doomed) git(['update-ref', '-d', c.refname], { cwd: root })
  if (!quiet && doomed.length) console.log(`pruned ${doomed.length} checkpoint(s)`)
  return doomed.length
}

const USAGE = `usage: node scripts/checkpoint.mjs <command>

  save [label] [--auto <trigger>] [--quiet]   snapshot the working tree
  list                                        show checkpoints, newest first
  diff <id> [--full] [-- <path>...]           compare checkpoint to current files
  restore <id> [--yes] [-- <path>...]         make files match the checkpoint
  prune [--keep <n>] [--days <d>]             delete old checkpoints (floor: 5 newest)

<id> accepts the full id from list or any unique substring of it.
Via npm, flags only reach the script after a double dash: npm run checkpoint -- restore <id> --yes`

function ago(date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function splitPathArgs(argv) {
  const sep = argv.indexOf('--')
  return sep === -1 ? { args: argv, paths: [] } : { args: argv.slice(0, sep), paths: argv.slice(sep + 1) }
}

function flagValue(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

async function main(argv) {
  const { args, paths } = splitPathArgs(argv)
  const [command, ...rest] = args
  const quiet = args.includes('--quiet')
  const root = repoRoot()
  if (command === 'save') {
    const label = rest.find((a) => !a.startsWith('--') && a !== flagValue(args, '--auto'))
    save(root, { label, trigger: flagValue(args, '--auto') || 'manual', quiet })
  } else if (command === 'list') {
    const list = listCheckpoints(root)
    if (list.length === 0) return console.log('no checkpoints yet (npm run checkpoint save)')
    const cur = workingTreeHash(root)
    for (const c of list) {
      const stat = git(['diff', '--shortstat', `${c.sha}^{tree}`, cur], { cwd: root })
      const drift = stat ? stat.trim() : 'matches current state'
      console.log(`${c.id}  ${ago(c.date)}  [${c.trigger}]  branch ${c.branch}  ${drift}`)
    }
  } else if (command === 'diff') {
    console.log(diffCheckpoint(root, rest.filter((a) => !a.startsWith('--'))[0], { full: args.includes('--full'), paths }))
  } else if (command === 'restore') {
    await restore(root, rest.filter((a) => !a.startsWith('--'))[0], { yes: args.includes('--yes'), quiet, paths })
  } else if (command === 'prune') {
    const n = prune(root, {
      keep: flagValue(args, '--keep') ? Number(flagValue(args, '--keep')) : undefined,
      days: flagValue(args, '--days') ? Number(flagValue(args, '--days')) : undefined,
      quiet,
    })
    if (!quiet && n === 0) console.log('nothing to prune')
  } else {
    console.error(USAGE)
    process.exit(command ? 1 : 0)
  }
}

// CLI entry (pathToFileURL handles spaces in the repo path)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
