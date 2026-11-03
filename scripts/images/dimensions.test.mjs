import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  contentImageUrls,
  displaySize,
  formatDimensions,
  imageSize,
  loadDimensions,
  mapProblems,
  probeDimensions,
  saveDimensions,
} from './dimensions.mjs';

const solid = (width, height, channels = 3) =>
  sharp({
    create: { width, height, channels, background: { r: 120, g: 80, b: 40, alpha: 0.5 } },
  });

function noise(width, height) {
  const data = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed >> 23;
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/** A fetch stand-in that serves byte ranges of one buffer and counts calls. */
function rangeServer(buffer) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const range = init.headers?.Range;
    calls.push(range);
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(a);
    if (start >= buffer.length) return new Response(null, { status: 416 });
    return new Response(buffer.subarray(start, Math.min(buffer.length, Number(b) + 1)), {
      status: 206,
    });
  };
  return { fetchImpl, calls };
}

test('imageSize reads PNG, GIF and JPEG headers', async () => {
  const png = await solid(321, 123).png().toBuffer();
  const gif = await solid(40, 30).gif().toBuffer();
  const jpeg = await solid(640, 480).jpeg().toBuffer();
  assert.deepEqual(imageSize(png), { type: 'png', width: 321, height: 123 });
  assert.deepEqual(imageSize(gif), { type: 'gif', width: 40, height: 30 });
  assert.deepEqual(imageSize(jpeg), { type: 'jpeg', width: 640, height: 480, orientation: 1 });
});

test('imageSize reads lossy, lossless and extended WebP headers', async () => {
  const lossy = await solid(1999, 1333).webp().toBuffer();
  const lossless = await solid(301, 17).webp({ lossless: true }).toBuffer();
  const extended = await solid(800, 533, 4).webp().toBuffer();
  assert.equal(lossy.toString('latin1', 12, 16), 'VP8 ');
  assert.equal(lossless.toString('latin1', 12, 16), 'VP8L');
  assert.equal(extended.toString('latin1', 12, 16), 'VP8X');
  assert.deepEqual(imageSize(lossy), { type: 'webp', width: 1999, height: 1333 });
  assert.deepEqual(imageSize(lossless), { type: 'webp', width: 301, height: 17 });
  assert.deepEqual(imageSize(extended), {
    type: 'webp',
    width: 800,
    height: 533,
    hasExif: false,
  });
});

test('imageSize returns null for unknown or truncated data', () => {
  assert.equal(imageSize(Buffer.from('not an image at all')), null);
  assert.equal(imageSize(Buffer.alloc(4)), null);
  assert.equal(imageSize('RIFF'), null);
});

test('displaySize swaps the axes for rotated EXIF orientations', () => {
  assert.deepEqual(displaySize({ width: 4, height: 3 }), [4, 3]);
  assert.deepEqual(displaySize({ width: 4, height: 3, orientation: 3 }), [4, 3]);
  assert.deepEqual(displaySize({ width: 4, height: 3, orientation: 6 }), [3, 4]);
});

