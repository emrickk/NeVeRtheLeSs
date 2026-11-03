#!/usr/bin/env node
/**
 * poster-variants.mjs: responsive WebP variants for the film, book and game
 * shelves (/library/movies/, /library/books/, /library/games/ and the
 * /library/ overview rows).
 *
 * Each poster's current CDN file stays as it is. This script downloads it,
 * encodes 240, 360 and 480 px wide WebP variants (same frame, no crop, no
 * sharpening; a width is skipped when the source is not wider), and, with
 * --upload, puts them on R2 next to the original under content-hashed keys
 * and records them in src/data/library/poster-variants.json, keyed by the
 * original URL. LibraryPage.astro then renders srcset/sizes for that poster;
 * a poster without an entry keeps its plain src.
 *
 * The map is a separate file on purpose: build-snapshot.mjs rewrites
 * movies.json and games.json wholesale, and books.json is edited by hand.
 * Every original URL carries a content hash, so a replaced cover has a new
 * URL, no entry, and falls back to its plain src until the next run.
 *
 * Usage:
 *   npm run library:poster-variants                          # dry run: encode and report, no R2, no JSON write
 *   npm run library:poster-variants -- --out-dir <dir>       # dry run, also save encodes and report.json
 *   npm run library:poster-variants -- --shelf books         # limit to shelves (movies,books,games)
 *   npm run library:poster-variants -- --upload              # upload missing variants, update the map
 *   npm run library:poster-variants -- --verify              # HEAD every recorded file on the CDN
 *
 * Credentials (only for --upload) come from the environment or .env.local.
 *
 * Safety: dry run unless --upload. Idempotent and append-only: posters whose
 * entry already matches are skipped, map entries are only added, and an
 * existing R2 object is never overwritten (key check plus If-None-Match: *,
 * shared with car-variants.mjs). Every uploaded or reused object is verified
 * by HEAD on R2 and on the CDN before its entry is recorded.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadConfig, loadEnvFile } from '../images/config.mjs';
import { makeClient } from '../images/r2.mjs';
import { download, encodeVariant, uploadIfAbsent, verifyOnCdn } from './car-variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DATA = join(REPO, 'src', 'data', 'library');
export const POSTER_VARIANTS_JSON = join(DATA, 'poster-variants.json');

// Poster tiles render 108 to about 205 CSS px wide (see POSTER_SIZES in
// LibraryPage.astro): 240 covers 1x, 360 covers the common 2x and 3x tiles
// (111 px at 390 wide, 159 px at 1280 wide), 480 covers the widest 2x tiles.
export const VARIANT_WIDTHS = [240, 360, 480];
export const LIBRARY_PREFIX = 'https://cdn.theneverless.com/library/';
export const SHELVES = ['movies', 'books', 'games'];
const CONCURRENCY = 5;

// ---------------------------------------------------------------- pure helpers

/** Poster sources per shelf, in page order: { shelf, id, title, url }. Rows
 *  without cover art render as text spines and have no source. External
 *  book-cover hosts are returned too; main() reports and skips them. */
export function posterSources({ movies, moviesLocal, books, games }) {
  const localIds = new Set(moviesLocal.map((m) => m.id));
  const movieRows = [...moviesLocal, ...movies.filter((m) => !localIds.has(m.id))];
  const out = [];
  for (const row of movieRows) {
    if (!row.nc && row.cv) {
      out.push({
        shelf: 'movies',
        id: row.id,
        title: row.t,
        url: `${LIBRARY_PREFIX}movies/${row.cv}`,
      });
    }
  }
  for (const book of books) {
    if (book.image) out.push({ shelf: 'books', id: book.id, title: book.t, url: book.image });
  }
  for (const row of games) {
    if (!row.nc && row.cv) {
      out.push({
        shelf: 'games',
        id: row.id,
        title: row.t,
        url: `${LIBRARY_PREFIX}games/${row.cv}`,
      });
    }
  }
  return out;
}

/** Variant widths for a source of this width: every configured width that
 *  is narrower than the source. */
export function widthsFor(sourceWidth) {
  return VARIANT_WIDTHS.filter((w) => w < sourceWidth);
}

/** True when the original itself is the best candidate above the variants,
 *  because the source is not wider than the largest configured width. */
export function keepsOriginal(sourceWidth) {
  return sourceWidth <= VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}

/** R2 key for one variant, next to the original:
 *  library/books/26184242.977b643ff75a-240w-0123456789ab.webp */
export function variantKey(sourceUrl, width, buffer) {
  if (!sourceUrl.startsWith(LIBRARY_PREFIX)) throw new Error(`Not a library CDN URL: ${sourceUrl}`);
  const path = new URL(sourceUrl).pathname.slice(1);
  const base = path.replace(/\.[a-z0-9]+$/i, '');
  if (!base || base.endsWith('/')) throw new Error(`Cannot derive a key from ${sourceUrl}`);
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `${base}-${width}w-${hash}.webp`;
}

