// One-command publish for post and library edits: checkpoint, selection,
// production preview, owner approval, release checks, commit, push, and a
// deploy watch. Two entry points share this file: the owner runs it
// interactively, and the ship-posts skill drives it with --preflight, then
// --review (serves the exact build that would ship), then --yes --digest
// after the owner approves in chat.
//
// The shared checkout is usually dirty (several sessions work in it), so ship
// never builds or checks it in place. It creates a temporary git worktree at
// origin/main, copies in ONLY the selected files (verifying each copied byte
// against the approval digest), and runs the preview build and the release
// checklist there. Unselected edits and untracked files in the shared
// checkout never reach the build, the checks, or the commit. The commit is
// made in the shared checkout with explicit paths, only while local main
// equals origin/main, and is verified blob by blob against the approved
// bytes before anything is pushed. Original spec:
// docs/superpowers/specs/2026-07-16-ship-command-design.md
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { astroBin, buildSite, previewArgs } from './build-output.mjs'
import { git, save } from './checkpoint.mjs'
import { checkContentFiles, formatFinding } from './content-check.mjs'
import {
  hasCanonicalSegments,
  isCanonicalFlatPostPath,
  isHeroPath,
  isLibraryDataPath,
  isPostPath,
  resolveHeroReference,
  resolveHeroReferenceFromContent,
  translationCounterparts,
  validatePostPathLocation,
  validateRepoFileLocation,
} from './post-paths.mjs'
import {
  computeChangeSet,
  hashChangeSet,
  isDraftPost,
  parseFrontmatterScalars,
  primaryPostPath,
  renderReviewPage,
  resolveBaseRef,
  reviewTargets,
  scalarIsTrue,
  slugForPostFile,
  writeManifest,
} from './preview-posts.mjs'
import { FORBIDDEN_PATHS, removeActiveRunDirs, runChecks, verdict } from './release-check.mjs'

const ACTIONS_URL = 'https://github.com/emrickk/NeVeRtheLeSs/actions'
const SITE_URL = 'https://theneverless.com'
export const USAGE =
  'usage: npm run ship -- [--preflight | --review | --yes --digest <d>] [--only <path> ...] ' +
  '[--include <path> ...] [--dry-run] [--message <msg>] [--port N] [--no-open]'

// Paths --include refuses. Dependencies cannot be verified because the
// temporary worktree reuses the shared node_modules; workflows and local
// state need a regular session.
const INCLUDE_BLOCKED = [
  ...FORBIDDEN_PATHS.map(({ name, re }) => ({ re, why: `${name} must never be committed` })),
  { re: /^scripts\/images\/\.manifest-notes\.json$/, why: 'local image notes must never be committed' },
  {
    re: /^package(?:-lock)?\.json$/,
    why: 'dependency changes cannot be verified with the shared node_modules; use a regular session',
  },
  { re: /^\.github\//, why: 'workflow changes need a regular session' },
  { re: /^(?:node_modules|dist|\.preview|\.astro)\//, why: 'generated or local state' },
]

export function partitionPaths(paths) {
  const posts = paths.filter(isPostPath)
  const heroes = paths.filter(isHeroPath)
  const library = paths.filter(isLibraryDataPath)
  const used = new Set([...posts, ...heroes, ...library])
  return {
    posts: posts.sort(),
    heroes: heroes.sort(),
    library: library.sort(),
    other: paths.filter((p) => !used.has(p)).sort(),
  }
}

export function postPathsFor(changeSet) {
  return changeSet.filter(isPostPath)
}

// Resolve the hero references owned by a logical post set. Sibling files use
// their primary post's frontmatter, where Astro stores heroImage.
export function referencedHeroesForPosts(root, postPaths) {
  const heroes = new Set()
  const errors = []
  const primaryPaths = [...new Set(postPaths.map(primaryPostPath))].sort()
  for (const postPath of primaryPaths) {
    const location = validatePostPathLocation(root, postPath)
    if (location.status === 'error') {
      errors.push(location.detail)
      continue
    }
    if (location.status === 'missing' || isDraftPost(root, postPath)) continue
    const result = resolveHeroReference(root, postPath)
    if (result.status === 'error') errors.push(result.detail)
    if (result.status === 'ok') heroes.add(result.path)
  }
  return { heroes: [...heroes].sort(), errors }
}

export function sharedHeroOwners(root, heroPaths, selectedPostPaths) {
  const changedHeroes = new Set(heroPaths)
  const selectedPrimaries = new Set(selectedPostPaths.map(primaryPostPath))
  const owners = []
  const trackedPosts = (
    git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'src/content/posts'], { cwd: root }) ||
    ''
  )
    .split('\0')
    .filter((postPath) => isCanonicalFlatPostPath(postPath))
    .filter((postPath) => !/\.(?:en|zh)\.(?:md|mdx)$/.test(postPath))
  for (const postPath of trackedPosts) {
    if (selectedPrimaries.has(postPath)) continue
    const content = git(['show', `HEAD:${postPath}`], { cwd: root })
    if (scalarIsTrue(parseFrontmatterScalars(content).draft)) continue
    const reference = resolveHeroReferenceFromContent(root, postPath, content, {
      checkFile: false,
    })
    if (reference.status === 'ok' && changedHeroes.has(reference.path)) {
      owners.push({ hero: reference.path, post: postPath })
    }
  }
  return owners.sort((a, b) => a.hero.localeCompare(b.hero) || a.post.localeCompare(b.post))
}

