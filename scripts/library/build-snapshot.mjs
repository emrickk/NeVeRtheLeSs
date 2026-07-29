#!/usr/bin/env node
/**
 * build-snapshot.mjs: regenerate the /library page data from the cleaned
 * media-library export (movies/TV + games), and optionally thumbnail and
 * upload cover art to R2 under library/.
 *
 * Usage:
 *   node scripts/library/build-snapshot.mjs                   # data only
 *   node scripts/library/build-snapshot.mjs --covers          # data + R2 covers
 *   node scripts/library/build-snapshot.mjs --source <dir>    # non-default export dir
 *   node scripts/library/build-snapshot.mjs --resolved <file> # non-default overlay
 *
 * Two sources, read once, manually, when the owner asks for a refresh (the
 * site build itself never touches either; iCloud paths are unreliable):
 *
 * 1. The douban-export "Emrick-clean" folder (--source): membership, titles,
 *    play hours, and cover art.
 * 2. The media.db resolved export (--resolved, newest library-resolved-*.json
 *    in the media-hub exports folder by default): the owner's manual-source
 *    refreshes. Rows with manual=true overwrite rating, comment, and watching
 *    state, and rows absent from Emrick-clean entirely are appended. Rows
 *    without manual=true never change anything: media.db also ingests sources
 *    (plex, letterboxd) whose watch history the owner has not approved for
 *    publication, so the resolved view must not alter membership on its own.
 *
 * Covers for appended works have no Emrick-clean file; drop an owner-approved
 * <id>.jpg into scripts/library/covers-extra/ (git-ignored) and it is picked
 * up as a fallback for both categories.
 *
 * Privacy: this is the only place deciding what library data becomes public.
 * Books are excluded entirely. Wish lists and backlogs are excluded. Entries
 * in HOLD_ENTRIES are excluded completely (owner decisions).
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import sharp from 'sharp'
import { loadEnvFile, loadConfig } from '../images/config.mjs'
import { makeClient, objectExists, putObject } from '../images/r2.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const OUT_DIR = join(REPO, 'src', 'data', 'library')

const DEFAULT_SOURCE =
  '/Users/anping.wang/Documents/Stuff/AI Space/douban-export/Emrick-clean'
const DEFAULT_RESOLVED_DIR =
  '/Users/anping.wang/Documents/Stuff/AI Space/media-hub/exports'
const EXTRA_COVERS = join(HERE, 'covers-extra')

/** Entries the owner decided must not appear at all (id: reason). */
const HOLD_ENTRIES = new Set([
  '27624787', // Skin (2018): owner hold, 2026-07-28
])

/** Display titles for resolved-appended works, which carry no show-level
 *  English title of their own (id: title, matching sibling rows). */
const TITLE_OVERRIDES = {
  '37018209': 'Guarding JieFangXi', // 守护解放西5, added via media.db 2026-07-29
}

const THUMB_WIDTH = 400
const THUMB_QUALITY = 80
const UPLOAD_CONCURRENCY = 8

// ---------------------------------------------------------------- helpers

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const SOURCE = opt('--source', DEFAULT_SOURCE)
const DO_COVERS = flag('--covers')

const GENERIC_SEASON = /^season\s*\d+$/i

/** Absolute path of the cover file behind each emitted cv, for uploads. */
const coverFiles = new Map()

/** Content-hashed cover filename, e.g. "12345.a1b2c3d4.jpg". A refreshed
 *  source cover gets a new URL, so the CDN's immutable caching never serves
 *  a stale image; unchanged covers keep their key and are skipped on upload.
 *  Directories are searched in order; covers-extra acts as the fallback. */
function coverName(srcDirs, id) {
  for (const dir of srcDirs) {
    const file = join(dir, `${id}.jpg`)
    if (!existsSync(file)) continue
    const h = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 8)
    coverFiles.set(id, file)
    return `${id}.${h}.jpg`
  }
  return null
}

/** English display title. TV rows use the show-level title: the season-level
 *  title_en is often "Season N" or a marketing alias (Squid Game S1 shows as
 *  "Round Six"). */
function movieTitle(r) {
  if (TITLE_OVERRIDES[r.douban_id]) return TITLE_OVERRIDES[r.douban_id]
  if (r.media_type === 'tv' && r.show_title_en) return r.show_title_en
  let en = r.title_en
  if (en && GENERIC_SEASON.test(en.trim())) en = ''
  return en || r.show_title_en || r.orig_title || r.title_zh
}

function rating(v) {
  return String(v ?? '').trim() ? Number(v) : 0
}

function compactRow(row) {
  // Strip empty/zero fields so the committed JSON stays small and readable.
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === '' || v === 0 || v === false || v == null) continue
    out[k] = v
  }
  return out
}

