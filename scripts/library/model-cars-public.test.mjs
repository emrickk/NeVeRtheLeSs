import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CARS_JSON } from './car-variants.mjs'

// model-cars.json is public. Purchase and fulfillment state (status, order,
// deposit, prices, delivery) lives only in the owner's private Life Records.
const cars = JSON.parse(readFileSync(CARS_JSON, 'utf8'))

/** Keys that must never appear at any depth of a public car row. */
const PRIVATE_KEYS = new Set([
  'status',
  'purchase',
  'record_note',
  'blog_display_order',
  'order_id',
  'line_total',
  'currency',
  'marketplace',
  'fulfillment_status',
  'fulfillment_note',
  'home_received_on',
  'receipt_confirmation_status',
  'input_evidence',
])

/** Top-level fields a public car row may carry. A new field needs a
 *  deliberate decision that it is public before it is added here. */
const PUBLIC_FIELDS = new Set([
  'id',
  'title',
  'brand',
  'scale',
  'officialImage',
  'officialUrl',
  'imageCredit',
  'verifiedOn',
  'ownershipPost',
  'displayImage',
  'displayImageVariants',
  'imageTreatment',
  'displaySourceImage',
  'displaySourceUrl',
  'imageSourceType',
  'sourceFilename',
  'imageStatus',
  'imageFrameColor',
  'imagePresentation',
  'imageSourceStatus',
  'imageSourceAudit',
  'imageSourceReferences',
  'listingUrl',
  'imageCrop',
  'imageGeneratedDimensions',
  'imageGeneration',
  'variantConfirmation',
  'imageSourceDimensions',
])

function privateKeyPaths(value, path = []) {
  if (Array.isArray(value)) return value.flatMap((item, i) => privateKeyPaths(item, [...path, i]))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(PRIVATE_KEYS.has(key) ? [[...path, key].join('.')] : []),
    ...privateKeyPaths(child, [...path, key]),
  ])
}

test('model-cars.json rows carry no purchase status or other private fields', () => {
  const found = cars.flatMap((car) => privateKeyPaths(car).map((p) => `${car.id}: ${p}`))
  assert.deepEqual(found, [], 'Keep purchase and fulfillment state in Life Records only')
})

test('model-cars.json rows only use fields known to be public', () => {
  const unknown = cars.flatMap((car) =>
    Object.keys(car)
      .filter((key) => !PUBLIC_FIELDS.has(key))
      .map((key) => `${car.id}: ${key}`)
  )
  assert.deepEqual(unknown, [], 'Decide whether a new field is public before adding it to PUBLIC_FIELDS')
})

test('the private-field check catches nested and top-level status', () => {
  assert.deepEqual(privateKeyPaths({ id: 'x', status: 'ordered' }), ['status'])
  assert.deepEqual(privateKeyPaths({ id: 'x', imageGeneration: { purchase: {} } }), [
    'imageGeneration.purchase',
  ])
  assert.deepEqual(privateKeyPaths({ id: 'x', title: 'Status quo', imageStatus: 'available' }), [])
})
