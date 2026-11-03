import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { loadEnvFile, loadConfig } from './config.mjs'
import { optimizeToWebp } from './optimize.mjs'
import { archiveOriginal } from './archive.mjs'
import { makeClient, putObject, objectExists } from './r2.mjs'
import { loadManifest, saveManifest, hasHash, addEntry, hashBuffer } from './manifest.mjs'
import { deriveKey, publicUrl, snippetFor } from './references.mjs'
import { DIMENSIONS_JSON, saveDimensions } from './dimensions.mjs'

const DEFAULT_STAGING = 'image-staging'
const DEFAULT_MANIFEST = 'scripts/images/.manifest.json'
const IMG_RE = /\.(jpe?g|png)$/i
const DEFAULT_BASE = 'https://cdn.theneverless.com'

function listStaged(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => statSync(p).isFile() && IMG_RE.test(p))
    .sort()
}

export async function run({
  stagingDir = DEFAULT_STAGING,
  manifestPath = DEFAULT_MANIFEST,
  dryRun = false,
  config = null,
  now = new Date(),
  log = console.log,
  prefix = null,
  archive = true,
  dimensionsPath = DIMENSIONS_JSON,
  client: injectedClient = null,
} = {}) {
  const files = listStaged(stagingDir)
  const base = config?.publicBase ?? DEFAULT_BASE
  const client = config && !dryRun ? (injectedClient ?? makeClient(config)) : null
  const manifest = loadManifest(manifestPath)
  const snippets = []

  for (const file of files) {
    const original = readFileSync(file)
    const hash = hashBuffer(original)
    if (hasHash(manifest, hash)) {
      const key = manifest[hash].key
      log(`↻ skip (already uploaded): ${path.basename(file)} -> ${key}`)
      snippets.push(snippetFor(key, base))
      continue
    }
    const key = deriveKey(path.basename(file), now, prefix, hash)
    // A key that already exists on R2 but is not in the manifest belongs to
    // some OTHER image (a filename collision); uploading would silently
    // replace it on the live CDN.
    if (!dryRun && config && (await objectExists(client, config.bucket, key))) {
      throw new Error(
        `refusing to overwrite existing R2 object ${key} (from ${path.basename(file)}); rename the file and re-run`,
      )
    }
    if (!dryRun && config && archive) {
      const arch = archiveOriginal(file, config)
      log(`  archived original -> ${arch.dest} (${arch.location})${arch.skipped ? ' [already archived]' : ''}`)
    }
    const { buffer, width, height, bytes } = await optimizeToWebp(file, { watermark: true })
    if (dryRun || !config) {
      log(`  [dry-run] ${key} (${width}px, ${(bytes / 1024).toFixed(0)} KB)`)
    } else {
      await putObject(client, config.bucket, key, buffer, 'image/webp')
      addEntry(manifest, hash, key, now.toISOString())
      // Saved per upload, not once at the end: a mid-batch failure must not
      // lose the dedupe entries of files already on the CDN.
      saveManifest(manifestPath, manifest)
      // Width and height for the build (scripts/rehype/image-dimensions.mjs);
      // commit src/data/image-dimensions.json together with the post. The
      // image is already live, so a failure here warns instead of stopping.
      try {
        saveDimensions({ [publicUrl(key, base)]: [width, height] }, dimensionsPath)
      } catch (err) {
        log(`  ! dimensions not recorded for ${key}: ${err.message} (run npm run images:dimensions)`)
      }
      log(`  ✓ uploaded ${key} (${width}px, ${(bytes / 1024).toFixed(0)} KB)`)
    }
    snippets.push(snippetFor(key, base))
  }

  return { snippets, count: files.length }
}

// CLI entry (pathToFileURL handles spaces in the repo path)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argValue = (flag) => {
    const i = process.argv.indexOf(flag)
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null
  }

  const dryRun = process.argv.includes('--dry-run')
  const stagingDir = argValue('--staging-dir') ?? DEFAULT_STAGING
  const manifestPath = argValue('--manifest') ?? DEFAULT_MANIFEST
  const prefix = argValue('--prefix')
  const archive = !process.argv.includes('--no-archive')
  loadEnvFile()
  const config = dryRun ? null : loadConfig()
  run({ dryRun, config, stagingDir, manifestPath, prefix, archive })
    .then(({ snippets, count }) => {
      if (count === 0) {
        console.log(`No images in ${stagingDir}/. Drop .jpg/.jpeg/.png there and re-run.`)
        return
      }
      console.log('\nPaste into your post:\n')
      console.log(snippets.join('\n'))
    })
    .catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
}
