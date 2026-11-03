// Off Duty section tabs: one sideways-scrolling row (same behavior as the
// post feed's category filters). Keeps the edge-fade state classes and the
// arrow buttons in sync, and brings the current tab into view on load.
export function mountLibraryTabs() {
  const rail = document.querySelector<HTMLElement>('[data-library-tabs]');
  const list = rail?.querySelector<HTMLElement>('[data-library-tab-list]');
  if (!rail || !list) return;
  const buttons = [...rail.querySelectorAll<HTMLButtonElement>('[data-library-tabs-scroll]')];

  const update = () => {
    const maxScroll = list.scrollWidth - list.clientWidth;
    const hasOverflow = maxScroll > 1;
    const atStart = list.scrollLeft <= 1;
    const atEnd = list.scrollLeft >= maxScroll - 1;
    rail.classList.toggle('has-overflow', hasOverflow);
    rail.classList.toggle('is-at-start', !hasOverflow || atStart);
    rail.classList.toggle('is-at-end', !hasOverflow || atEnd);
    buttons.forEach((button) => {
      const direction = button.dataset.libraryTabsScroll;
      button.disabled =
        !hasOverflow || (direction === 'prev' && atStart) || (direction === 'next' && atEnd);
    });
  };

  // Center the current tab in the row without scrolling the page itself.
  const current = list.querySelector<HTMLElement>('[aria-current="page"]');
  if (current && list.scrollWidth > list.clientWidth) {
    list.scrollLeft = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const direction = button.dataset.libraryTabsScroll === 'prev' ? -1 : 1;
      const distance = Math.max(list.clientWidth * 0.62, 160);
      list.scrollBy({ left: direction * distance, behavior: 'smooth' });
    });
  });

  list.addEventListener('scroll', update, { passive: true });
  list.addEventListener(
    'wheel',
    (event) => {
      if (list.scrollWidth <= list.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      list.scrollLeft += delta;
    },
    { passive: false }
  );
  window.addEventListener('resize', update);
  update();
}
