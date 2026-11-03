#!/usr/bin/env node
/**
 * dimensions.mjs: the committed width/height map for post and note images.
 *
 * src/data/image-dimensions.json maps every CDN image URL used in
 * src/content/ to its displayed [width, height] in pixels.
 * scripts/rehype/image-dimensions.mjs reads it at build time and gives each
 * <img> intrinsic width and height attributes, so text no longer jumps while
 * photos arrive. The build never touches the network: a URL missing from the
 * map only loses its dimensions and prints a warning.
 *
 * Usage:
 *   npm run images:dimensions               # probe URLs missing from the map, add them
 *   npm run images:dimensions -- --dry-run  # probe and report, write nothing
 *   npm run images:dimensions -- --check    # list referenced URLs missing from the map (no network)
 *
 * `npm run images` adds an entry for every image it uploads, so this script
 * is only needed for images uploaded some other way. Probing is read-only:
 * a ranged GET of the first 64 KB of each file (plus one more ranged GET for
 * a WebP whose EXIF block sits after the image data), five at a time.
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
export const DIMENSIONS_JSON = join(REPO, 'src', 'data', 'image-dimensions.json');
export const CONTENT_DIRS = [
  join(REPO, 'src', 'content', 'posts'),
  join(REPO, 'src', 'content', 'notes'),
];
export const CDN_ORIGIN = 'https://cdn.theneverless.com';

const PROBE_BYTES = 65536;
const CONCURRENCY = 5;
const CDN_IMAGE_RE =
  /https:\/\/cdn\.theneverless\.com\/[^\s"'()<>[\]]+?\.(?:webp|jpe?g|png|gif|avif)(?=[\s"'()<>[\]]|$)/gi;

// ---------------------------------------------------------------- parsing

/** EXIF orientation (1 to 8) from a TIFF block, or 1 when absent. */
export function exifOrientation(tiff) {
  if (tiff.length < 8) return 1;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const le = order === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { width, height, hasExif: Boolean(buf[20] & 0x08) };
  }
  return null;
}

function jpegSize(buf) {
  let orientation = 1;
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1];
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    const length = buf.readUInt16BE(o + 2);
    if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      orientation = exifOrientation(buf.subarray(o + 10, o + 2 + length));
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(o + 7), height: buf.readUInt16BE(o + 5), orientation };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    o += 2 + length;
  }
  return null;
}

/**
 * Pixel size of a PNG, GIF, JPEG or WebP from its leading bytes, or null
 * when the bytes are not enough or not an image this parser knows.
 * `type` names the format; JPEG reports its EXIF orientation, a WebP with
 * an EXIF block reports `hasExif` (its orientation lives later in the file).
 */
export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.length >= 24) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('latin1', 0, 4) === 'GIF8') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const size = webpSize(buf);
    return size ? { type: 'webp', ...size } : null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const size = jpegSize(buf);
    return size ? { type: 'jpeg', ...size } : null;
  }
  return null;
}

/** [width, height] as displayed: EXIF orientations 5 to 8 swap the axes. */
export function displaySize({ width, height, orientation = 1 }) {
  return orientation >= 5 ? [height, width] : [width, height];
}

/** Every CDN image URL in a Markdown or HTML string, in order, deduplicated. */
export function contentImageUrls(text) {
  return [...new Set(text.match(CDN_IMAGE_RE) ?? [])];
}

// ---------------------------------------------------------------- the map

/** Problems with a dimensions map object (empty when valid). */
export function mapProblems(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return ['not an object'];
  const problems = [];
  for (const [url, size] of Object.entries(map)) {
    if (!url.startsWith(`${CDN_ORIGIN}/`)) problems.push(`${url}: not a ${CDN_ORIGIN} URL`);
    if (
      !Array.isArray(size) ||
      size.length !== 2 ||
      !size.every((n) => Number.isInteger(n) && n > 0 && n <= 65535)
    ) {
      problems.push(`${url}: size is not [width, height] in whole pixels`);
    }
  }
  return problems;
}

/** The map at `path`, or {} when the file does not exist. A file that exists
 *  but is malformed throws: an unreadable map is a bug to fix, not a miss. */
export function loadDimensions(path = DIMENSIONS_JSON) {
  if (!existsSync(path)) return {};
  const map = JSON.parse(readFileSync(path, 'utf8'));
  const problems = mapProblems(map);
  if (problems.length) {
    throw new Error(`${path}: ${problems.slice(0, 5).join('; ')}`);
  }
  return map;
}