/** Problems with one recorded entry (empty when complete). */
export function entryProblems(sourceUrl, entry) {
  if (!entry) return ['no entry'];
  const problems = [];
  if (!(entry.sourceWidth > 0 && entry.sourceHeight > 0))
    problems.push('missing source dimensions');
  const images = Array.isArray(entry.images) ? entry.images : [];
  const expected = widthsFor(entry.sourceWidth || 0);
  if (keepsOriginal(entry.sourceWidth || 0)) expected.push(entry.sourceWidth);
  const widths = images.map((img) => img.width);
  if (JSON.stringify(widths) !== JSON.stringify(expected)) {
    problems.push(`widths ${JSON.stringify(widths)} instead of ${JSON.stringify(expected)}`);
  }
  const stem = sourceUrl.replace(/\.[a-z0-9]+$/i, '');
  for (const img of images) {
    const expectedHeight = Math.round((img.width * entry.sourceHeight) / entry.sourceWidth);
    if (Math.abs(img.height - expectedHeight) > 1) {
      problems.push(`${img.width}w height ${img.height} does not keep the source frame`);
    }
    const isOriginal = img.url === sourceUrl && img.width === entry.sourceWidth;
    const isVariant =
      typeof img.url === 'string' &&
      img.url.startsWith(`${stem}-${img.width}w-`) &&
      /-\d+w-[0-9a-f]{12}\.webp$/.test(img.url);
    if (!isOriginal && !isVariant)
      problems.push(`${img.width}w url is not a content-hashed WebP key`);
    if (!(Number.isInteger(img.bytes) && img.bytes > 0))
      problems.push(`${img.width}w has no byte size`);
  }
  return problems;
}

/** Stable text form: sorted keys, one entry per line. */
export function formatVariants(map) {
  const lines = Object.keys(map)
    .sort()
    .map((url) => `  ${JSON.stringify(url)}: ${JSON.stringify(map[url])}`);
  return lines.length ? `{\n${lines.join(',\n')}\n}\n` : '{}\n';
}

/** The entries to add to `current`: new keys only, never a replacement. */
export function appendOnly(current, additions) {
  const out = {};
  for (const [url, entry] of Object.entries(additions)) {
    if (!(url in current)) out[url] = entry;
  }
  return out;
}

/** The candidate a browser that takes the smallest sufficient width would
 *  load for a tile `cssWidth` px wide at `dpr` (the largest if none is). */
export function pickCandidate(images, cssWidth, dpr) {
  const needed = cssWidth * dpr;
  return images.find((img) => img.width >= needed) ?? images[images.length - 1];
}

// ---------------------------------------------------------------- I/O

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadVariants(path = POSTER_VARIANTS_JSON) {
  return existsSync(path) ? readJson(path) : {};
}

function writeVariants(path, map) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, formatVariants(map));
  renameSync(tmp, path);
}

function loadShelves() {
  return {
    movies: readJson(join(DATA, 'movies.json')),
    moviesLocal: readJson(join(DATA, 'movies-local.json')),
    books: readJson(join(DATA, 'books.json')),
    games: readJson(join(DATA, 'games.json')),
  };
}

