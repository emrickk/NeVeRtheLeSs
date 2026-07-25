#!/usr/bin/env node
// Post preview gate: build the production site, serve it for the owner to
// review changed posts in a real browser, and record approval as content
// hashes so release-check check 12 can enforce that nothing preview-relevant
// ships unseen. Design: docs/superpowers/specs/2026-07-15-post-preview-gate-design.md
// This script never pushes and never approves on its own.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Image-heavy exemplar reviewed whenever a site-wide file changes. Update it
// when a better exemplar post exists.
export const REPRESENTATIVE_POST = 'springtime-in-patagonia'

const POST_RE = /^src\/content\/posts\/[^/]+\.(?:md|mdx)$/
const NOTE_RE = /^src\/content\/notes\/[^/]+\.(?:md|mdx)$/
// astro-theme-config.ts and scripts/rehype/ are imported by astro.config.mjs
// and change every rendered page, so they are site-wide despite living
// outside src/.
const SITE_RE =
  /^(?:src|public)\/|^scripts\/rehype\/|^(?:astro\.config\.mjs|astro-theme-config\.ts|package\.json|package-lock\.json)$/

// 'post' renders at /posts/<slug>/; 'note' renders on the /notes/ timeline;
// 'site' can change any page; null never affects the deployed site. Content
// files must win over the generic src/ prefix rule.
export function classifyPath(path) {
  if (POST_RE.test(path)) return 'post'
  if (NOTE_RE.test(path)) return 'note'
  if (SITE_RE.test(path)) return 'site'
  return null
}

// Must track Astro's glob-loader id generation (the route is post.id). For
// dotted or nested filenames, check what ids Astro actually generates rather
// than trusting this filename-minus-extension shorthand.
export function slugForPostFile(path) {
  return path
    .split('/')
    .pop()
    .replace(/\.(?:md|mdx)$/, '')
    .replace(/\.(?:en|zh)$/, '')
}

// Sibling translation bodies (<slug>.en.md / <slug>.zh.md) render inside the
// primary post's page; frontmatter like draft lives on the primary only.
export function primaryPostPath(path) {
  return path.replace(/\.(?:en|zh)\.(md|mdx)$/, '.$1')
}

// Minimal YAML scalar parsing for frontmatter fields used by the safety
// tooling. A # begins a comment only outside quotes and when separated from
// the scalar, matching the inline-comment forms accepted by Astro's parser.
function stripYamlInlineComment(value) {
  let quote = null
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote === '"') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1
      } else if (char === "'") {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i)
    }
  }
  return value
}

