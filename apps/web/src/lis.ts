/** Long Island Sound page: overview (map and status grid), readouts and views per station, a zoom view,
 * and the bring-your-own-AI prompt. */
import "./site.css";

import promptTemplate from "../../../configs/prompts/visitor_prompt.txt?raw";
import registry from "../../../stations/stations.json";
import { highlight, renderLines, YELLOW, type ChartOptions, type Line } from "./chart";
import {
  COVERAGE_MIN, DAY, HOUR, Hourly, STRAT, dF, fToC, getJson, grid, stratStatus, yearLines,
  type History, type LastObs, type Live, type Meta, type MetaSeries, type MetaStation, type MetObs, type MetWindow, type YearLine,
} from "./series";

const DATA = "/data/v1";
const $ = (id: string) => document.getElementById(id)!;
/**
 * Series colors per theme. Dark ("chart room"): brand yellow for this year, past years darkening into the
 * night. Light ("gilded china"): gold for this year, past years in cobalt fading toward the cream. In both,
 * this year is the only line of its hue and weight, and older years recede. Contrast on the light ground
 * was checked on eggshell: gold 2.7:1 (chosen over 3:1 for warmth; never color-alone), cobalt ramp 8.0:1 to 2.5:1, depth, wind and air lines 4.5:1 or more.
 */
interface Palette {
  now: string; // this year, live readings
  contrast: string; // neutral lines (gusts, hourly differences): white on dark, navy on light
  delayed: string;
  depth: Record<string, string>;
  wind: string;
  air: string;
  bands: [string, string]; // surface-minus-bottom threshold shading: outer, inner
  yearStops: { t: number; L: number; C: number; h: number }[];
}

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    now: YELLOW,
    contrast: "#ffffff",
    delayed: "#f0b135",
    depth: { SFC: YELLOW, MID: "#ffffff", BTM: "#7fb8d8" },
    wind: "#9fd3c7", // a pale sea green, distinct from the water depths
    air: "#c4a7e7", // lavender, distinct from every water line
    bands: ["rgba(255,255,255,0.04)", "rgba(127,184,216,0.12)"],
    yearStops: [
      { t: 0, L: 0.6, C: 0.085, h: 195 }, // deep blue-green
      { t: 0.22, L: 0.56, C: 0.1, h: 265 }, // blue-violet
      { t: 1, L: 0.42, C: 0.1, h: 318 }, // deep plum
    ],
  },
  light: {
    now: "#b89300", // gilded gold, 2.7:1 on eggshell; this year is also the boldest line and named in legend and tooltip
    contrast: "#1c2a48",
    delayed: "#a35a00",
    depth: { SFC: "#133c8b", MID: "#3a78a1", BTM: "#29706c" },
    wind: "#23786f",
    air: "#7e4d8a",
    bands: ["rgba(28,42,72,0.04)", "rgba(58,120,161,0.12)"],
    yearStops: [
      { t: 0, L: 0.42, C: 0.13, h: 262 }, // deep cobalt
      { t: 0.35, L: 0.52, C: 0.11, h: 256 },
      { t: 1, L: 0.7, C: 0.06, h: 245 }, // pale willow blue, 2.5:1 on eggshell
    ],
  },
};

type Theme = keyof typeof PALETTES;
let P: Palette = PALETTES.dark;

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
const DEPTHS = ["SFC", "MID", "BTM"] as const;
const DEPTH_LABEL: Record<string, string> = { SFC: "Surface", MID: "Mid", BTM: "Bottom" };
const DELAYED_HOURS = 3; // older than this: delayed
const OFFLINE_HOURS = 24; // older than this: offline
const fmtUtc = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" });

function ago(iso: string | number): string {
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min ago`;
  const days = Math.round(h / 24);
  return days < 120 ? `${days} days ago` : `since ${fmtDate.format(new Date(t))}`;
}
const hoursOld = (iso: string) => (Date.now() - Date.parse(iso)) / 3.6e6;
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "--");
const signed = (v: number, d = 1) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}` : "--");
const cToF = (c: number) => (c * 9) / 5 + 32;

type State = "live" | "delayed" | "offline";

interface StationData {
  meta: MetaStation;
  depths: string[]; // depths this station has, top to bottom
  hourly: Record<string, Hourly | null>;
  m36: Record<string, Hourly | null>;
  chg: Record<string, Hourly | null>;
  delta: Hourly | null; // surface minus bottom, hourly (F)
  delta36: Hourly | null;
  obs: Record<string, LastObs | null>; // latest reading per depth (live, or the last one we hold)
  live: boolean; // any series still published by the server
  now: number; // the current hour: year comparisons are always about this time of year
  anchor: number; // end of the recent timelines: now for live stations, the last reading otherwise
  met: Met | null; // buoy weather, recent window only
}

interface Met {
  wind: Hourly | null; // knots
  gust: Hourly | null; // knots, hourly peak
  dir: Hourly | null; // degrees the wind blows from
  air: Hourly | null; // F
  last: MetObs | null;
}

/* ---------- Load ---------- */

