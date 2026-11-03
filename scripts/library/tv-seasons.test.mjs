import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupTvSeasons, seasonLabel, seasonRatingLines } from '../../src/utils/tv-seasons.ts';

const DATA = join(import.meta.dirname, '..', '..', 'src', 'data', 'library');
const read = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));

const season = (s, fields = {}) => ({
  id: `show-${s}`,
  t: 'Show',
  tv: true,
  s,
  cv: `show-${s}.jpg`,
  ...fields,
});

test('seasonLabel uses a range for contiguous seasons and a list otherwise', () => {
  assert.equal(seasonLabel(['4', '5', '6']), '4-6');
  assert.equal(seasonLabel(['4', '6']), '4, 6');
  assert.equal(seasonLabel(['1-4', '5-7', '8-9']), '1-9');
  assert.equal(seasonLabel(['1-4', '6']), '1-4, 6');
  assert.equal(seasonLabel(['3']), '3');
  const simpsons = [...Array(25).keys()]
    .map((i) => `${i + 1}`)
    .filter((s) => !['14', '16'].includes(s));
  assert.equal(seasonLabel(simpsons), '1-13, 15, 17-25');
  assert.equal(seasonLabel(['1', '2', '4', '5', '7']), '1-2, 4-5, 7');
});

test('seasonRatingLines merges consecutive seasons with the same rating', () => {
  const lines = (rows) => seasonRatingLines(rows.map(([s, r]) => ({ s, r })));
  assert.deepEqual(
    lines([
      ['1', 5],
      ['2', 5],
      ['3', 5],
      ['4', 5],
      ['5', 4],
      ['6', 4],
      ['7', 4],
      ['8', 5],
    ]),
    [
      { s: '1-4', r: 5 },
      { s: '5-7', r: 4 },
      { s: '8', r: 5 },
    ]
  );
  // A gap in the logged seasons, or an unrated season, ends the run.
  assert.deepEqual(
    lines([
      ['1', 4],
      ['3', 4],
      ['4', 4],
      ['5', undefined],
      ['6', 4],
    ]),
    [
      { s: '1', r: 4 },
      { s: '3-4', r: 4 },
      { s: '6', r: 4 },
    ]
  );
  // Half stars only merge with the same half star; range seasons extend runs.
  assert.deepEqual(
    lines([
      ['1-2', 4.5],
      ['3', 4.5],
      ['4', 4],
    ]),
    [
      { s: '1-3', r: 4.5 },
      { s: '4', r: 4 },
    ]
  );
});

test('films and single-season shows pass through unchanged', () => {
  const film = { id: 'f', t: 'Film', y: 2020, r: 4, m: '2024-01-01', cv: 'f.jpg' };
  const show = season('2', { y: 2021, r: 3, c: 'note', m: '2024-01-02' });
  const rows = [show, film];
  const out = groupTvSeasons(rows);
  assert.deepEqual(out, rows);
  assert.equal(out[0], show);
  assert.equal(out[1], film);
});

test('seasons merge into one card at the latest logged season', () => {
  const rows = [
    { id: 'a', t: 'A', m: '2026-08-01' },
    season('4', { y: 2023, r: 2, c: '同上一季：强行上价值', m: '2026-07-29' }),
    { id: 'b', t: 'B', m: '2026-07-29' },
    season('6', { y: 2025, r: 4.5, c: '还是那个味儿！', m: '2026-07-29' }),
    season('5', { y: 2024, r: 4, m: '2026-07-28' }),
    { id: 'c', t: 'C', m: '2026-07-01' },
  ];
  const out = groupTvSeasons(rows);
  assert.deepEqual(
    out.map((row) => row.id),
    ['a', 'b', 'show-6', 'c']
  );
  assert.deepEqual(out[2], {
    id: 'show-6',
    t: 'Show',
    tv: true,
    s: '4-6',
    y: '2023-2025',
    cv: 'show-6.jpg',
    m: '2026-07-29',
    c: 'S4: 同上一季：强行上价值\nS6: 还是那个味儿！',
    seasonRatings: [
      { s: '4', r: 2 },
      { s: '5', r: 4 },
      { s: '6', r: 4.5 },
    ],
  });
});

test('the latest log date wins over a higher season number', () => {
  const out = groupTvSeasons([season('1', { m: '2026-01-01' }), season('2', { m: '2025-01-01' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'show-1');
  assert.equal(out[0].cv, 'show-1.jpg');
  assert.equal(out[0].s, '1-2');
});

test('gaps, unrated seasons, one year and range seasons', () => {
  const [card] = groupTvSeasons([
    season('6', { y: 2020, m: '2024-02-01' }),
    season('1-4', { y: 2020, r: 5, m: '2024-01-01' }),
  ]);
  assert.equal(card.s, '1-4, 6');
  assert.equal(card.y, 2020);
  assert.equal('seasonRatings' in card, false);
  assert.equal(card.r, 5, 'a single rated season keeps the card rating');
  assert.equal('c' in card, false);

  const [same] = groupTvSeasons([
    season('1', { r: 4, m: '2024-01-01' }),
    season('2', { r: 4, m: '2024-01-02' }),
  ]);
  assert.equal('seasonRatings' in same, false, 'no line that repeats the card stars');
  assert.equal(same.r, 4, 'one merged line keeps the card rating');

  const [unrated] = groupTvSeasons([season('1'), season('2')]);
  assert.equal('r' in unrated, false);
  assert.equal('seasonRatings' in unrated, false);
  assert.equal('y' in unrated, false);
});

test('rows already grouped and rows without a season are left alone', () => {
  const office = {
    id: 'local-office',
    t: 'Show',
    tv: true,
    s: '1-9',
    seasonRatings: [
      { s: '1-4', r: 5 },
      { s: '5-9', r: 4 },
    ],
  };
  const special = { id: 'special', t: 'Show', tv: true, y: 2003, r: 5 };
  const rows = [office, special, season('1', { r: 5 })];
  assert.deepEqual(groupTvSeasons(rows), rows);
});

test('the real film shelf has one card per TV show title', () => {
  const local = read('movies-local.json');
  const ids = new Set(local.map((row) => row.id));
  const rows = [...local, ...read('movies.json').filter((row) => !ids.has(row.id))];
  const cards = groupTvSeasons(rows);
  const seasonal = cards.filter((row) => row.tv && row.s);
  assert.equal(new Set(seasonal.map((row) => row.t)).size, seasonal.length);
  assert.ok(cards.length < rows.length);
  // The local Office card is kept as written.
  assert.equal(
    cards.find((row) => row.id === 'local-the-office-us-seasons-1-9'),
    local.find((row) => row.id === 'local-the-office-us-seasons-1-9')
  );
});
