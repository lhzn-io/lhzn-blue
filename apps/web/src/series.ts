/** Hourly series: loading, merging the daily history with the live window, and the derived views.
 *
 * Every series is a continuous hourly array in UTC (degrees F, null for missing hours). All
 * derived values are computed here, in one place, so the charts and the AI prompt agree.
 */

export const HOUR = 3600;
export const DAY = 86400;

export interface Encoded {
  t0: string | null;
  step: number;
  unit: string;
  values: (number | null)[];
}

export interface LastObs {
  time: string;
  depth_m: number | null;
  temperature_c: number | null;
  salinity: number | null;
  oxygen_mg_l: number | null;
}

export interface LiveSeries extends Encoded {
  last_obs: LastObs | null;
  dataset: string;
}

export interface MetObs {
  time: string;
  wind_kt: number | null;
  gust_kt: number | null;
  dir_deg: number | null;
  air_f: number | null;
  pressure_mb: number | null;
}

/** Hourly buoy weather on one grid: wind (kt), peak gust (kt), direction (deg from), air (F), pressure (mbar). */
export interface MetWindow {
  t0: string | null;
  step: number;
  wind_kt?: (number | null)[];
  gust_kt?: (number | null)[];
  dir_deg?: (number | null)[];
  air_f?: (number | null)[];
  pressure_mb?: (number | null)[];
  last_obs: MetObs | null;
  dataset: string;
}

export interface Live {
  generated_at: string;
  series: Record<string, LiveSeries>; // water temperature (F), with the latest raw observation
  salinity?: Record<string, Encoded>;
  oxygen?: Record<string, Encoded>; // mg/L
  waves?: Record<string, WaveLive>;
  met?: Record<string, MetWindow>;
  datasets: Record<string, { last_ok?: string; last_error?: string; rows?: number }>;
}

export interface MetaSource {
  kind: "merlin" | "archive";
  dataset: string;
  first_obs?: string | null;
  last_obs?: string | null;
  note?: string | null;
  published?: boolean; // server sources: listed on the server at the last build
}

export interface MetaSeries {
  key: string;
  depth: string;
  label: string;
  depth_m: number[];
  record_start: string | null;
  hours: number;
  sources: MetaSource[];
  live: boolean; // has a current server source
  archived_last_obs: LastObs | null; // final reading, for archive-only series
  vars?: Record<string, { record_start: string | null; hours: number }>; // salinity and oxygen records
}

export interface MetaStation {
  id: string;
  name: string;
  operator: string;
  lat: number;
  lon: number;
  note: string | null;
  outage_note?: string | null; // shown only while the station's water quality is not published
  info_url: string | null;
  series: MetaSeries[];
}

export interface Meta {
  generated_at: string;
  waterway: { id: string; name: string };
  stations: MetaStation[];
  qc: string;
  server: string;
}

/** The daily history bundle: metadata plus the full hourly record of every series. */
export interface History {
  meta: Meta;
  series: Record<string, Encoded>;
}

/** Shore stations (NOAA CO-OPS): the latest 6-minute readings, in the page's units. */
export interface ShoreObs {
  time: string;
  water_f: number | null;
  air_f: number | null;
  wind_kt: number | null;
  gust_kt: number | null;
  dir_deg: number | null;
  pressure_mb: number | null;
  level_ft: number | null; // above MLLW
}

export interface TideEvent {
  t: string;
  ft: number;
  type: "H" | "L";
}

/** A shore station's last 100 days, hourly; the weather columns match MetWindow. */
export interface ShoreFrame {
  t0: string | null;
  step: number;
  water_f?: (number | null)[];
  air_f?: (number | null)[];
  wind_kt?: (number | null)[];
  gust_kt?: (number | null)[];
  dir_deg?: (number | null)[];
  pressure_mb?: (number | null)[];
  level_ft?: (number | null)[];
  last_obs: ShoreObs | null;
  tides: TideEvent[];
  datum: string;
  coops_id: string;
}

export interface ShoreLive {
  generated_at: string;
  qc: string;
  stations: Record<string, ShoreFrame>;
  datasets: Record<string, { last_ok?: string; last_error?: string }>;
}

export interface ShoreMetaStation {
  id: string;
  name: string;
  operator: string;
  lat: number;
  lon: number;
  info_url: string | null;
  coops_id: string;
  note?: string | null;
  record_start: string | null;
}

/** Shore water temperature, the full record: the top-of-hour readings CO-OPS publishes. */
export interface ShoreHistory {
  generated_at: string;
  meta: { qc: string; stations: ShoreMetaStation[] };
  series: Record<string, Encoded>;
}

