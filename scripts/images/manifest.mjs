import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'

export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// Fails closed: a manifest that exists but cannot be parsed means the dedupe
// state is unknown, and continuing with {} would re-upload everything and
// invite key collisions. The operator fixes or deletes the file explicitly.
export function loadManifest(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(
      `manifest at ${path} exists but cannot be parsed (${err.message}); ` +
        'refusing to continue with empty dedupe state. Fix or delete the file, then re-run.',
      { cause: err },
    )
  }
}

export function hasHash(manifest, hash) {
  return Object.prototype.hasOwnProperty.call(manifest, hash)
}

export function addEntry(manifest, hash, key, uploadedAt) {
  manifest[hash] = { key, uploadedAt }
  return manifest
}

// Merge-on-save so a concurrent run's entries survive (plain overwrite was
// last-writer-wins), and temp+rename so a crash mid-write never leaves a
// half-written manifest behind.
export function saveManifest(path, manifest) {
  let merged = manifest
  if (existsSync(path)) {
    try {
      merged = { ...JSON.parse(readFileSync(path, 'utf8')), ...manifest }
    } catch {
      merged = manifest
    }
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
  renameSync(tmp, path)
  return merged
}