// Freshness token binding an approval to the exact reviewed content: 12 hex
// chars of a sha256 over the sorted path:hash entries, newline-joined. Paths
// are part of every entry, so the selection (including --include paths) is
// bound as tightly as the bytes. Not a security boundary.
export function changeSetDigest(files) {
  const entries = Object.keys(files)
    .sort()
    .map((p) => `${p}:${files[p]}`)
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 12)
}

export function commitMessageFor(changeSet, { includes = [] } = {}) {
  const slugs = [...new Set(postPathsFor(changeSet).map((p) => slugForPostFile(p)))]
  const library = changeSet.filter(isLibraryDataPath).map((p) => basename(p, '.json'))
  const parts = []
  if (slugs.length) parts.push(`post: update ${slugs.join(', ')}`)
  if (library.length) parts.push(`library: update ${library.join(', ')}`)
  const subject = parts.join('; ') || 'ship: update selected files'
  return includes.length ? `${subject}\n\nAlso includes: ${includes.join(', ')}` : subject
}

// Everything a push could carry, unfiltered: worktree diff vs the base ref,
// untracked files, and the committed-only view (which catches a commit whose
// working-tree content was reverted without resetting the commit).
export function rawDiffPaths(root, baseRef) {
  const list = (args) => (git(args, { cwd: root }) || '').split('\0').filter(Boolean)
  return [
    ...new Set([
      ...list(['diff', '--no-renames', '--name-only', '-z', baseRef]),
      ...list(['ls-files', '--others', '--exclude-standard', '-z']),
      ...list(['diff', '--no-renames', '--name-only', '-z', `${baseRef}...HEAD`]),
    ]),
  ].sort()
}

// ahead counts commits that exist only on origin/main; localAhead counts
// commits that exist only on the current branch (committed but not pushed).
export function originStatus(root) {
  const hasOrigin = Boolean(
    git(['rev-parse', '--verify', '-q', 'origin/main'], { cwd: root, allowFail: true })
  )
  if (!hasOrigin) return { hasOrigin, ahead: 0, localAhead: 0 }
  const counts = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], { cwd: root })
  const parts = counts.split(/\s+/)
  return {
    hasOrigin,
    ahead: Number(parts[0] || '0'),
    localAhead: Number(parts[1] || '0'),
  }
}

function abort(detail) {
  return { status: 'abort', detail }
}

