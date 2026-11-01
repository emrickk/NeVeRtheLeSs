import { createHash } from 'node:crypto';
import { getCollection } from 'astro:content';
import { withBase } from './paths';
import { buildTranslationMap, resolveLangText } from './translations';

// Search palette index: built once per build, served as a static JSON file
// (src/pages/search-palette.json.ts) and fetched the first time search opens.

export type SearchPaletteItem = {
  title: string;
  titleZh: string;
  titleEn: string;
  lang: 'zh' | 'en';
  description: string;
  category: string;
  href: string;
};

async function buildSearchPaletteJson() {
  const posts = (await getCollection('posts'))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  const tmap = await buildTranslationMap();

  const items: SearchPaletteItem[] = posts.map((post) => {
    const text = resolveLangText(post.data, tmap);
    return {
      title: post.data.title,
      titleZh: text.titleZh ?? post.data.title,
      titleEn: text.titleEn ?? post.data.title,
      lang: post.data.lang ?? 'zh',
      description: post.data.description,
      category: post.data.category ?? 'Post',
      href: withBase(`/posts/${post.id}/`),
    };
  });

  const json = JSON.stringify(items);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 10);
  return { json, hash };
}

let cached: ReturnType<typeof buildSearchPaletteJson> | null = null;

export function getSearchPaletteJson() {
  // Rebuild on every dev request so post edits show up without a restart.
  if (import.meta.env.DEV) return buildSearchPaletteJson();
  cached ??= buildSearchPaletteJson();
  return cached;
}

export const SEARCH_PALETTE_DATA_PATH = '/search-palette.json';
