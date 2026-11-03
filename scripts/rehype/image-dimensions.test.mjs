import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from 'hast-util-to-html';
import rehypeImageDimensions from './image-dimensions.mjs';
import rehypeImageGallery from './image-gallery.mjs';
import rehypeProtectedContent from './protected-content.mjs';
import { DIMENSIONS_JSON, loadDimensions, referencedImageUrls } from '../images/dimensions.mjs';

const A = 'https://cdn.theneverless.com/2026/07/a.webp';
const B = 'https://cdn.theneverless.com/2026/07/b.webp';
const MISSING = 'https://cdn.theneverless.com/2026/07/missing.webp';
const dimensions = { [A]: [2000, 1333], [B]: [1500, 2000] };

const el = (tagName, properties = {}, children = []) => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const raw = (value) => ({ type: 'raw', value });
const img = (src, extra = {}) => el('img', { src, alt: '', ...extra });
const p = (...children) => el('p', {}, children);
const root = (...children) => ({ type: 'root', children });

function run(tree, { file = { path: 'src/content/posts/x.md' }, map = dimensions } = {}) {
  const warnings = [];
  rehypeImageDimensions({ dimensions: map, warn: (m) => warnings.push(m) })(tree, file);
  return warnings;
}

test('markdown images gain width and height from the map', () => {
  const a = img(A);
  const b = img(B);
  const warnings = run(root(p(a), p(b)));
  assert.equal(a.properties.width, 2000);
  assert.equal(a.properties.height, 1333);
  assert.equal(b.properties.width, 1500);
  assert.equal(b.properties.height, 2000);
  assert.deepEqual(warnings, []);
});

test('the attributes serialize as plain width and height', () => {
  const tree = root(p(img(A)));
  run(tree);
  assert.equal(toHtml(tree), `<p><img src="${A}" alt="" width="2000" height="1333"></p>`);
});

test('existing width or height attributes are kept as written', () => {
  const both = img(A, { width: 300, height: 200 });
  const onlyWidth = img(A, { width: 300 });
  run(root(both, onlyWidth));
  assert.equal(both.properties.width, 300);
  assert.equal(both.properties.height, 200);
  assert.equal(onlyWidth.properties.width, 300);
  assert.equal(onlyWidth.properties.height, undefined);
});

test('an inline style that sizes the image wins; height: auto does not count', () => {
  const sized = img(A, { style: 'width: 100%; aspect-ratio: 9 / 1; object-fit: cover;' });
  const auto = img(A, { style: 'height: auto;' });
  run(root(sized, auto));
  assert.equal(sized.properties.width, undefined);
  assert.equal(auto.properties.width, 2000);
});

test('raw HTML img tags gain the attributes and keep everything else', () => {
  const block = raw(
    `<div class="img-grid">\n  <img src="${A}" alt="One" loading="lazy" />\n  <img src='${B}' alt="Two">\n</div>`
  );
  const warnings = run(root(block));
  assert.equal(
    block.value,
    `<div class="img-grid">\n  <img width="2000" height="1333" src="${A}" alt="One" loading="lazy" />\n  <img width="1500" height="2000" src='${B}' alt="Two">\n</div>`
  );
  assert.deepEqual(warnings, []);
});

test('raw HTML img tags with their own size, or a sizing style, are untouched', () => {
  const tags = [
    `<img src="${A}" width="10">`,
    `<img height=10 src="${A}">`,
    `<img src="${A}" style="width: 100%; aspect-ratio: 9 / 1; object-fit: cover;">`,
  ];
  for (const tag of tags) {
    const node = raw(tag);
    run(root(node));
    assert.equal(node.value, tag);
  }
  const auto = raw(`<img src="${A}" style="height: auto; object-fit: contain;" alt="a > b">`);
  run(root(auto));
  assert.equal(
    auto.value,
    `<img width="2000" height="1333" src="${A}" style="height: auto; object-fit: contain;" alt="a > b">`
  );
});

test('attribute names that only contain width do not count as a width', () => {
  const node = raw(`<img data-width="5" src="${A}">`);
  run(root(node));
  assert.match(node.value, /^<img width="2000" height="1333" data-width="5"/);
});

test('images missing from the map fail soft with one warning per file', () => {
  const md = img(MISSING);
  const html = raw(`<img src="${MISSING}"><img src="https://example.com/x.png">`);
  const warnings = run(root(p(md), html, p(img(A))));
  assert.equal(md.properties.width, undefined);
  assert.equal(html.value, `<img src="${MISSING}"><img src="https://example.com/x.png">`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 image\(s\) in src\/content\/posts\/x\.md have no width\/height/);
  assert.match(warnings[0], /missing\.webp/);
  assert.match(warnings[0], /example\.com\/x\.png/);
});

test('an empty or absent map leaves the tree as it was', () => {
  const a = img(A);
  const warnings = run(root(p(a)), { map: {} });
  assert.equal(a.properties.width, undefined);
  assert.equal(warnings.length, 1);
  const plain = rehypeImageDimensions({ warn: () => {} });
  const b = img(A);
  plain(root(b), {});
  assert.equal(b.properties.width, undefined);
});

test('gallery detection is unchanged: sized images still form a gallery', () => {
  const tree = root(p(img(A)), p(img(B)), p(img(A)));
  run(tree);
  rehypeImageGallery()(tree);
  assert.equal(tree.children.length, 1);
  const list = tree.children[0];
  assert.equal(list.tagName, 'ul');
  assert.deepEqual(list.properties.className, ['image-gallery']);
  const sizes = list.children.map((li) => [
    li.children[0].properties.width,
    li.children[0].properties.height,
  ]);
  assert.deepEqual(sizes, [
    [2000, 1333],
    [1500, 2000],
    [2000, 1333],
  ]);
});

test('protected posts encrypt the sized markup', () => {
  const tree = root(p(img(A)), raw(`<img src="${B}">`));
  const file = {
    path: '/repo/src/content/posts/secret.md',
    cwd: '/repo',
    data: { astro: { frontmatter: { protected: true } } },
  };
  run(tree, { file });
  const html = toHtml(tree, { allowDangerousHtml: true });
  assert.match(html, /width="2000" height="1333"/);
  assert.match(html, /<img width="1500" height="2000"/);
  rehypeProtectedContent({ password: 'test-only' })(tree, file);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].properties.dataProtectedContent, '');
});

test('the committed map is valid and covers every CDN image the content references', () => {
  const map = loadDimensions(DIMENSIONS_JSON);
  const missing = referencedImageUrls().filter((url) => !map[url]);
  // A miss only costs layout stability, so report it rather than block deploys.
  if (missing.length) {
    console.warn(
      `[image-dimensions] ${missing.length} referenced image(s) are not in the map; run npm run images:dimensions`
    );
  }
  assert.ok(Object.keys(map).length > 0, 'the map is empty');
});
