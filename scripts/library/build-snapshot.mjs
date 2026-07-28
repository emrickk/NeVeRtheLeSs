#!/usr/bin/env node
/**
 * build-snapshot.mjs: regenerate the /library page data from the cleaned
 * media-library export (movies/TV + games), and optionally thumbnail and
 * upload cover art to R2 under library/.
 *
 * Usage:
 *   node scripts/library/build-snapshot.mjs                 # data only
 *   node scripts/library/build-snapshot.mjs --covers        # data + R2 covers
 *   node scripts/library/build-snapshot.mjs --source <dir>  # non-default export dir
 *
 * The source directory is the douban-export "Emrick-clean" folder. It is read
 * once, manually, when the owner asks for a refresh; the site build itself
 * never touches it (iCloud paths are unreliable). Covers are uploaded
 * resume-safe: objects that already exist on R2 are skipped.
 *
 * Privacy: this is the only place deciding what library data becomes public.
 * Books are excluded entirely. Wish lists and backlogs are excluded. Entries
 * in HOLD_ENTRIES are excluded completely (owner decisions).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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

/** Entries the owner decided must not appear at all (id: reason). */
const HOLD_ENTRIES = new Set([
  '27624787', // Skin (2018): owner hold, 2026-07-28
])

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

/** English display title. TV rows use the show-level title: the season-level
 *  title_en is often "Season N" or a marketing alias (Squid Game S1 shows as
 *  "Round Six"). */
function movieTitle(r) {
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

// ---------------------------------------------------------------- movies

function buildMovies(coverMisses) {
  const src = JSON.parse(readFileSync(join(SOURCE, 'all_clean.json'), 'utf8'))
  const keep = src
    .filter((r) => (r.status === 'collect' || r.status === 'do') && !HOLD_ENTRIES.has(r.douban_id))
    .sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''))
  return keep.map((r) => {
    const nc = !existsSync(join(SOURCE, 'covers', `${r.douban_id}.jpg`))
    if (nc) coverMisses.push(`movie ${r.douban_id} ${r.title_zh}`)
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
      nc,
    })
  })
}

// ---------------------------------------------------------------- games

function gameHours(g) {
  const s = String(g.steam_hours ?? '').trim() ? Number(g.steam_hours) : 0
  const p = String(g.psn_hours ?? '').trim() ? Number(g.psn_hours) : 0
  return s + p
}

function buildGames(coverMisses) {
  const src = JSON.parse(readFileSync(join(SOURCE, 'games_merged.json'), 'utf8'))
  const played = src.filter((g) => g.status === '玩过' && !HOLD_ENTRIES.has(g.id))
  const tracked = played.filter((g) => gameHours(g) > 0).sort((a, b) => gameHours(b) - gameHours(a))
  const untracked = played
    .filter((g) => gameHours(g) === 0)
    .sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''))
  untracked.sort((a, b) => rating(b.my_rating) - rating(a.my_rating))
  return [...tracked, ...untracked].map((g) => {
    const h = gameHours(g)
    const nc = !existsSync(join(SOURCE, 'covers-games', `${g.id}.jpg`))
    if (nc) coverMisses.push(`game ${g.id} ${g.name_en || g.name_zh}`)
    return compactRow({
      id: g.id,
      t: g.name_en || g.name_zh,
      y: g.year,
      h: h > 0 ? (h >= 100 ? Math.round(h) : Math.round(h * 10) / 10) : 0,
      r: rating(g.my_rating),
      c: g.my_comment.trim(),
      m: (g.marked_at || '').slice(0, 10),
      nc,
    })
  })
}

// ---------------------------------------------------------------- covers

async function uploadCovers(rows, srcDir, keyPrefix) {
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
      const key = `${keyPrefix}/${row.id}.jpg`
      if (await objectExists(client, config.bucket, key)) {
        skipped += 1
        continue
      }
      const file = join(srcDir, `${row.id}.jpg`)
      if (!existsSync(file)) {
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

  const coverMisses = []
  const movies = buildMovies(coverMisses)
  const games = buildGames(coverMisses)

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
    await uploadCovers(movies, join(SOURCE, 'covers'), 'library/movies')
    await uploadCovers(games, join(SOURCE, 'covers-games'), 'library/games')
  } else {
    console.log('covers skipped (pass --covers to thumbnail and upload)')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