function validateIncludes(root, include, rawChanged) {
  const changed = new Set(rawChanged)
  const errors = []
  for (const p of include) {
    if (!hasCanonicalSegments(p)) {
      errors.push(`${p}: not a canonical repo-relative path`)
      continue
    }
    if (isPostPath(p) || isLibraryDataPath(p)) {
      errors.push(`${p}: select posts and library data with --only, not --include`)
      continue
    }
    if (isHeroPath(p)) {
      errors.push(`${p}: hero covers are selected automatically from the selected posts`)
      continue
    }
    const blocked = INCLUDE_BLOCKED.find(({ re }) => re.test(p))
    if (blocked) {
      errors.push(`${p}: ${blocked.why}`)
      continue
    }
    if (!changed.has(p)) {
      errors.push(`${p}: not changed against origin/main`)
      continue
    }
    const location = validateRepoFileLocation(root, p)
    if (location.status === 'error') errors.push(location.detail)
  }
  return errors
}

// Selection and approval digest. Returns a plain result so every branch is
// testable: status 'abort' (exit 1), 'empty' (exit 0), or 'ok'.
//
// Selected by default: every changed, non-draft post (with its translation
// siblings), every changed src/data/library/*.json, and changed hero covers
// referenced by the selected posts. `only` narrows that to the given post or
// library paths (a selected post brings its changed translation siblings).
// `include` adds explicit extra paths (for a post that needs a component or
// style change); they are listed, digest-bound, and committed like the rest.
// Everything else in the shared checkout is reported as ignored, not an
// error: it never reaches the temporary worktree.
//
// Local HEAD must be main and equal origin/main: the commit is pushed as the
// next commit after origin/main, so unpushed local commits would otherwise
// ride along unreviewed. `dryRun` reports those conditions instead of
// aborting, because a dry run never commits or pushes.
export function preflight(root, { fetch = true, only = null, include = null, dryRun = false } = {}) {
  const notes = []
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
  if (branch !== 'main') {
    if (!dryRun) return abort(`on branch ${branch}; ship only runs on main`)
    notes.push(`dry run on branch ${branch} (a real ship requires main)`)
  }
  if (fetch && originStatus(root).hasOrigin) {
    try {
      git(['fetch', 'origin'], { cwd: root })
    } catch {
      console.error('warning: could not fetch origin; comparing against the last-known origin/main')
    }
  }
  const { hasOrigin, ahead, localAhead } = originStatus(root)
  if (hasOrigin && ahead > 0) {
    const detail =
      `origin/main has ${ahead} commit(s) not in local main; ` +
      'reconcile in a regular coding session (or git pull --rebase when comfortable) before shipping'
    if (!dryRun) return abort(detail)
    notes.push(detail)
  }
  if (hasOrigin && localAhead > 0) {
    const detail =
      `local main has ${localAhead} unpushed commit(s); ship pushes the next commit after ` +
      'origin/main and would carry them along. Push or reconcile them in a regular coding session first'
    if (!dryRun) return abort(detail)
    notes.push(`${detail} (dry run: their committed changes are not in the temporary worktree)`)
  }
  const baseRef = resolveBaseRef(root)
  const baseSha = git(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: root })
  const raw = rawDiffPaths(root, baseRef)
  const { heroes: changedHeroes, library: changedLibrary } = partitionPaths(raw)

  let normalizedOnly = null
  if (only && only.length > 0) {
    normalizedOnly = [...new Set(only)].sort()
    const invalid = normalizedOnly.filter((p) => !isCanonicalFlatPostPath(p) && !isLibraryDataPath(p))
    if (invalid.length > 0) {
      return abort(
        '--only accepts post paths and src/data/library/*.json, but received:\n  ' +
          invalid.join('\n  ')
      )
    }
  }
  const normalizedInclude = include && include.length > 0 ? [...new Set(include)].sort() : []
  const includeErrors = validateIncludes(root, normalizedInclude, raw)
  if (includeErrors.length > 0) {
    return abort('--include refused:\n  ' + includeErrors.join('\n  '))
  }

  const onlyPosts = normalizedOnly ? normalizedOnly.filter(isPostPath) : null
  const onlyLibrary = normalizedOnly ? new Set(normalizedOnly.filter(isLibraryDataPath)) : null

  const changedPosts = postPathsFor(computeChangeSet(root, { baseRef }))
  let postSet = changedPosts
  if (onlyPosts) {
    const wanted = new Set(onlyPosts.flatMap((p) => [p, ...translationCounterparts(p)]))
    postSet = changedPosts.filter((p) => wanted.has(p))
  }

  const postPathsToValidate = new Set()
  for (const postPath of [...postSet, ...(onlyPosts || [])]) {
    postPathsToValidate.add(postPath)
    postPathsToValidate.add(primaryPostPath(postPath))
  }
  const invalidPostLocations = [...postPathsToValidate]
    .sort()
    .map((postPath) => validatePostPathLocation(root, postPath))
    .filter((result) => result.status === 'error')
    .map((result) => result.detail)
  if (invalidPostLocations.length > 0) {
    return abort('invalid post path:\n  ' + invalidPostLocations.join('\n  '))
  }

  const librarySet = onlyLibrary ? changedLibrary.filter((p) => onlyLibrary.has(p)) : changedLibrary
  const libraryErrors = librarySet
    .map((p) => validateRepoFileLocation(root, p, 'src/data/library'))
    .filter((result) => result.status === 'error')
    .map((result) => result.detail)
  if (libraryErrors.length > 0) {
    return abort('invalid library data path:\n  ' + libraryErrors.join('\n  '))
  }

  const referenced = referencedHeroesForPosts(root, postSet)
  if (referenced.errors.length > 0) {
    return abort('invalid heroImage reference:\n  ' + referenced.errors.join('\n  '))
  }
  const referencedSet = new Set(referenced.heroes)
  const heroSet = changedHeroes.filter((p) => referencedSet.has(p))
  if (heroSet.length > 0) {
    const shared = sharedHeroOwners(root, heroSet, postSet)
    if (shared.length > 0) {
      return abort(
        'ship cannot change a hero cover also used by an unselected post:\n  ' +
          shared.map(({ hero, post }) => `${hero} -> ${post}`).join('\n  ')
      )
    }
  }

  const changeSet = [
    ...new Set([...postSet, ...heroSet, ...librarySet, ...normalizedInclude]),
  ].sort()
  if (changeSet.length === 0) {
    return {
      status: 'empty',
      detail: only ? 'nothing to ship for the selection' : 'nothing to ship',
      baseRef,
      notes,
    }
  }
  const selected = new Set(changeSet)
  const files = hashChangeSet(root, changeSet)
  return {
    status: 'ok',
    baseRef,
    baseSha,
    postSet,
    changeSet,
    includes: normalizedInclude,
    ignored: raw.filter((p) => !selected.has(p)),
    notes,
    files,
    digest: changeSetDigest(files),
  }
}

