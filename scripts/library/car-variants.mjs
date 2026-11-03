#!/usr/bin/env node
/**
 * car-variants.mjs: responsive WebP variants for the model-car gallery.
 *
 * Each car's displayImage stays the archive/full-size copy. This script
 * downloads it from the CDN, encodes 480 px and 800 px wide WebP variants
 * (same frame, no crop, no sharpening), uploads them to R2 next to the
 * originals under content-hashed keys, and records them per car in
 * src/data/library/model-cars.json as `displayImageVariants`.
 *
 * Usage:
 *   npm run library:car-variants -- --dry-run            # encode only, no R2, no JSON write
 *   npm run library:car-variants -- --dry-run --out-dir <dir>  # also save encodes locally
 *   npm run library:car-variants                         # upload missing variants, update JSON
 *   npm run library:car-variants -- --only <id>[,<id>]   # limit to some cars
 *   npm run library:car-variants -- --verify             # HEAD every recorded variant on the CDN
 *
 * Credentials come from the environment or .env.local (see .env.example).
 *
 * Safety: idempotent and append-only. Cars whose recorded variants already
 * derive from their current displayImage are skipped. An existing R2 object
 * is never overwritten: the key is checked first (scripts/images/r2.mjs) and
 * the upload is conditional (If-None-Match: *). Every uploaded or reused
 * object is verified by HEAD (content type and size) on R2 and on the CDN.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { loadConfig, loadEnvFile } from '../images/config.mjs'
import { makeClient, objectExists } from '../images/r2.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
export const CARS_JSON = join(REPO, 'src', 'data', 'library', 'model-cars.json')

export const VARIANT_WIDTHS = [480, 800]
export const WEBP_QUALITY = 84
export const CAR_IMAGE_PREFIX = 'https://cdn.theneverless.com/library/model-cars/'
const KEY_PREFIX = 'library/model-cars/'
const CONTENT_TYPE = 'image/webp'
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const CONCURRENCY = 4

// ---------------------------------------------------------------- pure helpers

/** R2 key for one variant: the original's basename, the width, and the
 *  first 12 hex digits of the variant's own SHA-256, e.g.
 *  library/model-cars/mgt01207-ai-redraw-a62a0dad9169-480w-0123456789ab.webp */
export function variantKey(displayImage, width, buffer) {
  const name = new URL(displayImage).pathname.split('/').pop()
  const base = name.replace(/\.[a-z0-9]+$/i, '')
  if (!base) throw new Error(`Cannot derive a key from ${displayImage}`)
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12)
  return `${KEY_PREFIX}${base}-${width}w-${hash}.webp`
}

/** Problems with one car's recorded variants (empty when complete). */
export function variantProblems(car) {
  if (!car.displayImage) return []
  const v = car.displayImageVariants
  if (!v) return ['no displayImageVariants']
  const problems = []
  if (v.source !== car.displayImage) problems.push('variants were made from a different displayImage')
  if (!(v.sourceWidth > 0 && v.sourceHeight > 0)) problems.push('missing source dimensions')
  const images = Array.isArray(v.images) ? v.images : []
  const widths = images.map((img) => img.width)
  if (JSON.stringify(widths) !== JSON.stringify(VARIANT_WIDTHS)) {
    problems.push(`widths ${JSON.stringify(widths)} instead of ${JSON.stringify(VARIANT_WIDTHS)}`)
  }
  for (const img of images) {
    const expectedHeight = Math.round((img.width * v.sourceHeight) / v.sourceWidth)
    if (Math.abs(img.height - expectedHeight) > 1) {
      problems.push(`${img.width}w height ${img.height} does not keep the source frame`)
    }
    if (
      typeof img.url !== 'string' ||
      !img.url.startsWith(CAR_IMAGE_PREFIX) ||
      !new RegExp(`-${img.width}w-[0-9a-f]{12}\\.webp$`).test(img.url)
    ) {
      problems.push(`${img.width}w url is not a content-hashed CDN WebP key`)
    }
    if (!(Number.isInteger(img.bytes) && img.bytes > 0)) problems.push(`${img.width}w has no byte size`)
  }
  return problems
}

/** Every car whose variants are missing or stale, with the reasons. */
export function carsMissingVariants(cars) {
  return cars
    .map((car) => ({ id: car.id, problems: variantProblems(car) }))
    .filter((entry) => entry.problems.length > 0)
}

