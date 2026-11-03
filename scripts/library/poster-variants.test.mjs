import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { encodeVariant } from './car-variants.mjs';
import {
  LIBRARY_PREFIX,
  POSTER_VARIANTS_JSON,
  VARIANT_WIDTHS,
  appendOnly,
  entryProblems,
  formatVariants,
  keepsOriginal,
  loadVariants,
  pickCandidate,
  posterSources,
  variantKey,
  widthsFor,
} from './poster-variants.mjs';

const DATA = join(import.meta.dirname, '..', '..', 'src', 'data', 'library');
const read = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const BOOK = 'https://cdn.theneverless.com/library/books/26184242.977b643ff75a.webp';
const MOVIE = 'https://cdn.theneverless.com/library/movies/36613832.359a04b5.jpg';

function bookEntry() {
  const stem = BOOK.replace(/\.webp$/, '');
  return {
    sourceWidth: 1160,
    sourceHeight: 1800,
    images: [
      { width: 240, height: 372, bytes: 9000, url: `${stem}-240w-aaaaaaaaaaaa.webp` },
      { width: 360, height: 559, bytes: 17000, url: `${stem}-360w-bbbbbbbbbbbb.webp` },
      { width: 480, height: 745, bytes: 26000, url: `${stem}-480w-cccccccccccc.webp` },
    ],
  };
}

function movieEntry() {
  const stem = MOVIE.replace(/\.jpg$/, '');
  return {
    sourceWidth: 400,
    sourceHeight: 600,
    images: [
      { width: 240, height: 360, bytes: 9000, url: `${stem}-240w-aaaaaaaaaaaa.webp` },
      { width: 360, height: 540, bytes: 17000, url: `${stem}-360w-bbbbbbbbbbbb.webp` },
      { width: 400, height: 600, bytes: 40000, url: MOVIE },
    ],
  };
}

test('the committed poster map is valid for every entry it holds', () => {
  const map = loadVariants(POSTER_VARIANTS_JSON);
  const problems = Object.entries(map).flatMap(([url, entry]) =>
    entryProblems(url, entry).map((p) => `${url}: ${p}`)
  );
  assert.deepEqual(problems, []);
  for (const url of Object.keys(map)) assert.ok(url.startsWith(LIBRARY_PREFIX), url);
});

test('posterSources lists every shelf poster the page renders, local films first', () => {
  const shelves = {
    movies: read('movies.json'),
    moviesLocal: read('movies-local.json'),
    books: read('books.json'),
    games: read('games.json'),
  };
  const sources = posterSources(shelves);
  const count = (shelf) => sources.filter((s) => s.shelf === shelf).length;
  const localIds = new Set(shelves.moviesLocal.map((m) => m.id));
  const movieRows = [
    ...shelves.moviesLocal,
    ...shelves.movies.filter((m) => !localIds.has(m.id)),
  ].filter((m) => !m.nc && m.cv);
  assert.equal(count('movies'), movieRows.length);
  assert.equal(count('books'), shelves.books.filter((b) => b.image).length);
  assert.equal(count('games'), shelves.games.filter((g) => !g.nc && g.cv).length);
  assert.equal(sources[0].id, shelves.moviesLocal[0].id);
  assert.equal(sources[0].url, `${LIBRARY_PREFIX}movies/${shelves.moviesLocal[0].cv}`);
});

test('widthsFor skips widths the source cannot fill; small sources keep the original', () => {
  assert.deepEqual(widthsFor(1160), VARIANT_WIDTHS);
  assert.deepEqual(widthsFor(400), [240, 360]);
  assert.deepEqual(widthsFor(480), [240, 360]);
  assert.deepEqual(widthsFor(200), []);
  assert.equal(keepsOriginal(1160), false);
  assert.equal(keepsOriginal(400), true);
  assert.equal(keepsOriginal(480), true);
});

test('variantKey sits next to the original and hashes the variant bytes', () => {
  const a = variantKey(BOOK, 240, Buffer.from('one'));
  assert.match(a, /^library\/books\/26184242\.977b643ff75a-240w-[0-9a-f]{12}\.webp$/);
  assert.notEqual(a, variantKey(BOOK, 240, Buffer.from('two')));
  assert.equal(a, variantKey(BOOK, 240, Buffer.from('one')));
  assert.match(
    variantKey(MOVIE, 360, Buffer.from('x')),
    /^library\/movies\/36613832\.359a04b5-360w-/
  );
  assert.throws(() => variantKey('https://img.example.com/cover.jpg', 240, Buffer.from('x')));
});

test('entryProblems accepts complete entries for large and small sources', () => {
  assert.deepEqual(entryProblems(BOOK, bookEntry()), []);
  assert.deepEqual(entryProblems(MOVIE, movieEntry()), []);
});

test('entryProblems flags missing, incomplete and malformed entries', () => {
  assert.deepEqual(entryProblems(BOOK, undefined), ['no entry']);

  const short = bookEntry();
  short.images.pop();
  assert.match(entryProblems(BOOK, short).join(), /widths/);

  const noOriginal = movieEntry();
  noOriginal.images.pop();
  assert.match(entryProblems(MOVIE, noOriginal).join(), /widths/);

  const wrongHost = bookEntry();
  wrongHost.images[0].url = 'https://example.com/x-240w-aaaaaaaaaaaa.webp';
  assert.match(entryProblems(BOOK, wrongHost).join(), /content-hashed/);

  const otherSource = bookEntry();
  assert.match(
    entryProblems(BOOK.replace('977b643ff75a', 'ffffffffffff'), otherSource).join(),
    /content-hashed/
  );

  const squashed = bookEntry();
  squashed.images[2].height = 720;
  assert.match(entryProblems(BOOK, squashed).join(), /source frame/);

  const noBytes = bookEntry();
  delete noBytes.images[1].bytes;
  assert.match(entryProblems(BOOK, noBytes).join(), /byte size/);
});

test('appendOnly never replaces an existing entry', () => {
  const current = { [BOOK]: bookEntry() };
  const additions = { [BOOK]: { replaced: true }, [MOVIE]: movieEntry() };
  assert.deepEqual(Object.keys(appendOnly(current, additions)), [MOVIE]);
  assert.deepEqual(appendOnly(current, { [BOOK]: bookEntry() }), {});
});

test('formatVariants writes sorted single-line entries that parse back', () => {
  const map = { [MOVIE]: movieEntry(), [BOOK]: bookEntry() };
  const text = formatVariants(map);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith(`  "${BOOK}"`));
  assert.deepEqual(JSON.parse(text), map);
  assert.equal(formatVariants({}), '{}\n');
});

test('pickCandidate takes the smallest sufficient width', () => {
  const images = bookEntry().images;
  assert.equal(pickCandidate(images, 111, 1).width, 240);
  assert.equal(pickCandidate(images, 111, 3).width, 360);
  assert.equal(pickCandidate(images, 159, 2).width, 360);
  assert.equal(pickCandidate(images, 182, 2).width, 480);
  assert.equal(pickCandidate(images, 200, 3).width, 480);
});

test('poster variants keep the 2:3 frame at every width', async () => {
  const source = await sharp({
    create: { width: 400, height: 600, channels: 3, background: '#405060' },
  })
    .jpeg()
    .toBuffer();
  for (const width of widthsFor(400)) {
    const out = await encodeVariant(source, width, { opaque: true });
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, width);
    assert.equal(meta.height, Math.round((width * 600) / 400));
  }
});