test('probeDimensions reads a JPEG orientation from its EXIF header', async () => {
  const jpeg = await solid(600, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const { fetchImpl, calls } = rangeServer(jpeg);
  assert.deepEqual(
    await probeDimensions('https://cdn.theneverless.com/x.jpg', fetchImpl),
    [400, 600]
  );
  assert.equal(calls.length, 1);
});

test('probeDimensions follows a WebP to its trailing EXIF chunk with ranged reads', async () => {
  const webp = await noise(1400, 1000)
    .webp({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  assert.ok(webp.length > 65536, 'the fixture must be larger than one probe');
  const { fetchImpl, calls } = rangeServer(webp);
  assert.deepEqual(
    await probeDimensions('https://cdn.theneverless.com/x.webp', fetchImpl),
    [1000, 1400]
  );
  assert.ok(calls.length >= 2 && calls.length <= 4, `used ${calls.length} requests`);
  assert.ok(calls.every((range) => /^bytes=\d+-\d+$/.test(range)));

  const upright = await noise(1400, 1000).webp({ quality: 95 }).withMetadata().toBuffer();
  assert.deepEqual(
    await probeDimensions('https://cdn.theneverless.com/y.webp', rangeServer(upright).fetchImpl),
    [1400, 1000]
  );
});

test('probeDimensions works when the server ignores Range', async () => {
  const webp = await solid(500, 250).webp().toBuffer();
  const fetchImpl = async () => new Response(webp, { status: 200 });
  assert.deepEqual(
    await probeDimensions('https://cdn.theneverless.com/z.webp', fetchImpl),
    [500, 250]
  );
});

test('probeDimensions reports HTTP errors and non-images', async () => {
  const notFound = async () => new Response('nope', { status: 404 });
  await assert.rejects(probeDimensions('https://cdn.theneverless.com/a.webp', notFound), /404/);
  const html = async () => new Response('<!doctype html><title>x</title>', { status: 200 });
  await assert.rejects(probeDimensions('https://cdn.theneverless.com/a.webp', html), /header/);
});

test('contentImageUrls finds CDN images in Markdown, HTML and plain links', () => {
  const text = [
    '![a](https://cdn.theneverless.com/2026/07/a.webp)',
    '<img src="https://cdn.theneverless.com/2026/07/b.webp" alt="b">',
    "<img src='https://cdn.theneverless.com/2026/07/c.jpg'>",
    '[link](https://cdn.theneverless.com/2026/07/a.webp "title")',
    'https://example.com/d.webp and https://cdn.theneverless.com/doc.pdf',
  ].join('\n');
  assert.deepEqual(contentImageUrls(text), [
    'https://cdn.theneverless.com/2026/07/a.webp',
    'https://cdn.theneverless.com/2026/07/b.webp',
    'https://cdn.theneverless.com/2026/07/c.jpg',
  ]);
});

test('mapProblems accepts a valid map and flags bad entries', () => {
  assert.deepEqual(mapProblems({ 'https://cdn.theneverless.com/a.webp': [10, 20] }), []);
  assert.deepEqual(mapProblems([]), ['not an object']);
  assert.match(mapProblems({ 'https://example.com/a.webp': [1, 1] })[0], /not a/);
  assert.match(mapProblems({ 'https://cdn.theneverless.com/a.webp': [0, 1] })[0], /whole pixels/);
  assert.match(mapProblems({ 'https://cdn.theneverless.com/a.webp': [1.5, 1] })[0], /whole/);
});

test('saveDimensions merges, sorts and writes one entry per line', () => {
  const work = mkdtempSync(join(tmpdir(), 'dims-'));
  try {
    const path = join(work, 'map.json');
    assert.deepEqual(loadDimensions(path), {});
    saveDimensions({ 'https://cdn.theneverless.com/b.webp': [3, 4] }, path);
    saveDimensions({ 'https://cdn.theneverless.com/a.webp': [1, 2] }, path);
    assert.equal(
      readFileSync(path, 'utf8'),
      '{\n  "https://cdn.theneverless.com/a.webp": [1, 2],\n  "https://cdn.theneverless.com/b.webp": [3, 4]\n}\n'
    );
    assert.deepEqual(loadDimensions(path), {
      'https://cdn.theneverless.com/a.webp': [1, 2],
      'https://cdn.theneverless.com/b.webp': [3, 4],
    });
    assert.throws(() => saveDimensions({ 'https://cdn.theneverless.com/c.webp': [0, 0] }, path));
    writeFileSync(path, '{ broken');
    assert.throws(() => loadDimensions(path));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('formatDimensions output is valid JSON', () => {
  const map = { 'https://cdn.theneverless.com/a.webp': [1, 2] };
  assert.deepEqual(JSON.parse(formatDimensions(map)), map);
  assert.equal(formatDimensions({}), '{}\n');
});