function writeJson(file, rows) {
  const body = '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n'
  writeFileSync(file, body, 'utf8')
}

// ------------------------------------------------------- resolved overlay

/** Load the media.db resolved export and index its manual-source rows by
 *  key (douban digits / st<appid> / ps<npcommid>, same scheme as the source
 *  ids). Fails hard when no export is found: rebuilding without the overlay
 *  would silently revert the owner's refreshed ratings and comments. */
function loadResolved() {
  let file = opt('--resolved', null)
  if (!file) {
    const names = existsSync(DEFAULT_RESOLVED_DIR)
      ? readdirSync(DEFAULT_RESOLVED_DIR)
          .filter((n) => /^library-resolved-\d{8}\.json$/.test(n))
          .sort()
      : []
    if (names.length === 0) {
      console.error(
        `No library-resolved-*.json found in ${DEFAULT_RESOLVED_DIR}; pass --resolved <file>`
      )
      process.exit(1)
    }
    file = join(DEFAULT_RESOLVED_DIR, names[names.length - 1])
  }
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const manual = new Map()
  for (const row of doc.rows) {
    if (row.manual === true) manual.set(row.key, row)
  }
  console.log(`resolved overlay: ${file}`)
  console.log(`  generated ${doc.generated}, ${doc.rows.length} rows, ${manual.size} manual`)
  return manual
}

/** Overwrite a source row's owner-editable fields from a manual row. The
 *  owner's comment text is an authentic record: copy byte-for-byte. Marked
 *  dates are NOT overlaid: manual rows carry the refresh date, and re-dating
 *  works he watched years ago would misplace them in the timeline. */
function applyManual(srcRow, m) {
  srcRow.my_rating = m.stars ?? ''
  srcRow.my_comment = m.comment ?? ''
  return srcRow
}

// ---------------------------------------------------------------- movies

function buildMovies(coverMisses, manual, consumed) {
  const src = JSON.parse(readFileSync(join(SOURCE, 'all_clean.json'), 'utf8'))
  const sourceIds = new Set(src.map((r) => r.douban_id))
  const keep = src
    .filter((r) => (r.status === 'collect' || r.status === 'do') && !HOLD_ENTRIES.has(r.douban_id))
    .sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''))
  let applied = 0
  for (const r of keep) {
    const m = manual.get(r.douban_id)
    if (!m) continue
    applyManual(r, m)
    if (m.watching) r.status = 'do'
    else if (r.status === 'do') r.status = 'collect'
    consumed.add(r.douban_id)
    applied += 1
  }
  // Manual rows for works Emrick-clean does not know at all become new
  // entries. Keys present in the source but filtered out (wish lists, holds)
  // stay out: the filter is the gate, not the overlay.
  const appended = []
  for (const [key, m] of manual) {
    if (consumed.has(key) || sourceIds.has(key) || HOLD_ENTRIES.has(key)) continue
    if (m.kind !== 'film' && m.kind !== 'tv') continue
    keep.push(
      applyManual(
        {
          douban_id: key,
          title_zh: m.title,
          title_en: m.title_en || '',
          orig_title: m.orig_title || '',
          show_title_en: '',
          media_type: m.kind === 'tv' ? 'tv' : 'movie',
          season_number: m.season ?? '',
          year: m.year ?? '',
          marked_at: m.marked || '',
          status: m.watching ? 'do' : 'collect',
        },
        m
      )
    )
    consumed.add(key)
    appended.push(`${key} ${m.title}`)
  }
  keep.sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''))
  console.log(`movies: ${applied} manual overlays applied, ${appended.length} appended`)
  for (const a of appended) console.log(`  new: ${a}`)
  return keep.map((r) => {
    const cv = coverName([join(SOURCE, 'covers'), EXTRA_COVERS], r.douban_id)
    if (!cv) coverMisses.push(`movie ${r.douban_id} ${r.title_zh}`)
    return compactRow({
      id: r.douban_id,
      t: movieTitle(r),
      y: r.year,
      tv: r.media_type === 'tv',
      s: String(r.season_number || ''),
      r: rating(r.my_rating),
      c: r.my_comment.trim(),
      m: (r.marked_at || '').slice(0, 10),
      w: r.status === 'do', // still watching
      cv,
      nc: !cv,
    })
  })
}

// ---------------------------------------------------------------- games

function gameHours(g) {
  const s = String(g.steam_hours ?? '').trim() ? Number(g.steam_hours) : 0
  const p = String(g.psn_hours ?? '').trim() ? Number(g.psn_hours) : 0
  return s + p
}

