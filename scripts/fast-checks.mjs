// Fast-lane checks for scoped publishes (ship --fast): validate exactly the
// files being shipped, in place of the full release checklist. The rationale
// and consequence model live in the ship spec; the short version is that the
// deploy build on GitHub Actions remains the final gate, the live site never
// breaks on a failed deploy, and these checks catch the realistic ways a
// post file can fail that build (frontmatter shape, hero path, protected
// mismatch) plus accidental secrets, in well under a second.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { parseFrontmatterScalars, scalarIsTrue } from './preview-posts.mjs'
import { loadAllowlist, scanTextForSecrets } from './release-check.mjs'

const SIBLING_RE = /\.(zh|en)\.(md|mdx)$/
const LANGS = ['zh', 'en']
const POSTS_RE = /^src\/content\/posts\/.+\.(?:md|mdx)$/
const HERO_PREFIX = 'src/assets/hero/'
const HERO_FORMATS = new Map([
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.png', 'png'],
  ['.webp', 'webp'],
])

function hasCanonicalSegments(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false
  if (path.isAbsolute(relPath) || relPath.includes('\\') || relPath.includes('\0')) return false
  if (relPath.includes('//')) return false
  return relPath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export function isPostPath(relPath) {
  return hasCanonicalSegments(relPath) && POSTS_RE.test(relPath)
}

export function isCanonicalFlatPostPath(relPath) {
  return hasCanonicalSegments(relPath) && /^src\/content\/posts\/[^/]+\.(?:md|mdx)$/.test(relPath)
}

export function isHeroPath(relPath) {
  return (
    hasCanonicalSegments(relPath) &&
    relPath.startsWith(HERO_PREFIX) &&
    relPath.length > HERO_PREFIX.length
  )
}

function normalizeBool(value) {
  if (value === undefined || value === '') return false
  return scalarIsTrue(String(value))
}

// Path of the counterpart translation file on disk, or null when none exists.
export function siblingOnDisk(root, relPath) {
  const sibling = SIBLING_RE.test(relPath)
    ? [relPath.replace(SIBLING_RE, '.$2')]
    : LANGS.map((lang) => relPath.replace(/\.(md|mdx)$/, `.${lang}.$1`))
  for (const candidate of sibling) {
    if (candidate !== relPath && existsSync(path.join(root, candidate))) return candidate
  }
  return null
}

function inspectContainedFile(root, targetAbs, containerAbs) {
  const rootAbs = path.resolve(root)
  const lexicalRelative = path.relative(containerAbs, targetAbs)
  if (
    lexicalRelative === '' ||
    lexicalRelative === '..' ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  ) {
    return { status: 'error', reason: 'escape' }
  }

  const repoRelative = path.relative(rootAbs, targetAbs)
  let current = rootAbs
  for (const segment of repoRelative.split(path.sep)) {
    current = path.join(current, segment)
    let componentStat
    try {
      componentStat = lstatSync(current)
    } catch {
      return { status: 'error', reason: 'missing' }
    }
    if (componentStat.isSymbolicLink()) return { status: 'error', reason: 'symlink' }
  }
  if (!lstatSync(targetAbs).isFile()) return { status: 'error', reason: 'missing' }

  const realContainer = realpathSync(containerAbs)
  const realTarget = realpathSync(targetAbs)
  const realRelative = path.relative(realContainer, realTarget)
  if (
    realRelative === '..' ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    return { status: 'error', reason: 'escape' }
  }
  return { status: 'ok' }
}

function inspectHeroLocation(root, heroAbs) {
  return inspectContainedFile(root, heroAbs, path.resolve(root, HERO_PREFIX))
}

export function validatePostPathLocation(root, relPath) {
  if (!isPostPath(relPath)) {
    return { status: 'error', detail: `${relPath}: invalid post path` }
  }
  const postAbs = path.resolve(root, relPath)
  const location = inspectContainedFile(root, postAbs, path.resolve(root, 'src/content/posts'))
  if (location.reason === 'symlink') {
    return {
      status: 'error',
      detail: `${relPath}: post must not be a symlink or use symlink path components`,
    }
  }
  if (location.reason === 'escape') {
    return { status: 'error', detail: `${relPath}: post resolves outside src/content/posts` }
  }
  if (location.reason === 'missing') return { status: 'missing' }
  return { status: 'ok' }
}

// Resolve a primary post's heroImage into a repo-relative path. The content
// schema expects covers to live under src/assets/hero; rejecting absolute and
// escaping references here keeps both ship preflight and the fast lane on the
// same fail-closed rule.
export function resolveHeroReferenceFromContent(root, relPath, raw, { checkFile = true } = {}) {
  const abs = path.join(root, relPath)
  const fm = parseFrontmatterScalars(raw)
  if (!fm.heroImage) return { status: 'none' }

  const reference = String(fm.heroImage)
  const heroAbs = path.resolve(path.dirname(abs), reference)
  const heroRel = path.relative(root, heroAbs).split(path.sep).join('/')
  if (path.isAbsolute(reference) || !isHeroPath(heroRel)) {
    return {
      status: 'error',
      detail:
        `${relPath}: heroImage escapes src/assets/hero ` +
        `or points somewhere else (${reference})`,
    }
  }
  if (!checkFile) return { status: 'ok', path: heroRel, reference }
  const location = inspectHeroLocation(root, heroAbs)
  if (location.reason === 'missing') {
    return {
      status: 'error',
      detail: `${relPath}: heroImage not found on disk (${reference})`,
    }
  }
  if (location.reason === 'symlink') {
    return {
      status: 'error',
      detail: `${relPath}: heroImage must not be a symlink or use symlink path components (${reference})`,
    }
  }
  if (location.reason === 'escape') {
    return {
      status: 'error',
      detail: `${relPath}: heroImage resolves outside src/assets/hero (${reference})`,
    }
  }
  return { status: 'ok', path: heroRel, reference }
}

export function resolveHeroReference(root, relPath) {
  const location = validatePostPathLocation(root, relPath)
  if (location.status === 'error') return location
  if (location.status === 'missing') return { status: 'none' }
  return resolveHeroReferenceFromContent(
    root,
    relPath,
    readFileSync(path.join(root, relPath), 'utf8')
  )
}

// Frontmatter shape of one post file against the collection contract in
// src/content.config.ts. Deliberately pragmatic: required fields, date
// parseability, hero existence, protected parity with the on-disk sibling.
export function validatePostFile(root, relPath) {
  const errors = []
  const abs = path.join(root, relPath)
  const location = validatePostPathLocation(root, relPath)
  if (location.status === 'error') return [location.detail]
  if (location.status === 'missing') return [`${relPath}: file not found`]
  const raw = readFileSync(abs, 'utf8')
  if (!/^---\r?\n/.test(raw)) return [`${relPath}: no frontmatter block`]
  const fm = parseFrontmatterScalars(raw)

  const requireString = (key) => {
    if (fm[key] === undefined || String(fm[key]).trim() === '') {
      errors.push(`${relPath}: missing required field ${key}`)
    }
  }

  if (SIBLING_RE.test(relPath)) {
    requireString('translationKey')
    if (!LANGS.includes(fm.lang)) {
      errors.push(`${relPath}: lang must be zh or en`)
    }
  } else {
    requireString('title')
    requireString('description')
    requireString('pubDate')
    if (fm.pubDate && Number.isNaN(Date.parse(fm.pubDate))) {
      errors.push(`${relPath}: pubDate does not parse as a date (${fm.pubDate})`)
    }
    if (fm.updatedDate && Number.isNaN(Date.parse(fm.updatedDate))) {
      errors.push(`${relPath}: updatedDate does not parse as a date (${fm.updatedDate})`)
    }
    if (fm.lang && !LANGS.includes(fm.lang)) {
      errors.push(`${relPath}: lang must be zh or en`)
    }
    const hero = resolveHeroReference(root, relPath)
    if (hero.status === 'error') errors.push(hero.detail)
    if (fm.slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.slug)) {
      errors.push(`${relPath}: slug must be lowercase letters, digits, and hyphens (${fm.slug})`)
    }
  }

  // protected must match between the pair or the build refuses the post
  const siblingPath = siblingOnDisk(root, relPath)
  if (siblingPath) {
    const siblingLocation = validatePostPathLocation(root, siblingPath)
    if (siblingLocation.status === 'error') {
      errors.push(siblingLocation.detail)
    } else {
      const siblingFm = parseFrontmatterScalars(readFileSync(path.join(root, siblingPath), 'utf8'))
      if (normalizeBool(fm.protected) !== normalizeBool(siblingFm.protected)) {
        errors.push(`${relPath}: protected flag differs from ${siblingPath}; set it in both files`)
      }
    }
  }

  return errors
}