export const TREE_CHANGED_DETAIL =
  'the tree changed since the review (another session?); nothing committed, start over'

export function recheckApprovedChangeSet(
  root,
  approvedDigest,
  { only = null, include = null, dryRun = false, baseSha = null } = {}
) {
  const current = preflight(root, { fetch: false, only, include, dryRun })
  if (
    current.status !== 'ok' ||
    current.digest !== approvedDigest ||
    (baseSha && current.baseSha !== baseSha)
  ) {
    return { status: 'abort', detail: TREE_CHANGED_DETAIL }
  }
  return current
}

// ---------------------------------------------------------------------------
// Temporary worktree

// Workspaces still on disk, so a signal handler can remove them; a signal
// skips the finally in main.
const activeWorkspaces = new Set()

// Cache directories Astro and Vite write inside node_modules stay private to
// the temporary worktree; every package is a symlink to the shared install.
const PRIVATE_NODE_MODULES = new Set(['.astro', '.vite', '.cache'])
// Env files Vite's loadEnv reads for a production build (POST_PASSWORD for
// protected posts). Symlinked, never copied, and git-ignored in the worktree.
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function linkNodeModules(root, tree) {
  const source = join(root, 'node_modules')
  if (!existsSync(source)) {
    throw new Error(`${source} is missing; run npm ci in the shared checkout first`)
  }
  const target = join(tree, 'node_modules')
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (PRIVATE_NODE_MODULES.has(entry)) continue
    symlinkSync(join(source, entry), join(target, entry))
  }
}