function buildGames(coverMisses, manual, consumed) {
  const src = JSON.parse(readFileSync(join(SOURCE, 'games_merged.json'), 'utf8'))
  const sourceIds = new Set(src.map((g) => g.id))
  const played = src.filter((g) => g.status === '玩过' && !HOLD_ENTRIES.has(g.id))
  let applied = 0
  for (const g of played) {
    const m = manual.get(g.id)
    if (!m) continue
    applyManual(g, m)
    consumed.add(g.id)
    applied += 1
  }
  const appended = []
  for (const [key, m] of manual) {
    if (consumed.has(key) || sourceIds.has(key) || HOLD_ENTRIES.has(key)) continue
    if (m.kind !== 'game') continue
    played.push(
      applyManual(
        {
          id: key,
          name_en: m.title_en || '',
          name_zh: m.title,
          year: m.year ?? '',
          marked_at: m.marked || '',
          status: '玩过',
          steam_hours: '',
          psn_hours: '',
        },
        m
      )
    )
    consumed.add(key)
    appended.push(`${key} ${m.title}`)
  }
  console.log(`games: ${applied} manual overlays applied, ${appended.length} appended`)
  for (const a of appended) console.log(`  new: ${a}`)
  const tracked = played.filter((g) => gameHours(g) > 0).sort((a, b) => gameHours(b) - gameHours(a))
  const untracked = played
    .filter((g) => gameHours(g) === 0)
    .sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''))
  untracked.sort((a, b) => rating(b.my_rating) - rating(a.my_rating))
  return [...tracked, ...untracked].map((g) => {
    const h = gameHours(g)
    const cv = coverName([join(SOURCE, 'covers-games'), EXTRA_COVERS], g.id)
    if (!cv) coverMisses.push(`game ${g.id} ${g.name_en || g.name_zh}`)
    return compactRow({
      id: g.id,
      t: g.name_en || g.name_zh,
      y: g.year,
      h: h > 0 ? (h >= 100 ? Math.round(h) : Math.round(h * 10) / 10) : 0,
      r: rating(g.my_rating),
      c: g.my_comment.trim(),
      m: (g.marked_at || '').slice(0, 10),
      cv,
      nc: !cv,
    })
  })
}

// ---------------------------------------------------------------- covers

async function uploadCovers(rows, keyPrefix) {
  loadEnvFile(join(REPO, '.env.local'))
  const config = loadConfig()
  const client = makeClient(config)
  let uploaded = 0
  let skipped = 0
  let missing = 0
  const queue = rows.filter((r) => !r.nc)
  async function worker() {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      const key = `${keyPrefix}/${row.cv}`
      if (await objectExists(client, config.bucket, key)) {
        skipped += 1
        continue
      }
      const file = coverFiles.get(row.id)
      if (!file || !existsSync(file)) {
        missing += 1
        continue
      }
      const buf = await sharp(file)
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY, progressive: true, mozjpeg: true })
        .toBuffer()
      await putObject(client, config.bucket, key, buf, 'image/jpeg')
      uploaded += 1
      if ((uploaded + skipped) % 200 === 0) {
        console.log(`  ${keyPrefix}: ${uploaded} uploaded, ${skipped} already present`)
      }
    }
  }
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker))
  console.log(`${keyPrefix}: ${uploaded} uploaded, ${skipped} already present, ${missing} missing locally`)
}

// ---------------------------------------------------------------- main

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`Source directory not found: ${SOURCE}`)
    process.exit(1)
  }
  mkdirSync(OUT_DIR, { recursive: true })

  const manual = loadResolved()
  const consumed = new Set()
  const coverMisses = []
  const movies = buildMovies(coverMisses, manual, consumed)
  const games = buildGames(coverMisses, manual, consumed)
  const unconsumed = [...manual.keys()].filter((k) => !consumed.has(k))
  if (unconsumed.length > 0) {
    console.log(`manual rows NOT published (unlisted status in source, or held):`)
    for (const k of unconsumed) console.log(`  ${k} ${manual.get(k).title}`)
  }

  writeJson(join(OUT_DIR, 'movies.json'), movies)
  writeJson(join(OUT_DIR, 'games.json'), games)
  console.log(`movies.json: ${movies.length} rows (held: ${HOLD_ENTRIES.size} total across both)`)
  console.log(`games.json: ${games.length} rows`)
  if (coverMisses.length > 0) {
    console.log(`entries without local cover art (will render as text spines):`)
    for (const m of coverMisses) console.log(`  ${m}`)
  }

  if (DO_COVERS) {
    console.log('uploading covers to R2...')
    await uploadCovers(movies, 'library/movies')
    await uploadCovers(games, 'library/games')
  } else {
    console.log('covers skipped (pass --covers to thumbnail and upload)')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
