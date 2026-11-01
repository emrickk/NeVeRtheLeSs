type SearchItem = {
  title: string;
  titleZh?: string;
  titleEn?: string;
  lang?: 'zh' | 'en';
  description: string;
  category: string;
  href: string;
};

const MAX_RESULTS = 6;
let paletteApi: { open: () => void; close: () => void } | null = null;

function normalize(value: string) {
  return value.toLocaleLowerCase().trim();
}

let itemsRequest: Promise<SearchItem[]> | null = null;

// Fetch the post index once, on first open. A failed request is forgotten so
// the next open (or keystroke) tries again.
function loadItems(src: string): Promise<SearchItem[]> {
  itemsRequest ??= fetch(src)
    .then((response) => {
      if (!response.ok) throw new Error(`Search index request failed: ${response.status}`);
      return response.json();
    })
    .then((parsed: unknown) => (Array.isArray(parsed) ? (parsed as SearchItem[]) : []))
    .catch((error: unknown) => {
      itemsRequest = null;
      throw error;
    });
  return itemsRequest;
}

function scoreItem(item: SearchItem, query: string) {
  if (!query) return 1;
  // Match against both language titles so search works in either language.
  const titles = [item.title, item.titleZh ?? '', item.titleEn ?? '']
    .map(normalize)
    .filter(Boolean);
  const category = normalize(item.category);
  const description = normalize(item.description);
  const haystack = `${titles.join(' ')} ${category} ${description}`;

  if (titles.some((t) => t === query)) return 100;
  if (titles.some((t) => t.startsWith(query))) return 80;
  if (titles.some((t) => t.includes(query))) return 60;
  if (category.includes(query)) return 40;
  if (description.includes(query)) return 20;
  if (query.split(/\s+/).every((part) => haystack.includes(part))) return 10;
  return 0;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[char];
  });
}

// Both-language title spans; global lang.css hides the inactive one and the
// toggle updates it live without re-rendering.
function titleSpans(item: SearchItem) {
  const orig = item.lang === 'en' ? 'en' : 'zh';
  const zh = escapeHtml(item.titleZh ?? item.title);
  const en = escapeHtml(item.titleEn ?? item.title);
  // Each span's lang names the text it holds. The index fills a missing
  // translation with the original title, so a span equal to it keeps the
  // original language.
  const code = (lang: 'zh' | 'en') => (lang === 'en' ? 'en' : 'zh-CN');
  const zhLang = code(orig === 'zh' || zh === escapeHtml(item.title) ? orig : 'zh');
  const enLang = code(orig === 'en' || en === escapeHtml(item.title) ? orig : 'en');
  return (
    `<span class="lang lang-zh" lang="${zhLang}"${orig === 'zh' ? ' data-orig' : ''}>${zh}</span>` +
    `<span class="lang lang-en" lang="${enLang}"${orig === 'en' ? ' data-orig' : ''}>${en}</span>`
  );
}

export function mountSearchPalette(root: ParentNode = document) {
  const dialog = root.querySelector('[data-search-palette]');
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (dialog.dataset.ready === 'true') return;
  dialog.dataset.ready = 'true';

  const input = dialog.querySelector('[data-search-palette-input]');
  const results = dialog.querySelector('[data-search-palette-results]');
  const closeButton = dialog.querySelector('[data-search-palette-close]');
  if (!(input instanceof HTMLInputElement) || !(results instanceof HTMLElement)) return;

  const src = dialog.dataset.searchPaletteSrc ?? '';
  let items: SearchItem[] | null = null;
  let loadFailed = false;
  let loadPending = false;
  let activeIndex = 0;
  let renderedItems: SearchItem[] = [];

  const syncActiveItem = () => {
    results.querySelectorAll<HTMLElement>('[data-search-palette-item]').forEach((item) => {
      item.classList.toggle('is-active', Number(item.dataset.index || 0) === activeIndex);
    });
  };

  const showStatus = (message: string) => {
    renderedItems = [];
    results.innerHTML = `<p class="search-palette-empty" role="status">${message}</p>`;
  };

  const ensureItems = () => {
    if (items || loadPending) return;
    loadPending = true;
    results.setAttribute('aria-busy', 'true');
    loadItems(src)
      .then((loaded) => {
        items = loaded;
      })
      .catch(() => {
        loadFailed = true;
      })
      .finally(() => {
        loadPending = false;
        results.removeAttribute('aria-busy');
        if (dialog.open) render();
      });
  };

  const render = () => {
    if (!items) {
      if (loadFailed) {
        showStatus('Search could not load. Check your connection and try again.');
      } else {
        showStatus('Loading posts…');
        ensureItems();
      }
      return;
    }

    const query = normalize(input.value);
    renderedItems = items
      .map((item) => ({ item, score: scoreItem(item, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map(({ item }) => item);

    activeIndex = Math.min(activeIndex, Math.max(renderedItems.length - 1, 0));

    if (renderedItems.length === 0) {
      results.innerHTML = '<p class="search-palette-empty">No matching posts.</p>';
      return;
    }

    results.innerHTML = renderedItems
      .map(
        (item, index) => `
          <a
            class="search-palette-item${index === activeIndex ? ' is-active' : ''}"
            href="${escapeHtml(item.href)}"
            data-search-palette-item
            data-index="${index}"
          >
            <span class="search-palette-item-main">
              <span class="search-palette-item-title">${titleSpans(item)}</span>
              <span class="search-palette-item-desc">${escapeHtml(item.description)}</span>
            </span>
            <span class="search-palette-item-meta">${escapeHtml(item.category)}</span>
          </a>
        `
      )
      .join('');
  };

  const open = () => {
    if (dialog.open) {
      requestAnimationFrame(() => input.focus());
      return;
    }

    dialog.showModal();
    input.value = '';
    activeIndex = 0;
    loadFailed = false;
    render();
    requestAnimationFrame(() => input.focus());
  };

  const close = () => {
    if (dialog.open) dialog.close();
  };

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const isEditable =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    if (!dialog.open || (isEditable && target !== input)) return;

    if (event.key === 'Escape') {
      close();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, renderedItems.length - 1);
      render();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
      return;
    }

    if (event.key === 'Enter' && renderedItems[activeIndex]) {
      event.preventDefault();
      window.location.href = renderedItems[activeIndex].href;
    }
  });

  input.addEventListener('input', () => {
    activeIndex = 0;
    if (!items) loadFailed = false;
    render();
  });

  closeButton?.addEventListener('click', () => {
    close();
  });

  results.addEventListener('mouseover', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-search-palette-item]');
    if (!item) return;
    activeIndex = Number(item.dataset.index || 0);
    syncActiveItem();
  });

  dialog.addEventListener('cancel', () => {
    close();
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  paletteApi = { open, close };
}

export function openSearchPalette() {
  paletteApi?.open();
}