function metOf(w: MetWindow | undefined): Met | null {
  if (!w || !w.t0) return null;
  return {
    wind: Hourly.fromArray(w.t0, w.wind_kt),
    gust: Hourly.fromArray(w.t0, w.gust_kt),
    dir: Hourly.fromArray(w.t0, w.dir_deg),
    air: Hourly.fromArray(w.t0, w.air_f),
    last: w.last_obs,
  };
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** Wind direction (degrees it blows from) as a 16-point compass name. */
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** A small arrow pointing downwind (the way the wind is blowing), with the compass point it comes from. */
function windArrow(fromDeg: number): string {
  const to = (fromDeg + 180) % 360;
  return `<svg class="wind-arrow" viewBox="-6 -6 12 12" width="12" height="12" role="img" aria-label="from ${compass(fromDeg)}"><title>from ${compass(fromDeg)} (${Math.round(fromDeg)}°), blowing toward ${compass(to)}</title><g transform="rotate(${to.toFixed(0)})"><path d="M0 -5 L3.2 2.6 L0 1 L-3.2 2.6 Z" fill="currentColor"/></g></svg>`;
}

/** Wind units: buoy data arrives in knots; the reader picks how it is shown (remembered per browser). */
const WIND_UNITS = {
  kt: { factor: 1, label: "kt", name: "knots", digits: 0 },
  mph: { factor: 1.150779, label: "mph", name: "miles per hour", digits: 0 },
  ms: { factor: 0.514444, label: "m/s", name: "metres per second", digits: 1 },
} as const;
type WindUnit = keyof typeof WIND_UNITS;
let WU: WindUnit = "kt";
try {
  const saved = localStorage.getItem("lhzn-blue-wind-unit");
  if (saved && saved in WIND_UNITS) WU = saved as WindUnit;
} catch {
  /* private mode: knots */
}
const windVal = (kt: number) => kt * WIND_UNITS[WU].factor;
const windFmt = (kt: number | null | undefined) =>
  kt == null || !Number.isFinite(kt) ? "--" : windVal(kt).toFixed(WIND_UNITS[WU].digits);

async function load(): Promise<{ meta: Meta; live: Live; stations: StationData[] }> {
  const [hist, live] = await Promise.all([getJson<History>(`${DATA}/history.json`), getJson<Live>(`${DATA}/live.json`)]);
  const meta = hist.meta;
  // West to east, everywhere: the status grid, the station sections, and the AI prompt.
  meta.stations.sort((a, b) => a.lon - b.lon);
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const stations = meta.stations.map((st) => {
    const hourly: Record<string, Hourly | null> = {};
    const m36: Record<string, Hourly | null> = {};
    const chg: Record<string, Hourly | null> = {};
    const obs: Record<string, LastObs | null> = {};
    for (const s of st.series) {
      const h = Hourly.merge(Hourly.decode(hist.series[s.key]), Hourly.decode(live.series[s.key]));
      hourly[s.depth] = h;
      m36[s.depth] = h ? h.rolling(36, 24) : null;
      chg[s.depth] = m36[s.depth]?.change(168) ?? null;
      obs[s.depth] = live.series[s.key]?.last_obs ?? s.archived_last_obs ?? null;
    }
    const delta = hourly.SFC && hourly.BTM ? hourly.SFC.minus(hourly.BTM) : null;
    const isLive = st.series.some((s) => s.live);
    const lastData = Math.max(...Object.values(hourly).map((h) => (h ? h.lastValid() : -Infinity)));
    return {
      meta: st,
      depths: DEPTHS.filter((d) => st.series.some((s) => s.depth === d)),
      hourly, m36, chg, obs,
      delta, delta36: delta ? delta.rolling(36, 24) : null,
      live: isLive,
      now,
      anchor: isLive || !Number.isFinite(lastData) ? now : lastData,
      met: metOf(live.met?.[st.id]),
    };
  });
  return { meta, live, stations };
}

/* ---------- State and derived values ---------- */

function obsState(o: LastObs | null): State {
  if (!o) return "offline";
  const h = hoursOld(o.time);
  return h > OFFLINE_HOURS ? "offline" : h > DELAYED_HOURS ? "delayed" : "live";
}

/** The whole buoy for the map and status dots: "partial" when its water sensors are offline but its
 * weather sensors still report (as at Central Sound). */
function overallState(d: StationData): State | "partial" {
  const water = stationState(d);
  const weather = d.met?.last ? obsState({ time: d.met.last.time } as LastObs) : "offline";
  return water === "offline" && weather !== "offline" ? "partial" : water;
}

function stationState(d: StationData): State {
  const states = d.depths.map((dep) => obsState(d.obs[dep]));
  return states.includes("live") ? "live" : states.includes("delayed") ? "delayed" : "offline";
}

/** Years drawn: this year whenever it has data, earlier years only with enough coverage. Years with no
 * data at all in the window (for example during an outage) are neither drawn nor listed. */
function visibleYears(lines: YearLine[]): { shown: YearLine[]; hidden: YearLine[] } {
  const shown = lines.filter((l) => (l.offset === 0 ? l.coverage > 0 : l.coverage >= COVERAGE_MIN));
  const hidden = lines.filter((l) => l.offset > 0 && l.coverage > 0 && l.coverage < COVERAGE_MIN);
  return { shown, hidden };
}

/** OKLCH to sRGB hex (for the year ramp). */
function oklch(L: number, C: number, h: number): string {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const g = (x: number) => {
    x = Math.min(1, Math.max(0, x));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return "#" + lin.map((x) => Math.round(g(x) * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * Year colors: the current year is the only line in the theme's "now" color, and the boldest. Earlier
 * years step away from it by age (see PALETTES): in the dark theme, deep blue-green to deep plum (at most
 * 5.0:1 on the page against the yellow's 11.7:1; the darkest 2.1:1); in the light theme, deep cobalt to
 * pale willow blue. Adjacent years are told apart by the tooltip and by legend highlighting.
 */
function yearStyle(offset: number, maxOffset: number): Pick<Line, "color" | "width" | "opacity"> {
  if (offset === 0) return { color: P.now, width: 2.6, opacity: 1 };
  const t = maxOffset <= 1 ? 0 : (offset - 1) / (maxOffset - 1);
  const S = P.yearStops;
  const [a, b] = t <= S[1].t ? [S[0], S[1]] : [S[1], S[2]];
  const u = (t - a.t) / (b.t - a.t);
  return {
    color: oklch(a.L + (b.L - a.L) * u, a.C + (b.C - a.C) * u, a.h + (b.h - a.h) * u),
    width: offset === 1 ? 1.3 : 1.05,
    opacity: 0.88,
  };
}

function stratNow(d: StationData): { deltaC: number; status: string } {
  const end = d.delta ? d.delta.lastValid() : NaN;
  const deltaC = d.delta && Number.isFinite(end) ? (d.delta.mean(end - 23 * HOUR, end) * 5) / 9 : NaN;
  return { deltaC, status: stratStatus(deltaC) };
}

/* ---------- Figures: one builder per view, used inline and in the zoom view ---------- */

type Kind = "yoy" | "chg" | "col" | "sb" | "wind" | "air";

/**
 * Charts sit in two columns, and a chart shares its time axis with the ones above and below it: the left
 * column follows the year comparison (96 days back, 14 ahead), the right column the 7-day change (60 days
 * back). Every station uses the same axes, so outages show as aligned empty stretches.
 */
const LEFT = (d: StationData): [number, number] => [d.now - 96 * DAY, d.now + 14 * DAY];
const RIGHT = (d: StationData): [number, number] => [d.now - 60 * DAY, d.now];

interface Built {
  opts: ChartOptions;
  legend: [string, string, number][];
  note?: string;
}

interface Fig {
  title: string;
  sub: string;
  depthTabs: boolean;
  seasonal: boolean; // compares years on the same dates (anchored at now); otherwise a recent timeline
  available: (d: StationData) => boolean;
  window: (d: StationData) => [number, number];
  maxSpan: number; // widest zoom in the normal view
  start?: (d: StationData) => number; // earliest data for this figure, if not the water record
  build: (d: StationData, depth: string, x0: number, x1: number, full: boolean) => Built;
}

const recordStart = (d: StationData) =>
  Math.min(...Object.values(d.hourly).filter((h): h is Hourly => !!h).map((h) => h.t0));

/** Every chart of a view shares one time axis across stations (now), so an outage shows as an empty
 * stretch rather than a chart that quietly ends early. */
const endOf = (d: StationData, _f: Fig) => d.now;

/** LISICOS panels (images on the operator's site) for a station: the only recent view of series the
 * data server does not publish. */
type Panels = { weather?: string; water_quality?: string; waves?: string };
const panelsOf = (id: string): Panels =>
  ((registry.stations as { id: string; panels?: Panels }[]).find((s) => s.id === id)?.panels ?? {});

/** The latest reading we have seen for any depth of the station (epoch seconds). */
function lastSeen(d: StationData): number {
  return Math.max(...d.depths.map((dep) => (d.obs[dep] ? Date.parse(d.obs[dep]!.time) / 1000 : -Infinity)));
}

/**
 * Waves, stated fairly per buoy: LISICOS lists wave data for Western Sound, Execution Rocks and Central
 * Sound only, so ARTG has no wave sensor rather than an outage. For the others, the wave datasets are not
 * on the data server now; the date given is our last saved copy, not a guess at when they stopped.
 */
type Waves = { sensor: boolean; dataset?: string; published?: boolean; last_saved_copy?: string };
const wavesOf = (id: string): Waves | null =>
  ((registry.stations as { id: string; waves?: Waves }[]).find((s) => s.id === id)?.waves ?? null);

function wavesText(id: string, short = false): string {
  const w = wavesOf(id);
  if (!w) return "";
  if (!w.sensor) return short ? "no sensor" : "Waves: no wave sensor on this buoy.";
  if (w.published) return short ? "published" : "Waves: published on the data server.";
  // We did not check daily, so the date is when we last saw the waves on the server, not when they stopped.
  const seen = w.last_saved_copy ? fmtDate.format(new Date(`${w.last_saved_copy}T12:00:00Z`)) : "";
  return short
    ? `offline${seen ? `, last seen ${seen.replace(/, \d{4}$/, "")}` : ""}`
    : `Waves: not on the data server now${seen ? `; last seen there ${seen}` : ""}. LISICOS posts a wave panel as an image.`;
}

/** The strongest hourly gust of each Eastern-time day, with the hour it happened (epoch seconds, knots). */
function dailyPeaks(gust: Hourly | null): [number, number][] {
  if (!gust) return [];
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const best = new Map<string, [number, number]>();
  gust.v.forEach((g, i) => {
    if (Number.isNaN(g)) return;
    const t = gust.t0 + i * HOUR;
    const key = day.format(new Date(t * 1000));
    const cur = best.get(key);
    if (!cur || g > cur[1]) best.set(key, [t, g]);
  });
  return [...best.values()];
}

/** Why a recent chart is empty, with where to look instead. */
function emptyNote(d: StationData): string {
  const p = panelsOf(d.meta.id);
  const t = lastSeen(d);
  const last = Number.isFinite(t) ? `Last reading: ${fmtDate.format(new Date(t * 1000))}. ` : "";
  const panel = p.water_quality ? ` or the <a href="${p.water_quality}">LISICOS water quality panel</a>` : "";
  return `No published data in this window. ${last}See Full record${panel}.`;
}

function limits(d: StationData, f: Fig, full: boolean): { min: number; max: number; maxSpan: number } {
  const end = endOf(d, f);
  const min = Math.min(f.start?.(d) ?? recordStart(d), end - 2 * DAY);
  return full
    ? { min, max: end + 2 * DAY, maxSpan: Infinity }
    : { min: Math.min(min, f.window(d)[0]), max: Math.max(end + (f.seasonal ? 60 : 2) * DAY, f.window(d)[1]), maxSpan: f.maxSpan };
}

const fullRange = (d: StationData, f: Fig): [number, number] => [f.start?.(d) ?? recordStart(d), endOf(d, f) + DAY];

/** Our holdings for one series: hours with data, share of the span, and where the history comes from. */
function coverageNote(d: StationData, depth: string): string {
  const h = d.hourly[depth];
  const s = d.meta.series.find((x) => x.depth === depth);
  if (!h || !s) return "";
  let have = 0;
  h.v.forEach((x) => {
    if (!Number.isNaN(x)) have++;
  });
  const start = fmtDate.format(new Date(h.t0 * 1000));
  const end = fmtDate.format(new Date(h.lastValid() * 1000));
  const kept = s.sources.filter((x) => x.kind === "archive");
  const archived = kept.length
    ? `; includes history no longer on the server, kept from our own saved downloads (${kept.map((x) => `${x.dataset} to ${x.last_obs?.slice(0, 10)}`).join(", ")})`
    : "";
  return `${s.label}: ${start} to ${end}, ${have.toLocaleString()} hourly values, ${Math.round((100 * have) / h.v.length)}% of the span; gaps are periods with no data${archived}.`;
}

/** The whole record as one timeline, each year's stretch in that year's color. */
function timelineBuilt(d: StationData, series: Hourly | null, depth: string, xs: number[], extra: Partial<ChartOptions>): Built {
  if (!series) return { opts: { xs, lines: [], unit: "°F", ...extra }, legend: [] };
  const current = new Date(d.now * 1000).getUTCFullYear();
  const first = new Date(series.t0 * 1000).getUTCFullYear();
  const maxOffset = Math.max(1, current - first);
  const years = [...Array(current - first + 1).keys()].map((i) => first + i);
  const lines = years
    .map((y) => ({
      ys: xs.map((t) => (new Date(t * 1000).getUTCFullYear() === y ? series.at(t) : NaN)),
      label: String(y),
      ...yearStyle(current - y, maxOffset),
    }))
    .filter((l) => l.ys.some((v) => Number.isFinite(v)));
  return {
    opts: { xs, lines, unit: "°F", empty: emptyNote(d), ...extra },
    legend: lines.map((l) => [l.label, l.color, l.opacity ?? 1]),
    note: coverageNote(d, depth),
  };
}

function yearBuilt(d: StationData, series: Hourly | null, xs: number[], extra: Partial<ChartOptions>): Built {
  const all = series ? yearLines(series, xs, d.now) : [];
  const { shown, hidden } = visibleYears(all);
  // Scale the ramp to the whole record, so a year keeps its color when another is hidden or the view pans.
  const maxOffset = Math.max(1, ...all.map((l) => l.offset));
  const lines = [...shown].reverse().map((l) => ({ ys: l.values, label: String(l.year), ...yearStyle(l.offset, maxOffset) }));
  return {
    opts: { xs, lines, unit: "°F", empty: emptyNote(d), ...extra },
    legend: shown.map((l) => [String(l.year), yearStyle(l.offset, maxOffset).color, yearStyle(l.offset, maxOffset).opacity ?? 1]),
    note: hidden.length
      ? `not drawn (under ${COVERAGE_MIN * 100}% coverage in this window): ${hidden.map((l) => l.year).join(", ")}`
      : undefined,
  };
}

const FIGS: Record<Kind, Fig> = {
  yoy: {
    title: "This year against earlier years",
    sub: "36 h mean, same dates",
    depthTabs: true,
    seasonal: true,
    available: () => true,
    window: LEFT,
    maxSpan: 366 * DAY,
    build: (d, depth, x0, x1, full) =>
      full
        ? timelineBuilt(d, d.m36[depth], depth, grid(x0, x1), { marker: { x: d.now, label: "now" } })
        : yearBuilt(d, d.m36[depth], grid(x0, x1), { marker: { x: d.now, label: "now" } }),
  },
  chg: {
    title: "7-day change",
    sub: "of the 36 h mean",
    depthTabs: true,
    seasonal: true,
    available: () => true,
    window: RIGHT,
    maxSpan: 366 * DAY,
    build: (d, depth, x0, x1, full) =>
      full ? timelineBuilt(d, d.chg[depth], depth, grid(x0, x1), { zero: true }) : yearBuilt(d, d.chg[depth], grid(x0, x1), { zero: true }),
  },
  col: {
    title: "Water column",
    sub: "hourly and 36 h mean",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.depths.length >= 2,
    window: LEFT,
    maxSpan: 2 * 366 * DAY,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const lines: Line[] = [];
      const legend: [string, string, number][] = [];
      for (const s of [...d.meta.series].reverse()) {
        const h = d.hourly[s.depth];
        const m = d.m36[s.depth];
        if (!h || !m) continue;
        const color = P.depth[s.depth];
        lines.push({ ys: xs.map((t) => h.at(t)), color, width: 0.8, opacity: 0.22, label: `${s.label} hourly`, tip: false });
        lines.push({ ys: xs.map((t) => m.at(t)), color, width: 1.8, opacity: 1, label: `${s.label} 36 h` });
        legend.unshift([s.label, color, 1]);
      }
      return { opts: { xs, lines, unit: "°F", empty: emptyNote(d) }, legend };
    },
  },
  sb: {
    title: "Surface minus bottom",
    sub: "shading marks the working thresholds",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.delta,
    window: RIGHT,
    maxSpan: 2 * 366 * DAY,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const { delta, delta36 } = d;
      const lines: Line[] =
        delta && delta36
          ? [
              { ys: xs.map((t) => delta.at(t)), color: P.contrast, width: 0.9, opacity: 0.5, label: "hourly" },
              { ys: xs.map((t) => delta36.at(t)), color: P.now, width: 1.8, label: "36 h mean" },
            ]
          : [];
      const [mx, st] = [dF(STRAT.mixed), dF(STRAT.stratified)];
      return {
        opts: {
          xs, lines, unit: "°F", zero: true, hoverDigits: 2, empty: emptyNote(d),
          bands: [
            { y0: -st, y1: st, fill: P.bands[0] },
            { y0: -mx, y1: mx, fill: P.bands[1] },
          ],
        },
        legend: [["hourly", P.contrast, 0.5], ["36 h mean", P.now, 1]],
        note: `inner band: mixed (under ${STRAT.mixed} °C, ${dF(STRAT.mixed).toFixed(2)} °F); outer band: weakly stratified (to ${STRAT.stratified} °C)`,
      };
    },
  },
  wind: {
    title: "Wind",
    sub: "smoothed, with hourly and each day's peak gust",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.met?.wind,
    window: LEFT,
    maxSpan: 100 * DAY,
    start: (d) => d.met?.wind?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const m = d.met;
      // Smoothing follows the zoom: a half-life of about a tenth of a day per day shown, from 1 h (a few
      // days in view) to 12 h (the default 110 days), so the line keeps a readable density at any span.
      const halfLife = Math.min(12, Math.max(1, Math.round(((x1 - x0) / DAY) * 0.11)));
      const smooth = m?.wind?.ema(halfLife);
      const smoothLabel = `Wind, smoothed (${halfLife} h half-life)`; // the parameter travels with the plot
      const peaks = dailyPeaks(m?.gust ?? null);
      const u = WIND_UNITS[WU];
      const fmtU = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
      // Each day's strongest gust, placed on the grid point nearest its hour.
      const step = xs.length > 1 ? xs[1] - xs[0] : HOUR;
      const peakYs = xs.map(() => NaN);
      for (const [t, g] of peaks) {
        const i = Math.round((t - xs[0]) / step);
        if (i >= 0 && i < xs.length) peakYs[i] = windVal(g);
      }
      const lines: Line[] = m
        ? [
            { ys: peakYs, color: P.contrast, opacity: 0.55, label: "Daily peak gust", dots: true, fmt: fmtU },
            { ys: xs.map((t) => windVal(m.wind?.at(t) ?? NaN)), color: P.wind, width: 0.7, opacity: 0.22, label: "Wind, hourly", fmt: fmtU },
            { ys: xs.map((t) => windVal(m.gust?.at(t) ?? NaN)), color: P.contrast, label: "Gust, hourly", hidden: true, fmt: fmtU },
            { ys: xs.map((t) => windVal(smooth?.at(t) ?? NaN)), color: P.wind, width: 1.8, label: smoothLabel, fmt: fmtU },
            { ys: xs.map((t) => m.dir?.at(t) ?? NaN), color: P.wind, label: "From", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
          ]
        : [];
      return {
        opts: { xs, lines, unit: ` ${u.label}`, zero: true, empty: "No weather data in this window." },
        legend: [[smoothLabel, P.wind, 1], ["Wind, hourly", P.wind, 0.35], ["Daily peak gust", P.contrast, 0.55]],
      };
    },
  },
  air: {
    title: "Air and water temperature",
    sub: "hourly",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.met?.air,
    window: RIGHT,
    maxSpan: 100 * DAY,
    start: (d) => d.met?.air?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const top = d.depths[0];
      const water = d.hourly[top];
      const label = `Water, ${DEPTH_LABEL[top].toLowerCase()}`;
      const lines: Line[] = [
        { ys: xs.map((t) => water?.at(t) ?? NaN), color: P.depth[top], width: 1.6, label },
        { ys: xs.map((t) => d.met?.air?.at(t) ?? NaN), color: P.air, width: 1.3, label: "Air" },
      ];
      return {
        opts: { xs, lines, unit: "°F", empty: emptyNote(d) },
        legend: [[label, P.depth[top], 1], ["Air", P.air, 1]],
      };
    },
  },
};

function legendHtml(b: Built): string {
  return (
    b.legend
      .map(([label, color, op]) => `<button type="button" class="lg" data-label="${label}"><i style="background:${color};opacity:${op}"></i>${label}</button>`)
      .join("") + (b.note ? `<span class="off">${b.note}</span>` : "")
  );
}

/** Hovering, focusing or tapping a legend entry highlights its line(s) in the plot. */
function wireLegend(legend: HTMLElement, plot: HTMLElement): void {
  let pinned: string | null = null;
  const set = (label: string | null) => highlight(plot, label);
  legend.addEventListener("pointerover", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".lg");
    if (b && pinned === null) set(b.dataset.label!);
  });
  legend.addEventListener("pointerout", () => {
    if (pinned === null) set(null);
  });
  legend.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".lg");
    if (!b) return;
    pinned = pinned === b.dataset.label ? null : b.dataset.label!;
    legend.querySelectorAll(".lg").forEach((x) => x.classList.toggle("pinned", (x as HTMLElement).dataset.label === pinned));
    set(pinned);
  });
}

