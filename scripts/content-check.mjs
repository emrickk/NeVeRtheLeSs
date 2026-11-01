#!/usr/bin/env node
// Content checks for changed posts (release-check check 13, also
// `npm run check:content`). Only post files changed against origin/main are
// checked, never the whole 2005-era archive:
//   (a) translation pairs: a changed post with a sibling translation (or a
//       changed sibling) needs its own non-empty title and description in
//       each language file, and the two files must actually pair. The site
//       resolver (src/utils/translations.ts) silently falls back to the other
//       language when a sibling title or description is empty, and silently
//       drops a sibling whose translationKey or lang does not match.
//   (b) every markdown or HTML image has non-empty alt text (npm run images
//       emits ![]() placeholders).
//   (c) no em dash (U+2014) anywhere in the file: body, title, description.
// Rules (b) and (c) apply to the lines a change added or modified; a new file
// is checked in full. Editing one line of an archived post therefore does
// not demand cleaning up the whole post. --whole-file checks every line.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  isPostPath,
  isSiblingPostPath,
  translationCounterparts,
  validatePostPathLocation,
} from './post-paths.mjs'
import {
  classifyPath,
  computeChangeSet,
  isDraftPost,
  parseFrontmatterScalars,
  resolveBaseRef,
  resolveDiffBase,
} from './preview-posts.mjs'

const EM_DASH = '\u2014'
const LANGS = ['zh', 'en']

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

// Changed, non-draft post files that exist on disk (deletions have no
// content to check).
export function changedPostFiles(root, { baseRef = resolveBaseRef(root) } = {}) {
  return computeChangeSet(root, { baseRef }).filter(
    (p) => classifyPath(p) === 'post' && existsSync(join(root, p)) && !isDraftPost(root, p)
  )
}

// Line numbers (1-based, current file) that the working tree added or
// modified relative to diffBase, or 'all' for a file absent at diffBase.
export function changedLineNumbers(root, relPath, diffBase) {
  const atBase = git(['cat-file', '-e', `${diffBase}:${relPath}`], { cwd: root, allowFail: true })
  if (atBase === null) return 'all'
  const diff =
    git(['diff', '--no-renames', '--no-color', '--unified=0', diffBase, '--', relPath], {
      cwd: root,
    }) || ''
  const lines = new Set()
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    for (let i = 0; i < count; i += 1) lines.add(start + i)
  }
  return lines
}

function frontmatterInfo(raw) {
  const data = parseFrontmatterScalars(raw)
  const lineOf = {}
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (block) {
    block[1].split(/\r?\n/).forEach((line, i) => {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):/)
      if (kv && !(kv[1] in lineOf)) lineOf[kv[1]] = i + 2
    })
  }
  return { data, lineOf, hasFrontmatter: Boolean(block) }
}

function finding(file, line, rule, message) {
  return { file, line, rule, message }
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\s*[([]/g
const HTML_IMG_RE = /<img\b[^>]*>/gi
const ALT_ATTR_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

// Rules (b) and (c) for one file. `lines` is 'all' or a Set of line numbers.
export function checkFileText(relPath, raw, { lines = 'all' } = {}) {
  const findings = []
  const selected = (n) => lines === 'all' || lines.has(n)
  let fence = null
  raw.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
    }
    if (!selected(n)) return
    if (line.includes(EM_DASH)) {
      findings.push(
        finding(
          relPath,
          n,
          'em-dash',
          `em dash (U+2014) at column ${line.indexOf(EM_DASH) + 1}; use a comma, colon, or parentheses`
        )
      )
    }
    if (fence !== null || fenceMatch) return
    for (const m of line.matchAll(MD_IMAGE_RE)) {
      if (m[1].trim() === '') {
        findings.push(
          finding(relPath, n, 'image-alt', 'markdown image has empty alt text; describe the image')
        )
      }
    }
    for (const m of line.matchAll(HTML_IMG_RE)) {
      const alt = m[0].match(ALT_ATTR_RE)
      const value = alt ? (alt[1] ?? alt[2] ?? alt[3] ?? '') : ''
      if (value.trim() === '') {
        findings.push(
          finding(relPath, n, 'image-alt', '<img> has no or empty alt attribute; describe the image')
        )
      }
    }
  })
  return findings
}

function existingOnDisk(root, paths) {
  return paths.filter(
    (p) => isPostPath(p) && validatePostPathLocation(root, p).status === 'ok'
  )
}

// Primary and sibling paths of the pair a changed file belongs to, or null
// when it has no translation on disk.
export function translationPairFor(root, relPath) {
  const primary = isSiblingPostPath(relPath)
    ? existingOnDisk(root, translationCounterparts(relPath))[0]
    : relPath
  if (!primary || validatePostPathLocation(root, primary).status !== 'ok') return null
  const siblings = existingOnDisk(root, translationCounterparts(primary))
  if (siblings.length === 0) return null
  return { primary, siblings }
}