// New or edited covers must be real JPEG, PNG, or WebP images and meet the
// two minimum shapes documented in docs/images.md. Sharp is already a runtime
// dependency for the image pipeline; metadata checks are followed by a full
// decode so truncated image data cannot pass the fast lane.
export async function validateHeroFile(root, relPath) {
  if (!isHeroPath(relPath)) return [`${relPath}: invalid hero path`]
  const abs = path.join(root, relPath)
  const location = inspectHeroLocation(root, abs)
  if (location.reason === 'symlink') {
    return [`${relPath}: hero cover must not be a symlink or use symlink path components`]
  }
  if (location.reason === 'escape') return [`${relPath}: hero cover resolves outside the repo`]
  if (location.status === 'error') return [`${relPath}: hero file not found`]

  const expectedFormat = HERO_FORMATS.get(path.extname(relPath).toLowerCase())
  if (!expectedFormat) {
    return [`${relPath}: hero cover must be JPEG, PNG, or WebP`]
  }

  let metadata
  try {
    metadata = await sharp(abs, { failOn: 'truncated' }).metadata()
    await sharp(abs, { failOn: 'truncated' }).raw().toBuffer()
  } catch (err) {
    return [`${relPath}: invalid ${expectedFormat.toUpperCase()} image (${err.message})`]
  }
  if (metadata.format !== expectedFormat) {
    return [
      `${relPath}: file extension expects ${expectedFormat}, but image data is ${metadata.format || 'unknown'}`,
    ]
  }

  const { width, height } = metadata.autoOrient || metadata
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return [`${relPath}: image dimensions could not be read`]
  }
  const meetsWideMinimum = width >= 2400 && height >= 1260
  const meetsSquareMinimum = width >= 1600 && height >= 1600
  if (!meetsWideMinimum && !meetsSquareMinimum) {
    return [
      `${relPath}: cover is ${width}x${height}; minimum is 2400x1260 for wide covers or 1600x1600 for square covers`,
    ]
  }
  return []
}