/* ---------- Overview: map and status grid ---------- */

/**
 * The last 7 days of hourly temperature as a tiny line, scaled to its own week's range: the vertical
 * exaggeration makes a 1-degree swing visible. The range is in the tooltip, so the shape is never read
 * as an absolute value.
 */
function sparkline(d: StationData, depth: string, color: string): string {
  const h = d.hourly[depth];
  return h ? sparklineOf(h, color, "F") : "";
}

function sparklineOf(h: Hourly, color: string, unit: string): string {
  const end = h.lastValid();
  const xs = grid(end - 7 * DAY, end, 170);
  const ys = xs.map((t) => h.at(t));
  const ok = ys.filter((v) => Number.isFinite(v));
  if (ok.length < 2) return "";
  const lo = Math.min(...ok);
  const hi = Math.max(...ok);
  const W = 64;
  const H = 16;
  let path = "";
  let pen = false;
  ys.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = (i / (xs.length - 1)) * W;
    const y = H - 1 - ((v - lo) / Math.max(0.2, hi - lo)) * (H - 2);
    path += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  const title = `last 7 days: ${lo.toFixed(1)} to ${hi.toFixed(1)} ${unit} (scaled to this range)`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}"><title>${title}</title><path d="${path}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
}

function cellHtml(d: StationData, depth: string): string {
  if (!d.depths.includes(depth)) return `<td class="na" title="No ${DEPTH_LABEL[depth].toLowerCase()} sensor published">&middot;</td>`;
  const o = d.obs[depth];
  const state = obsState(o);
  if (!o || o.temperature_c == null) return `<td class="offline">--</td>`;
  if (state === "offline") {
    // An old reading is not a current condition: show the outage, not the value.
    const since = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", year: "numeric" }).format(new Date(o.time));
    return `<td class="offline" title="${DEPTH_LABEL[depth]}: last reading ${fmtUtc(o.time)}"><b>--</b><small>since ${since}</small></td>`;
  }
  return `<td class="${state}" title="${DEPTH_LABEL[depth]}: ${f1(cToF(o.temperature_c))} F, ${ago(o.time)}">${sparkline(d, depth, state === "live" ? P.now : P.delayed)}<b>${f1(cToF(o.temperature_c))}&deg;</b><small>${ago(o.time).replace(" ago", "")}</small></td>`;
}