// Rule (a) for one primary and its siblings. Mirrors resolveLangText: the
// primary's lang (default zh) names its own language, and the sibling is
// found by `${translationKey}:${otherLang}`.
export function checkTranslationPair(root, { primary, siblings }) {
  const findings = []
  const read = (p) => frontmatterInfo(readFileSync(join(root, p), 'utf8'))
  const p = read(primary)
  const primaryLang = p.data.lang || 'zh'
  const otherLang = primaryLang === 'zh' ? 'en' : 'zh'
  const requireText = (file, info, key, langLabel) => {
    const value = info.data[key]
    if (value === undefined || String(value).trim() === '') {
      findings.push(
        finding(
          file,
          info.lineOf[key] || 1,
          'translation-pair',
          `${key} is ${value === undefined ? 'missing' : 'empty'}; ` +
            `the ${langLabel} ${key} would silently fall back to the other language`
        )
      )
    }
  }
  requireText(primary, p, 'title', primaryLang)
  requireText(primary, p, 'description', primaryLang)
  if (!p.data.translationKey) {
    findings.push(
      finding(
        primary,
        p.lineOf.translationKey || 1,
        'translation-pair',
        `translationKey is missing, so ${siblings.join(', ')} never pairs with this post`
      )
    )
  }
  if (!LANGS.includes(primaryLang)) {
    findings.push(
      finding(primary, p.lineOf.lang || 1, 'translation-pair', `lang must be zh or en (${primaryLang})`)
    )
  }
  for (const sibling of siblings) {
    const s = read(sibling)
    const suffix = sibling.match(/\.(zh|en)\.(?:md|mdx)$/)[1]
    if (s.data.lang !== suffix) {
      findings.push(
        finding(
          sibling,
          s.lineOf.lang || 1,
          'translation-pair',
          `lang is ${s.data.lang ? `'${s.data.lang}'` : 'missing'} but the file name says ${suffix}`
        )
      )
    }
    if (suffix !== otherLang) {
      findings.push(
        finding(
          sibling,
          1,
          'translation-pair',
          `the primary ${primary} is ${primaryLang}, so its translation must be ${otherLang}, not ${suffix}; the site never shows this file`
        )
      )
    }
    if (p.data.translationKey && s.data.translationKey !== p.data.translationKey) {
      findings.push(
        finding(
          sibling,
          s.lineOf.translationKey || 1,
          'translation-pair',
          `translationKey ${s.data.translationKey ? `'${s.data.translationKey}'` : 'is missing'}, ` +
            `expected '${p.data.translationKey}' from ${primary}; the site never shows this translation`
        )
      )
    }
    requireText(sibling, s, 'title', suffix)
    requireText(sibling, s, 'description', suffix)
  }
  return findings
}

export function checkContentFiles(root, files, { baseRef = resolveBaseRef(root), wholeFile = false } = {}) {
  const diffBase = resolveDiffBase(root, baseRef).ref
  const findings = []
  const pairsSeen = new Set()
  const checked = []
  for (const relPath of [...new Set(files)].sort()) {
    const location = validatePostPathLocation(root, relPath)
    if (location.status === 'missing') continue
    if (location.status === 'error') {
      findings.push(finding(relPath, 1, 'path', location.detail))
      continue
    }
    checked.push(relPath)
    const raw = readFileSync(join(root, relPath), 'utf8')
    const lines = wholeFile ? 'all' : changedLineNumbers(root, relPath, diffBase)
    findings.push(...checkFileText(relPath, raw, { lines }))
    const pair = translationPairFor(root, relPath)
    if (pair && !pairsSeen.has(pair.primary)) {
      pairsSeen.add(pair.primary)
      findings.push(...checkTranslationPair(root, pair))
    }
  }
  const unique = new Map()
  for (const f of findings) unique.set(`${f.file}:${f.line}:${f.rule}:${f.message}`, f)
  const sorted = [...unique.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)
  )
  return { checked, findings: sorted }
}

export function formatFinding(f) {
  return `${f.file}:${f.line} [${f.rule}] ${f.message}`
}

// Release-check entry point. SKIP when no post changed.
export function runContentCheck(root, { baseRef, files, wholeFile = false } = {}) {
  const base = baseRef ?? resolveBaseRef(root)
  const targets = files ?? changedPostFiles(root, { baseRef: base })
  if (targets.length === 0) return { status: 'SKIP', detail: 'no changed post files' }
  const { checked, findings } = checkContentFiles(root, targets, { baseRef: base, wholeFile })
  if (findings.length) {
    const shown = findings.slice(0, 30).map(formatFinding).join('\n')
    const more = findings.length > 30 ? `\n... and ${findings.length - 30} more` : ''
    return {
      status: 'FAIL',
      detail: `${findings.length} content problem(s) in changed posts:\n${shown}${more}`,
      findings,
    }
  }
  return {
    status: 'PASS',
    detail: `${checked.length} changed post file(s): translation pairs, image alt text, no em dashes`,
    findings,
  }
}

// CLI entry (pathToFileURL handles spaces in the repo path)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'whole-file': { type: 'boolean', default: false },
        base: { type: 'string' },
      },
    })
  } catch (err) {
    console.error(err.message)
    console.error('usage: npm run check:content -- [--whole-file] [--base <ref>] [post file ...]')
    process.exit(1)
  }
  const root = git(['rev-parse', '--show-toplevel'])
  const files = parsed.positionals.length ? parsed.positionals : undefined
  const result = runContentCheck(root, {
    baseRef: parsed.values.base,
    files,
    wholeFile: parsed.values['whole-file'],
  })
  console.log(`content check: ${result.status}`)
  if (result.detail) console.log(result.detail)
  process.exit(result.status === 'FAIL' ? 1 : 0)
}
