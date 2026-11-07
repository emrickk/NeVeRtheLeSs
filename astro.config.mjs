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
import rehypeImageDimensions from './scripts/rehype/image-dimensions.mjs';
import rehypeImageGallery from './scripts/rehype/image-gallery.mjs';
import rehypeProtectedContent from './scripts/rehype/protected-content.mjs';
import { loadDimensions } from './scripts/images/dimensions.mjs';
import postEditor from './scripts/post-editor/integration.mjs';
import config from './astro-theme-config.ts';
import { toneExpressiveCodeOptions } from './src/config/expressive-code.ts';

// https://astro.build/config
// Password for posts with `protected: true` frontmatter. Read from the
// process env (CI secret) or .env.local (local builds); never committed.
const postPassword =
  process.env.POST_PASSWORD ||
  loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '').POST_PASSWORD;

// SHOW_DRAFTS=1 renders draft posts for local review builds (preview-posts,
// ship); see src/utils/drafts.ts. A deploy build must never carry it.
if (process.env.SHOW_DRAFTS === '1' && process.env.CI) {
  throw new Error('SHOW_DRAFTS=1 is for local review builds only; unset it for CI and deploy builds');
}

const configuredSite = process.env.ASTRO_SITE_URL || config.site.url;
const configuredBaseValue = process.env.ASTRO_SITE_BASE ?? config.site.base;
const configuredBase =
  configuredBaseValue === '/' ? '' : configuredBaseValue.replace(/\/$/, '');

/** @param {string} pathname */
export default defineConfig({
  site: configuredSite,
  base: configuredBase || undefined,
  integrations: [
    expressiveCode(toneExpressiveCodeOptions),
    mdx(),
    sitemap({
      // Hidden reading page: noindex and kept out of every listing.
      filter: (page) => !page.includes('/reading/hecaitou-birthdays/'),
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
        // Width and height for post images from the committed map
        // (src/data/image-dimensions.json). Passing the map as an option also
        // puts it in Astro's config digest, so a map change clears the cached
        // rendered Markdown.
        [rehypeImageDimensions, { dimensions: loadDimensions() }],
        rehypeImageGallery,
        // Keep last: encrypts the fully processed tree of protected posts.
        [rehypeProtectedContent, { password: postPassword }],
      ],
    }),
  },
});