/** Latest buoy wind: mean and gust in the chosen unit, a downwind arrow with the compass point it comes
 * from, and air temperature, with a 7-day wind sparkline. */
function windCell(d: StationData): string {
  const o = d.met?.last;
  if (!o || o.wind_kt == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent wind</small></td>`;
  const u = WIND_UNITS[WU].label;
  const dir = o.dir_deg != null ? compass(o.dir_deg) : "";
  const title = `Wind ${windFmt(o.wind_kt)} ${u}, gusts ${windFmt(o.gust_kt)} ${u}, from ${dir || "--"}; air ${f1(o.air_f ?? NaN)} F; ${ago(o.time)}`;
  const spark = d.met?.wind ? sparklineOf(d.met.wind, P.wind, "kt") : "";
  return `<td class="${state} wind" title="${title}">${spark}<b>${o.dir_deg != null ? windArrow(o.dir_deg) : ""}${dir} ${windFmt(o.wind_kt)}<small class="g">${u}</small></b><small>gusts ${windFmt(o.gust_kt)} &middot; air ${o.air_f != null ? Math.round(o.air_f) + "&deg;" : "--"} &middot; ${ago(o.time).replace(" ago", "")}</small></td>`;
}

/** Waves: an outage where the buoy has a wave sensor, "no sensor" where it does not. */
function wavesCell(d: StationData): string {
  const w = wavesOf(d.meta.id);
  if (!w) return `<td class="na">&middot;</td>`;
  const panel = panelsOf(d.meta.id).waves;
  if (!w.sensor) return `<td class="na" title="${wavesText(d.meta.id)}"><small>no sensor</small></td>`;
  const inner = `<b>--</b><small>${wavesText(d.meta.id, true)}</small>`;
  return `<td class="offline waves" title="${wavesText(d.meta.id)}">${panel ? `<a href="${panel}">${inner}</a>` : inner}</td>`;
}

function statusGrid(stations: StationData[]): void {
  const rows = stations
    .map((d) => {
      const st = overallState(d);
      return `<tr><th scope="row"><a href="#${d.meta.id}"><i class="dot ${st}"></i>${d.meta.name}</a></th>${DEPTHS.map((dep) => cellHtml(d, dep)).join("")}${windCell(d)}${wavesCell(d)}</tr>`;
    })
    .join("");
  $("status").innerHTML = `
    <table class="status-grid">
      <caption>Latest readings, west to east: water temperature (&deg;F) and wind (${WIND_UNITS[WU].label})</caption>
      <thead><tr><th></th>${DEPTHS.map((d) => `<th scope="col">${DEPTH_LABEL[d]}</th>`).join("")}<th scope="col">Wind</th><th scope="col">Waves</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="status-key"><i class="dot live"></i>under ${DELAYED_HOURS} h old <i class="dot delayed"></i>under ${OFFLINE_HOURS} h <i class="dot partial"></i>weather only <i class="dot offline"></i>offline
      &middot; lines: last 7 days, each stretched to its own range</p>`;
}

async function overviewMap(stations: StationData[]): Promise<void> {
  const box = $("map");
  try {
    const { drawMap } = await import("./map");
    drawMap(
      box,
      stations.map((d) => {
        const dep = d.depths.includes("SFC") ? "SFC" : d.depths[0];
        const o = d.obs[dep];
        const state = overallState(d);
        const w = d.met?.last;
        const wind = w && w.wind_kt != null ? `wind ${w.dir_deg != null ? compass(w.dir_deg) + " " : ""}${windFmt(w.wind_kt)} ${WIND_UNITS[WU].label}, ${ago(w.time)}` : "";
        const reading =
          state === "partial"
            ? `Weather live: ${wind}<br>Water quality offline${o ? ` since ${fmtDate.format(new Date(o.time))}` : ""}`
            : o && o.temperature_c != null
              ? `${DEPTH_LABEL[dep]} ${f1(cToF(o.temperature_c))}&deg;F, ${ago(o.time)}${wind ? `<br>${wind}` : ""}`
              : "no reading";
        const waves = wavesText(d.meta.id, true);
        const label = waves ? `${reading}<br>Waves: ${waves}` : reading;
        return { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, state, label };
      }),
      (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }),
      currentTheme(),
    );
  } catch {
    box.innerHTML = `<p class="note">The map could not load.</p>`;
  }
}

/* ---------- Station sections ---------- */

function depthTabsHtml(d: StationData, key: string, active: string): string {
  return `<span class="tabs" role="group" aria-label="Depth">${d.meta.series
    .map((s) => `<button class="tab" type="button" data-fig="${key}" data-depth="${s.depth}" aria-pressed="${s.depth === active}">${s.label}</button>`)
    .join("")}</span>`;
}

function sectionHtml(d: StationData): string {
  const st = d.meta;
  const id = st.id;
  const rec = st.series.map((s) => `${s.label.toLowerCase()} from ${s.record_start?.slice(0, 4) ?? "--"}`).join(", ");
  const kinds = (Object.keys(FIGS) as Kind[]).filter((k) => FIGS[k].available(d));
  const fig = (key: Kind) => {
    const f = FIGS[key];
    return `
    <figure>
      <figcaption><span class="cap-label">${f.title}</span><span class="cap-sub">${f.sub}</span>${f.depthTabs && d.depths.length > 1 ? depthTabsHtml(d, key, d.depths[0]) : ""}
        <span class="fig-actions"><button class="expand" type="button" data-station="${id}" data-fig="${key}" data-full="1" aria-label="Full record: ${f.title}, ${st.name}">Full record</button><button class="expand" type="button" data-station="${id}" data-fig="${key}" aria-label="Expand: ${f.title}, ${st.name}">Expand</button></span></figcaption>
      <div class="plot" id="${id}-${key}" data-station="${id}" data-fig="${key}" title="Click to expand"><svg role="img" aria-label="${f.title}"></svg><div class="plot-labels" aria-hidden="true"></div></div>
      <div class="legend" id="${id}-${key}-legend"></div>
    </figure>`;
  };
  // Any buoy can go quiet (a sensor fault, a recovery, or the server dropping a dataset): say so in the
  // same words for every station, plus the station's own outage note when the server is not publishing.
  const quiet = stationState(d) === "offline";
  const notes = [
    st.note,
    wavesText(id),
    !d.live && st.outage_note ? st.outage_note : "",
    quiet
      ? `No reading since ${fmtDate.format(new Date(lastSeen(d) * 1000))}, so there is no line for this year and the recent charts are empty. ` +
        `The year charts show this time of year in the years we hold; Full record shows everything we have kept. ` +
        `For recent conditions, see the LISICOS panels above (images on their site).`
      : "",
  ].filter(Boolean);
  return `
    <section class="station" id="${id}" aria-labelledby="${id}-title">
      <div class="station-head">
        <h2 id="${id}-title"><i class="dot ${overallState(d)}"></i>${st.name}</h2>
        <span class="sid">${id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W</span>
        <span class="rec">Record: ${rec}</span>
      </div>
      <p class="station-links"><span>At LISICOS:</span>${[
        st.info_url ? `<a href="${st.info_url}">About this buoy</a>` : "",
        panelsOf(id).weather ? `<a href="${panelsOf(id).weather}">Weather panel</a>` : "",
        panelsOf(id).water_quality ? `<a href="${panelsOf(id).water_quality}">Water quality panel</a>` : "",
        panelsOf(id).waves ? `<a href="${panelsOf(id).waves}">Wave panel</a>` : "",
      ]
        .filter(Boolean)
        .join("")}</p>
      ${notes.length ? `<p class="station-note">${notes.join(" ")}</p>` : ""}
      <div class="band" id="${id}-readouts"></div>
      <div class="figs">${kinds.map(fig).join("")}</div>
    </section>`;
}

function readouts(d: StationData): void {
  const tempItem = (depth: string) => {
    const o = d.obs[depth];
    const label = d.meta.series.find((s) => s.depth === depth)?.label ?? depth;
    if (!o || o.temperature_c == null) return `<div class="readout"><div class="num">--</div><span class="lab">${label}</span><span class="sub">no recent reading</span></div>`;
    const state = obsState(o);
    if (state === "offline") {
      // An old reading is not a current condition: keep it out of the big figure.
      return `<div class="readout"><div class="num">--</div><span class="lab">${label}</span>
        <span class="sub offline">no current reading &middot; last ${f1(cToF(o.temperature_c))}&deg;F at ${o.depth_m ?? "--"} m, ${fmtDate.format(new Date(o.time))}</span></div>`;
    }
    return `<div class="readout"><div class="num">${f1(cToF(o.temperature_c))}&deg;F<small>${o.temperature_c.toFixed(1)}&deg;C</small></div>
      <span class="lab">${label}</span><span class="sub ${state}">${o.depth_m ?? "--"} m &middot; ${ago(o.time)}</span></div>`;
  };
  const items = d.depths.filter((dep) => dep !== "MID").map(tempItem);
  const offline = stationState(d) === "offline";
  if (d.delta) {
    const sb = stratNow(d);
    items.push(
      offline
        ? `<div class="readout"><div class="num">--</div><span class="lab">Surface minus bottom</span>
      <span class="sub offline">no current reading &middot; last ${signed(sb.deltaC, 2)}&deg;C, ${sb.status}</span></div>`
        : `<div class="readout"><div class="num">${signed(sb.deltaC, 2)}&deg;C</div><span class="lab">Surface minus bottom</span>
      <span class="sub">${sb.status} (alpha definition) &middot; 24 h mean</span></div>`,
    );
  }
  const deep = d.obs.BTM ?? d.obs[d.depths[d.depths.length - 1]];
  const where = d.obs.BTM ? "Bottom" : "Surface";
  const doNow = deep?.oxygen_mg_l != null && obsState(deep) !== "offline";
  items.push(`<div class="readout"><div class="num">${doNow ? deep!.oxygen_mg_l!.toFixed(1) : "--"}<small>mg/L</small></div><span class="lab">${where} dissolved oxygen</span>
      <span class="sub${doNow ? "" : " offline"}">${
        doNow
          ? `salinity ${deep!.salinity != null ? deep!.salinity.toFixed(1) : "--"} &middot; ${ago(deep!.time)}`
          : deep?.oxygen_mg_l != null
            ? `no current reading &middot; last ${deep.oxygen_mg_l.toFixed(1)} mg/L, ${fmtDate.format(new Date(deep.time))}`
            : "no recent reading"
      }</span></div>`);
  $(`${d.meta.id}-readouts`).innerHTML = items.join("");
}

const activeDepth = (d: StationData, key: Kind) =>
  document.querySelector<HTMLButtonElement>(`#${d.meta.id} .tab[data-fig="${key}"][aria-pressed="true"]`)?.dataset.depth ?? d.depths[0];

function drawInline(d: StationData, key: Kind): void {
  if (!FIGS[key].available(d)) return;
  const [x0, x1] = FIGS[key].window(d);
  const b = FIGS[key].build(d, activeDepth(d, key), x0, x1, false);
  renderLines($(`${d.meta.id}-${key}`), b.opts);
  $(`${d.meta.id}-${key}-legend`).innerHTML = legendHtml(b);
}

/* ---------- Zoom view: wheel or pinch to zoom, drag to pan, tooltips throughout ---------- */

interface ZoomState {
  d: StationData;
  key: Kind;
  depth: string;
  x0: number;
  x1: number;
  full: boolean; // the whole record as a timeline, instead of the default view
}

let zoom: ZoomState | null = null;
let zoomFrame = 0;

function drawZoom(): void {
  if (!zoom) return;
  const b = FIGS[zoom.key].build(zoom.d, zoom.depth, zoom.x0, zoom.x1, zoom.full);
  renderLines($("zoom-plot"), b.opts);
  $("zoom-legend").innerHTML = legendHtml(b);
}

/** Switch between the default view and the full record, and label the toggle for the other one. */
function setFull(full: boolean): void {
  if (!zoom) return;
  const f = FIGS[zoom.key];
  zoom.full = full;
  const [a, b] = full ? fullRange(zoom.d, f) : f.window(zoom.d);
  zoom.x0 = a;
  zoom.x1 = b;
  const toggle = $("zoom-full");
  toggle.textContent = full ? (f.seasonal ? "Same dates by year" : "Recent") : "Full record";
  toggle.setAttribute("aria-pressed", String(full));
  $("zoom-sub").textContent = full ? "everything we hold, each year in its color; gaps are periods with no data" : f.sub;
  requestZoomDraw();
}

function requestZoomDraw(): void {
  cancelAnimationFrame(zoomFrame);
  zoomFrame = requestAnimationFrame(drawZoom);
}

/** Clamp the range to the figure's limits, keeping the span. */
function setRange(x0: number, x1: number): void {
  if (!zoom) return;
  const lim = limits(zoom.d, FIGS[zoom.key], zoom.full);
  const span = Math.max(0, Math.min(Math.max(x1 - x0, 2 * DAY), lim.maxSpan, lim.max - lim.min));
  let a = x1 - x0 !== span ? (x0 + x1) / 2 - span / 2 : x0;
  a = Math.max(lim.min, Math.min(a, lim.max - span));
  zoom.x0 = a;
  zoom.x1 = a + span;
  requestZoomDraw();
}

function zoomBy(factor: number, center?: number): void {
  if (!zoom) return;
  const c = center ?? (zoom.x0 + zoom.x1) / 2;
  setRange(c - (c - zoom.x0) * factor, c + (zoom.x1 - c) * factor);
}

function openZoom(d: StationData, key: Kind, full = false): void {
  const f = FIGS[key];
  const [x0, x1] = f.window(d);
  zoom = { d, key, depth: activeDepth(d, key), x0, x1, full: false };
  $("zoom-title").textContent = `${f.title} · ${d.meta.name}`;
  $("zoom-tabs").innerHTML = f.depthTabs && d.depths.length > 1 ? depthTabsHtml(d, "zoom", zoom.depth) : "";
  ($("zoom") as HTMLDialogElement).showModal();
  setFull(full); // draws after layout, so the axis labels fit the dialog's width
}

function wireZoom(): void {
  const dialog = $("zoom") as HTMLDialogElement;
  const plot = $("zoom-plot");
  plot.dataset.zoom = "1";
  new ResizeObserver(() => requestZoomDraw()).observe(plot);
  wireLegend($("zoom-legend"), plot);
  const svg = plot.querySelector("svg")!;
  const span = () => (zoom ? zoom.x1 - zoom.x0 : 1);
  const timeAt = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    return zoom!.x0 + ((clientX - box.left) / Math.max(1, box.width)) * span();
  };

  $("zoom-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // click on the backdrop
  });
  dialog.addEventListener("close", () => (zoom = null));
  $("zoom-in").addEventListener("click", () => zoomBy(1 / 1.6));
  $("zoom-out").addEventListener("click", () => zoomBy(1.6));
  $("zoom-reset").addEventListener("click", () => {
    if (!zoom) return;
    const f = FIGS[zoom.key];
    const [a, b] = zoom.full ? fullRange(zoom.d, f) : f.window(zoom.d);
    setRange(a, b);
  });
  $("zoom-full").addEventListener("click", () => setFull(!zoom?.full));
  $("zoom-tabs").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".tab");
    if (!btn || !zoom) return;
    zoom.depth = btn.dataset.depth!;
    $("zoom-tabs").querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    requestZoomDraw();
  });
  dialog.addEventListener("keydown", (e) => {
    if (!zoom) return;
    if (e.key === "+" || e.key === "=") zoomBy(1 / 1.6);
    else if (e.key === "-") zoomBy(1.6);
    else if (e.key === "ArrowLeft") setRange(zoom.x0 - span() * 0.2, zoom.x1 - span() * 0.2);
    else if (e.key === "ArrowRight") setRange(zoom.x0 + span() * 0.2, zoom.x1 + span() * 0.2);
  });

  svg.addEventListener(
    "wheel",
    (e) => {
      if (!zoom) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dt = (e.deltaX / svg.getBoundingClientRect().width) * span();
        setRange(zoom.x0 + dt, zoom.x1 + dt);
      } else zoomBy(Math.exp(e.deltaY * 0.0015), timeAt(e.clientX));
    },
    { passive: false },
  );

  // Pointer drag pans; two pointers pinch-zoom around their midpoint.
  const pointers = new Map<number, number>();
  let start: { x0: number; x1: number; pts: [number, number][] } | null = null;
  const snapshot = () => {
    start = zoom ? { x0: zoom.x0, x1: zoom.x1, pts: [...pointers.entries()] } : null;
  };
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e.clientX);
    snapshot();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!zoom || !start || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e.clientX);
    const width = svg.getBoundingClientRect().width;
    const s0 = start.x1 - start.x0;
    if (pointers.size === 1 && start.pts.length === 1) {
      const dt = ((start.pts[0][1] - e.clientX) / width) * s0;
      setRange(start.x0 + dt, start.x1 + dt);
    } else if (pointers.size === 2 && start.pts.length === 2) {
      const [a, b] = start.pts.map(([, x]) => x);
      const [c, d] = [...pointers.values()];
      const factor = Math.max(8, Math.abs(b - a)) / Math.max(8, Math.abs(d - c));
      const box = svg.getBoundingClientRect();
      const mid = start.x0 + (((a + b) / 2 - box.left) / width) * s0;
      setRange(mid - (mid - start.x0) * factor, mid + (start.x1 - mid) * factor);
    }
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    snapshot();
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("dblclick", () => $("zoom-reset").click());
}