// All fast-lane findings for a scoped change set: frontmatter shape per
// post, image metadata per hero, plus a secret scan limited to post text.
// Binary hero bytes are never parsed as posts or scanned as text. Empty
// array = go.
// A change-set path missing on disk is a staged deletion (git computed the
// set), which needs no content validation: the commit removes the page.
export async function runFastChecks(root, changeSet) {
  const postPaths = changeSet.filter(isPostPath)
  const heroPaths = changeSet.filter(isHeroPath)
  const errors = postPaths.flatMap((relPath) => {
    const location = validatePostPathLocation(root, relPath)
    return location.status === 'missing' ? [] : validatePostFile(root, relPath)
  })
  for (const relPath of heroPaths) errors.push(...(await validateHeroFile(root, relPath)))
  for (const relPath of changeSet) {
    if (!isPostPath(relPath) && !isHeroPath(relPath)) {
      errors.push(`${relPath}: unsupported fast-lane path`)
    }
  }

  const allowlist = loadAllowlist(root)
  for (const relPath of postPaths) {
    const abs = path.join(root, relPath)
    const location = validatePostPathLocation(root, relPath)
    if (location.status !== 'ok') continue
    for (const finding of scanTextForSecrets(readFileSync(abs, 'utf8'), relPath, allowlist)) {
      errors.push(
        `${finding.file}:${finding.line} possible secret ${finding.pattern} ${finding.redacted}`
      )
    }
  }
  return errors
}
