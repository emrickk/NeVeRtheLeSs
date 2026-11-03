#!/usr/bin/env node
/**
 * car-image.mjs: upload one finished model-car display image to R2 and
 * verify it on the CDN.
 *
 * The key is content-hashed and sits with the other car images:
 *   library/model-cars/<id>[-<label>]-<first 12 hex of sha256>.<ext>
 * e.g. library/model-cars/mgt01051-ai-redraw-3111fa4de9f3.png
 *
 * Usage:
 *   npm run library:car-image -- --id <car-id> --file <absolute path> [--label ai-redraw]
 *   npm run library:car-image -- ... --dry-run          # compute only, no credentials, no network
 *   npm run library:car-image -- ... --receipt <path>   # also write the JSON result to a file
 *
 * Prints one JSON result on stdout (progress goes to stderr).
 * Credentials come from the environment or .env.local (see .env.example).
 *
 * Safety: never overwrites. An existing key is reused (same name means same
 * bytes) and the upload is conditional (If-None-Match: *). After the upload
 * the CDN copy is downloaded and its SHA-256 must match the local file.
 * This script does not edit model-cars.json or any other record; data
 * records are updated separately.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { loadConfig, loadEnvFile } from '../images/config.mjs';
import { makeClient, objectExists } from '../images/r2.mjs';
import { CAR_IMAGE_PREFIX } from './car-variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const KEY_PREFIX = 'library/model-cars/';
const HASH_LENGTH = 12;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Accepted file extensions: key extension, content type, and sharp format. */
export const IMAGE_TYPES = {
  '.png': { ext: 'png', contentType: 'image/png', format: 'png' },
  '.jpg': { ext: 'jpg', contentType: 'image/jpeg', format: 'jpeg' },
  '.jpeg': { ext: 'jpg', contentType: 'image/jpeg', format: 'jpeg' },
  '.webp': { ext: 'webp', contentType: 'image/webp', format: 'webp' },
};

const ID_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------- pure helpers

/** The type entry for a file path, or an error for anything but png, jpg/jpeg, webp. */
export function imageType(file) {
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) {
    throw new Error(
      `Unsupported file type ${extname(file) || '(none)'}: use png, jpg, jpeg or webp`
    );
  }
  return type;
}

/** R2 key for one display image. The car id is lowercased, as in the
 *  existing keys (MGT01051 becomes mgt01051). */
export function imageKey(id, label, sha256, ext) {
  if (!ID_PATTERN.test(id || '')) throw new Error(`Invalid --id ${JSON.stringify(id)}`);
  if (label != null && !LABEL_PATTERN.test(label)) {
    throw new Error(
      `Invalid --label ${JSON.stringify(label)}: use lowercase letters, digits, hyphens`
    );
  }
  if (!/^[0-9a-f]{64}$/.test(sha256 || '')) throw new Error('sha256 must be 64 hex digits');
  const name = [id.toLowerCase(), label, sha256.slice(0, HASH_LENGTH)].filter(Boolean).join('-');
  return `${KEY_PREFIX}${name}.${ext}`;
}

export function parseArgs(argv) {
  const opts = { id: null, file: null, label: null, dryRun: false, receipt: null };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--id') opts.id = value(++i, arg);
    else if (arg === '--file') opts.file = value(++i, arg);
    else if (arg === '--label') opts.label = value(++i, arg);
    else if (arg === '--receipt') opts.receipt = value(++i, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.id) throw new Error('--id is required');
  if (!opts.file) throw new Error('--file is required');
  if (!isAbsolute(opts.file)) throw new Error(`--file must be an absolute path: ${opts.file}`);
  if (opts.receipt && !isAbsolute(opts.receipt)) {
    throw new Error(`--receipt must be an absolute path: ${opts.receipt}`);
  }
  // Validate id and label before any file is read.
  imageKey(opts.id, opts.label, '0'.repeat(64), 'png');
  imageType(opts.file);
  return opts;
}

/** Everything about the local file that the result needs. */
export async function describeImage(file) {
  const type = imageType(file);
  const buffer = readFileSync(file);
  const meta = await sharp(buffer, { failOn: 'error' }).metadata();
  if (meta.format !== type.format) {
    throw new Error(
      `${file}: contents are ${meta.format}, not ${type.format} as the extension says`
    );
  }
  return {
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    width: meta.width,
    height: meta.height,
    ext: type.ext,
    contentType: type.contentType,
  };
}

// ---------------------------------------------------------------- I/O

/** Upload only when the key is absent. Returns true when this run wrote it. */
async function uploadIfAbsent(client, bucket, key, image) {
  if (await objectExists(client, bucket, key)) return false;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: image.buffer,
        ContentType: image.contentType,
        CacheControl: CACHE_CONTROL,
        IfNoneMatch: '*',
      })
    );
  } catch (err) {
    // 412: someone created the key between the check and the put. Keep theirs.
    if (err?.$metadata?.httpStatusCode !== 412) throw err;
    return false;
  }
  return true;
}

async function verifyOnR2(client, bucket, key, image) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentType !== image.contentType || head.ContentLength !== image.bytes) {
    throw new Error(
      `R2 HEAD ${key}: type ${head.ContentType}, length ${head.ContentLength} (expected ${image.contentType}, ${image.bytes})`
    );
  }
}

async function verifyOnCdn(url, image) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`CDN GET ${url}: HTTP ${res.status}`);
  const type = res.headers.get('content-type');
  if (type !== image.contentType) {
    throw new Error(`CDN GET ${url}: content-type ${type} (expected ${image.contentType})`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== image.sha256) {
    throw new Error(
      `CDN GET ${url}: sha256 ${sha256} (${body.length} B) does not match the local file ${image.sha256} (${image.bytes} B)`
    );
  }
}

export async function main(
  argv = process.argv.slice(2),
  { log = console.error, out = console.log } = {}
) {
  const opts = parseArgs(argv);
  const image = await describeImage(opts.file);
  const key = imageKey(opts.id, opts.label, image.sha256, image.ext);
  const displayImage = `${CAR_IMAGE_PREFIX}${key.slice(KEY_PREFIX.length)}`;
  const result = {
    id: opts.id,
    displayImage,
    key,
    sha256: image.sha256,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    contentType: image.contentType,
    uploaded: null,
    verifiedAt: null,
  };

  if (opts.dryRun) {
    result.dryRun = true;
    log(`dry run: would upload ${opts.file} to ${key}`);
  } else {
    loadEnvFile(join(REPO, '.env.local'));
    const config = loadConfig();
    if (`${config.publicBase}/${KEY_PREFIX}` !== CAR_IMAGE_PREFIX) {
      throw new Error(`R2_PUBLIC_BASE ${config.publicBase} does not serve ${CAR_IMAGE_PREFIX}`);
    }
    const client = makeClient(config);
    try {
      result.uploaded = await uploadIfAbsent(client, config.bucket, key, image);
      await verifyOnR2(client, config.bucket, key, image);
    } finally {
      client.destroy();
    }
    log(`${result.uploaded ? 'uploaded' : 'already on R2, not overwritten'}: ${key}`);
    await verifyOnCdn(displayImage, image);
    result.verifiedAt = new Date().toISOString();
    log(`CDN bytes verified: ${displayImage}`);
  }

  const json = JSON.stringify(result, null, 2);
  out(json);
  if (opts.receipt) writeFileSync(opts.receipt, `${json}\n`);
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