/* ---------- Freshness and notes ---------- */

function updatedStrip(meta: Meta, live: Live): void {
  const latest = Object.values(live.series)
    .map((s) => s.last_obs?.time)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const failing = Object.entries(live.datasets)
    // Only datasets that were working before: a series in a known outage is explained in its own section.
    .filter(([, s]) => s.last_error && s.last_ok && s.last_error.slice(0, 20) > s.last_ok)
    .map(([k]) => k);
  const draw = () => {
    const parts = [
      `<b>Updated</b>${fmtUtc(live.generated_at)} <span class="ago">(${ago(live.generated_at)})</span>`,
      latest ? `latest buoy reading ${fmtUtc(latest)} <span class="ago">(${ago(latest)})</span>` : "no recent buoy reading",
      `history rebuilt ${fmtUtc(meta.generated_at)}`,
    ];
    if (failing.length) parts.push(`<span class="warn">last fetch failed for ${failing.join(", ")}; showing the last good values</span>`);
    $("updated").innerHTML = parts.join(`<span class="sep">&middot;</span>`);
  };
  draw();
  window.setInterval(draw, 60_000);
}

function about(meta: Meta): void {
  $("about-method").innerHTML =
    `Each line is a trailing 36-hour mean of hourly means (at least 24 of the 36 hours present; gaps are left as gaps). Earlier years are drawn ` +
    `on the same calendar dates, in muted colors from deep blue-green (last year) through purples (oldest), so this year's yellow line stands alone, and a year is drawn only when at least ${COVERAGE_MIN * 100}% ` +
    `of the window has data, so a partial deployment year does not read as an anomaly. The 7-day change is the 36-hour mean now minus the same ` +
    `mean 168 hours earlier. Stratification uses a working definition for this alpha: surface minus bottom temperature over the last 24 hours, ` +
    `mixed under ${STRAT.mixed} &deg;C, weakly stratified to ${STRAT.stratified} &deg;C, stratified above. Quality control: ${meta.qc} ` +
    `Times are stored in UTC and labelled in Eastern time.` +
    `<br><br>Wind: the bold line is a two-sided exponential moving average of the hourly wind (run forward and then ` +
    `backward, so peaks are not delayed; at the latest hour it uses past data only, and it restarts after a gap rather ` +
    `than bridging it). Its half-life is a display parameter that follows the time span on screen, about 0.11 days per ` +
    `day shown, between 1 and 12 hours, so zooming in sharpens the line; the value in use is shown with each plot. The ` +
    `faint line is the hourly mean and the dots are each day's strongest gust. Buoy weather is kept for the last 100 days so far.`;
  const src = meta.stations
    .flatMap((st) =>
      st.series.map((s: MetaSeries) => {
        const parts = s.sources.map((x) =>
          x.kind === "archive"
            ? `<code>${x.dataset}</code> ${x.first_obs?.slice(0, 10)} to ${x.last_obs?.slice(0, 10)} (${x.note ?? "kept from our own saved download"})`
            : x.published === false
              ? `<code>${x.dataset}</code> (not published on the server now; checked hourly)`
              : `<code>${x.dataset}</code> from ${x.first_obs?.slice(0, 10) ?? "--"}`,
        );
        return `${st.name} ${s.label.toLowerCase()} (sensor depth ${s.depth_m.join(" and ")} m): ${parts.join("; then ")}.`;
      }),
    )
    .join(" ");
  $("about-sources").innerHTML = `Sources: ${src}`;
}

