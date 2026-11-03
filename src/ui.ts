// Reader-visible UI strings. Each {zh, en} pair renders through LangText
// (visible text) or langPair (attributes, which cannot hold two spans), so
// the EN·中 toggle switches it with the rest of the page.
export type LangPair = { zh: string; en: string };

/** One attribute value for both languages, in the LangToggle style: "中文 / English". */
export function langPair(text: LangPair) {
  return text.zh === text.en ? text.en : `${text.zh} / ${text.en}`;
}

const ui = {
  backLink: { zh: '← 全部文章', en: '← All Posts' },
  readingTime: (n: number): LangPair => ({ zh: `约 ${n} 分钟`, en: `${n} min read` }),
  updated: { zh: '更新于', en: 'Updated' },
  relatedPosts: { zh: '相关文章', en: 'Related' },
  allPosts: { zh: '全部文章 →', en: 'All Posts →' },
  postNav: {
    label: { zh: '上一篇和下一篇', en: 'Post navigation' },
    older: { zh: '← 较早', en: '← Older' },
    newer: { zh: '较新 →', en: 'Newer →' },
  },
  postsEyebrow: { zh: '存档', en: 'Archive' },
  postsTitle: { zh: '全部文章', en: 'All Posts' },
  // The homepage tagline is the owner's wording, kept in English in both modes.
  heroTitle: 'Keep thinking.',
  heroTitleLine2: '',
  viewAll: { zh: '全部文章 →', en: 'All Posts →' },
  readLink: { zh: '阅读 →', en: 'Read →' },
  selectedPosts: { zh: '精选文章', en: 'Selected posts' },
  postFeed: {
    all: { zh: '全部', en: 'All' },
    filterLabel: { zh: '按分类筛选文章', en: 'Filter posts by category' },
    previousCategories: { zh: '向左滚动分类', en: 'Scroll categories left' },
    nextCategories: { zh: '向右滚动分类', en: 'Scroll categories right' },
    empty: { zh: '没有符合条件的文章。', en: 'No posts match this filter.' },
    more: { zh: '加载更多', en: 'Load more' },
    read: { zh: '阅读', en: 'Read' },
  },
  notes: {
    eyebrow: { zh: '微博客', en: 'Microblog' },
    title: { zh: '随记', en: 'Notes' },
    description: '2010 年至今的微博客存档 · microblog archive from X/Twitter',
    onX: { zh: 'X 原帖', en: 'on X' },
    empty: { zh: '还没有随记。', en: 'No notes yet.' },
  },
  header: {
    skipLink: { zh: '跳到正文', en: 'Skip to content' },
    navLabel: { zh: '主导航', en: 'Primary navigation' },
  },
  comments: { zh: '评论', en: 'Comments' },
  footer: {
    label: { zh: '页脚导航', en: 'Footer navigation' },
  },
};

export function getUiText() {
  return ui;
}
