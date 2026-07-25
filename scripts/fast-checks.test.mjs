// Tests for the fast-lane checks (ship --fast). Fixture repos in tmpdirs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { runFastChecks, siblingOnDisk, validateHeroFile, validatePostFile } from './fast-checks.mjs'

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'fast-checks-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

const GOOD_PRIMARY = `---
title: 'A City Walk'
description: 'A walk.'
pubDate: '2024-07-06'
heroImage: '../../assets/hero/2026/07/cover.webp'
lang: 'en'
translationKey: 'a-city-walk'
---

Body.
`

const GOOD_SIBLING = `---
translationKey: 'a-city-walk'
lang: 'zh'
title: '城市漫步'
---

正文。
`

const PAIR_TREE = {
  'src/content/posts/a-city-walk.md': GOOD_PRIMARY,
  'src/content/posts/a-city-walk.zh.md': GOOD_SIBLING,
  'src/assets/hero/2026/07/cover.webp': 'binary-ish',
}

async function heroBuffer(width, height, format = 'webp') {
  const image = sharp({
    create: { width, height, channels: 3, background: '#eeeeee' },
  })
  return image[format]().toBuffer()
}

test('a valid pair passes all fast checks', async () => {
  const root = makeTree(PAIR_TREE)
  try {
    const errors = await runFastChecks(root, [
      'src/content/posts/a-city-walk.md',
      'src/content/posts/a-city-walk.zh.md',
    ])
    assert.deepEqual(errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file with no frontmatter fails', () => {
  const root = makeTree({ 'src/content/posts/x.md': 'test' })
  try {
    assert.match(validatePostFile(root, 'src/content/posts/x.md')[0], /no frontmatter/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing required fields and a bad date are reported', () => {
  const root = makeTree({
    'src/content/posts/x.md': `---\ntitle: 'X'\npubDate: 'not a date'\n---\nBody.\n`,
  })
  try {
    const errors = validatePostFile(root, 'src/content/posts/x.md')
    assert.ok(
      errors.some((e) => /missing required field description/.test(e)),
      errors.join('; ')
    )
    assert.ok(
      errors.some((e) => /pubDate does not parse/.test(e)),
      errors.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a heroImage pointing at a missing file is reported', () => {
  const root = makeTree({
    'src/content/posts/x.md': `---\ntitle: 'X'\ndescription: 'D'\npubDate: '2024-01-01'\nheroImage: '../../assets/hero/missing.webp'\n---\nBody.\n`,
  })
  try {
    const errors = validatePostFile(root, 'src/content/posts/x.md')
    assert.ok(
      errors.some((e) => /heroImage not found/.test(e)),
      errors.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a heroImage escaping the hero directory is reported', () => {
  const root = makeTree({
    'src/content/posts/x.md': `---\ntitle: 'X'\ndescription: 'D'\npubDate: '2024-01-01'\nheroImage: '../../../outside.webp'\n---\nBody.\n`,
    'outside.webp': 'not a cover',
  })
  try {
    const errors = validatePostFile(root, 'src/content/posts/x.md')
    assert.ok(
      errors.some((e) => /heroImage escapes/.test(e)),
      errors.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a sibling missing translationKey or lang is reported', () => {
  const root = makeTree({
    'src/content/posts/x.zh.md': `---\ntitle: 'X'\n---\nBody.\n`,
  })
  try {
    const errors = validatePostFile(root, 'src/content/posts/x.zh.md')
    assert.ok(errors.some((e) => /missing required field translationKey/.test(e)))
    assert.ok(errors.some((e) => /lang must be zh or en/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a protected mismatch across the pair is reported for either side', () => {
  const root = makeTree({
    ...PAIR_TREE,
    'src/content/posts/a-city-walk.md': GOOD_PRIMARY.replace(
      "lang: 'en'",
      "lang: 'en'\nprotected: true"
    ),
  })
  try {
    const fromPrimary = validatePostFile(root, 'src/content/posts/a-city-walk.md')
    assert.ok(
      fromPrimary.some((e) => /protected flag differs/.test(e)),
      fromPrimary.join('; ')
    )
    const fromSibling = validatePostFile(root, 'src/content/posts/a-city-walk.zh.md')
    assert.ok(
      fromSibling.some((e) => /protected flag differs/.test(e)),
      fromSibling.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('siblingOnDisk resolves both directions and misses cleanly', () => {
  const root = makeTree(PAIR_TREE)
  try {
    assert.equal(
      siblingOnDisk(root, 'src/content/posts/a-city-walk.md'),
      'src/content/posts/a-city-walk.zh.md'
    )
    assert.equal(
      siblingOnDisk(root, 'src/content/posts/a-city-walk.zh.md'),
      'src/content/posts/a-city-walk.md'
    )
    assert.equal(siblingOnDisk(root, 'src/content/posts/lonely.md'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the scoped secret scan catches a planted token', async () => {
  const fakeToken = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
  const root = makeTree({
    'src/content/posts/x.md': `---\ntitle: 'X'\ndescription: 'D'\npubDate: '2024-01-01'\n---\nkey ${fakeToken} in prose.\n`,
  })
  try {
    const errors = await runFastChecks(root, ['src/content/posts/x.md'])
    assert.ok(
      errors.some((e) => /possible secret aws-access-key/.test(e)),
      errors.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an invalid slug is reported and a valid one passes', () => {
  const root = makeTree({
    'src/content/posts/x.md': `---\ntitle: 'X'\ndescription: 'D'\npubDate: '2024-01-01'\nslug: 'my-custom-url'\n---\nBody.\n`,
    'src/content/posts/y.md': `---\ntitle: 'Y'\ndescription: 'D'\npubDate: '2024-01-01'\nslug: 'Bad Slug!'\n---\nBody.\n`,
  })
  try {
    assert.deepEqual(validatePostFile(root, 'src/content/posts/x.md'), [])
    const errors = validatePostFile(root, 'src/content/posts/y.md')
    assert.ok(
      errors.some((e) => /slug must be lowercase/.test(e)),
      errors.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a deleted file in the change set is skipped, not an error', async () => {
  const root = makeTree({
    'src/content/posts/kept.md': `---\ntitle: 'K'\ndescription: 'D'\npubDate: '2024-01-01'\n---\nBody.\n`,
  })
  try {
    const errors = await runFastChecks(root, [
      'src/content/posts/kept.md',
      'src/content/posts/deleted-post.md',
      'src/content/posts/deleted-post.zh.md',
    ])
    assert.deepEqual(errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fast checks accept a documented-size hero without parsing or secret-scanning binary bytes', async () => {
  const fakeToken = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
  const cover = Buffer.concat([await heroBuffer(1600, 1600), Buffer.from(fakeToken)])
  const root = makeTree({
    ...PAIR_TREE,
    'src/assets/hero/2026/07/cover.webp': cover,
  })
  try {
    const errors = await runFastChecks(root, [
      'src/content/posts/a-city-walk.md',
      'src/content/posts/a-city-walk.zh.md',
      'src/assets/hero/2026/07/cover.webp',
    ])
    assert.deepEqual(errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hero validation rejects undersized and extension-mismatched covers', async () => {
  const root = makeTree({
    'src/assets/hero/small.webp': await heroBuffer(1200, 1200),
    'src/assets/hero/not-really-webp.webp': await heroBuffer(1600, 1600, 'png'),
  })
  try {
    const small = await validateHeroFile(root, 'src/assets/hero/small.webp')
    assert.ok(
      small.some((e) => /minimum is 2400x1260.*1600x1600/.test(e)),
      small.join('; ')
    )
    const mismatch = await validateHeroFile(root, 'src/assets/hero/not-really-webp.webp')
    assert.ok(
      mismatch.some((e) => /extension expects webp.*image data is png/.test(e)),
      mismatch.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hero validation fully decodes and rejects truncated image data', async () => {
  const complete = await heroBuffer(2400, 1260, 'jpeg')
  const root = makeTree({
    'src/assets/hero/truncated.jpg': complete.subarray(0, complete.length - 1),
  })
  try {
    const errors = await validateHeroFile(root, 'src/assets/hero/truncated.jpg')
    assert.ok(
      errors.some((e) => /invalid JPEG image/.test(e)),
      errors.join('; ')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fast checks reject unrelated paths instead of treating them as posts', async () => {
  const root = makeTree({ 'docs/notes.md': 'text' })
  try {
    const errors = await runFastChecks(root, ['docs/notes.md'])
    assert.deepEqual(errors, ['docs/notes.md: unsupported fast-lane path'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