/* ---------- Bring your own AI ---------- */

function promptData(stations: StationData[]): string {
  const out: string[] = [];
  for (const d of stations) {
    const st = d.meta;
    const xs = grid(d.now - 96 * DAY, d.now + 14 * DAY, Infinity);
    out.push(`Station ${st.id}, ${st.name} (${st.operator}), ${st.lat.toFixed(2)} N, ${Math.abs(st.lon).toFixed(2)} W.${st.note ? " " + st.note : ""}${!d.live && st.outage_note ? " " + st.outage_note : ""}`);
    for (const s of st.series) {
      const o = d.obs[s.depth];
      const m = d.m36[s.depth];
      out.push(`  ${s.label} (sensor depth ${s.depth_m.join(" and ")} m; hourly record from ${s.record_start?.slice(0, 10) ?? "unknown"}${s.live ? "" : "; not published on the server now"}):`);
      if (o && o.temperature_c != null) {
        const extra = [
          o.salinity != null ? `salinity ${o.salinity.toFixed(2)}` : "",
          o.oxygen_mg_l != null ? `dissolved oxygen ${o.oxygen_mg_l.toFixed(2)} mg/L` : "",
        ].filter(Boolean);
        out.push(`    ${s.live ? "latest" : "last"} observation ${fmtUtc(o.time)} (${ago(o.time)}): ${f1(cToF(o.temperature_c))} F (${o.temperature_c.toFixed(2)} C)${extra.length ? "; " + extra.join("; ") : ""}.`);
      } else out.push(`    no recent observation.`);
      if (!m) continue;
      // Anchor to the latest hour with a 36 h mean (the server runs about an hour behind the clock). With no
      // recent data (an outage), anchor the comparison to now: "this time of year in the years we hold".
      const tLast = m.lastValid();
      const recent = xs.indexOf(tLast) >= 0;
      const iAt = recent ? xs.indexOf(tLast) : xs.indexOf(d.now);
      const { shown, hidden } = visibleYears(yearLines(m, xs, d.now));
      if (recent) {
        const cur = m.at(tLast);
        const chg = d.chg[s.depth]?.at(tLast) ?? NaN;
        out.push(`    36 h mean as of ${fmtUtc(new Date(tLast * 1000).toISOString())}: ${f1(cur)} F (${f1(fToC(cur))} C); 7-day change: ${signed(chg)} F.`);
      } else {
        out.push(`    no data in the last 96 days (last 36 h mean ${fmtUtc(new Date(tLast * 1000).toISOString())}); comparisons below are for this date and hour in earlier years.`);
      }
      const past = shown.filter((l) => l.offset > 0 && Number.isFinite(l.values[iAt])).map((l) => `${l.year} ${f1(l.values[iAt])} F`);
      if (past.length) out.push(`    36 h mean at the same date and hour in earlier years: ${past.join("; ")}.`);
      if (hidden.length) out.push(`    years left out of the comparison because under ${COVERAGE_MIN * 100}% of the 110-day window has data: ${hidden.map((l) => l.year).join(", ")}.`);
    }
    if (d.delta) {
      const sb = stratNow(d);
      out.push(`  Surface minus bottom, mean of the last 24 hours with data: ${signed(sb.deltaC, 2)} C, ${sb.status}.`);
    }
    const w = d.met?.last;
    if (w && w.wind_kt != null) {
      const dir = w.dir_deg != null ? `from ${compass(w.dir_deg)} (${Math.round(w.dir_deg)} degrees)` : "direction unknown";
      out.push(
        `  Weather at the buoy, ${fmtUtc(w.time)} (${ago(w.time)}): wind ${f1(w.wind_kt)} kt ${dir}, gusts ${f1(w.gust_kt ?? NaN)} kt` +
          (WU === "kt" ? "; " : ` (wind ${windFmt(w.wind_kt)} ${WIND_UNITS[WU].label}, gusts ${windFmt(w.gust_kt)} ${WIND_UNITS[WU].label}); `) +
          `air ${f1(w.air_f ?? NaN)} F; pressure ${w.pressure_mb != null ? w.pressure_mb.toFixed(1) : "--"} mbar.`,
      );
    }
    if (wavesOf(st.id)) out.push(`  ${wavesText(st.id)}`);
  }
  return out.join("\n");
}