/** Waves at a buoy: heights in metres, periods in seconds. */
export interface WaveObs {
  time: string;
  hs_m: number | null; // significant wave height
  hmax_m: number | null; // highest wave
  tp_s: number | null; // dominant period
  ta_s: number | null; // average period
}

export interface WaveFrame {
  t0: string | null;
  step: number;
  hs_m?: (number | null)[];
  hmax_m?: (number | null)[];
  tp_s?: (number | null)[];
  ta_s?: (number | null)[];
}

/** The live window: the last 100 days, and whether the server published the dataset at the last check. */
export interface WaveLive extends WaveFrame {
  last_obs: WaveObs | null;
  published: boolean;
  checked_at: string;
  dataset: string;
}

/** The full wave record, with each station's status. */
export interface WaveHistory {
  generated_at: string;
  qc: string;
  meta: Record<string, { dataset: string; published: boolean; checked_at: string; record_start: string | null; last_obs: WaveObs | null; saved_downloads: number | null }>;
  stations: Record<string, WaveFrame>;
}

/** The salinity or oxygen history: the same hourly record, loaded when a reader switches to it. */
export interface VarHistory {
  generated_at: string;
  var: string;
  unit: string;
  series: Record<string, Encoded>;
}

/** A dense hourly series: value at `t0 + i * 3600` seconds; NaN where missing. */
export class Hourly {
  constructor(
    readonly t0: number,
    readonly v: Float64Array,
  ) {}

  get t1(): number {
    return this.t0 + (this.v.length - 1) * HOUR;
  }

  at(t: number): number {
    const i = Math.round((t - this.t0) / HOUR);
    return i >= 0 && i < this.v.length ? this.v[i] : NaN;
  }

  static decode(e: Encoded | undefined): Hourly | null {
    if (!e || !e.t0 || !e.values.length) return null;
    return Hourly.fromArray(e.t0, e.values);
  }

  static fromArray(t0: string | null | undefined, values: (number | null)[] | undefined): Hourly | null {
    if (!t0 || !values || !values.length) return null;
    const v = new Float64Array(values.length);
    values.forEach((x, i) => (v[i] = x == null ? NaN : x));
    return new Hourly(Date.parse(t0) / 1000, v);
  }

  /** History overlaid with the live window; live values win where both exist. */
  static merge(history: Hourly | null, live: Hourly | null): Hourly | null {
    if (!history) return live;
    if (!live) return history;
    const t0 = Math.min(history.t0, live.t0);
    const t1 = Math.max(history.t1, live.t1);
    const v = new Float64Array(Math.round((t1 - t0) / HOUR) + 1).fill(NaN);
    for (const s of [history, live]) {
      const off = Math.round((s.t0 - t0) / HOUR);
      s.v.forEach((x, i) => {
        if (!Number.isNaN(x)) v[off + i] = x;
      });
    }
    return new Hourly(t0, v);
  }

  /** Trailing mean over `hours`, requiring at least `minCount` valid hours; never fills gaps. */
  rolling(hours = 36, minCount = 24): Hourly {
    const out = new Float64Array(this.v.length).fill(NaN);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.v.length; i++) {
      const x = this.v[i];
      if (!Number.isNaN(x)) {
        sum += x;
        n++;
      }
      if (i >= hours) {
        const y = this.v[i - hours];
        if (!Number.isNaN(y)) {
          sum -= y;
          n--;
        }
      }
      if (n >= minCount) out[i] = sum / n;
    }
    return new Hourly(this.t0, out);
  }

  /**
   * Exponential moving average with the given half-life (hours). Two-sided (forward, then backward over the
   * result) removes the lag a one-sided EMA puts on peaks; at the series' end only past data is used. Gaps
   * are never bridged: the average restarts after a missing hour.
   */
  ema(halfLifeHours: number, twoSided = true): Hourly {
    const alpha = 1 - Math.pow(0.5, 1 / Math.max(0.01, halfLifeHours));
    const pass = (src: Float64Array, reverse: boolean): Float64Array => {
      const out = new Float64Array(src.length).fill(NaN);
      let s = NaN;
      const n = src.length;
      for (let k = 0; k < n; k++) {
        const i = reverse ? n - 1 - k : k;
        const x = src[i];
        if (Number.isNaN(x)) {
          s = NaN; // restart after a gap
          continue;
        }
        s = Number.isNaN(s) ? x : s + alpha * (x - s);
        out[i] = s;
      }
      return out;
    };
    const fwd = pass(this.v, false);
    return new Hourly(this.t0, twoSided ? pass(fwd, true) : fwd);
  }

  /** Change over `lagHours`: x(t) - x(t - lag). */
  change(lagHours = 168): Hourly {
    const out = new Float64Array(this.v.length).fill(NaN);
    for (let i = lagHours; i < this.v.length; i++) out[i] = this.v[i] - this.v[i - lagHours];
    return new Hourly(this.t0, out);
  }

  minus(other: Hourly): Hourly {
    const out = new Float64Array(this.v.length);
    for (let i = 0; i < this.v.length; i++) out[i] = this.v[i] - other.at(this.t0 + i * HOUR);
    return new Hourly(this.t0, out);
  }

  /** Last valid time at or before `t`. */
  lastValid(): number {
    for (let i = this.v.length - 1; i >= 0; i--) if (!Number.isNaN(this.v[i])) return this.t0 + i * HOUR;
    return NaN;
  }

  /** Mean of valid values in [a, b]. */
  mean(a: number, b: number): number {
    let s = 0;
    let n = 0;
    for (let t = a; t <= b; t += HOUR) {
      const x = this.at(t);
      if (!Number.isNaN(x)) {
        s += x;
        n++;
      }
    }
    return n ? s / n : NaN;
  }
}