export function parseFrontmatterScalars(raw) {
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const data = {}
  if (!block) return data
  for (const line of block[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!kv) continue
    let value = stripYamlInlineComment(kv[2]).trim()
    const quoted = value.match(/^(['"])([\s\S]*)\1$/)
    if (quoted) {
      value =
        quoted[1] === '"'
          ? quoted[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          : quoted[2].replace(/''/g, "'")
    }
    data[kv[1]] = value
  }
  return data
}

export function scalarIsTrue(value) {
  return typeof value === 'string' && value.toLowerCase() === 'true'
}

function git(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, '')
  } catch (err) {
    if (allowFail) return null
    throw new Error(
      `git ${args.join(' ')} failed: ${err.stderr ? String(err.stderr).trim() : err.message}`
    )
  }
}

// Drafts are excluded from the build, so a post that was already a draft at
// the base ref has nothing to review; a draft flip back to false re-enters
// the change set as a normal edit.
export function isDraftPost(root, path) {
  const p = join(root, primaryPostPath(path))
  if (!existsSync(p)) return false
  return scalarIsTrue(parseFrontmatterScalars(readFileSync(p, 'utf8')).draft)
}

// A published post flipped to draft REMOVES a live page, which is exactly
// what the gate exists to review, so only posts that were also drafts at the
// base ref (or did not exist there: brand-new drafts) leave the change set.
export function wasDraftAtBase(root, path, baseRef) {
  const primary = primaryPostPath(path)
  const content = git(['show', `${baseRef}:${primary}`], { cwd: root, allowFail: true })
  if (content === null) return true
  return scalarIsTrue(parseFrontmatterScalars(content).draft)
}

// Same fallback as release-check's secret scan: origin/main when it exists
// (the deployed state), HEAD otherwise (fresh clones, test fixtures).
export function resolveBaseRef(root) {
  return git(['rev-parse', '--verify', '-q', 'origin/main'], { cwd: root, allowFail: true })
    ? 'origin/main'
    : 'HEAD'
}

// A checkout can lag origin/main when another session pushes (a worktree
// branched before the push, for example). Diffing the working tree straight
// against origin/main would then report the remote-only commits as phantom
// local changes, so diff against the merge-base of HEAD and the base ref
// instead: working-tree edits and local commits ahead of the merge-base
// still count, already-deployed content does not. Fails closed: when the
// merge-base cannot be determined, keep the full diff against the base ref.
export function resolveDiffBase(root, baseRef) {
  if (baseRef === 'HEAD') return { ref: 'HEAD', headBehind: false }
  const baseSha = git(['rev-parse', '--verify', '-q', `${baseRef}^{commit}`], {
    cwd: root,
    allowFail: true,
  })
  const mergeBase = baseSha && git(['merge-base', 'HEAD', baseSha], { cwd: root, allowFail: true })
  if (!mergeBase || mergeBase === baseSha) return { ref: baseRef, headBehind: false }
  return { ref: mergeBase, headBehind: true }
}

// Deploys run npm ci && npm run build, so npm script edits other than
// "build" cannot change the deployed site; every other package.json field
// (dependencies, overrides, engines) can. Fails closed: a parse error or a
// missing base version counts as site-affecting. JSON.stringify comparison
// is key-order sensitive, which can only over-flag, never under-flag.
export function packageJsonAffectsSite(root, baseRef) {
  try {
    const significant = (raw) => {
      const { scripts = {}, ...rest } = JSON.parse(raw)
      return JSON.stringify({ ...rest, buildScript: scripts.build })
    }
    const base = git(['show', `${baseRef}:package.json`], { cwd: root })
    const current = readFileSync(join(root, 'package.json'), 'utf8')
    return significant(base) !== significant(current)
  } catch {
    return true
  }
}

// Preview-relevant files changed relative to the base ref (resolved through
// resolveDiffBase, so remote-only commits never count): committed-ahead
// and working-tree edits (git diff) plus untracked files. Sorted for stable
// output and manifest comparison. -z output with NUL splitting keeps
// non-ASCII paths verbatim (default core.quotepath=true would C-quote them
// and they would silently fail classifyPath). The diff call fails closed:
// a git error throws, and release-check turns the throw into a FAIL, rather
// than shrinking the change set to untracked-only.
export function computeChangeSet(root, { baseRef = resolveBaseRef(root) } = {}) {
  const diffBase = resolveDiffBase(root, baseRef).ref
  const diff = git(['diff', '--no-renames', '--name-only', '-z', diffBase], { cwd: root }) || ''
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }) || ''
  const all = new Set([...diff.split('\0'), ...untracked.split('\0')].filter(Boolean))
  return [...all]
    .filter((path) => {
      const kind = classifyPath(path)
      if (kind === null) return false
      if (kind === 'post' && isDraftPost(root, path) && wasDraftAtBase(root, path, diffBase))
        return false
      if (path === 'package.json' && !packageJsonAffectsSite(root, diffBase)) return false
      return true
    })
    .sort()
}

