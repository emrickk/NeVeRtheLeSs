import { withBase } from '../utils/paths';

type PagefindUIOptions = {
  element: string;
  showSubResults: boolean;
  translations: {
    placeholder: string;
    zero_results: string;
  };
};

declare global {
  interface Window {
    PagefindUI?: new (options: PagefindUIOptions) => unknown;
  }
}

const isProductionBuild = import.meta.env.PROD;

const COPY = {
  placeholder: { zh: '搜索文章…', en: 'Search posts…' },
  zeroResults: { zh: '没有找到与 [QUERY] 相关的结果', en: 'No results for [QUERY]' },
  unavailable: {
    zh: '搜索要在正式构建之后才能使用。',
    en: 'Search is available after a production build.',
  },
};

function currentLang(): 'zh' | 'en' {
  return document.documentElement.getAttribute('data-lang') === 'zh' ? 'zh' : 'en';
}

function langSpans(text: { zh: string; en: string }) {
  const zh = document.createElement('span');
  zh.className = 'lang lang-zh';
  zh.lang = 'zh-CN';
  zh.dataset.orig = '';
  zh.textContent = text.zh;
  const en = document.createElement('span');
  en.className = 'lang lang-en';
  en.lang = 'en';
  en.textContent = text.en;
  return [zh, en];
}

// The recent-posts list sits under the empty box and hides once the reader
// types. Pagefind's clear button empties the input without an input event,
// so clicks inside the search UI re-check too.
function mountRecentToggle(el: HTMLElement) {
  const recent = document.querySelector<HTMLElement>('[data-search-recent]');
  if (!recent) return;
  const sync = () => {
    const input = el.querySelector<HTMLInputElement>('input');
    recent.hidden = Boolean(input && input.value.trim());
  };
  el.addEventListener('input', sync);
  el.addEventListener('click', () => requestAnimationFrame(sync));
  sync();
}

// Pagefind fixes its translations at start-up; keep the placeholder on the
// toggle's language afterwards.
function mountPlaceholderSync(el: HTMLElement) {
  const sync = () => {
    const input = el.querySelector<HTMLInputElement>('input');
    if (input) input.placeholder = COPY.placeholder[currentLang()];
  };
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-lang'],
  });
}

function loadPagefindCss() {
  if (document.querySelector('link[data-pagefind-ui-css]')) return;

  const link = document.createElement('link');
  link.href = withBase('/pagefind/pagefind-ui.css');
  link.rel = 'stylesheet';
  link.dataset.pagefindUiCss = 'true';
  document.head.append(link);
}

async function loadPagefindUi() {
  if (window.PagefindUI) return Promise.resolve();
  if (!isProductionBuild) {
    throw new Error('Pagefind UI is not available');
  }

  loadPagefindCss();

  const existing = document.querySelector<HTMLScriptElement>('script[data-pagefind-ui]');
  if (existing) {
    return new Promise<void>((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', reject, { once: true });
    });
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = withBase('/pagefind/pagefind-ui.js');
    script.dataset.pagefindUi = 'true';
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.append(script);
  });
}

async function initSearchPage() {
  const el = document.getElementById('search');
  if (!el || el.dataset.pagefindReady === 'true') return;
  el.dataset.pagefindReady = 'true';
  try {
    await loadPagefindUi();
    if (!window.PagefindUI) throw new Error('Pagefind UI failed to load');
    el.replaceChildren();
    const lang = currentLang();
    new window.PagefindUI({
      element: '#search',
      showSubResults: true,
      translations: {
        placeholder: COPY.placeholder[lang],
        zero_results: COPY.zeroResults[lang],
      },
    });
    el.setAttribute('aria-busy', 'false');
    mountPlaceholderSync(el);
    mountRecentToggle(el);
  } catch {
    el.setAttribute('aria-busy', 'false');
    el.replaceChildren(...langSpans(COPY.unavailable));
  }
}

export function mountSearchPage() {
  void initSearchPage();
}