/** Hourly grid from `a` to `b` (epoch seconds, inclusive), thinned to at most `maxPoints` points. */
export function grid(a: number, b: number, maxPoints = 3000): number[] {
  const step = HOUR * Math.max(1, Math.ceil((b - a) / HOUR / maxPoints));
  const out: number[] = [];
  for (let t = Math.floor(a / step) * step; t <= b; t += step) out.push(t);
  return out;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * The same calendar moment `years` earlier (month, day, hour in UTC). Feb 29 has no counterpart in
 * a non-leap year and maps to NaN; Feb 29 of a leap source year is simply never sampled.
 */
export function shiftYears(t: number, years: number): number {
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear() - years;
  if (d.getUTCMonth() === 1 && d.getUTCDate() === 29 && !isLeap(y)) return NaN;
  return Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()) / 1000;
}

export interface YearLine {
  year: number;
  offset: number;
  values: number[]; // aligned with the window grid
  coverage: number; // share of the window with a value
}

/** Each year's values over the current window, mapped onto the current calendar. */
export function yearLines(s: Hourly, xs: number[], now: number): YearLine[] {
  const current = new Date(now * 1000).getUTCFullYear();
  const first = new Date(s.t0 * 1000).getUTCFullYear();
  const lines: YearLine[] = [];
  for (let offset = 0; current - offset >= first; offset++) {
    const values = xs.map((t) => {
      if (offset === 0 && t > now) return NaN;
      const src = shiftYears(t, offset);
      return Number.isNaN(src) ? NaN : s.at(src);
    });
    const span = offset === 0 ? xs.filter((t) => t <= now).length : xs.length;
    const have = values.filter((v) => !Number.isNaN(v)).length;
    lines.push({ year: current - offset, offset, values, coverage: span ? have / span : 0 });
  }
  return lines;
}

export const COVERAGE_MIN = 0.8;

export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const dF = (dc: number) => (dc * 9) / 5;

/** Working stratification definition (alpha): surface minus bottom, mean of the last 24 hours, in C. */
export const STRAT = { mixed: 0.3, stratified: 1.0 };

export function stratStatus(deltaC: number): string {
  if (Number.isNaN(deltaC)) return "unknown";
  const a = Math.abs(deltaC);
  if (a < STRAT.mixed) return "mixed";
  if (a <= STRAT.stratified) return "weakly stratified";
  return deltaC > 0 ? "stratified" : "inverted";
}

/**
 * Dissolved oxygen reference levels, mg/L. Hypoxia under 3 and anoxia under 1 are the Long Island Sound
 * Partnership's definitions (lispartnership.org, hypoxia indicator). 4.8 is EPA's Virginian Province
 * criterion for continuous exposure, protecting growth (EPA-822-R-00-012, 2000).
 */
export const DO_LEVELS = { anoxic: 1, hypoxic: 3, growth: 4.8 };

export function oxygenStatus(mgL: number): string {
  if (!Number.isFinite(mgL)) return "unknown";
  if (mgL < DO_LEVELS.anoxic) return "anoxic";
  if (mgL < DO_LEVELS.hypoxic) return "hypoxic";
  if (mgL < DO_LEVELS.growth) return "below the growth criterion";
  return "above the growth criterion";
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok || !res.headers.get("content-type")?.includes("json")) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
