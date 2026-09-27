import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  // Primary posts only — exclude `*.en.md` / `*.zh.md` sibling translations so
  // routes, list views, and RSS come from primaries and URLs stay unchanged.
  loader: glob({
    base: './src/content/posts',
    pattern: ['**/*.{md,mdx}', '!**/*.{en,zh}.{md,mdx}'],
  }),
  // Type-check frontmatter using a schema. The .describe() texts surface as
  // hover help in editors (Astro writes them into the generated JSON schema);
  // they document what each field changes for readers on the site.
  schema: ({ image }) =>
    z.object({
      title: z
        .string()
        .describe(
          'Post title, in the language of this file. Readers see it on the post page, home cards, the browser tab, RSS, and link previews.',
        ),
      description: z
        .string()
        .describe(
          'One-line summary. Readers see it on home cards and in RSS; search engines and chat apps show it under shared links.',
        ),
      // Transform string to Date object
      pubDate: z.coerce
        .date()
        .describe(
          'Publication date shown on the post; also orders posts on the home page, feed, and RSS.',
        ),
      readingTime: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional reading time in minutes for posts whose text is rendered by a component.'),
      // The glob loader uses data.slug as the entry id when present, so this
      // overrides the URL that otherwise comes from the filename.
      slug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits, and hyphens only')
        .optional()
        .describe(
          'Custom URL for this post: theneverless.com/posts/<slug>/. Lowercase letters, digits, and hyphens. Empty uses the filename. Changing it on a published post breaks existing links to the old URL.',
        ),
      updatedDate: z.coerce
        .date()
        .optional()
        .describe(
          'Optional last-updated date. Shown on the post next to the publication date and sent to search engines as the modified time.',
        ),
      heroImage: z
        .optional(image())
        .describe(
          'Cover image. Used on home cards and as the link preview image; appears at the top of the post page only when Show Hero is on. Lives in src/assets/hero, minimum size in docs/images.md.',
        ),
      showHero: z
        .boolean()
        .default(false)
        .describe(
          'Render the cover image at the top of the post page itself. Off means the cover only appears on home cards and link previews.',
        ),
      focusEffect: z
        .literal('scroll-dark')
        .optional()
        .describe(
          'Reading effect on the post page: scroll-dark dims the page around the passage being read as the reader scrolls. Leave empty for a normal page.',
        ),
      category: z
        .string()
        .optional()
        .describe(
          'Raw category key: Journal, Things, Prodigal, Words, or Repost. Readers see the bilingual display name mapped in categoryLabels in astro-theme-config.ts, so rename categories there, never here.',
        ),
      homeFeatured: z
        .boolean()
        .default(false)
        .describe(
          'Give this post one of the big featured cards at the top of the home page.',
        ),
      homeHeroOrder: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Pin this post into the home hero cards at this position (1 is first). Leave empty to let recency decide.',
        ),
      homeOrder: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Pin this post at a fixed position in the home page list (1 is first). Leave empty for date order.',
        ),
      draft: z
        .boolean()
        .default(false)
        .describe(
          'Hide this post from the site: it disappears from the home page, feed, and RSS until turned off.',
        ),
      // Password-protected body: encrypted at build time by
      // scripts/rehype/protected-content.mjs. Bilingual posts must set this
      // in the sibling translation too. Runbook: docs/protected-posts.md.
      protected: z
        .boolean()
        .default(false)
        .describe(
          'Encrypt the post body at build time; readers need the password to read it. Title, description, and cover stay public. Must be set in BOTH language files.',
        ),
      // Bilingual support. `lang` is the post's original language; `title`
      // and `description` above are in that language. The other language's
      // title, description, and body live in the sibling translation file.
      lang: z
        .enum(['zh', 'en'])
        .optional()
        .describe(
          'The language this file is written in. Drives which version the language toggle on the site shows readers.',
        ),
      translationKey: z
        .string()
        .optional()
        .describe(
          'Pairs this post with its sibling translation file for the site language toggle. Wiring: do not edit.',
        ),
    }),
});

const translations = defineCollection({
  // Sibling translation bodies: `<slug>.en.md` / `<slug>.zh.md`.
  loader: glob({
    base: './src/content/posts',
    pattern: '**/*.{en,zh}.{md,mdx}',
  }),
  schema: z.object({
    translationKey: z
      .string()
      .describe(
        'Pairs this translation with its primary post for the site language toggle. Wiring: do not edit.',
      ),
    lang: z
      .enum(['zh', 'en'])
      .describe(
        'The language this file is written in. Drives which version the language toggle on the site shows readers.',
      ),
    // Display title/description for this language. Optional so a post builds
    // mid-translation; the theme falls back to the primary's title/description.
    title: z
      .string()
      .optional()
      .describe(
        'Title in this language. Shown to readers using this language; falls back to the primary title when empty.',
      ),
    description: z
      .string()
      .optional()
      .describe(
        'Summary in this language. Shown to readers using this language; falls back to the primary description when empty.',
      ),
    // Must match the primary post's flag; posts/[...slug].astro enforces it.
    protected: z
      .boolean()
      .default(false)
      .describe(
        'Must match the primary file. Encrypts this body at build time; readers need the password.',
      ),
  }),
});

const notes = defineCollection({
  // Microblog notes imported from the X/Twitter archive by
  // scripts/migrate/tweets_import.py. One file per tweet or self-thread,
  // keyed by tweetId; bodies are verbatim tweet text (mechanical
  // transforms only). No titles, no drafts, no bilingual siblings.
  loader: glob({
    base: './src/content/notes',
    pattern: '**/*.md',
  }),
  schema: z.object({
    date: z.coerce.date(),
    tweetId: z.string(),
    source: z.string().url(),
    tweetCount: z.number().int().positive(),
  }),
});

export const collections = { posts, translations, notes };
