// Tests for the changed-post content checks. Fixture repos live in tmpdirs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  changedLineNumbers,
  changedPostFiles,
  checkFileText,
  runContentCheck,
} from './content-check.mjs'
import { cleanup, makeFixtureRepo, run, write } from './test-helpers.mjs'

const P = 'src/content/posts/'
const PRIMARY_ZH =
  "---\ntitle: '标题'\ndescription: '简介'\npubDate: '2026-07-16'\nlang: 'zh'\ntranslationKey: 'alpha'\n---\n\n正文\n"
const SIBLING_EN =
  "---\ntranslationKey: 'alpha'\nlang: 'en'\ntitle: 'Title'\ndescription: 'Summary'\n---\n\nBody\n"

function fixture(t) {
  const root = makeFixtureRepo()
  t.after(() => cleanup(root))
  return root
}

function rules(result) {
  return (result.findings || []).map((f) => `${f.file}:${f.line}:${f.rule}`)
}

test('content check SKIPs when no post changed', (t) => {
  const root = fixture(t)
  write(root, 'docs/x.md', 'not a post \u2014 ignored\n')
  assert.equal(runContentCheck(root, { baseRef: 'HEAD' }).status, 'SKIP')
})

test('translation pair: complete pair passes', (t) => {
  const root = fixture(t)
  write(root, `${P}alpha.md`, PRIMARY_ZH)
  write(root, `${P}alpha.en.md`, SIBLING_EN)
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.equal(res.status, 'PASS', res.detail)
})

test('translation pair: empty sibling title and missing description fail with file:line', (t) => {
  const root = fixture(t)
  write(root, `${P}alpha.md`, PRIMARY_ZH)
  write(
    root,
    `${P}alpha.en.md`,
    "---\ntranslationKey: 'alpha'\nlang: 'en'\ntitle: ''\n---\n\nBody\n"
  )
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.equal(res.status, 'FAIL')
  assert.deepEqual(rules(res), [
    `${P}alpha.en.md:1:translation-pair`,
    `${P}alpha.en.md:4:translation-pair`,
  ])
  assert.match(res.detail, /alpha\.en\.md:4 \[translation-pair\] title is empty/)
  assert.match(res.detail, /description is missing; the en description would silently fall back/)
})

test('translation pair: an unchanged sibling is still checked when the primary changes', (t) => {
  const root = fixture(t)
  write(root, `${P}alpha.md`, PRIMARY_ZH)
  write(root, `${P}alpha.en.md`, "---\ntranslationKey: 'alpha'\nlang: 'en'\n---\n\nBody\n")
  run(root, ['add', 'src'])
  run(root, ['commit', '-q', '-m', 'pair baseline'])
  write(root, `${P}alpha.md`, PRIMARY_ZH.replace('正文', '正文 2'))
  assert.deepEqual(changedPostFiles(root, { baseRef: 'HEAD' }), [`${P}alpha.md`])
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.equal(res.status, 'FAIL')
  assert.ok(rules(res).every((r) => r.startsWith(`${P}alpha.en.md:`)))
})

test('translation pair: an empty primary description fails', (t) => {
  const root = fixture(t)
  write(root, `${P}alpha.md`, PRIMARY_ZH.replace("description: '简介'", "description: ''"))
  write(root, `${P}alpha.en.md`, SIBLING_EN)
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.deepEqual(rules(res), [`${P}alpha.md:3:translation-pair`])
})

test('translation pair: mismatched translationKey and wrong lang fail', (t) => {
  const root = fixture(t)
  write(root, `${P}alpha.md`, PRIMARY_ZH)
  write(root, `${P}alpha.en.md`, SIBLING_EN.replace("translationKey: 'alpha'", "translationKey: 'beta'").replace("lang: 'en'", "lang: 'zh'"))
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.equal(res.status, 'FAIL')
  assert.match(res.detail, /translationKey 'beta', expected 'alpha'/)
  assert.match(res.detail, /lang is 'zh' but the file name says en/)
})

test('translation pair: a zh sibling of a zh primary is flagged as never shown', (t) => {
  const root = fixture(t)
  write(root, `${P}alpha.md`, PRIMARY_ZH)
  write(root, `${P}alpha.zh.md`, SIBLING_EN.replace("lang: 'en'", "lang: 'zh'"))
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.match(res.detail, /must be en, not zh/)
})