function parseArgs(argv) {
  const opts = { upload: false, verify: false, shelves: new Set(SHELVES), outDir: null, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--upload') opts.upload = true;
    else if (arg === '--dry-run') opts.upload = false;
    else if (arg === '--verify') opts.verify = true;
    else if (arg === '--shelf') {
      opts.shelves = new Set((argv[++i] || '').split(',').filter(Boolean));
      const unknown = [...opts.shelves].filter((s) => !SHELVES.includes(s));
      if (opts.shelves.size === 0 || unknown.length) {
        throw new Error(`--shelf takes a comma-separated list of ${SHELVES.join(', ')}`);
      }
    } else if (arg === '--out-dir') {
      opts.outDir = argv[++i];
      if (!opts.outDir) throw new Error('--out-dir needs a directory');
    } else if (arg === '--limit') {
      opts.limit = Number(argv[++i]);
      if (!(opts.limit > 0)) throw new Error('--limit needs a positive number');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.upload && opts.verify) throw new Error('--upload and --verify are separate runs');
  return opts;
}

async function headLength(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return { status: res.status, length: Number(res.headers.get('content-length')) };
}

async function processPoster(poster, ctx) {
  const source = await download(poster.url);
  const meta = await sharp(source).metadata();
  const opaque = !meta.hasAlpha || (await sharp(source).stats()).isOpaque;
  const images = [];
  const files = [];
  for (const width of widthsFor(meta.width)) {
    const variant = await encodeVariant(source, width, { opaque });
    const key = variantKey(poster.url, width, variant.buffer);
    const url = `${new URL(poster.url).origin}/${key}`;
    if (ctx.outDir) {
      const file = join(ctx.outDir, key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, variant.buffer);
      files.push(file);
    }
    let action = 'planned';
    if (ctx.upload) {
      action = await uploadIfAbsent(ctx.client, ctx.config.bucket, key, variant.buffer);
      await verifyOnCdn(url, variant.bytes);
    }
    ctx.counts[action] = (ctx.counts[action] || 0) + 1;
    ctx.plannedBytes += variant.bytes;
    images.push({ width: variant.width, height: variant.height, bytes: variant.bytes, url });
  }
  if (keepsOriginal(meta.width)) {
    images.push({ width: meta.width, height: meta.height, bytes: source.length, url: poster.url });
  }
  if (ctx.outDir) {
    const file = join(ctx.outDir, 'originals', new URL(poster.url).pathname.slice(1));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return {
    entry: { sourceWidth: meta.width, sourceHeight: meta.height, images },
    originalBytes: source.length,
    format: meta.format,
  };
}

async function verifyRecorded(map, log) {
  let failures = 0;
  let checked = 0;
  for (const [sourceUrl, entry] of Object.entries(map)) {
    for (const problem of entryProblems(sourceUrl, entry)) {
      failures += 1;
      log(`  ${sourceUrl}: ${problem}`);
    }
    for (const img of entry.images || []) {
      checked += 1;
      try {
        if (img.url === sourceUrl) {
          const head = await headLength(img.url);
          if (head.status !== 200 || head.length !== img.bytes) {
            throw new Error(`CDN HEAD ${img.url}: status ${head.status}, length ${head.length}`);
          }
        } else {
          await verifyOnCdn(img.url, img.bytes);
        }
      } catch (err) {
        failures += 1;
        log(`  ${sourceUrl}: ${err.message}`);
      }
    }
  }
  log(
    failures
      ? `verify: ${failures} problem(s)`
      : `verify: all ${checked} recorded files OK on the CDN`
  );
  return failures ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parseArgs(argv);
  const map = loadVariants();
  if (opts.verify) return verifyRecorded(map, log);

  const all = posterSources(loadShelves()).filter((p) => opts.shelves.has(p.shelf));
  const external = all.filter((p) => !p.url.startsWith(LIBRARY_PREFIX));
  for (const p of external)
    log(`  skip ${p.shelf} ${p.id}: external cover host ${new URL(p.url).host}`);
  const seen = new Set();
  let todo = all.filter((p) => {
    if (!p.url.startsWith(LIBRARY_PREFIX) || seen.has(p.url)) return false;
    seen.add(p.url);
    return entryProblems(p.url, map[p.url]).length > 0;
  });
  if (opts.limit) todo = todo.slice(0, opts.limit);
  log(
    `${todo.length} of ${all.length} posters need variants` +
      `${opts.upload ? '' : ' (dry run: nothing is uploaded or recorded)'}`
  );
  if (todo.length === 0) return 0;

  const ctx = { upload: opts.upload, outDir: opts.outDir, counts: {}, plannedBytes: 0 };
  if (ctx.outDir) mkdirSync(ctx.outDir, { recursive: true });
  if (opts.upload) {
    loadEnvFile(join(REPO, '.env.local'));
    ctx.config = loadConfig();
    if (`${ctx.config.publicBase}/library/` !== LIBRARY_PREFIX) {
      throw new Error(`R2_PUBLIC_BASE ${ctx.config.publicBase} does not serve ${LIBRARY_PREFIX}`);
    }
    ctx.client = makeClient(ctx.config);
  }

  const results = new Map();
  const report = [];
  const failures = [];
  const queue = [...todo];
  let done = 0;
  async function worker() {
    for (let poster = queue.shift(); poster; poster = queue.shift()) {
      try {
        const result = await processPoster(poster, ctx);
        results.set(poster.url, result.entry);
        report.push({ ...poster, ...result });
      } catch (err) {
        failures.push(poster.url);
        log(`  ${poster.shelf} ${poster.id}: FAILED ${err.message}`);
      }
      done += 1;
      if (done % 250 === 0) log(`  ${done} of ${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const shelf of SHELVES) {
    const rows = report.filter((r) => r.shelf === shelf);
    if (!rows.length) continue;
    const original = rows.reduce((n, r) => n + r.originalBytes, 0);
    const variants = rows.flatMap((r) => r.entry.images.filter((i) => i.url !== r.url));
    const bytes = variants.reduce((n, i) => n + i.bytes, 0);
    log(
      `${shelf}: ${rows.length} posters, originals ${original} B, ${variants.length} variants ${bytes} B`
    );
  }
  log(`objects: ${JSON.stringify(ctx.counts)}, variant bytes ${ctx.plannedBytes} B`);
  if (ctx.outDir) {
    report.sort((a, b) => SHELVES.indexOf(a.shelf) - SHELVES.indexOf(b.shelf));
    writeFileSync(join(ctx.outDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
    log(`wrote ${join(ctx.outDir, 'report.json')}`);
  }

  if (opts.upload && results.size > 0) {
    // Re-read so the write only adds entries to the current file.
    const latest = loadVariants();
    const additions = appendOnly(latest, Object.fromEntries(results));
    for (const url of results.keys()) {
      if (!(url in additions))
        log(`  kept the existing entry for ${url} (append-only; delete it by hand to redo it)`);
    }
    writeVariants(POSTER_VARIANTS_JSON, { ...latest, ...additions });
    log(`added ${Object.keys(additions).length} entries to ${POSTER_VARIANTS_JSON}`);
  }
  if (failures.length) {
    log(`failed: ${failures.length}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message || err);
      process.exit(1);
    }
  );
}