function buildPrompt(meta: Meta, live: Live, stations: StationData[]): string {
  const fill: Record<string, string> = {
    waterway: meta.waterway.name,
    page_url: location.origin + location.pathname,
    generated_at: live.generated_at.slice(0, 16).replace("T", " "),
    strat_mixed: String(STRAT.mixed),
    strat_stratified: String(STRAT.stratified),
    qc: meta.qc,
    data: promptData(stations),
    question: "[Write your question here, for example: how does this fall compare with recent years, and is the water column still stratified?]",
  };
  return promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, k: string) => fill[k] ?? "");
}

function wireCopy(meta: Meta, live: Live, stations: StationData[]): void {
  const status = $("copy-status");
  const box = $("prompt-box") as HTMLTextAreaElement;
  $("copy").addEventListener("click", async () => {
    const text = buildPrompt(meta, live, stations);
    box.value = text;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `Copied ${text.length.toLocaleString()} characters. Paste it into your assistant and edit the question at the end.`;
      box.hidden = true;
    } catch {
      box.hidden = false;
      box.focus();
      box.select();
      status.textContent = "Clipboard access was blocked; the prompt is selected below, ready to copy.";
    }
  });
}

/* ---------- Main ---------- */

/** Wind units (kt, mph, m/s): knots by default; the choice is remembered in this browser only. */
function wireUnits(redraw: () => void): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".unit-switch [data-unit]");
  const mark = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === WU)));
  mark();
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      WU = b.dataset.unit as WindUnit;
      try {
        localStorage.setItem("lhzn-blue-wind-unit", WU);
      } catch {
        /* private mode: the choice lasts for this page only */
      }
      mark();
      redraw();
    }),
  );
}

