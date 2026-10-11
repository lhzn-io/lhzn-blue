/**
 * Readout context: which way a reading is heading now, and how unusual it is for the time of year.
 *
 * Direction compares two adjacent windows sized to how fast each quantity moves (3h for wind and waves, 24h for
 * water temperature), with a small dead band so noise reads as steady. The seasonal context is a percentile of
 * the recent value against the same dates (plus or minus a week) in every earlier year on record ("%ile"). The
 * windows and dead bands live here, in one place, to tune on the water.
 */
import { DAY, HOUR, Hourly } from "./series";

export interface TrendSpec {
  /** Hours in each compared window (the latest window against the one before it). */
  window: number;
  /** "mean": the windows' means; "point": the latest value against the value one window earlier. */
  mode: "mean" | "point";
  /** Changes smaller than this (in the series' own units) read as steady. */
  dead: number;
  /** Words for rising, falling and steady; arrows when absent. */
  words?: [string, string, string];
}

/** Per quantity, in the series' stored units (°F, practical salinity, mg/L, knots, metres, mbar). */
export const TRENDS: Record<string, TrendSpec> = {
  temp: { window: 24, mode: "point", dead: 0.2 },
  salinity: { window: 24, mode: "point", dead: 0.05 },
  oxygen: { window: 24, mode: "point", dead: 0.2 },
  wind: { window: 3, mode: "mean", dead: 2, words: ["building", "subsiding", "steady"] },
  waves: { window: 3, mode: "mean", dead: 0.1, words: ["building", "subsiding", "steady"] },
  pressure: { window: 3, mode: "point", dead: 1, words: ["rising", "falling", "steady"] },
  air: { window: 24, mode: "point", dead: 2, words: ["warmer", "cooler", "steady"] },
  stratification: { window: 24, mode: "mean", dead: 0.18, words: ["stratifying", "mixing", "steady"] },
};

/** How a seasonal percentile is taken: the value averaged over `span` hours, compared across years. */
export interface SeasonSpec {
  span: number;
  halfWidthDays: number;
  minYears: number;
}

export const SEASONS: Record<string, SeasonSpec> = {
  water: { span: 1, halfWidthDays: 7, minYears: 3 }, // the 36h mean itself
  wind: { span: 72, halfWidthDays: 7, minYears: 3 }, // the last 3 days' mean wind
  waves: { span: 72, halfWidthDays: 7, minYears: 3 },
  air: { span: 24, halfWidthDays: 7, minYears: 3 },
  pressure: { span: 24, halfWidthDays: 7, minYears: 3 },
};

export interface Trend {
  dir: 1 | -1 | 0;
  delta: number;
}

/** Direction over the spec's window, or null where either window has no data. */
export function trend(s: Hourly | null | undefined, spec: TrendSpec): Trend | null {
  if (!s) return null;
  const end = s.lastValid();
  if (!Number.isFinite(end)) return null;
  const w = spec.window * HOUR;
  const delta =
    spec.mode === "mean" ? s.mean(end - w + HOUR, end) - s.mean(end - 2 * w + HOUR, end - w) : s.at(end) - s.at(end - w);
  if (!Number.isFinite(delta)) return null;
  return { dir: Math.abs(delta) < spec.dead ? 0 : delta > 0 ? 1 : -1, delta };
}

const YEAR = Math.round(365.2425 * 24) * HOUR;

/** The latest value (averaged over `span` hours) as a percentile of the same dates in earlier years. A year
 * counts when at least half of its samples have data; fewer than `minYears` such years gives null. */
export function seasonalPercentile(s: Hourly | null | undefined, spec: SeasonSpec): { pct: number; years: number } | null {
  if (!s) return null;
  const end = s.lastValid();
  if (!Number.isFinite(end)) return null;
  const span = spec.span * HOUR;
  const valueAt = (t: number) => (spec.span <= 1 ? s.at(t) : s.mean(t - span + HOUR, t));
  const now = valueAt(end);
  if (!Number.isFinite(now)) return null;
  const samples: number[] = [];
  let years = 0;
  const step = 6 * HOUR;
  for (let k = 1; end - k * YEAR - spec.halfWidthDays * DAY >= s.t0; k++) {
    const centre = end - k * YEAR;
    const got: number[] = [];
    let tried = 0;
    for (let t = centre - spec.halfWidthDays * DAY; t <= centre + spec.halfWidthDays * DAY; t += step) {
      tried++;
      const v = valueAt(t);
      if (Number.isFinite(v)) got.push(v);
    }
    if (got.length >= tried / 2) {
      years++;
      samples.push(...got);
    }
  }
  if (years < spec.minYears || !samples.length) return null;
  const below = samples.filter((v) => v < now).length;
  const equal = samples.filter((v) => v === now).length;
  return { pct: Math.round((100 * (below + equal / 2)) / samples.length), years };
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, ... */
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

/** "↑ 0.6°F in 24h", "building, +5 kt in 3h", "steady over 24h". `fmt` formats the change in display units. */
export function trendText(t: Trend | null, spec: TrendSpec, fmt: (v: number) => string): string {
  if (!t) return "";
  const span = `${spec.window}h`;
  if (t.dir === 0) return `${spec.words?.[2] ?? "steady"} over ${span}`;
  const signed = `${t.delta > 0 ? "+" : "−"}${fmt(Math.abs(t.delta))}`;
  if (spec.words) return `${spec.words[t.dir > 0 ? 0 : 1]}, ${signed} in ${span}`;
  return `${t.dir > 0 ? "↑" : "↓"} ${fmt(Math.abs(t.delta))} in ${span}`;
}

/** "74th %ile", "74th %ile (last 3 days)", or a short reason when the record is too short. */
export function percentileText(p: { pct: number; years: number } | null, what = ""): string {
  if (!p) return "record too short for a %ile";
  return `${ordinal(p.pct)} %ile${what ? ` (${what})` : ""}`;
}

/** Hourly values smoothed less the more recent they are: hourly for the last two days, then a half-life that
 * widens to 6h by two weeks back and to a day by a month back. Detail where a mariner needs it, a trend behind. */
export function smoothByAge(s: Hourly, now: number): Hourly {
  const halfLives = [1, 2, 3, 4, 6, 9, 12, 18, 24];
  const smoothed = halfLives.map((h) => s.ema(h));
  const target = (ageH: number) => {
    if (ageH <= 48) return 0;
    if (ageH <= 14 * 24) return 1 + ((ageH - 48) / (14 * 24 - 48)) * 5; // 1h to 6h
    if (ageH <= 30 * 24) return 6 + ((ageH - 14 * 24) / (16 * 24)) * 18; // 6h to 24h
    return 24;
  };
  const out = new Float64Array(s.v.length).fill(NaN);
  for (let i = 0; i < s.v.length; i++) {
    const h = target((now - (s.t0 + i * HOUR)) / HOUR);
    if (h <= 0) {
      out[i] = s.v[i];
      continue;
    }
    // Blend the two neighbouring half-lives, so the line has no steps where the smoothing changes.
    let j = halfLives.findIndex((x) => x >= h);
    if (j <= 0) j = Math.max(1, j === -1 ? halfLives.length - 1 : 1);
    const [lo, hi] = [halfLives[j - 1], halfLives[j]];
    const w = Math.min(1, Math.max(0, (h - lo) / (hi - lo)));
    const a = smoothed[j - 1].v[i];
    const b = smoothed[j].v[i];
    out[i] = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * w : Number.isFinite(b) ? b : a;
  }
  return new Hourly(s.t0, out);
}
