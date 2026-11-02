import process from 'node:process'

const REQUIRED = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE',
]

// Load .env.local if present. Absent file is fine (rely on ambient env).
export function loadEnvFile(path = '.env.local') {
  try {
    process.loadEnvFile(path)
  } catch {
    // no local env file, that's OK for dry-runs and CI
  }
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. ` +
        `Copy .env.example to .env.local and fill them in.`,
    )
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicBase: env.R2_PUBLIC_BASE.replace(/\/+$/, ''),
    nasArchivePath: env.NAS_ARCHIVE_PATH?.trim() || null,
  }
}
