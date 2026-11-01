// @ts-check

import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import expressiveCode from 'astro-expressive-code';
import { defineConfig } from 'astro/config';
import process from 'node:process';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import { loadEnv } from 'vite';
import rehypeImageGallery from './scripts/rehype/image-gallery.mjs';
import rehypeProtectedContent from './scripts/rehype/protected-content.mjs';
import postEditor from './scripts/post-editor/integration.mjs';
import config from './astro-theme-config.ts';
import { toneExpressiveCodeOptions } from './src/config/expressive-code.ts';

// https://astro.build/config
const sitemapExcludedPaths = new Set(['/search/']);
// Password for posts with `protected: true` frontmatter. Read from the
// process env (CI secret) or .env.local (local builds); never committed.
const postPassword =
  process.env.POST_PASSWORD ||
  loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '').POST_PASSWORD;

const configuredSite = process.env.ASTRO_SITE_URL || config.site.url;
const configuredBaseValue = process.env.ASTRO_SITE_BASE ?? config.site.base;
const configuredBase =
  configuredBaseValue === '/' ? '' : configuredBaseValue.replace(/\/$/, '');

/** @param {string} pathname */
function withoutConfiguredBase(pathname) {
  if (!configuredBase) return pathname;
  if (!pathname.startsWith(configuredBase)) return pathname;

  return pathname.slice(configuredBase.length) || '/';
}

export default defineConfig({
  site: configuredSite,
  base: configuredBase || undefined,
  integrations: [
    expressiveCode(toneExpressiveCodeOptions),
    mdx(),
    sitemap({
      filter: (page) => !sitemapExcludedPaths.has(withoutConfiguredBase(new URL(page).pathname)),
    }),
    postEditor(),
  ],
  build: {
    inlineStylesheets: 'always',
  },
  // Astro 7 changed the default to 'jsx', which strips whitespace between
  // inline elements. Keep the HTML-aware compression the site was built with.
  compressHTML: true,

  markdown: {
    // Astro 7 defaults to the Satteri processor, which does not run rehype
    // plugins. The unified (remark/rehype) pipeline keeps the plugins below.
    processor: unified({
      rehypePlugins: [
        rehypeSlug,
        [
          rehypeAutolinkHeadings,
          {
            behavior: 'append',
            properties: { ariaHidden: true, tabIndex: -1, class: 'heading-anchor' },
            content: { type: 'text', value: '#' },
          },
        ],
        rehypeImageGallery,
        // Keep last: encrypts the fully processed tree of protected posts.
        [rehypeProtectedContent, { password: postPassword }],
      ],
    }),
  },
});
