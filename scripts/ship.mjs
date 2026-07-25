// One-command publish for post edits: chains checkpoint, purity check,
// production preview, owner approval, release checks, commit, push, and a
// deploy watch. Two entry points share this file: the owner runs it
// interactively, and the ship-posts skill drives it with --preflight then
// --yes --digest after the owner approves in chat. Spec:
// docs/superpowers/specs/2026-07-16-ship-command-design.md
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { git, save } from './checkpoint.mjs'
import {
  computeChangeSet,
  hashChangeSet,
  isDraftPost,
  parseFrontmatterScalars,
  primaryPostPath,
  renderReviewPage,
  resolveBaseRef,
  reviewTargets,
  routeSlugForPostFile,
  scalarIsTrue,
  slugForPostFile,
  writeManifest,
} from './preview-posts.mjs'
import { runChecks, verdict } from './release-check.mjs'
import {
  isCanonicalFlatPostPath,
  isHeroPath,
  isPostPath,
  resolveHeroReference,
  resolveHeroReferenceFromContent,
  runFastChecks,
  validatePostPathLocation,
} from './fast-checks.mjs'

const ACTIONS_URL = 'https://github.com/emrickk/emrickk.github.io/actions'
const USAGE =
  'usage: npm run ship -- [--preflight] [--yes --digest <d>] [--only <path> ...] [--fast] [--message <msg>] [--port N] [--no-open]'

export function partitionPurity(paths) {
  return {
    posts: paths.filter(isPostPath).sort(),
    heroes: paths.filter(isHeroPath).sort(),
    other: paths.filter((p) => !isPostPath(p) && !isHeroPath(p)).sort(),
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
// chars of a sha256 over the sorted path:hash entries, newline-joined. Not a
// security boundary.
export function changeSetDigest(files) {
  const entries = Object.keys(files)
    .sort()
    .map((p) => `${p}:${files[p]}`)
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 12)
}

export function commitMessageFor(changeSet) {
  const slugs = [...new Set(postPathsFor(changeSet).map((p) => slugForPostFile(p)))]
  return `post: update ${slugs.join(', ')}`
}

// Everything a push would carry, unfiltered: worktree diff vs the base ref,
// untracked files, and the committed-only view (which catches a commit whose
// working-tree content was reverted without resetting the commit; the diff
// shows nothing for it, the push still carries it).
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
// commits that exist only on local main (committed but not pushed).
export function originStatus(root) {
  const hasOrigin = Boolean(
    git(['rev-parse', '--verify', '-q', 'origin/main'], { cwd: root, allowFail: true })
  )
  if (!hasOrigin) return { hasOrigin, ahead: 0, localAhead: 0 }
  const counts = git(['rev-list', '--left-right', '--count', 'origin/main...main'], { cwd: root })
  const parts = counts.split(/\s+/)
  return {
    hasOrigin,
    ahead: Number(parts[0] || '0'),
    localAhead: Number(parts[1] || '0'),
  }
}

// Spec step 1. Returns a plain result so every branch is testable:
// status 'abort' (exit 1), 'empty' (exit 0), or 'ok' with changeSet and
// digest. Fetch failures warn and fall back to the last-known origin/main.
// `only` (repo-relative paths) scopes the shipped change set to the given
// changed post files; purity still checks the whole tree, so unrelated paths
// keep blocking, and unselected post edits simply stay pending. Referenced
// changed hero covers are the sole allowed non-post additions.
// `strictSync` (fast lane) additionally requires local main to be exactly
// origin/main: `git push` pushes the whole branch, so any unpushed local
// commit would ride along with the scoped publish otherwise.
export function preflight(root, { fetch = true, only = null, strictSync = false } = {}) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
  if (branch !== 'main') {
    return { status: 'abort', detail: `on branch ${branch}; ship only runs on main` }
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
    return {
      status: 'abort',
      detail:
        `origin/main has ${ahead} commit(s) not in local main; ` +
        'reconcile in a regular coding session (or git pull --rebase when comfortable) before shipping',
    }
  }
  if (strictSync && hasOrigin && localAhead > 0) {
    return {
      status: 'abort',
      detail:
        `local main has ${localAhead} unpushed commit(s); a scoped publish pushes the whole ` +
        'branch and would carry them along. Push or reconcile them in a regular coding session first',
    }
  }
  const baseRef = resolveBaseRef(root)
  const {
    posts: changedPosts,
    heroes: changedHeroes,
    other,
  } = partitionPurity(rawDiffPaths(root, baseRef))
  if (other.length > 0) {
    return {
      status: 'abort',
      detail:
        'ship only publishes post edits and their referenced hero covers, but these changed too:\n  ' +
        other.join('\n  ') +
        '\nhandle this in a regular coding session instead',
    }
  }

  let normalizedOnly = null
  if (only && only.length > 0) {
    normalizedOnly = [...new Set(only)].sort()
    const invalid = normalizedOnly.filter((p) => !isCanonicalFlatPostPath(p))
    if (invalid.length > 0) {
      return {
        status: 'abort',
        detail: '--only accepts post paths, but received:\n  ' + invalid.join('\n  '),
      }
    }
  }

  const postPathsToValidate = new Set()
  for (const postPath of [...changedPosts, ...(normalizedOnly || [])]) {
    postPathsToValidate.add(postPath)
    postPathsToValidate.add(primaryPostPath(postPath))
  }
  const invalidPostLocations = [...postPathsToValidate]
    .sort()
    .map((postPath) => validatePostPathLocation(root, postPath))
    .filter((result) => result.status === 'error')
    .map((result) => result.detail)
  if (invalidPostLocations.length > 0) {
    return {
      status: 'abort',
      detail: 'invalid post path:\n  ' + invalidPostLocations.join('\n  '),
    }
  }

  let postSet = postPathsFor(computeChangeSet(root, { baseRef }))
  let postChangeSet = postSet
  if (normalizedOnly) {
    const wanted = new Set(normalizedOnly)
    postChangeSet = postChangeSet.filter((p) => wanted.has(p))
    postSet = postChangeSet
  }

  const referenced = referencedHeroesForPosts(root, postSet)
  if (referenced.errors.length > 0) {
    return {
      status: 'abort',
      detail: 'invalid heroImage reference:\n  ' + referenced.errors.join('\n  '),
    }
  }
  const referencedSet = new Set(referenced.heroes)
  const unreferencedHeroes = changedHeroes.filter((p) => !referencedSet.has(p))
  if (unreferencedHeroes.length > 0) {
    return {
      status: 'abort',
      detail:
        'changed hero cover(s) are not referenced by the selected post set:\n  ' +
        unreferencedHeroes.join('\n  '),
    }
  }
  const heroChangeSet = changedHeroes.filter((p) => referencedSet.has(p))
  if (heroChangeSet.length > 0) {
    const shared = sharedHeroOwners(root, heroChangeSet, postSet)
    if (shared.length > 0) {
      return {
        status: 'abort',
        detail:
          'ship cannot change a hero cover also used by an unselected post:\n  ' +
          shared.map(({ hero, post }) => `${hero} -> ${post}`).join('\n  '),
      }
    }
  }
  const changeSet = [...postChangeSet, ...heroChangeSet].sort()
  if (changeSet.length === 0) {
    return {
      status: 'empty',
      detail: only ? 'nothing to ship for the selected post(s)' : 'nothing to ship',
      baseRef,
    }
  }
  return {
    status: 'ok',
    baseRef,
    postSet,
    changeSet,
    digest: changeSetDigest(hashChangeSet(root, changeSet)),
  }
}