// Pages the owner must look at for a given change set. A deleted primary post
// sends review to the homepage (the post should vanish from lists); a deleted
// sibling still renders on the surviving primary page. Notes have no per-note
// page, so any note change, including a deletion, reviews the /notes/
// timeline. Site-wide changes get the homepage plus one image-heavy exemplar.
// Sorted and deduplicated, '/' first.
// Route slug for a post file: the frontmatter `slug` when the primary
// declares one (the glob loader uses data.slug as the entry id), otherwise
// the filename shorthand. Deleted files fall back to the filename.
export function routeSlugForPostFile(root, path) {
  const primary = join(root, primaryPostPath(path))
  if (existsSync(primary)) {
    const fm = readFileSync(primary, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const m = fm && fm[1].match(/^slug:\s*['"]?([a-z0-9-]+)['"]?\s*$/m)
    if (m) return m[1]
  }
  return slugForPostFile(path)
}

export function reviewTargets(root, changeSet) {
  const targets = new Set()
  for (const path of changeSet) {
    const kind = classifyPath(path)
    if (kind === 'post') {
      // A currently-draft post has no page of its own (a published-to-draft
      // flip removes one), so review goes to the homepage like a deletion.
      if (existsSync(join(root, primaryPostPath(path))) && !isDraftPost(root, path))
        targets.add(`/posts/${routeSlugForPostFile(root, path)}/`)
      else targets.add('/')
    } else if (kind === 'note') {
      targets.add('/notes/')
    } else {
      targets.add('/')
      targets.add(`/posts/${REPRESENTATIVE_POST}/`)
    }
  }
  return [...targets].sort()
}

export function hashChangeSet(root, changeSet) {
  const files = {}
  for (const path of changeSet) {
    const p = join(root, path)
    files[path] = existsSync(p)
      ? createHash('sha256').update(readFileSync(p)).digest('hex')
      : 'deleted'
  }
  return files
}

function manifestPath(root) {
  return join(root, '.preview', 'manifest.json')
}

// approvedAt and baseRef are informational only; enforcement compares the
// files map exclusively.
export function writeManifest(root, files, { baseRef }) {
  mkdirSync(join(root, '.preview'), { recursive: true })
  writeFileSync(
    manifestPath(root),
    JSON.stringify({ approvedAt: new Date().toISOString(), baseRef, files }, null, 2) + '\n'
  )
}

export function readManifest(root) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(root), 'utf8'))
    return parsed && parsed.files && typeof parsed.files === 'object' ? parsed : null
  } catch {
    return null
  }
}

// Empty result means every current change is covered by the approval.
// Approved entries absent from the current change set are deliberately not
// problems: a file only leaves the change set when its content settles back
// into the base ref (the approved bytes were committed and deployed under
// this same gate, or the edit was reverted) or when package.json stops being
// site-significant. In every case nothing unreviewed can ship from it, and
// re-editing it puts it back in the change set where the drift checks below
// apply.
export function manifestDiff(currentFiles, manifest) {
  const approved = manifest.files
  const problems = []
  for (const [path, hash] of Object.entries(currentFiles)) {
    if (!(path in approved)) problems.push(`${path}: not covered by the approval`)
    else if (approved[path] !== hash) problems.push(`${path}: changed since approval`)
  }
  return problems
}

const REMEDIATION =
  'run npm run preview-posts, review in the browser, then npm run preview-posts -- --approve'