/** A copy of the car with displayImageVariants placed right after
 *  displayImage. Every other key keeps its value and order. */
export function withVariants(car, variants) {
  const out = {}
  for (const [key, value] of Object.entries(car)) {
    if (key === 'displayImageVariants') continue
    out[key] = value
    if (key === 'displayImage') out.displayImageVariants = variants
  }
  if (!('displayImageVariants' in out)) out.displayImageVariants = variants
  return out
}

/** Encode one variant. Lanczos downscale only: no crop, no sharpening, sRGB
 *  output without metadata; alpha is kept only when the source uses it. */
export async function encodeVariant(source, width, { opaque }) {
  let pipeline = sharp(source, { failOn: 'error' }).resize({ width, withoutEnlargement: true })
  if (opaque) pipeline = pipeline.removeAlpha()
  const { data, info } = await pipeline
    .webp({ quality: WEBP_QUALITY, effort: 6, smartSubsample: true })
    .toBuffer({ resolveWithObject: true })
  return { buffer: data, width: info.width, height: info.height, bytes: data.length }
}

// ---------------------------------------------------------------- I/O

function parseArgs(argv) {
  const opts = { dryRun: false, verify: false, only: null, outDir: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--verify') opts.verify = true
    else if (arg === '--only') opts.only = new Set((argv[++i] || '').split(',').filter(Boolean))
    else if (arg === '--out-dir') opts.outDir = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (opts.only && opts.only.size === 0) throw new Error('--only needs a comma-separated list of ids')
  if (opts.outDir === undefined) throw new Error('--out-dir needs a directory')
  return opts
}

export async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
  const type = res.headers.get('content-type') || ''
  if (!type.startsWith('image/')) throw new Error(`GET ${url}: unexpected content-type ${type}`)
  return Buffer.from(await res.arrayBuffer())
}

async function headCdn(url) {
  const res = await fetch(url, { method: 'HEAD' })
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    length: Number(res.headers.get('content-length')),
  }
}

export async function verifyOnCdn(url, bytes) {
  const head = await headCdn(url)
  if (head.status !== 200 || head.type !== CONTENT_TYPE || head.length !== bytes) {
    throw new Error(
      `CDN HEAD ${url}: status ${head.status}, type ${head.type}, length ${head.length} (expected 200, ${CONTENT_TYPE}, ${bytes})`
    )
  }
}

export async function verifyOnR2(client, bucket, key, bytes) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  if (head.ContentType !== CONTENT_TYPE || head.ContentLength !== bytes) {
    throw new Error(
      `R2 HEAD ${key}: type ${head.ContentType}, length ${head.ContentLength} (expected ${CONTENT_TYPE}, ${bytes})`
    )
  }
}

/** Upload only when the key is absent; an existing key must already hold
 *  an object of the same type and size (same content hash in its name). */
export async function uploadIfAbsent(client, bucket, key, buffer) {
  if (await objectExists(client, bucket, key)) {
    await verifyOnR2(client, bucket, key, buffer.length)
    return 'reused'
  }
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: CONTENT_TYPE,
        CacheControl: CACHE_CONTROL,
        IfNoneMatch: '*',
      })
    )
  } catch (err) {
    // 412: someone created the key between the check and the put. Keep theirs.
    if (err?.$metadata?.httpStatusCode !== 412) throw err
  }
  await verifyOnR2(client, bucket, key, buffer.length)
  return 'uploaded'
}

async function processCar(car, ctx) {
  const source = await download(car.displayImage)
  const meta = await sharp(source).metadata()
  const opaque = !meta.hasAlpha || (await sharp(source).stats()).isOpaque
  const images = []
  for (const width of VARIANT_WIDTHS) {
    if (width > meta.width) throw new Error(`${car.id}: source is only ${meta.width}px wide`)
    const variant = await encodeVariant(source, width, { opaque })
    const key = variantKey(car.displayImage, width, variant.buffer)
    const url = `${new URL(car.displayImage).origin}/${key}`
    if (ctx.outDir) writeFileSync(join(ctx.outDir, key.split('/').pop()), variant.buffer)
    let action = 'planned'
    if (!ctx.dryRun) {
      action = await uploadIfAbsent(ctx.client, ctx.config.bucket, key, variant.buffer)
      await verifyOnCdn(url, variant.bytes)
    }
    ctx.log(`  ${car.id} ${width}w ${variant.width}x${variant.height} ${variant.bytes} B ${action} ${key}`)
    ctx.keys.push({ key, action })
    images.push({ width: variant.width, height: variant.height, bytes: variant.bytes, url })
  }
  return {
    source: car.displayImage,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    images,
  }
}

