#!/usr/bin/env node
// Internal link check for the built site: scans dist/**/*.html for href, src
// and srcset values that point at this site (root-relative, page-relative, or
// absolute https://theneverless.com/...) and verifies each target exists in
// dist. Pagefind asset paths referenced from bundled JS are checked as well.
// External URLs and the image CDN are ignored. Exits 1 when any link is
// broken, 2 when dist is missing.
//
// Usage: node scripts/check-built-links.mjs [distDir]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SITE_ORIGIN = 'https://theneverless.com'
const SITE_HOSTS = new Set(['theneverless.com', 'www.theneverless.com'])

// Every file under dist as a POSIX relative path. Lookups go through this set
// instead of existsSync so the check is case-sensitive on macOS too, matching
// GitHub Pages.
export function listFiles(dist) {
  const out = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else out.add(relative(dist, p).split(sep).join('/'))
    }
  }
  walk(dist)
  return out
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// Raw link values from href, src and srcset attributes. Script, style and
// comment bodies are dropped first so template strings in inline JS are not
// mistaken for markup.
export function extractRefs(html) {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const refs = []
  const attr = /(?<![\w-])(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  for (const m of markup.matchAll(attr)) {
    const value = decodeEntities(m[2] ?? m[3] ?? '').trim()
    if (!value) continue
    if (m[1].toLowerCase() === 'srcset') {
      for (const candidate of value.split(',')) {
        const url = candidate.trim().split(/\s+/)[0]
        if (url) refs.push(url)
      }
    } else {
      refs.push(value)
    }
  }
  return refs
}

// The search UI loads Pagefind at runtime from bundled JS, not from markup,
// so quoted /pagefind/... literals in dist JS count as links too.
export function extractPagefindRefs(js) {
  return [...js.matchAll(/["'`](\/pagefind\/[^"'`\s?#]+)/g)].map((m) => m[1])
}

// The page's own URL on the site, used as the base for relative links.
export function pageUrlFor(relPath) {
  if (relPath === 'index.html') return `${SITE_ORIGIN}/`
  if (relPath.endsWith('/index.html')) return `${SITE_ORIGIN}/${relPath.slice(0, -'index.html'.length)}`
  return `${SITE_ORIGIN}/${relPath}`
}

// Decoded pathname for links that target this site, or null for anything
// external (other hosts, the CDN, mailto:, data:, javascript:) and for
// same-page fragment links.
export function internalPath(ref, pageUrl) {
  if (ref.startsWith('#')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^https?:/i.test(ref)) return null
  let url
  try {
    url = new URL(ref, pageUrl)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !SITE_HOSTS.has(url.hostname)) return null
  try {
    return decodeURIComponent(url.pathname)
  } catch {
    return url.pathname
  }
}

// Same resolution rules as the static host: a trailing slash means
// index.html, a bare path may be a file, a directory with index.html, or
// an extensionless .html page.
export function resolvesTo(pathname, files) {
  const rel = pathname.replace(/^\/+/, '')
  if (rel === '' || rel.endsWith('/')) return files.has(`${rel}index.html`)
  return files.has(rel) || files.has(`${rel}/index.html`) || files.has(`${rel}.html`)
}

export function checkBuiltLinks(dist) {
  const files = listFiles(dist)
  const pages = [...files].filter((f) => f.endsWith('.html')).sort()
  const scripts = [...files].filter((f) => f.endsWith('.js') && !f.startsWith('pagefind/')).sort()
  const broken = new Map()
  let checked = 0
  const verify = (from, pathname) => {
    checked++
    if (resolvesTo(pathname, files)) return
    if (!broken.has(pathname)) broken.set(pathname, new Set())
    broken.get(pathname).add(from)
  }
  for (const page of pages) {
    const pageUrl = pageUrlFor(page)
    const html = readFileSync(join(dist, page), 'utf8')
    for (const ref of extractRefs(html)) {
      const pathname = internalPath(ref, pageUrl)
      if (pathname !== null) verify(page, pathname)
    }
  }
  for (const script of scripts) {
    for (const ref of extractPagefindRefs(readFileSync(join(dist, script), 'utf8'))) verify(script, ref)
  }
  return { pages: pages.length, checked, broken }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = resolve(process.argv[2] ?? 'dist')
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    console.error(`check-built-links: ${dist} not found (build first)`)
    process.exit(2)
  }
  const { pages, checked, broken } = checkBuiltLinks(dist)
  if (broken.size === 0) {
    console.log(`check-built-links: PASS, ${checked} internal links across ${pages} pages all resolve`)
    process.exit(0)
  }
  console.error(`check-built-links: FAIL, ${broken.size} broken internal targets (${checked} links across ${pages} pages)`)
  for (const [target, from] of [...broken].sort(([a], [b]) => a.localeCompare(b))) {
    const list = [...from].sort()
    const shown = list.slice(0, 5).join(', ')
    const more = list.length > 5 ? ` (+${list.length - 5} more)` : ''
    console.error(`  ${target}\n    from: ${shown}${more}`)
  }
  process.exit(1)
}
