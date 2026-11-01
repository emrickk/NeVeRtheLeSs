// Path rules shared by the publishing tools (ship, content-check): which
// repo-relative paths count as posts, translation siblings, hero covers, and
// library data, plus fail-closed location checks that refuse symlinks and
// paths escaping their expected directory.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { parseFrontmatterScalars } from './preview-posts.mjs'

const POSTS_RE = /^src\/content\/posts\/.+\.(?:md|mdx)$/
const FLAT_POST_RE = /^src\/content\/posts\/[^/]+\.(?:md|mdx)$/
const SIBLING_RE = /\.(zh|en)\.(md|mdx)$/
const LIBRARY_RE = /^src\/data\/library\/[^/]+\.json$/
export const HERO_PREFIX = 'src/assets/hero/'

export function hasCanonicalSegments(relPath) {
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
  return hasCanonicalSegments(relPath) && FLAT_POST_RE.test(relPath)
}

export function isSiblingPostPath(relPath) {
  return isPostPath(relPath) && SIBLING_RE.test(relPath)
}

export function isHeroPath(relPath) {
  return (
    hasCanonicalSegments(relPath) &&
    relPath.startsWith(HERO_PREFIX) &&
    relPath.length > HERO_PREFIX.length
  )
}

export function isLibraryDataPath(relPath) {
  return hasCanonicalSegments(relPath) && LIBRARY_RE.test(relPath)
}

// Every file that renders on the same page as relPath: for a primary post,
// its possible translation siblings; for a sibling, its primary. Candidates
// only; callers decide which exist or changed.
export function translationCounterparts(relPath) {
  const m = relPath.match(SIBLING_RE)
  if (m) {
    const stem = relPath.slice(0, -m[0].length)
    return [`${stem}.md`, `${stem}.mdx`]
  }
  const stem = relPath.replace(/\.(?:md|mdx)$/, '')
  return ['zh', 'en'].flatMap((lang) => [`${stem}.${lang}.md`, `${stem}.${lang}.mdx`])
}

// lstat walk from the repo root to the target: refuses missing files,
// symlinks anywhere in the path, and anything resolving outside container.
export function inspectContainedFile(root, targetAbs, containerAbs) {
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

// Generic location check for any selected repo file: 'ok', 'missing' (a
// deletion), or 'error' with a detail line.
export function validateRepoFileLocation(root, relPath, container = '') {
  if (!hasCanonicalSegments(relPath)) {
    return { status: 'error', detail: `${relPath}: not a canonical repo-relative path` }
  }
  const containerAbs = path.resolve(root, container)
  const location = inspectContainedFile(root, path.resolve(root, relPath), containerAbs)
  if (location.reason === 'symlink') {
    return {
      status: 'error',
      detail: `${relPath}: must not be a symlink or use symlink path components`,
    }
  }
  if (location.reason === 'escape') {
    return { status: 'error', detail: `${relPath}: resolves outside ${container || 'the repo'}` }
  }
  if (location.reason === 'missing') {
    // A dangling path component that is itself a symlink still counts as an
    // error above; a plain missing file is a deletion.
    return existsSync(path.resolve(root, relPath))
      ? { status: 'error', detail: `${relPath}: not a regular file` }
      : { status: 'missing' }
  }
  return { status: 'ok' }
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
// schema expects covers to live under src/assets/hero; absolute and escaping
// references are rejected so ship fails closed.
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
  const location = inspectContainedFile(root, heroAbs, path.resolve(root, HERO_PREFIX))
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
