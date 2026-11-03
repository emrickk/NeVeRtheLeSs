import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { describeImage, imageKey, imageType, main, parseArgs } from './car-image.mjs';

const SHA = '3111fa4de9f3896d788477abc64347f8e6cd8296fce1184d93be4e67a6f94e29';

async function tempImage(name, format = 'png') {
  const dir = mkdtempSync(join(tmpdir(), 'car-image-test-'));
  const file = join(dir, name);
  const buffer = await sharp({
    create: { width: 30, height: 20, channels: 3, background: '#d0d4d8' },
  })
    .toFormat(format)
    .toBuffer();
  writeFileSync(file, buffer);
  return { dir, file, buffer };
}

test('imageKey matches the existing displayImage naming', () => {
  // Existing record: mgt01051-ai-redraw-3111fa4de9f3.png for car id MGT01051.
  assert.equal(
    imageKey('MGT01051', 'ai-redraw', SHA, 'png'),
    'library/model-cars/mgt01051-ai-redraw-3111fa4de9f3.png'
  );
  assert.equal(
    imageKey('huayra-bc-event', null, SHA, 'webp'),
    'library/model-cars/huayra-bc-event-3111fa4de9f3.webp'
  );
});

test('imageKey rejects unsafe ids, labels and hashes', () => {
  for (const id of ['', '../etc', 'a/b', 'a b', '-lead', 'trail-', 'a--b', 'a_b']) {
    assert.throws(() => imageKey(id, null, SHA, 'png'), /Invalid --id/, id);
  }
  for (const label of ['AI-redraw', 'ai_redraw', 'ai/redraw', '', '-x']) {
    assert.throws(() => imageKey('MGT01051', label, SHA, 'png'), /Invalid --label/, label);
  }
  assert.throws(() => imageKey('MGT01051', null, 'abc', 'png'), /sha256/);
});

test('imageType accepts png, jpg/jpeg and webp, and rejects anything else', () => {
  assert.deepEqual(imageType('/x/a.PNG'), { ext: 'png', contentType: 'image/png', format: 'png' });
  assert.equal(imageType('/x/a.jpeg').ext, 'jpg');
  assert.equal(imageType('/x/a.jpg').contentType, 'image/jpeg');
  assert.equal(imageType('/x/a.webp').contentType, 'image/webp');
  for (const file of ['/x/a.gif', '/x/a.avif', '/x/a.tiff', '/x/a.svg', '/x/a']) {
    assert.throws(() => imageType(file), /Unsupported file type/, file);
  }
});

test('parseArgs requires --id and an absolute --file and validates values', () => {
  const ok = parseArgs([
    '--id',
    'MGT01051',
    '--file',
    '/x/a.png',
    '--label',
    'ai-redraw',
    '--dry-run',
  ]);
  assert.deepEqual(ok, {
    id: 'MGT01051',
    file: '/x/a.png',
    label: 'ai-redraw',
    dryRun: true,
    receipt: null,
  });
  assert.throws(() => parseArgs(['--file', '/x/a.png']), /--id is required/);
  assert.throws(() => parseArgs(['--id', 'MGT01051']), /--file is required/);
  assert.throws(() => parseArgs(['--id', 'MGT01051', '--file', 'a.png']), /absolute path/);
  assert.throws(() => parseArgs(['--id', '--file', '/x/a.png']), /--id needs a value/);
  assert.throws(() => parseArgs(['--id', 'MGT01051', '--file', '/x/a.gif']), /Unsupported/);
  assert.throws(() => parseArgs(['--id', 'a/b', '--file', '/x/a.png']), /Invalid --id/);
  assert.throws(
    () => parseArgs(['--id', 'MGT01051', '--file', '/x/a.png', '--label', 'Bad']),
    /Invalid --label/
  );
  assert.throws(
    () => parseArgs(['--id', 'MGT01051', '--file', '/x/a.png', '--receipt', 'r.json']),
    /absolute path/
  );
  assert.throws(
    () => parseArgs(['--id', 'MGT01051', '--file', '/x/a.png', '--force']),
    /Unknown argument/
  );
});

test('describeImage refuses contents that do not match the extension', async () => {
  const { dir, file } = await tempImage('fake.webp', 'png');
  try {
    await assert.rejects(describeImage(file), /contents are png, not webp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run computes the result without credentials or network', async () => {
  const { dir, file, buffer } = await tempImage('MGT01051.jpeg', 'jpeg');
  const receipt = join(dir, 'receipt.json');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const realFetch = globalThis.fetch;
  const envBefore = Object.keys(process.env).filter((k) => k.startsWith('R2_'));
  globalThis.fetch = () => {
    throw new Error('dry run must not use the network');
  };
  const printed = [];
  try {
    const code = await main(
      [
        '--id',
        'MGT01051',
        '--file',
        file,
        '--label',
        'ai-redraw',
        '--dry-run',
        '--receipt',
        receipt,
      ],
      { log: () => {}, out: (s) => printed.push(s) }
    );
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  try {
    assert.deepEqual(
      Object.keys(process.env).filter((k) => k.startsWith('R2_')),
      envBefore,
      'dry run must not load .env.local'
    );
    assert.equal(printed.length, 1);
    const result = JSON.parse(printed[0]);
    const key = `library/model-cars/mgt01051-ai-redraw-${sha256.slice(0, 12)}.jpg`;
    assert.deepEqual(result, {
      id: 'MGT01051',
      displayImage: `https://cdn.theneverless.com/${key}`,
      key,
      sha256,
      bytes: buffer.length,
      width: 30,
      height: 20,
      contentType: 'image/jpeg',
      uploaded: null,
      verifiedAt: null,
      dryRun: true,
    });
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