test('translation pair: a post without a sibling is not a pair', (t) => {
  const root = fixture(t)
  write(root, `${P}solo.md`, "---\ntitle: 'Solo'\npubDate: '2026-07-16'\n---\n\nbody\n")
  assert.equal(runContentCheck(root, { baseRef: 'HEAD' }).status, 'PASS')
})

test('image alt: empty markdown and html alt fail, described images pass', (t) => {
  const root = fixture(t)
  write(
    root,
    `${P}pics.md`,
    [
      '---',
      "title: 'Pics'",
      '---',
      '',
      '![](https://cdn.theneverless.com/a.webp)',
      '![ ](https://cdn.theneverless.com/b.webp)',
      '![A red car](https://cdn.theneverless.com/c.webp)',
      '<img src="https://cdn.theneverless.com/d.webp">',
      '<img alt="" src="x.webp">',
      "<img alt='Harbor at dusk' src='e.webp'>",
      '```',
      '![](inside-code-is-not-rendered.webp)',
      '```',
      '',
    ].join('\n')
  )
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.equal(res.status, 'FAIL')
  assert.deepEqual(rules(res), [
    `${P}pics.md:5:image-alt`,
    `${P}pics.md:6:image-alt`,
    `${P}pics.md:8:image-alt`,
    `${P}pics.md:9:image-alt`,
  ])
})

test('em dash: body, title, and description lines fail; clean text passes', (t) => {
  const root = fixture(t)
  write(
    root,
    `${P}dash.md`,
    "---\ntitle: 'A \u2014 B'\ndescription: 'C\u2014D'\n---\n\nclean line\nbody \u2014 here\n"
  )
  const res = runContentCheck(root, { baseRef: 'HEAD' })
  assert.deepEqual(rules(res), [
    `${P}dash.md:2:em-dash`,
    `${P}dash.md:3:em-dash`,
    `${P}dash.md:7:em-dash`,
  ])
  assert.match(res.detail, /dash\.md:7 \[em-dash\] em dash \(U\+2014\) at column 6/)
  assert.deepEqual(checkFileText('x.md', 'en dash – is fine\n'), [])
})

test('changed lines only: an edit to an archived post ignores its old problems', (t) => {
  const root = fixture(t)
  const archived = "---\ntitle: 'Old'\n---\n\nold \u2014 dash\n![](old.webp)\nline to fix\n"
  write(root, `${P}old.md`, archived)
  run(root, ['add', 'src'])
  run(root, ['commit', '-q', '-m', 'archive'])
  write(root, `${P}old.md`, archived.replace('line to fix', 'line fixed'))
  assert.deepEqual([...changedLineNumbers(root, `${P}old.md`, 'HEAD')], [7])
  assert.equal(runContentCheck(root, { baseRef: 'HEAD' }).status, 'PASS')
  // A new problem on an edited line is caught, and --whole-file sees all.
  write(root, `${P}old.md`, archived.replace('line to fix', 'line \u2014 fixed'))
  assert.deepEqual(rules(runContentCheck(root, { baseRef: 'HEAD' })), [`${P}old.md:7:em-dash`])
  assert.equal(runContentCheck(root, { baseRef: 'HEAD', wholeFile: true }).findings.length, 3)
})

test('content check ignores unchanged and draft-at-base posts', (t) => {
  const root = fixture(t)
  write(root, `${P}draft.md`, "---\ntitle: 'D'\ndraft: true\n---\n\n\u2014\n")
  assert.deepEqual(changedPostFiles(root, { baseRef: 'HEAD' }), [])
})

test('cli: npm run check:content exits 1 with file:line findings', (t) => {
  const root = fixture(t)
  write(root, `${P}dash.md`, "---\ntitle: 'A'\n---\n\nbody \u2014 here\n")
  const cli = fileURLToPath(new URL('./content-check.mjs', import.meta.url))
  let res
  try {
    execFileSync('node', [cli], { cwd: root, encoding: 'utf8' })
    res = { code: 0 }
  } catch (err) {
    res = { code: err.status, stdout: String(err.stdout) }
  }
  assert.equal(res.code, 1)
  assert.match(res.stdout, /src\/content\/posts\/dash\.md:5 \[em-dash\]/)
})

test('release-check runs the content check as quick-mode check 13', async () => {
  const { CHECKS } = await import('./release-check.mjs')
  const entry = CHECKS.find((c) => c.num === 13)
  assert.equal(entry.name, 'post content')
  assert.notEqual(entry.full, true)
})
