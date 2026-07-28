type NavItem = {
  label: string;
  href: string;
  /** Optional zh label; when set the header renders a toggle-aware pair. */
  labelZh?: string;
};

/**
 * astro-theme-config.ts
 *
 * Central configuration for the Tone theme.
 * Most site-level customization should happen in this file.
 */

const config = {
  site: {
    /** Production origin, used for canonical links, sitemap, and Open Graph metadata. */
    url: 'https://theneverless.com',
    /** Subpath such as '/repo-name'. Keep empty when deploying at a domain root. */
    base: '',
    lang: 'zh-CN',
    locale: 'zh_CN',
    dateLocale: 'zh-CN',
    title: 'NeVeRtheLeSs',
    logoLabel: 'NeVeRtheLeSs',
    description: '2005 年至今的个人博客 · personal blog since 2005',
    /** Language-specific descriptions shown on the homepage hero; they swap with the EN·中 toggle. */
    descriptionZh: '一些成果：常常随机，时而混乱，很少算得上完成。',
    descriptionEn: 'Some outcomes here: often random, sometimes chaotic, rarely ready.',
    author: 'NeVeRtheLeSs',
    /** Optional absolute or root-relative image URL for homepage/search/about social previews. */
    defaultOgImage: '/og.png',
  },

  // The logo already links to `/`. Add items here if you want visible header links.
  // Example: [{ label: 'Posts', href: '/posts' }, { label: 'About', href: '/about' }]
  nav: [
    { label: 'Posts', labelZh: '文章', href: '/posts' },
    { label: 'Notes', labelZh: '随记', href: '/notes' },
    { label: 'Library', labelZh: '书影音', href: '/library' },
  ] as NavItem[],

  // Footer links stay visible by default so readers have a stable way to move around.
  footerNav: [
    { label: 'Posts', href: '/posts' },
    { label: 'About', href: '/about' },
    { label: 'Search', href: '/search' },
  ] as NavItem[],

  content: {
    categoryOrder: ['Journal', 'Things', 'Prodigal', 'Words', 'Repost'],
    /**
     * Bilingual display names for post categories; they swap with the EN·中
     * toggle. Frontmatter keeps the raw key. Unmapped categories show the
     * raw key in both languages.
     */
    categoryLabels: {
      Words: { zh: '随想', en: 'Musings' },
      Journal: { zh: '日志', en: 'Journal' },
      Repost: { zh: '转载', en: 'Repost' },
      Things: { zh: '琢磨', en: 'Mulling' },
      Prodigal: { zh: '败家', en: 'Splurges' },
    } as Record<string, { zh: string; en: string }>,
  },

  behavior: {
    smoothScroll: true,
  },

  comments: {
    // One-line switch after you fill the giscus values:
    // mode: 'off'           -> no comments
    // mode: 'giscus'        -> original giscus theme
    // mode: 'giscus-custom' -> Tone custom giscus theme
    // Local preview can also use PUBLIC_GISCUS_MODE and PUBLIC_GISCUS_* in .env.local.
    mode: 'giscus-custom',
    provider: 'giscus',
    giscus: {
      repo: 'emrickk/emrickk.github.io',
      repoId: 'R_kgDOTWatYA',
      category: 'Announcements',
      categoryId: 'DIC_kwDOTWatYM4DBD9Y',
      mapping: 'pathname',
      strict: '0',
      reactionsEnabled: '1',
      emitMetadata: '0',
      inputPosition: 'bottom',
      theme: 'preferred_color_scheme',
      customLightTheme: '/giscus-light.css',
      customDarkTheme: '/giscus-dark.css',
      lang: 'en',
      loading: 'eager',
    },
  },

  social: {
    website: '', // e.g. 'https://your-site.com'
    email: '', // e.g. 'hello@your-site.com'
    linkedin: '', // e.g. 'https://www.linkedin.com/in/yourhandle'
    github: '', // e.g. 'https://github.com/yourhandle'
  },

  about: {
    /** Profile image URL. Leave empty to use the text-only About layout. */
    profileImage: '',
    name: 'NeVeRtheLeSs',
    /** Every {zh, en} pair below swaps with the EN·中 toggle. */
    role: { zh: '居然还在', en: 'Still here, somehow' },
    location: { zh: '地球某处', en: 'Somewhere on Earth' },
    focus: { zh: '生活，以及碰巧留意到的东西', en: 'Life and whatever catches my attention' },
    lead: {
      zh: '这个博客是 2005 年开始写的。二十多年过去，留下来的东西却比你想象的少得多。所以其实也没那么深。',
      en: 'This blog started in 2005. More than twenty years later, there is far less here than you might expect. So, not that deep after all.',
    },
    headline: ['Still waters', 'run deep.'],
    statementLabel: { zh: '关于博客', en: 'About the Blog' },
    statementTitle: { zh: '写写停停', en: 'On and off' },
    statement: {
      zh: '这里没有固定主题。我随手写下当时在想的、在做的，偶尔也回头总结一下生活。看看最新一篇的日期大概就知道了：你来的时候，这个博客多半已经停更几个月了。',
      en: "There's no fixed topic here. I write down whatever I happen to be thinking or doing, plus the occasional look back at life. And the date on the latest post probably gives it away: depending on when you drop by, odds are this blog has been quiet for a few months.",
    },
    careerLabel: { zh: '几个年份', en: 'A Few Dates' },
    career: [
      {
        period: { zh: '2005', en: '2005' },
        title: { zh: '开始写博客', en: 'Started the blog' },
        description: {
          zh: '那时候当然没想到，它会留到今天。',
          en: 'I did not expect it to last this long.',
        },
      },
      {
        period: { zh: '2018', en: '2018' },
        title: { zh: '搬到太平洋另一边', en: 'Moved across the Pacific' },
        description: {
          zh: '这个博客也跟着一起过来了。',
          en: 'The blog came with me.',
        },
      },
      {
        period: { zh: '现在', en: 'Now' },
        title: { zh: '在做下一代娱乐产品', en: 'Building next-generation entertainment products' },
        description: {
          zh: '博客要是再停更，多半就是因为它。',
          en: 'If the blog goes quiet again, this is probably why.',
        },
      },
    ],
    interests: [
      {
        zh: '去过的地方，和从那里带回来的照片',
        en: 'Places I have been and photographs I brought back',
      },
      {
        zh: '用过、做过，或者想得太多的东西',
        en: 'Things I have used, worked on, or thought too much about',
      },
      { zh: '一些不想就这么忘掉的小事', en: 'Small moments I wanted to keep somewhere' },
    ],
    interestsLabel: { zh: '随记', en: 'Notes' },
    interestsHeading: { zh: '最后留在这里的东西', en: 'What ends up here' },
  },
};

export default config;
