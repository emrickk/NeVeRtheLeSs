// The media snapshot logs each TV season as its own row. The library shows one
// card per show: groupTvSeasons merges a show's season rows (same exact title)
// into the card shape movies-local.json already uses for The Office, with the
// seasons in `s` and one rating line per run of same-rated seasons in
// `seasonRatings`.

export type SeasonRating = { s: string; r: number };

type SeasonFields = {
  t: string;
  y?: number | string;
  tv?: boolean;
  s?: string;
  r?: number;
  seasonRatings?: SeasonRating[];
  c?: string;
  m?: string;
};

export type GroupedRow<T> = Omit<T, 'y' | 'seasonRatings'> & {
  y?: number | string;
  seasonRatings?: SeasonRating[];
};

/** First and last season numbers of "4" or "1-4"; NaN when not numeric. */
const seasonBounds = (s: string) => {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s);
  if (!match) return [NaN, NaN];
  const first = Number(match[1]);
  return [first, match[2] ? Number(match[2]) : first];
};

const bySeason = (a: string, b: string) => {
  const [x] = seasonBounds(a);
  const [y] = seasonBounds(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  return x - y;
};

/**
 * Splits season-sorted items into runs of consecutive seasons (each starts
 * one after the previous run's last) for which `sameRun` also holds, and
 * labels each run "4" or "4-6". A season that is not a number stands alone.
 */
function seasonRuns<T>(items: T[], season: (item: T) => string, sameRun: (a: T, b: T) => boolean) {
  const runs: { s: string; first: number; last: number; items: T[] }[] = [];
  for (const item of items) {
    const [first, last] = seasonBounds(season(item));
    const run = runs[runs.length - 1];
    if (
      run &&
      !Number.isNaN(first) &&
      first === run.last + 1 &&
      sameRun(run.items[run.items.length - 1], item)
    ) {
      run.last = last;
      run.items.push(item);
    } else {
      runs.push({ s: season(item), first, last, items: [item] });
    }
  }
  return runs.map((run) => ({
    ...run,
    s: Number.isNaN(run.first)
      ? run.s
      : run.first === run.last
        ? `${run.first}`
        : `${run.first}-${run.last}`,
  }));
}

/** Seasons (sorted) as "1-13, 15, 17-25": consecutive seasons become a range. */
export function seasonLabel(seasons: string[]) {
  return seasonRuns(
    seasons,
    (s) => s,
    () => true
  )
    .map((run) => run.s)
    .join(', ');
}

/**
 * One rating line per run of consecutive seasons with the same rating, the
 * way The Office reads ("1-4" 5 stars, "5-7" 4 stars). An unrated season
 * breaks the run and gets no line.
 */
export function seasonRatingLines(seasons: { s: string; r?: number }[]): SeasonRating[] {
  return seasonRuns(
    seasons,
    (row) => row.s,
    (a, b) => Boolean(a.r) && a.r === b.r
  )
    .filter((run) => run.items[0].r)
    .map((run) => ({ s: run.s, r: run.items[0].r! }));
}

/**
 * One row per TV show. Rows with `tv` and a season `s` that share an exact
 * title merge into one card at the position of the most recently logged
 * season (latest `m`, then highest season), taking that season's id, cover
 * and log date. Everything else, including single-season shows and rows that
 * already carry seasonRatings, passes through unchanged.
 */
export function groupTvSeasons<T extends SeasonFields>(rows: T[]): GroupedRow<T>[] {
  const groupable = (row: T) => row.tv && row.s && !row.seasonRatings;
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!groupable(row)) continue;
    const group = groups.get(row.t);
    if (group) group.push(row);
    else groups.set(row.t, [row]);
  }

  const leaders = new Map<string, T>();
  for (const [title, group] of groups) {
    if (group.length < 2) continue;
    let leader = group[0];
    for (const row of group.slice(1)) {
      const newer = (row.m ?? '') > (leader.m ?? '');
      const tie = (row.m ?? '') === (leader.m ?? '');
      if (newer || (tie && bySeason(row.s!, leader.s!) > 0)) leader = row;
    }
    leaders.set(title, leader);
  }

  const out: GroupedRow<T>[] = [];
  for (const row of rows) {
    const leader = groupable(row) ? leaders.get(row.t) : undefined;
    if (!leader) {
      out.push(row);
      continue;
    }
    if (row !== leader) continue;
    out.push(mergeSeasons(leader, groups.get(row.t)!));
  }
  return out;
}

function mergeSeasons<T extends SeasonFields>(leader: T, group: T[]): GroupedRow<T> {
  const seasons = [...group].sort((a, b) => bySeason(a.s!, b.s!));
  const seasonRatings = seasonRatingLines(seasons.map((row) => ({ s: row.s!, r: row.r })));
  const years = seasons.map((row) => row.y).filter((y): y is number => typeof y === 'number');
  const from = Math.min(...years);
  const to = Math.max(...years);
  const notes = seasons.filter((row) => row.c?.trim()).map((row) => `S${row.s}: ${row.c!.trim()}`);

  // Fields a merged card has no value for are left out, not set to undefined.
  const merged: Record<string, unknown> = {
    ...leader,
    s: seasonLabel(seasons.map((row) => row.s!)),
  };
  delete merged.y;
  delete merged.c;
  delete merged.r;
  if (years.length) merged.y = from === to ? from : `${from}-${to}`;
  if (notes.length) merged.c = notes.join('\n');
  if (seasonRatings.length) merged.seasonRatings = seasonRatings;
  // Two or more season lines replace the card rating, as on The Office.
  if (seasonRatings.length === 1) merged.r = seasonRatings[0].r;
  return merged as GroupedRow<T>;
}
