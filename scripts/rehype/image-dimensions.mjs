// Build-time intrinsic sizes for post images. Every <img> whose src is in
// the committed map (src/data/image-dimensions.json, kept by
// scripts/images/dimensions.mjs and `npm run images`) gains width and height
// attributes, so the browser reserves each photo's box before it arrives
// and the text below no longer jumps (cumulative layout shift).
//
// Runs before rehype-raw, so it handles both element images (Markdown
// `![]()`) and the raw HTML blocks that hold `<img>` tags (img-grid pairs),
// which it edits as text without reparsing them. The build stays offline:
// an image missing from the map keeps its markup and is reported once per
// file as a warning, never an error.
//
// An image is left alone when it already has a width or height attribute,
// or an inline style that sets a width or height other than auto (the
// attributes would then fight the author's sizing).

const SIZE_STYLE_RE = /(?:^|;)\s*(?:width|height)\s*:(?!\s*auto\s*(?:;|$))/i;
const RAW_IMG_RE = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

function attribute(tag, name) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i');
  const match = tag.match(re);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasAttribute(tag, name) {
  return new RegExp(`\\s${name}(?:\\s*=|[\\s/>])`, 'i').test(tag);
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sizeFor(dimensions, src) {
  if (typeof src !== 'string' || !src) return undefined;
  const size = dimensions[src] ?? dimensions[src.trim()];
  return Array.isArray(size) ? size : undefined;
}

function styleSetsSize(style) {
  return typeof style === 'string' && SIZE_STYLE_RE.test(style);
}

function visit(node, onImage, onRaw) {
  if (node.type === 'element' && node.tagName === 'img') onImage(node);
  else if (node.type === 'raw') onRaw(node);
  for (const child of node.children ?? []) visit(child, onImage, onRaw);
}

/**
 * @param {{ dimensions?: Record<string, [number, number]>, warn?: (message: string) => void }} [options]
 */
export default function rehypeImageDimensions(options = {}) {
  const dimensions = options.dimensions ?? {};
  const warn = options.warn ?? ((message) => console.warn(message));

  return (tree, file) => {
    const missing = new Set();

    const onImage = (node) => {
      const props = (node.properties ??= {});
      if (props.width !== undefined || props.height !== undefined) return;
      if (styleSetsSize(props.style)) return;
      const size = sizeFor(dimensions, props.src);
      if (!size) {
        if (props.src) missing.add(String(props.src));
        return;
      }
      props.width = size[0];
      props.height = size[1];
    };

    const onRaw = (node) => {
      if (typeof node.value !== 'string' || !/<img\b/i.test(node.value)) return;
      node.value = node.value.replace(RAW_IMG_RE, (tag) => {
        if (hasAttribute(tag, 'width') || hasAttribute(tag, 'height')) return tag;
        const style = attribute(tag, 'style');
        if (style !== undefined && styleSetsSize(decodeEntities(style))) return tag;
        const src = attribute(tag, 'src');
        const size = src === undefined ? undefined : sizeFor(dimensions, decodeEntities(src));
        if (!size) {
          if (src) missing.add(decodeEntities(src));
          return tag;
        }
        return tag.replace(/^<img\b/i, `<img width="${size[0]}" height="${size[1]}"`);
      });
    };

    visit(tree, onImage, onRaw);

    if (missing.size) {
      const where = file?.path ? ` in ${file.path}` : '';
      const list = [...missing].map((src) => `\n  ${src}`).join('');
      warn(
        `[image-dimensions] ${missing.size} image(s)${where} have no width/height ` +
          `(run npm run images:dimensions):${list}`
      );
    }
  };
}