/** Stable text form: sorted keys, one `"url": [w, h]` entry per line. */
export function formatDimensions(map) {
  const lines = Object.keys(map)
    .sort()
    .map((url) => `  ${JSON.stringify(url)}: [${map[url][0]}, ${map[url][1]}]`);
  return lines.length ? `{\n${lines.join(',\n')}\n}\n` : '{}\n';
}

/**
 * Append entries to the map file (merge on save, temp file plus rename).
 * Existing entries are kept unless `entries` gives the same URL a new size,
 * which only happens when the CDN object itself was replaced.
 */
export function saveDimensions(entries, path = DIMENSIONS_JSON) {
  const merged = { ...loadDimensions(path), ...entries };
  const problems = mapProblems(merged);
  if (problems.length) throw new Error(`refusing to save ${path}: ${problems[0]}`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, formatDimensions(merged));
  renameSync(tmp, path);
  return merged;
}

/** CDN image URLs referenced from the content directories. */
export function referencedImageUrls(dirs = CONTENT_DIRS) {
  const urls = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!/\.(?:md|mdx)$/.test(name)) continue;
      for (const url of contentImageUrls(readFileSync(join(dir, name), 'utf8'))) urls.add(url);
    }
  }
  return [...urls].sort();
}

// ---------------------------------------------------------------- probing

async function rangeGet(url, start, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Range: `bytes=${start}-${start + PROBE_BYTES - 1}` },
  });
  if (res.status === 416) return Buffer.alloc(0);
  if (res.status !== 206 && res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A server that ignores Range answers 200 with the whole file.
  return res.status === 200 && start > 0 ? buf.subarray(start) : buf;
}

/** Orientation of a WebP whose VP8X header flags an EXIF chunk. The chunk
 *  usually comes after the image data, so walk the RIFF chunk headers and
 *  fetch further ranges only when the walk runs past the bytes in hand. */
async function webpOrientation(url, head, fetchImpl) {
  let buf = head;
  let base = 0;
  let offset = 12;
  for (let reads = 0; reads <= 6; ) {
    let rel = offset - base;
    if (rel + 8 > buf.length) {
      if (reads === 6) break;
      buf = await rangeGet(url, offset, fetchImpl);
      base = offset;
      reads += 1;
      rel = 0;
      if (buf.length < 8) break;
    }
    const type = buf.toString('latin1', rel, rel + 4);
    const size = buf.readUInt32LE(rel + 4);
    if (type === 'EXIF') {
      if (rel > 0 && rel + 8 + size > buf.length) {
        // Re-read from the chunk start; IFD0 (and its orientation) is at the front.
        buf = await rangeGet(url, offset, fetchImpl);
        rel = 0;
      }
      let tiff = buf.subarray(rel + 8, rel + 8 + size);
      if (tiff.toString('latin1', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
      return exifOrientation(tiff);
    }
    offset += 8 + size + (size % 2);
  }
  return 1;
}

/** Displayed [width, height] of one CDN image, read with ranged GETs. */
export async function probeDimensions(url, fetchImpl = fetch) {
  const head = await rangeGet(url, 0, fetchImpl);
  const size = imageSize(head);
  if (!size) throw new Error(`${url}: not a PNG, GIF, JPEG or WebP header in the first 64 KB`);
  if (size.type === 'webp' && size.hasExif) {
    size.orientation = await webpOrientation(url, head, fetchImpl);
  }
  return displaySize(size);
}

function parseArgs(argv) {
  const opts = { dryRun: false, check: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--check') opts.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), log = console.log, fetchImpl = fetch) {
  const opts = parseArgs(argv);
  const map = loadDimensions();
  const referenced = referencedImageUrls();
  const missing = referenced.filter((url) => !map[url]);
  log(`${referenced.length} CDN images referenced, ${missing.length} missing from the map`);
  if (opts.check) {
    for (const url of missing) log(`  missing: ${url}`);
    return missing.length ? 1 : 0;
  }
  if (missing.length === 0) return 0;

  const found = {};
  const failures = [];
  const queue = [...missing];
  async function worker() {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        found[url] = await probeDimensions(url, fetchImpl);
      } catch (err) {
        failures.push(url);
        log(`  FAILED ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  log(
    `probed ${Object.keys(found).length}, failed ${failures.length}${opts.dryRun ? ' (dry run)' : ''}`
  );
  if (!opts.dryRun && Object.keys(found).length) {
    saveDimensions(found);
    log(`updated ${DIMENSIONS_JSON}`);
  }
  return failures.length ? 1 : 0;
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
