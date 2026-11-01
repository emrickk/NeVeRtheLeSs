import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import {
  CARS_JSON,
  VARIANT_WIDTHS,
  carsMissingVariants,
  encodeVariant,
  variantKey,
  variantProblems,
  withVariants,
} from './car-variants.mjs'

const cars = JSON.parse(readFileSync(CARS_JSON, 'utf8'))
const SOURCE = 'https://cdn.theneverless.com/library/model-cars/abc-ai-redraw-0123456789ab.png'

function completeCar() {
  return {
    id: 'X',
    displayImage: SOURCE,
    displayImageVariants: {
      source: SOURCE,
      sourceWidth: 1536,
      sourceHeight: 1024,
      images: [
        {
          width: 480,
          height: 320,
          bytes: 100,
          url: 'https://cdn.theneverless.com/library/model-cars/abc-ai-redraw-0123456789ab-480w-aaaaaaaaaaaa.webp',
        },
        {
          width: 800,
          height: 533,
          bytes: 200,
          url: 'https://cdn.theneverless.com/library/model-cars/abc-ai-redraw-0123456789ab-800w-bbbbbbbbbbbb.webp',
        },
      ],
    },
  }
}

test('every model car with a displayImage has current responsive variants', () => {
  const missing = carsMissingVariants(cars)
  assert.deepEqual(
    missing,
    [],
    `Run \`npm run library:car-variants\` for: ${missing
      .map((m) => `${m.id} (${m.problems.join('; ')})`)
      .join(', ')}`
  )
})

test('every recorded variant URL is unique', () => {
  const urls = cars.flatMap((car) => car.displayImageVariants?.images.map((img) => img.url) || [])
  assert.equal(new Set(urls).size, urls.length)
})

test('variantProblems accepts a complete record', () => {
  assert.deepEqual(variantProblems(completeCar()), [])
})

test('variantProblems flags missing, stale and malformed variants', () => {
  const missing = { id: 'X', displayImage: SOURCE }
  assert.deepEqual(variantProblems(missing), ['no displayImageVariants'])

  const stale = completeCar()
  stale.displayImage = SOURCE.replace('0123456789ab', 'ffffffffffff')
  assert.match(variantProblems(stale).join(), /different displayImage/)

  const oneWidth = completeCar()
  oneWidth.displayImageVariants.images.pop()
  assert.match(variantProblems(oneWidth).join(), /widths/)

  const wrongHost = completeCar()
  wrongHost.displayImageVariants.images[0].url = 'https://example.com/a-480w-aaaaaaaaaaaa.webp'
  assert.match(variantProblems(wrongHost).join(), /content-hashed CDN WebP/)

  const squashed = completeCar()
  squashed.displayImageVariants.images[1].height = 450
  assert.match(variantProblems(squashed).join(), /source frame/)

  assert.deepEqual(variantProblems({ id: 'pending' }), [], 'a car without a photo needs no variants')
})

test('variantKey sits next to the original and hashes the variant bytes', () => {
  const a = variantKey(SOURCE, 480, Buffer.from('one'))
  const b = variantKey(SOURCE, 480, Buffer.from('two'))
  assert.match(a, /^library\/model-cars\/abc-ai-redraw-0123456789ab-480w-[0-9a-f]{12}\.webp$/)
  assert.notEqual(a, b)
  assert.equal(a, variantKey(SOURCE, 480, Buffer.from('one')))
})

test('withVariants adds the field after displayImage and changes nothing else', () => {
  const car = cars.find((c) => c.displayImage)
  const plain = { ...car }
  delete plain.displayImageVariants
  const variants = completeCar().displayImageVariants
  const out = withVariants(plain, variants)
  const keys = Object.keys(out)
  assert.equal(keys[keys.indexOf('displayImage') + 1], 'displayImageVariants')
  assert.deepEqual(out.displayImageVariants, variants)
  for (const [key, value] of Object.entries(plain)) assert.deepEqual(out[key], value)
  assert.deepEqual(
    keys.filter((k) => k !== 'displayImageVariants'),
    Object.keys(plain)
  )
})

test('encodeVariant keeps the 3:2 frame at each width without enlarging', async () => {
  const source = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: '#d0d4d8' },
  })
    .png()
    .toBuffer()
  for (const width of VARIANT_WIDTHS) {
    const out = await encodeVariant(source, width, { opaque: true })
    const meta = await sharp(out.buffer).metadata()
    assert.equal(meta.format, 'webp')
    assert.equal(meta.width, width)
    assert.equal(meta.height, Math.round((width * 1024) / 1536))
    assert.equal(meta.hasAlpha, false)
    assert.equal(out.bytes, out.buffer.length)
  }
})