function linkEnvFiles(root, tree) {
  for (const name of ENV_FILES) {
    if (existsSync(join(root, name))) symlinkSync(join(root, name), join(tree, name))
  }
}

// Copy the approved bytes of every selected path into the worktree. Each
// file is read once, hashed, compared with the approval, and the same buffer
// is written, so the worktree holds exactly the digest-bound content.
export function copyApprovedFiles(root, tree, files) {
  for (const [relPath, hash] of Object.entries(files)) {
    const source = join(root, relPath)
    const target = join(tree, relPath)
    if (hash === 'deleted') {
      if (existsSync(source)) throw new Error(`${relPath}: ${TREE_CHANGED_DETAIL}`)
      rmSync(target, { force: true })
      continue
    }
    if (!existsSync(source) || lstatSync(source).isSymbolicLink()) {
      throw new Error(`${relPath}: ${TREE_CHANGED_DETAIL}`)
    }
    const buffer = readFileSync(source)
    if (sha256(buffer) !== hash) throw new Error(`${relPath}: ${TREE_CHANGED_DETAIL}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buffer)
  }
}

export function removeShipWorkspace(root, ws) {
  if (!ws || ws.removed) return
  git(['worktree', 'remove', '--force', '--force', ws.tree], { cwd: root, allowFail: true })
  rmSync(ws.dir, { recursive: true, force: true })
  // If `worktree remove` failed, drop only this worktree's own admin entry;
  // `git worktree prune` could touch other sessions' worktrees.
  if (ws.gitDir && ws.gitDir.includes(`${sep}worktrees${sep}`) && existsSync(ws.gitDir)) {
    rmSync(ws.gitDir, { recursive: true, force: true })
  }
  ws.removed = true
  activeWorkspaces.delete(ws)
}

export function removeActiveWorkspaces(root) {
  for (const ws of [...activeWorkspaces]) removeShipWorkspace(root, ws)
}

// Detached worktree at the approved base commit plus the selected files.
export function createShipWorkspace(root, pre, { linkDeps = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blog-ship-'))
  const ws = { dir, tree: join(dir, 'site'), gitDir: null, removed: false }
  activeWorkspaces.add(ws)
  try {
    git(['worktree', 'add', '--detach', '-q', ws.tree, pre.baseSha], { cwd: root })
    ws.gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: ws.tree })
    if (linkDeps) linkNodeModules(root, ws.tree)
    linkEnvFiles(root, ws.tree)
    copyApprovedFiles(root, ws.tree, pre.files)
  } catch (err) {
    removeShipWorkspace(root, ws)
    throw err
  }
  return ws
}

// ---------------------------------------------------------------------------
// Commit and push

function gitBuffer(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

// Problems with commit `sha` against the approval: parent, exact path list,
// and every blob's sha256. Empty array means the commit is exactly the
// reviewed content.
export function verifyCommit(root, sha, { baseSha, files }) {
  const problems = []
  const parent = git(['rev-parse', `${sha}^`], { cwd: root, allowFail: true })
  if (parent !== baseSha) problems.push(`parent is ${parent}, expected origin/main ${baseSha}`)
  const touched = (git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', sha], { cwd: root }) || '')
    .split('\0')
    .filter(Boolean)
    .sort()
  const expected = Object.keys(files).sort()
  if (touched.join('\n') !== expected.join('\n')) {
    problems.push(`commit touches [${touched.join(', ')}], expected [${expected.join(', ')}]`)
  }
  for (const [relPath, hash] of Object.entries(files)) {
    const listed = git(['ls-tree', '--name-only', sha, '--', relPath], { cwd: root })
    if (hash === 'deleted') {
      if (listed) problems.push(`${relPath}: still present, expected deleted`)
      continue
    }
    if (!listed) {
      problems.push(`${relPath}: missing from the commit`)
      continue
    }
    if (sha256(gitBuffer(['cat-file', 'blob', `${sha}:${relPath}`], root)) !== hash) {
      problems.push(`${relPath}: committed bytes differ from the approved bytes`)
    }
  }
  return problems
}

// The only mutation of the shared checkout: one explicit-path commit on
// main, verified against the approval. On any mismatch (another session
// edited a selected file in the last milliseconds) the commit is undone
// inside this checkout, the paths are unstaged again, and nothing is pushed.
// The trailer marks agent-driven runs (CLAUDECODE is set in Claude Code's
// shell); owner-run ships produce a plain authored commit.
export function commitApproved(
  root,
  { baseSha, files },
  { message, trailer = Boolean(process.env.CLAUDECODE) } = {}
) {
  const paths = Object.keys(files).sort()
  const head = git(['rev-parse', 'HEAD'], { cwd: root })
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
  if (branch !== 'main' || head !== baseSha) {
    throw new Error(`local main must equal origin/main (${baseSha.slice(0, 7)}) to commit; nothing committed`)
  }
  const body = trailer
    ? `${message}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
    : message
  git(['add', '--', ...paths], { cwd: root })
  git(['commit', '-q', '-m', body, '--', ...paths], { cwd: root })
  const sha = git(['rev-parse', 'HEAD'], { cwd: root })
  const problems = verifyCommit(root, sha, { baseSha, files })
  if (problems.length > 0) {
    if (git(['rev-parse', 'HEAD'], { cwd: root }) === sha) {
      git(['reset', '-q', '--soft', `${sha}^`], { cwd: root })
      git(['reset', '-q', '--', ...paths], { cwd: root })
    }
    throw new Error(
      'the commit did not match the approved bytes, so it was undone and nothing was pushed:\n  ' +
        problems.join('\n  ') +
        '\nstart over from the preflight'
    )
  }
  return sha
}

// Push exactly the verified commit; a moved origin/main makes this a
// rejected non-fast-forward instead of a silent merge.
export function pushCommit(root, sha) {
  git(['push', '-q', 'origin', `${sha}:refs/heads/main`], { cwd: root })
}

// ---------------------------------------------------------------------------
// Review server and deploy watch

// Tracks the spawned preview server so a signal can still stop it.
let activeServer = null

// The preview server is spawned detached (its own process group) so the whole
// group can be signalled; killing only the direct child could orphan it.
function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    server.kill()
  }
}