const TREE_CHANGED_DETAIL =
  'the tree changed since the review (another session?); nothing committed, start over'

export function recheckApprovedChangeSet(
  root,
  approvedDigest,
  { only = null, strictSync = false } = {}
) {
  const current = preflight(root, { fetch: false, only, strictSync })
  if (current.status !== 'ok' || current.digest !== approvedDigest) {
    return { status: 'abort', detail: TREE_CHANGED_DETAIL }
  }
  return current
}

// The only git mutations in ship: one explicit-path commit and one push.
// The trailer marks agent-driven runs (CLAUDECODE is set in Claude Code's
// shell); owner-run ships produce a plain authored commit.
export function commitAndPush(
  root,
  changeSet,
  { message, trailer = Boolean(process.env.CLAUDECODE), push = true } = {}
) {
  const body = trailer
    ? `${message}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
    : message
  git(['add', '--', ...changeSet], { cwd: root })
  git(['commit', '-q', '-m', body, '--', ...changeSet], { cwd: root })
  const sha = git(['rev-parse', 'HEAD'], { cwd: root })
  if (push) git(['push', '-q', 'origin', 'main'], { cwd: root })
  return sha
}

// Tracks the currently spawned preview server so a signal (Ctrl+C, external
// SIGTERM) can still stop it even though it bypasses the `finally` in main.
// Set by main at spawn time and read by the CLI entry's signal handlers;
// importing this module for its exports never touches it.
let activeServer = null

// The preview server is spawned detached (its own process group) because npx
// is the direct child and astro the grandchild; killing just npx orphans the
// server on the port. Killing the negated pid signals the whole group.
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
async function watchDeploy(root, sha, slugs) {
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    let runs
    try {
      runs = JSON.parse(
        execFileSync(
          'gh',
          [
            'run',
            'list',
            '--workflow',
            'deploy.yml',
            '--limit',
            '1',
            '--json',
            'status,conclusion,headSha',
          ],
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
        for (const slug of slugs) console.log(`  https://theneverless.com/posts/${slug}/`)
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

export async function main(values) {
  const root = git(['rev-parse', '--show-toplevel'])
  if (values.yes && !values.digest) {
    console.error('--yes requires --digest <d> from a prior --preflight run')
    console.error(USAGE)
    return 1
  }
  if (values.fast && !(Array.isArray(values.only) && values.only.length > 0)) {
    console.error('--fast requires --only <path>: the fast lane is for scoped publishes')
    console.error(USAGE)
    return 1
  }
  save(root, { trigger: 'ship', quiet: true })
  const only = Array.isArray(values.only) && values.only.length > 0 ? values.only : null
  const pre = preflight(root, { only, strictSync: Boolean(values.fast) })
  if (pre.status === 'abort') {
    console.error(pre.detail)
    return 1
  }
  if (pre.status === 'empty') {
    console.log(pre.detail)
    return 0
  }
  console.log(`publish change(s) vs ${pre.baseRef} (${pre.changeSet.length}):`)
  for (const p of pre.changeSet) console.log('  ' + p)
  console.log(`changeset digest: ${pre.digest}`)
  if (values.preflight) return 0

  let server = null
  try {
    if (!values.yes) {
      // The build also runs inside release-check later; the duplication is
      // the accepted cost of reusing the gates unmodified.
      console.log('\nbuilding production output...')
      const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
      if (build.status !== 0) {
        console.error('build failed; fix it before shipping')
        return 1
      }
      const reviewFile = join(root, '.preview', 'review.html')
      mkdirSync(join(root, '.preview'), { recursive: true })
      writeFileSync(
        reviewFile,
        renderReviewPage(reviewTargets(root, pre.postSet), { host: 'localhost', port: values.port })
      )
      server = spawn('npx', ['astro', 'preview', '--port', values.port], {
        cwd: root,
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
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = (
        await rl.question(`\napprove these ${pre.changeSet.length} file(s) and ship? [y/N] `)
      ).trim()
      rl.close()
      if (answer.toLowerCase() !== 'y') {
        console.log('not approved; nothing recorded')
        return 0
      }
    }

    // Freshness check, both modes: the approval binds to exactly the
    // reviewed content. A concurrent session's post edit (or any new
    // non-post change) landing after the review aborts here.
    const approved = values.yes ? values.digest : pre.digest
    const now = recheckApprovedChangeSet(root, approved, {
      only,
      strictSync: Boolean(values.fast),
    })
    if (now.status !== 'ok') {
      console.error(now.detail)
      return 1
    }
    if (!values.fast) {
      // The fast lane skips the review manifest: there was no review, so
      // recording an approval would be a false audit trail.
      writeManifest(root, hashChangeSet(root, now.changeSet), { baseRef: now.baseRef })
      console.log('approval recorded')
    }
    if (server) {
      stopServer(server)
      server = null
      activeServer = null
    }

    if (values.fast) {
      console.log('\nrunning fast checks...')
      const errors = await runFastChecks(root, now.changeSet)
      if (errors.length > 0) {
        console.error('fast checks failed:\n  ' + errors.join('\n  '))
        return 1
      }
      console.log(`fast checks passed for ${now.changeSet.length} file(s)`)
    } else {
      console.log('\nrunning release checks...')
      const results = await runChecks(root, { previewChangeSet: now.changeSet })
      const summary = verdict(results)
      console.log('\n' + summary)
      if (!summary.startsWith('VERDICT: GO')) return 1
    }

    // Checks can take long enough for another session to edit a selected post
    // or hero. Re-bind the approved digest immediately before the explicit
    // commit, then use only this final path set below.
    const final = recheckApprovedChangeSet(root, approved, {
      only,
      strictSync: Boolean(values.fast),
    })
    if (final.status !== 'ok') {
      console.error(final.detail)
      return 1
    }

    const sha = commitAndPush(root, final.changeSet, {
      message: values.message || commitMessageFor(final.postSet),
    })
    console.log(`pushed ${sha.slice(0, 7)} to origin/main`)
    const conclusion = await watchDeploy(root, sha, [
      ...new Set(final.postSet.map((p) => routeSlugForPostFile(root, p))),
    ])
    if (values.fast && conclusion !== 'success' && conclusion !== 'unknown') {
      console.error(
        'deploy failed: the post is NOT live (the site stays on the previous version) ' +
          'and main is blocked until this is fixed. Fix the post and publish again, ' +
          'or revert in a regular coding session.'
      )
      return 1
    }
    return 0
  } finally {
    stopServer(server)
    activeServer = null
  }
}

// CLI entry (pathToFileURL handles spaces in the repo path)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let values
  try {
    ;({ values } = parseArgs({
      options: {
        message: { type: 'string' },
        port: { type: 'string', default: '4322' },
        'no-open': { type: 'boolean', default: false },
        preflight: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        only: { type: 'string', multiple: true },
        fast: { type: 'boolean', default: false },
        digest: { type: 'string' },
      },
    }))
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    process.exit(1)
  }
  // A signal death (Ctrl+C at the prompt, an external SIGTERM) bypasses the
  // `finally` in main; stop the detached preview server here so it never
  // gets orphaned on the port.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopServer(activeServer)
      process.exit(130)
    })
  }
  main(values).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message)
      process.exit(1)
    }
  )
}
