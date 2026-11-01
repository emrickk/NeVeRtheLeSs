import process from 'node:process';

/**
 * Whether `draft: true` posts get a page at their normal /posts/<slug>/ URL:
 * in `astro dev`, and in the safety tools' review builds (preview-posts and
 * ship set SHOW_DRAFTS=1). Never in `npm run build` or CI; astro.config.mjs
 * refuses SHOW_DRAFTS=1 when CI is set. Draft pages are noindex, carry a
 * visible Draft marker, and stay out of every list, feed, and search index.
 */
export const SHOW_DRAFTS = import.meta.env.DEV || process.env.SHOW_DRAFTS === '1';