// Poll until the preview server answers, so the review link works when it is
// printed. Never fatal: the owner can still decline if it never comes up.
async function waitForServer(url, { intervalMs = 500, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(intervalMs) })
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  return false
}

// Returns the deploy conclusion: 'success', a failure conclusion string,
// or 'unknown' (gh unavailable, or the watch timed out).
async function watchDeploy(root, sha, urls) {
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    let runs
    try {
      runs = JSON.parse(
        execFileSync(
          'gh',
          ['run', 'list', '--workflow', 'deploy.yml', '--limit', '1', '--json', 'status,conclusion,headSha'],
          { cwd: root, encoding: 'utf8' }
        )
      )
    } catch {
      console.log('gh unavailable; watch the deploy at ' + ACTIONS_URL)
      return 'unknown'
    }
    const run = runs[0]
    if (run && run.headSha === sha && run.status === 'completed') {
      if (run.conclusion === 'success') {
        console.log('deploy complete:')
        for (const url of urls) console.log(`  ${url}`)
      } else {
        console.log(`deploy finished with conclusion ${run.conclusion}; inspect ${ACTIONS_URL}`)
      }
      return run.conclusion || 'unknown'
    }
    await new Promise((resolve) => setTimeout(resolve, 10000))
  }
  console.log('deploy watch timed out after 5 minutes; check ' + ACTIONS_URL)
  return 'unknown'
}