/** The Light/Dark toggle: dark by default; the choice is remembered in this browser only. */
function wireTheme(redraw: () => void): void {
  const btn = $("theme-toggle");
  const label = () => {
    const light = currentTheme() === "light";
    btn.textContent = light ? "Dark" : "Light";
    btn.setAttribute("aria-pressed", String(light));
    btn.setAttribute("aria-label", light ? "Switch to the dark theme" : "Switch to the light theme");
  };
  label();
  btn.addEventListener("click", async () => {
    const next: Theme = currentTheme() === "light" ? "dark" : "light";
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("lhzn-blue-theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    P = PALETTES[next];
    label();
    redraw();
    try {
      (await import("./map")).setMapTheme(next);
    } catch {
      /* map not loaded */
    }
  });
}

async function main(): Promise<void> {
  P = PALETTES[currentTheme()];
  try {
    const { meta, live, stations } = await load();
    const byId = Object.fromEntries(stations.map((d) => [d.meta.id, d]));
    $("stations").innerHTML = stations.map(sectionHtml).join("");
    statusGrid(stations);
    void overviewMap(stations);
    const drawAll = () => {
      for (const d of stations) {
        readouts(d);
        (Object.keys(FIGS) as Kind[]).forEach((k) => drawInline(d, k));
      }
      if (zoom) drawZoom();
    };
    drawAll();
    for (const d of stations) {
      for (const k of Object.keys(FIGS) as Kind[]) {
        const legend = document.getElementById(`${d.meta.id}-${k}-legend`);
        if (legend) wireLegend(legend, $(`${d.meta.id}-${k}`));
      }
    }

    // Depth tabs, expand buttons, and a click on any inline chart opens the zoom view.
    $("stations").addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".legend") || target.closest("a")) return;
      const tab = target.closest<HTMLButtonElement>(".tab");
      if (tab) {
        const section = tab.closest<HTMLElement>(".station")!;
        const key = tab.dataset.fig as Kind;
        section.querySelectorAll(`.tab[data-fig="${key}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b === tab)));
        drawInline(byId[section.id], key);
        return;
      }
      const opener = target.closest<HTMLElement>(".expand, .plot");
      if (opener?.dataset.station) openZoom(byId[opener.dataset.station], opener.dataset.fig as Kind, opener.dataset.full === "1");
    });
    wireZoom();
    updatedStrip(meta, live);
    about(meta);
    wireCopy(meta, live, stations);
    const redraw = () => {
      drawAll();
      statusGrid(stations);
    };
    wireTheme(redraw);
    wireUnits(redraw);
    // Keep "now" and the ages current on a page left open, and refit axis labels on resize.
    window.setInterval(() => {
      drawAll();
      statusGrid(stations);
    }, 10 * 60_000);
    let pending = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(drawAll, 200);
    });
  } catch (err) {
    $("updated").innerHTML = `<b>Unavailable</b>could not load the data (${String(err)}). Please try again shortly.`;
  }
}

void main();
