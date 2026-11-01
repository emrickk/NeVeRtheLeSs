import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadEnvFile, loadConfig } from './config.mjs'
import { makeClient, putObject, objectExists, deleteObject } from './r2.mjs'

// The live test PUTs and DELETEs an object under _smoketest/ in the
// production bucket, so credentials alone never enable it: it runs only when
// the shell that started the tests sets R2_LIVE=1 (read before .env.local is
// loaded, so that file cannot switch it on). release-check strips R2_LIVE.
// Run it deliberately with: R2_LIVE=1 npm run test:images
export function liveSkipReason(env = process.env, loadCreds = () => loadConfig()) {
  if (env.R2_LIVE !== '1') {
    return 'R2 live test skipped: set R2_LIVE=1 to PUT/DELETE a _smoketest/ object in the production bucket'
  }
  try {
    loadCreds()
  } catch {
    return 'R2 live test skipped: R2_LIVE=1 but no R2 credentials in env or .env.local'
  }
  return false
}

const liveRequested = process.env.R2_LIVE === '1'
let config = null
if (liveRequested) {
  loadEnvFile()
  try { config = loadConfig() } catch { /* no creds -> skip below */ }
}
const skip = liveSkipReason(process.env, () => {
  if (!config) throw new Error('no creds')
  return config
})

test('R2 live test is gated on R2_LIVE=1, not on credentials', () => {
  const creds = () => ({})
  assert.match(liveSkipReason({}, creds), /set R2_LIVE=1/)
  assert.match(liveSkipReason({ R2_LIVE: 'true' }, creds), /set R2_LIVE=1/)
  assert.match(liveSkipReason({ R2_LIVE: '1' }, () => { throw new Error('none') }), /no R2 credentials/)
  assert.equal(liveSkipReason({ R2_LIVE: '1' }, creds), false)
})

test('put then head round-trips against R2 (live)', { skip }, async () => {
  const client = makeClient(config)
  const key = `_smoketest/hello-${process.pid}.txt`
  try {
    await putObject(client, config.bucket, key, Buffer.from('hi'), 'text/plain')
    assert.equal(await objectExists(client, config.bucket, key), true)
    assert.equal(await objectExists(client, config.bucket, `_smoketest/missing-${process.pid}`), false)
  } finally {
    await deleteObject(client, config.bucket, key)
  }
  assert.equal(await objectExists(client, config.bucket, key), false)
})