// Release-check check 12. Cheap: git plus hashing, no build or server.
// When the base ref has commits HEAD lacks, every verdict says so: the
// change set was computed against the merge-base, and the operator should
// know the comparison base is not origin/main itself.
// `changeSet` overrides the computed set for scoped publishes (ship --only):
// the approval then only needs to cover the files actually being shipped.
export function checkPostPreview(root, { baseRef, changeSet: changeSetOverride } = {}) {
  const base = baseRef ?? resolveBaseRef(root)
  const scopedNote = changeSetOverride ? ' (scoped change set)' : ''
  const note =
    (resolveDiffBase(root, base).headBehind
      ? ` (${base} has commits not in HEAD; change set is local work vs their merge-base)`
      : '') + scopedNote
  const changeSet = changeSetOverride ?? computeChangeSet(root, { baseRef: base })
  if (changeSet.length === 0)
    return { status: 'SKIP', detail: `no preview-relevant changes${note}` }
  const manifest = readManifest(root)
  if (!manifest) {
    return {
      status: 'FAIL',
      detail: `${changeSet.length} preview-relevant change(s) with no approval; ${REMEDIATION}${note}`,
    }
  }
  const currentFiles = hashChangeSet(root, changeSet)
  const problems = manifestDiff(currentFiles, manifest)
  if (problems.length) {
    const shown = problems.slice(0, 10).join('\n')
    const more = problems.length > 10 ? `\n... and ${problems.length - 10} more` : ''
    return { status: 'FAIL', detail: `${shown}${more}\n${REMEDIATION}${note}` }
  }
  const settled = Object.keys(manifest.files).filter((path) => !(path in currentFiles)).length
  const settledNote = settled ? `; ${settled} approved file(s) already committed or reverted` : ''
  return {
    status: 'PASS',
    detail: `${changeSet.length} changed file(s) covered by preview approval${settledNote}${note}`,
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderReviewPage(targets, { host, port }) {
  const items = targets
    .map((t) => {
      const safe = escapeHtml(t)
      return `      <li><a href="http://${host}:${port}${safe}" target="_blank">${safe}</a></li>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Post preview review</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  li { margin: 0.4rem 0; }
</style>
</head>
<body>
<h1>Review these pages</h1>
<ul>
${items}
</ul>
<h2>Checklist</h2>
<ul>
  <li>Both languages (use the language toggle)</li>
  <li>Dark mode and light mode</li>
  <li>A narrow window or a real phone</li>
  <li>Images load and grids lay out correctly</li>
</ul>
<p>When everything looks right, approve with: <code>npm run preview-posts -- --approve</code></p>
</body>
</html>
`
}

function localIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

// CLI entry (pathToFileURL handles spaces in the repo path)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let values
  try {
    ;({ values } = parseArgs({
      options: {
        approve: { type: 'boolean', default: false },
        port: { type: 'string', default: '4322' },
        host: { type: 'boolean', default: false },
        'no-open': { type: 'boolean', default: false },
      },
    }))
  } catch (err) {
    console.error(err.message)
    console.error('usage: npm run preview-posts -- [--approve] [--port N] [--host] [--no-open]')
    process.exit(1)
  }
  const root = git(['rev-parse', '--show-toplevel'])
  const baseRef = resolveBaseRef(root)
  const { headBehind } = resolveDiffBase(root, baseRef)
  const baseLabel = headBehind ? `the merge-base of HEAD and ${baseRef}` : baseRef
  if (headBehind) {
    console.log(
      `note: ${baseRef} has commits not in HEAD (another session may have pushed); comparing against their merge-base so only local changes count`
    )
  }
  const changeSet = computeChangeSet(root, { baseRef })

  if (values.approve) {
    if (changeSet.length === 0) {
      console.error('nothing to approve: no preview-relevant changes vs ' + baseLabel)
      process.exit(1)
    }
    console.log(`approving ${changeSet.length} file(s) vs ${baseLabel}:`)
    for (const p of changeSet) console.log('  ' + p)
    writeManifest(root, hashChangeSet(root, changeSet), { baseRef: baseLabel })
    console.log('approval recorded; release-check check 12 passes until any of these files change')
    console.log(
      'caution: this covers every preview-relevant change in the tree, including any from other sessions; make sure the list matches what was reviewed'
    )
    process.exit(0)
  }

  if (changeSet.length === 0) {
    console.log('nothing to preview: no preview-relevant changes vs ' + baseLabel)
    process.exit(0)
  }
  console.log(`preview-relevant changes vs ${baseLabel} (${changeSet.length}):`)
  for (const p of changeSet) console.log('  ' + p)

  console.log('\nbuilding production output...')
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  if (build.status !== 0) {
    if (build.error) console.error('could not run npm: ' + build.error.message)
    else console.error('build failed; fix it before previewing')
    process.exit(build.status ?? 1)
  }

  const host = values.host ? localIp() || 'localhost' : 'localhost'
  const targets = reviewTargets(root, changeSet)
  const reviewFile = join(root, '.preview', 'review.html')
  mkdirSync(join(root, '.preview'), { recursive: true })
  writeFileSync(reviewFile, renderReviewPage(targets, { host, port: values.port }))

  const serverArgs = ['astro', 'preview', '--port', values.port]
  if (values.host) serverArgs.push('--host')
  const server = spawn('npx', serverArgs, { cwd: root, stdio: 'inherit' })
  server.on('error', (err) => {
    console.error('could not start the preview server: ' + err.message)
    process.exit(1)
  })

  console.log(`\nreview page: ${reviewFile}`)
  console.log(`server: http://${host}:${values.port}/`)
  console.log('when everything looks right: npm run preview-posts -- --approve')
  console.log('stop the server with Ctrl+C\n')
  if (!values['no-open']) spawnSync('open', [reviewFile])

  server.on('exit', (code) => process.exit(code ?? 0))
}