async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// Main flow. `deps` exists for tests; the CLI passes none.

export async function main(values, deps = {}) {
  const {
    root = git(['rev-parse', '--show-toplevel']),
    checks = runChecks,
    build = buildSite,
    ask = askYesNo,
    watch = watchDeploy,
    linkDeps = true,
    checkpoint = true,
    // --review serves until a signal ends the process; tests resolve it.
    waitForStop = () => new Promise(() => {}),
  } = deps
  if (values.yes && !values.digest) {
    console.error('--yes requires --digest <d> from a prior --preflight run')
    console.error(USAGE)
    return 1
  }
  if (values.review && (values.yes || values.preflight)) {
    console.error('--review cannot be combined with --yes or --preflight')
    console.error(USAGE)
    return 1
  }
  const dryRun = Boolean(values['dry-run'])
  const only = Array.isArray(values.only) && values.only.length > 0 ? values.only : null
  const include = Array.isArray(values.include) && values.include.length > 0 ? values.include : null
  if (checkpoint) save(root, { trigger: 'ship', quiet: true })
  const pre = preflight(root, { only, include, dryRun })
  for (const note of pre.notes || []) console.log(`note: ${note}`)
  if (pre.status === 'abort') {
    console.error(pre.detail)
    return 1
  }
  if (pre.status === 'empty') {
    console.log(pre.detail)
    return 0
  }
  console.log(`publish change(s) vs ${pre.baseRef} (${pre.changeSet.length}):`)
  for (const p of pre.changeSet) {
    console.log(`  ${p}${pre.includes.includes(p) ? '  (--include)' : ''}`)
  }
  if (pre.ignored.length > 0) {
    console.log(
      `ignoring ${pre.ignored.length} other changed or untracked path(s) in this checkout; ` +
        'they are not built, checked, or committed'
    )
  }
  console.log(`changeset digest: ${pre.digest}`)

  const content = checkContentFiles(root, pre.postSet, { baseRef: pre.baseRef })
  if (content.findings.length > 0) {
    console.error('content check failed; fix these before shipping:')
    for (const f of content.findings) console.error('  ' + formatFinding(f))
    return 1
  }
  if (values.preflight) return 0
  if (values.yes && values.digest !== pre.digest) {
    console.error(TREE_CHANGED_DETAIL)
    return 1
  }
  const approved = values.yes ? values.digest : pre.digest
  const recheckOptions = { only, include, dryRun, baseSha: pre.baseSha }

  let ws = null
  let server = null
  try {
    ws = createShipWorkspace(root, pre, { linkDeps })
    console.log(`temporary worktree: ${ws.tree}`)
    if (!values.yes) {
      const outDir = join(ws.dir, 'dist')
      console.log('\nbuilding production output in the temporary worktree...')
      const built = build(ws.tree, outDir, { stdio: 'inherit' })
      if (!built.ok) {
        if (built.output) console.error(built.output.trim())
        console.error('build failed; fix it before shipping')
        return 1
      }
      const reviewFile = join(ws.dir, 'review.html')
      writeFileSync(
        reviewFile,
        renderReviewPage(reviewTargets(ws.tree, pre.changeSet), { host: 'localhost', port: values.port })
      )
      server = spawn(astroBin(ws.tree), previewArgs(outDir, { port: values.port }), {
        cwd: ws.tree,
        stdio: ['ignore', 'ignore', 'inherit'],
        detached: true,
      })
      server.on('error', (err) => {
        console.error(`could not start the preview server: ${err.message}`)
      })
      activeServer = server
      if (!(await waitForServer(`http://localhost:${values.port}/`))) {
        console.error('warning: the review server did not come up; you can still answer N')
      }
      console.log(`\nreview page: ${reviewFile}`)
      console.log(`server: http://localhost:${values.port}/`)
      if (!values['no-open']) spawnSync('open', [reviewFile])
      if (values.review) {
        const flags = [
          ...(only || []).map((p) => `--only ${p}`),
          ...(include || []).map((p) => `--include ${p}`),
        ].join(' ')
        console.log(
          '\nthis is the exact build that would ship. After the owner approves it, stop this ' +
            'server (Ctrl+C) and run:\n' +
            `  npm run ship -- --yes --digest ${pre.digest}${flags ? ' ' + flags : ''}`
        )
        await waitForStop()
        console.log('review stopped; nothing recorded')
        return 0
      }
      if (!(await ask(`\napprove these ${pre.changeSet.length} file(s) and ship? [y/N] `))) {
        console.log('not approved; nothing recorded')
        return 0
      }
    }

    // Freshness check, both modes: the shared checkout must still hold the
    // approved bytes, since the commit is made there.
    const now = recheckApprovedChangeSet(root, approved, recheckOptions)
    if (now.status !== 'ok') {
      console.error(now.detail)
      return 1
    }
    writeManifest(root, now.files, { baseRef: now.baseRef })
    console.log('approval recorded')
    stopServer(server)
    server = null
    activeServer = null

    console.log('\nrunning release checks in the temporary worktree...')
    const results = await checks(ws.tree, {
      previewChangeSet: now.changeSet,
      previewStateRoot: root,
      skipCheckpoint: 'ship checkpointed the shared checkout; this is its temporary worktree',
    })
    const summary = verdict(results)
    console.log('\n' + summary)
    if (!summary.startsWith('VERDICT: GO')) return 1

    // Checks take minutes; re-bind the approval right before the commit.
    const final = recheckApprovedChangeSet(root, approved, recheckOptions)
    if (final.status !== 'ok') {
      console.error(final.detail)
      return 1
    }
    const message = values.message || commitMessageFor(final.changeSet, { includes: final.includes })
    const urls = reviewTargets(ws.tree, final.changeSet).map((t) => SITE_URL + t)
    if (dryRun) {
      console.log(
        `\ndry run: would commit ${final.changeSet.length} file(s) as "${message.split('\n')[0]}" ` +
          'and push to origin/main; nothing committed or pushed'
      )
      return 0
    }
    const sha = commitApproved(root, final, { message })
    pushCommit(root, sha)
    console.log(`pushed ${sha.slice(0, 7)} to origin/main`)
    await watch(root, sha, urls)
    return 0
  } finally {
    stopServer(server)
    activeServer = null
    if (ws) removeShipWorkspace(root, ws)
  }
}

export const CLI_OPTIONS = {
  message: { type: 'string' },
  port: { type: 'string', default: '4322' },
  'no-open': { type: 'boolean', default: false },
  preflight: { type: 'boolean', default: false },
  review: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  only: { type: 'string', multiple: true },
  include: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean', default: false },
  digest: { type: 'string' },
}

// CLI entry (pathToFileURL handles spaces in the repo path)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let values
  try {
    ;({ values } = parseArgs({ options: CLI_OPTIONS }))
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    process.exit(1)
  }
  const root = git(['rev-parse', '--show-toplevel'])
  // A signal (Ctrl+C at the prompt, an external SIGTERM) bypasses the
  // finally in main: stop the detached preview server and remove the
  // temporary worktree and build directories here.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      stopServer(activeServer)
      removeActiveWorkspaces(root)
      removeActiveRunDirs()
      process.exit(130)
    })
  }
  main(values, { root }).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message)
      process.exit(1)
    }
  )
}
