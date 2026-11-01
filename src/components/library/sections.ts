// Off Duty library sections. /library/ is the overview; each section has its
// own statically rendered page at /library/<id>/.
export const LIBRARY_SECTIONS = [
  { id: 'movies', zh: '影视', en: 'Films' },
  { id: 'books', zh: '书籍', en: 'Books' },
  { id: 'games', zh: '游戏', en: 'Games' },
  { id: 'cars', zh: '车模', en: 'Model cars' },
  { id: 'hotels', zh: '酒店', en: 'Hotels' },
] as const;

export type LibrarySectionId = (typeof LIBRARY_SECTIONS)[number]['id'];
export type LibraryView = 'overview' | LibrarySectionId;

// The overview previews the first few items of each shelf.
export const OVERVIEW_GRID_ITEMS = 6;
export const OVERVIEW_CARS_PER_SCALE = 4;
