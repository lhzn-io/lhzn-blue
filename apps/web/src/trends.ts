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
  /** Changes smaller than this (in the series' own units) read as no change (a flat arrow). */
  dead: number;
  /** Changes from `dead` up to `rates[0]` are slow, up to `rates[1]` steady, beyond it sudden. */
  rates: [number, number];
  /** Words for rising, falling and no change (for hover text and screen readers). */
  words?: [string, string, string];
}

/** Per quantity, in the series' stored units (°F, practical salinity, mg/L, knots, metres, mbar). */
export const TRENDS: Record<string, TrendSpec> = {
  temp: { window: 24, mode: "point", dead: 0.2, rates: [0.8, 2] },
  salinity: { window: 24, mode: "point", dead: 0.05, rates: [0.2, 0.6] },
  oxygen: { window: 24, mode: "point", dead: 0.2, rates: [0.8, 2] },
  wind: { window: 3, mode: "mean", dead: 2, rates: [5, 10], words: ["building", "subsiding", "steady"] },
  waves: { window: 3, mode: "mean", dead: 0.1, rates: [0.3, 0.6], words: ["building", "subsiding", "steady"] },
  pressure: { window: 3, mode: "point", dead: 1, rates: [2, 3], words: ["rising", "falling", "steady"] },
  air: { window: 24, mode: "point", dead: 2, rates: [6, 12], words: ["warming", "cooling", "steady"] },
  stratification: { window: 24, mode: "mean", dead: 0.18, rates: [0.7, 1.8], words: ["stratifying", "mixing", "steady"] },
  departure: { window: 6, mode: "mean", dead: 0.1, rates: [0.3, 0.6], words: ["rising", "falling", "steady"] },
};

/** Wind direction: shifts under this many degrees (or in wind under `minKt`) are not shown. */
export const VEER = { window: 3, dead: 20, minKt: 5 };

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

/** A change as a trend: no direction inside the spec's dead band. */
export function classify(delta: number, spec: TrendSpec): Trend {
  return { dir: Math.abs(delta) < spec.dead ? 0 : delta > 0 ? 1 : -1, delta };
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
  return classify(delta, spec);
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

const ARROW_ANGLE = { flat: 0, slow: 20, steady: 45, sudden: 70 };
type Rate = keyof typeof ARROW_ANGLE;

/** A thin arrow at an angle: up and to the right for rising, down for falling; the steeper, the faster. The
 * rotation is inside the SVG, so it survives being painted into an image. */
function arrowSvg(rate: Rate, dir: 1 | -1 | 0): string {
  const deg = -ARROW_ANGLE[rate] * (dir || 0);
  return (
    `<svg class="trend-arrow" viewBox="-8 -8 16 16" width="13" height="13" aria-hidden="true">` +
    `<g transform="rotate(${deg})"><path d="M-6 0H5M1.5-3.5L5 0L1.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`
  );
}

function rateOf(t: Trend, spec: TrendSpec): Rate {
  const a = Math.abs(t.delta);
  return t.dir === 0 ? "flat" : a < spec.rates[0] ? "slow" : a < spec.rates[1] ? "steady" : "sudden";
}

const ADVERB: Record<Rate, string> = { flat: "", slow: "slowly", steady: "steadily", sudden: "quickly" };

/** An arrow at the rate's angle and the signed change over the window: "↗ +0.6°F over the last 24 h", or the word
 * for no change ("steady over the last 3 h") inside the dead band, where a rounded number would read as a change.
 * With `model`, the model's change over the window ahead: "HRRR ↘ −4 kt over the next 3 h". The words ("rising
 * slowly") are in the hover text and in a hidden span for screen readers and the AI prompt. `fmt` formats a size in
 * display units. */
export function trendText(t: Trend | null, spec: TrendSpec, fmt: (v: number) => string, model = ""): string {
  if (!t) return "";
  const rate = rateOf(t, spec);
  const [up, down, none] = spec.words ?? ["rising", "falling", "no change"];
  const words = t.dir === 0 ? none : `${t.dir > 0 ? up : down} ${ADVERB[rate]}`;
  const change = t.dir === 0 ? none : `${t.delta > 0 ? "+" : "\u2212"}${fmt(Math.abs(t.delta))}`;
  const span = `over the ${model ? "next" : "last"} ${spec.window} h`;
  const title = `${model ? `${model} forecast: ` : ""}${words}${t.dir === 0 ? "" : `, ${change.replace(/<[^>]+>/g, "")}`} ${span}`;
  return `<span class="trend-part${model ? " trend-ahead" : ""}" title="${title}">${model ? `${model} ` : ""}${arrowSvg(rate, t.dir)}<span class="sr-only">${model ? "forecast " : ""}${words}</span> ${change} ${span}</span>`;
}

/** Mean direction (degrees) of the wind over [a, b], as a vector mean so 350 and 10 average to 0. */
function meanDirection(dir: Hourly, a: number, b: number): number {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let t = a; t <= b; t += HOUR) {
    const d = dir.at(t);
    if (!Number.isFinite(d)) continue;
    x += Math.sin((d * Math.PI) / 180);
    y += Math.cos((d * Math.PI) / 180);
    n++;
  }
  return n ? ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 : NaN;
}

/** Veering (the wind shifting clockwise, ↻) or backing (counterclockwise, ↺) over the last window against the one
 * before; empty in light wind or when the shift is small. */
export function veerText(dir: Hourly | null | undefined, speed: Hourly | null | undefined): string {
  if (!dir || !speed) return "";
  const end = dir.lastValid();
  if (!Number.isFinite(end)) return "";
  const w = VEER.window * HOUR;
  if (!(speed.mean(end - w + HOUR, end) >= VEER.minKt)) return "";
  const now = meanDirection(dir, end - w + HOUR, end);
  const before = meanDirection(dir, end - 2 * w + HOUR, end - w);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return "";
  const shift = ((now - before + 540) % 360) - 180; // -180..180, clockwise positive
  if (Math.abs(shift) < VEER.dead) return "";
  const words = shift > 0 ? "veering" : "backing";
  return `<span class="trend-part" title="${words} ${Math.round(Math.abs(shift))}\u00b0 in ${VEER.window}h">${shift > 0 ? "\u21bb" : "\u21ba"}<span class="sr-only">${words}</span> ${Math.round(Math.abs(shift))}\u00b0</span>`;
}

/** "74th %ile", "74th %ile (last 3 days)", or "-- %ile" when there are fewer than three earlier years. */
export function percentileText(p: { pct: number; years: number } | null, what = ""): string {
  if (!p) return `<span class="trend-part" title="Fewer than three earlier years on record">-- %ile</span>`;
  return `<span class="trend-part">${ordinal(p.pct)} %ile${what ? ` (${what})` : ""}</span>`;
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