async function verifyRecorded(cars, log) {
  let failures = 0
  for (const car of cars) {
    for (const problem of variantProblems(car)) {
      failures += 1
      log(`  ${car.id}: ${problem}`)
    }
    for (const img of car.displayImageVariants?.images || []) {
      try {
        await verifyOnCdn(img.url, img.bytes)
      } catch (err) {
        failures += 1
        log(`  ${car.id}: ${err.message}`)
      }
    }
  }
  return failures
}

function writeCars(cars) {
  const tmp = `${CARS_JSON}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cars, null, 2)}\n`)
  renameSync(tmp, CARS_JSON)
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parseArgs(argv)
  const cars = JSON.parse(readFileSync(CARS_JSON, 'utf8'))

  if (opts.verify) {
    const failures = await verifyRecorded(cars, log)
    log(failures ? `verify: ${failures} problem(s)` : `verify: all ${cars.length} cars OK on the CDN`)
    return failures ? 1 : 0
  }

  for (const car of cars) {
    if (car.displayImage && !car.displayImage.startsWith(CAR_IMAGE_PREFIX)) {
      throw new Error(`${car.id}: displayImage is not on ${CAR_IMAGE_PREFIX}`)
    }
  }
  const todo = cars.filter(
    (car) =>
      car.displayImage &&
      (!opts.only || opts.only.has(car.id)) &&
      variantProblems(car).length > 0
  )
  if (opts.only) {
    const known = new Set(cars.map((car) => car.id))
    const unknown = [...opts.only].filter((id) => !known.has(id))
    if (unknown.length) throw new Error(`Unknown car id(s): ${unknown.join(', ')}`)
  }
  log(`${todo.length} of ${cars.length} cars need variants${opts.dryRun ? ' (dry run)' : ''}`)
  if (todo.length === 0) return 0

  const ctx = { dryRun: opts.dryRun, outDir: opts.outDir, keys: [], log }
  if (ctx.outDir) mkdirSync(ctx.outDir, { recursive: true })
  if (!opts.dryRun) {
    loadEnvFile(join(REPO, '.env.local'))
    ctx.config = loadConfig()
    if (`${ctx.config.publicBase}/${KEY_PREFIX}` !== CAR_IMAGE_PREFIX) {
      throw new Error(`R2_PUBLIC_BASE ${ctx.config.publicBase} does not serve ${CAR_IMAGE_PREFIX}`)
    }
    ctx.client = makeClient(ctx.config)
  }

  const results = new Map()
  const failures = []
  const queue = [...todo]
  async function worker() {
    for (let car = queue.shift(); car; car = queue.shift()) {
      try {
        results.set(car.id, await processCar(car, ctx))
      } catch (err) {
        failures.push(car.id)
        log(`  ${car.id}: FAILED ${err.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const totalBytes = [...results.values()].flatMap((v) => v.images).reduce((n, i) => n + i.bytes, 0)
  const counts = ctx.keys.reduce((acc, { action }) => ({ ...acc, [action]: (acc[action] || 0) + 1 }), {})
  log(`${results.size} cars, ${ctx.keys.length} variants, ${totalBytes} B total ${JSON.stringify(counts)}`)

  if (!opts.dryRun && results.size > 0) {
    // Re-read so the write only adds variant fields to the current file.
    const latest = JSON.parse(readFileSync(CARS_JSON, 'utf8'))
    const updated = latest.map((car) =>
      results.has(car.id) && results.get(car.id).source === car.displayImage
        ? withVariants(car, results.get(car.id))
        : car
    )
    writeCars(updated)
    log(`updated ${CARS_JSON} for ${results.size} cars`)
  }
  if (failures.length) {
    log(`failed: ${failures.join(', ')}`)
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message || err)
      process.exit(1)
    }
  )
}
