/** Long Island Sound page: overview (map and status grid), readouts and views per station, a zoom view,
 * and the bring-your-own-AI prompt. */
import "./site.css";
import "./away-links";

import promptTemplate from "../../../configs/prompts/visitor_prompt.txt?raw";
import { renderLines, YELLOW, type ChartOptions, type Line } from "./chart";
import { wireHints } from "./hints";
import { chainButton, navigateTo, revealLinked, wireLinks } from "./links";
import { compass, windGlyphs } from "./wind-dir";
import { comfortTableHtml } from "./comfort-thresholds";
import { smoothByAge } from "./trends";
import type { FieldData, FieldKind, RasterHistory } from "./fields";
import { wireSuggest } from "./suggest";
import {
  COVERAGE_MIN, DAY, DO_LEVELS, HOUR, Hourly, STRAT, dF, getJson, grid, yearLines, type LastObs,
  type Live, type Meta, type MetaSeries,
} from "./series";
import { mountAdvisories } from "./advisory";
import { ago, escHtml, fmtDate, signed } from "./waterway/format";
import { AT, atFuture, atLabel, setAt, sparklineOf } from "./waterway/cursor";
import { DEPTH_LABEL, isWater, obsState, overallState, type StationData, stationState, type VarKey, WATER_VARS } from "./waterway/station-data";
import { stationPin, stationTables } from "./waterway/cells";
import { configureModels } from "./waterway/models";
import { type Built, type Fig, legendHtml, openZoom, redrawZoom, visibleYears, wireLegend, wireZoom } from "./waterway/figures";
import { stationReadouts } from "./waterway/readouts";
import { openAbout, wireAbout } from "./waterway/about";
import { configureData, onModelData } from "./waterway/data";
import { FCST, forecastAt, HRRR_HIST_LABEL, hrrrAsOf, hrrrHist, loadForecast, mountVintage } from "./waterway/forecast";
import { loadNwps, mountNwpsVintage, NWPS, nwpsLabel, nwpsRunAt, nwpsRuns, nwpsSeries } from "./waterway/nwps";
import { OUTLOOK, outlookHtml } from "./waterway/outlook";
import { NEXT48 } from "./waterway/next48";
import { ADV, ADV_WIND, advisoriesFor, loadAdvisories, zoneOf, zonesInForce } from "./waterway/advisories";
import { hideWsTip, showWsTip, windAcrossHtml, WS_BACK, wsPoint } from "./waterway/wind-strip";
import { DEPARTURE, loadTides, onTides, TIDES } from "./waterway/tides";
import { departureBuilt, departureRowsSvg, drawLadder, highestAheadHtml, hiloBuilt, tidesTable } from "./waterway/tides-view";
import { configureSchematic, syncSchematic } from "./waterways/sound-schematic";
import { cfs, dailyFlow, ordinal, pct, percentileOf, riverFlow } from "./waterway/rivers";
import { gaugePins, riverReadoutsHtml, riverTable, wireRiverHover } from "./waterway/rivers-view";
import { dropDown, wireMore } from "./waterway/phone-bar";
import { updatedStrip, wireOutageIcon } from "./waterway/freshness";
import { BOAT, wireBoat } from "./waterway/boat";
import { wireLocate } from "./waterway/locate";
import { embedMode } from "./waterway/embed";
import { wireCollect } from "./waterway/prompt";
import { ensureVar, infoUrl, joinExtras, lastSeen, lastWave, load, panelsOf, RIVER_SECTIONS, startExtras, TURB_SECTION, useVar, WAVE_LIVE, WAVE_META, wavesOf, wavesText } from "./adapters/sound";
import { LONG_ISLAND_SOUND as LIS } from "./waterways/long-island-sound";
import { gaugeAboutHtml, setUsgsWq, stationAboutHtml, usgsWqHtml } from "./waterways/sound-page";
import { currentSpeed, setUnit, waveUnit, WIND_UNITS, windVal, WU } from "./waterway/units";

const DATA = LIS.data;
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
  line: string; // a plot's one series (wind, pressure, waves, a river's turbidity)
  second: string; // a second kind of series on the same axis (air against water)
  ramp: { L: [number, number]; C: [number, number]; h: [number, number] }; // strong to pale willow blues, for order
  bands: [string, string]; // surface-minus-bottom threshold shading: outer, inner
  oxygen: [string, string, string]; // dissolved oxygen shading: anoxic, hypoxic, below the growth criterion
  advisory: [string, string]; // NWS advisories behind the wind, in brick red: small craft, gale and above
  miss: string; // a forecast's typical miss, either side of it: faint lavender, apart from the forecast's own blue
  yearStops: { t: number; L: number; C: number; h: number }[];
}

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    now: YELLOW,
    contrast: "#ffffff",
    delayed: "#f0b135",
    depth: { SFC: YELLOW, MID: "#ffffff", BTM: "#7fb8d8" },
    line: "#7fb8d8", // pale willow blue
    second: "#ffffff",
    ramp: { L: [0.86, 0.52], C: [0.06, 0.09], h: [225, 255] },
    bands: ["rgba(255,255,255,0.04)", "rgba(127,184,216,0.12)"],
    oxygen: ["rgba(240,177,53,0.26)", "rgba(240,177,53,0.14)", "rgba(240,177,53,0.05)"],
    advisory: ["rgba(210,74,55,0.16)", "rgba(210,74,55,0.36)"],
    miss: "#b7a2dd",
    yearStops: [
      { t: 0, L: 0.78, C: 0.07, h: 225 }, // pale willow blue
      { t: 0.3, L: 0.64, C: 0.09, h: 245 },
      { t: 1, L: 0.46, C: 0.09, h: 258 }, // deep cobalt, 2.2:1 on the page
    ],
  },
  light: {
    now: "#b89300", // gilded gold, 2.7:1 on eggshell; this year is also the boldest line and named in legend and tooltip
    contrast: "#1c2a48",
    delayed: "#a35a00",
    depth: { SFC: "#133c8b", MID: "#4a7fae", BTM: "#86a8cb" }, // cobalt to pale willow, surface to bottom
    line: "#133c8b", // cobalt
    second: "#86a8cb", // pale willow
    ramp: { L: [0.36, 0.72], C: [0.13, 0.06], h: [262, 245] },
    bands: ["rgba(28,42,72,0.04)", "rgba(58,120,161,0.12)"],
    oxygen: ["rgba(163,90,0,0.22)", "rgba(163,90,0,0.12)", "rgba(163,90,0,0.045)"],
    advisory: ["rgba(158,36,24,0.09)", "rgba(158,36,24,0.24)"],
    miss: "#9a84cc",
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


let VK: VarKey = "wind"; // a first visit opens on Wind & waves (the comfort map); a link or a remembered view wins
/** What a link asked for: ?view=oxygen&layer=sst&t=-30d#WLIS-col (see linkUrl). */
const LINK = new URLSearchParams(location.search);
try {
  const saved = LINK.get("view") ?? localStorage.getItem("lhzn-blue-water-var");
  if (saved && saved in WATER_VARS) VK = saved as VarKey;
} catch {
  /* private mode: Wind & waves */
}
const { fig: EMBED, station: EMBED_STATION } = embedMode(LINK, LIS.defaults.embedStation);
if (EMBED) VK = EMBED === "next48" ? "wind" : "temp";
const V = () => WATER_VARS[VK];








/** The next predicted high or low after now. */
/** Feet to one decimal, with a true minus sign and no "-0.0". */

/* ---------- State and derived values ---------- */



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
 * years step away from it by age (see PALETTES): in the dark theme, pale willow blue to deep cobalt (the
 * darkest 2.2:1 on the page against the yellow's 11.7:1); in the light theme, deep cobalt to pale willow blue. Adjacent years are told apart by the tooltip and by legend highlighting.
 */
/** n willow blues from strong to pale, for series that have an order (basin size, west to east). */
function willowRamp(n: number): string[] {
  const { L, C, h } = P.ramp;
  return Array.from({ length: n }, (_, i) => {
    const u = n <= 1 ? 0 : i / (n - 1);
    return oklch(L[0] + (L[1] - L[0]) * u, C[0] + (C[1] - C[0]) * u, h[0] + (h[1] - h[0]) * u);
  });
}

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

/** Stratification is a temperature measure, whichever variable is shown. */

/* ---------- Figures: one builder per view, used inline and in the zoom view ---------- */

type Kind = "yoy" | "chg" | "col" | "sb" | "next48" | "hilo" | "dep" | "wind" | "air" | "tide" | "waves" | "pressure" | "flow" | "share" | "rturb" | "ryoy" | "rpct" | "bturb";

/**
 * Charts sit in two columns, and a chart shares its time axis with the ones above and below it: the left
 * column follows the year comparison (96 days back, 14 ahead), the right column the 7-day change (60 days
 * back). Every station uses the same axes, so outages show as aligned empty stretches.
 */
const LEFT = (d: StationData): [number, number] => [d.now - 96 * DAY, d.now + 14 * DAY];
const RIGHT = (d: StationData): [number, number] => [d.now - 60 * DAY, d.now];





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
  if (d.kind === "shore" && isWater(VK) && VK !== "temp") return `${d.meta.name} measures water temperature only; ${V().label.toLowerCase()} comes from the buoys.`;
  const p = panelsOf(d.meta.id);
  const t = lastSeen(d);
  const last = Number.isFinite(t) ? `Last reading: ${fmtDate.format(new Date(t * 1000))}. ` : "";
  const panel = p.water_quality ? ` or the <a href="${p.water_quality}">${LIS.operator} water quality panel</a>` : "";
  return `No published data in this window. ${last}See Full record${panel}.`;
}



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

/** Axis unit and tooltip precision for the selected variable; for oxygen, the reference levels as shading
 * (with the axis reaching down to the hypoxia level, so it is always in view). */
function varOpts(levels = true): Partial<ChartOptions> & { unit: string } {
  const base = { unit: V().unit, hoverDigits: V().digits };
  if (VK !== "oxygen" || !levels) return base;
  return {
    ...base,
    floor: DO_LEVELS.hypoxic - 0.5,
    bands: [
      { y0: -1, y1: DO_LEVELS.anoxic, fill: P.oxygen[0] },
      { y0: DO_LEVELS.anoxic, y1: DO_LEVELS.hypoxic, fill: P.oxygen[1] },
      { y0: DO_LEVELS.hypoxic, y1: DO_LEVELS.growth, fill: P.oxygen[2] },
    ],
  };
}

const OXYGEN_NOTE = `shading: under ${DO_LEVELS.anoxic} mg/L anoxic, under ${DO_LEVELS.hypoxic} hypoxic (${LIS.oxygenAuthority}), under ${DO_LEVELS.growth} below EPA's growth criterion`;

/** The whole record as one timeline, each year's stretch in that year's color. */
/** Anything with a start and a value at a time: an hourly series, or a river's daily flow. */
type Series = { t0: number; at(t: number): number };

function timelineBuilt(d: StationData, series: Series | null, depth: string, xs: number[], extra: Partial<ChartOptions>): Built {
  if (!series) return { opts: { xs, lines: [], ...varOpts(), unit: V().unit, ...extra }, legend: [] };
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
    opts: { xs, lines, ...varOpts(), unit: V().unit, empty: emptyNote(d), ...extra },
    legend: lines.map((l) => [l.label, l.color, l.opacity ?? 1]),
    note: [coverageNote(d, depth), VK === "oxygen" && extra.bands === undefined ? OXYGEN_NOTE : ""].filter(Boolean).join(" "),
  };
}

function yearBuilt(d: StationData, series: Series | null, xs: number[], extra: Partial<ChartOptions>): Built {
  const all = series ? yearLines(series, xs, d.now) : [];
  const { shown, hidden } = visibleYears(all);
  // Scale the ramp to the whole record, so a year keeps its color when another is hidden or the view pans.
  const maxOffset = Math.max(1, ...all.map((l) => l.offset));
  const lines = [...shown].reverse().map((l) => ({ ys: l.values, label: String(l.year), ...yearStyle(l.offset, maxOffset) }));
  const notes = [
    hidden.length ? `not drawn (under ${COVERAGE_MIN * 100}% coverage in this window): ${hidden.map((l) => l.year).join(", ")}` : "",
    VK === "oxygen" && extra.bands === undefined ? OXYGEN_NOTE : "",
  ].filter(Boolean);
  return {
    opts: { xs, lines, ...varOpts(), unit: V().unit, empty: emptyNote(d), ...extra },
    legend: shown.map((l) => [String(l.year), yearStyle(l.offset, maxOffset).color, yearStyle(l.offset, maxOffset).opacity ?? 1]),
    note: notes.length ? notes.join("; ") : undefined,
  };
}

const FIGS: Record<Kind, Fig> = {
  yoy: {
    title: "This year against earlier years",
    varies: true,
    in: (k) => isWater(k),
    sub: "36h mean, same dates",
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
    varies: true,
    in: (k) => isWater(k),
    sub: "of the 36h mean",
    depthTabs: true,
    seasonal: true,
    available: () => true,
    window: RIGHT,
    maxSpan: 366 * DAY,
    build: (d, depth, x0, x1, full) =>
      full
        ? timelineBuilt(d, d.chg[depth], depth, grid(x0, x1), { zero: true, bands: [], floor: undefined })
        : yearBuilt(d, d.chg[depth], grid(x0, x1), { zero: true, bands: [], floor: undefined }),
  },
  col: {
    title: "Water column",
    varies: true,
    in: (k) => isWater(k),
    sub: "hourly and 36h mean",
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
        lines.push({ ys: xs.map((t) => m.at(t)), color, width: 1.8, opacity: 1, label: `${s.label} 36h` });
        legend.unshift([s.label, color, 1]);
      }
      return { opts: { xs, lines, ...varOpts(), empty: emptyNote(d) }, legend, note: VK === "oxygen" ? OXYGEN_NOTE : undefined };
    },
  },
  sb: {
    title: "Surface minus bottom",
    varies: true,
    in: (k) => isWater(k),
    sub: "hourly and 36h mean",
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
              { ys: xs.map((t) => delta36.at(t)), color: P.now, width: 1.8, label: "36h mean" },
            ]
          : [];
      const legend: [string, string, number][] = [["hourly", P.contrast, 0.5], ["36h mean", P.now, 1]];
      if (VK !== "temp") {
        // Salinity and oxygen differences have no working thresholds here; the stratification bands are thermal.
        return { opts: { xs, lines, ...varOpts(false), zero: true, hoverDigits: 2, empty: emptyNote(d) }, legend };
      }
      const [mx, st] = [dF(STRAT.mixed), dF(STRAT.stratified)];
      return {
        opts: {
          xs, lines, unit: "°F", zero: true, hoverDigits: 2, empty: emptyNote(d),
          bands: [
            { y0: -st, y1: st, fill: P.bands[0] },
            { y0: -mx, y1: mx, fill: P.bands[1] },
          ],
        },
        legend,
        note: `shading marks the working thresholds: inner band mixed (under ${STRAT.mixed} °C, ${dF(STRAT.mixed).toFixed(2)} °F), outer band weakly stratified (to ${STRAT.stratified} °C)`,
      };
    },
  },
  next48: NEXT48,
  wind: {
    title: "Wind",
    varies: false,
    in: (k) => k === "wind",
    sub: "smoothed, with hourly and each day's peak gust",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.met?.wind && Number.isFinite(d.met.wind.lastValid()),
    window: LEFT,
    maxSpan: 100 * DAY,
    start: (d) => d.met?.wind?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const m = d.met;
      // Detail where a mariner needs it: hourly for the last two days, then smoother with age (a 6h half-life by two
      // weeks back, a day by a month back), at any zoom.
      const smooth = m?.wind ? smoothByAge(m.wind, d.now) : null;
      const smoothLabel = "Wind, smoothed by age (hourly for 2 days)";
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
      const hh = hrrrHist(d.meta.id, xs[0], xs[xs.length - 1], (t) => m?.wind?.at(t) ?? NaN);
      const lines: Line[] = m
        ? [
            ...(hh?.wind ? [{ ys: xs.map((t) => (Number.isFinite(m.wind?.at(t) ?? NaN) ? NaN : windVal(hh.wind!.at(t)))), color: P.line, width: 1, opacity: 0.7, dash: "4 3", label: HRRR_HIST_LABEL, fmt: fmtU }] : []),
            { ys: peakYs, color: P.contrast, opacity: 0.55, label: "Daily peak gust", dots: true, fmt: fmtU },
            { ys: xs.map((t) => windVal(m.wind?.at(t) ?? NaN)), color: P.line, width: 0.7, opacity: 0.22, label: "Wind, hourly", fmt: fmtU },
            { ys: xs.map((t) => windVal(m.gust?.at(t) ?? NaN)), color: P.contrast, label: "Gust, hourly", hidden: true, fmt: fmtU },
            { ys: xs.map((t) => windVal(smooth?.at(t) ?? NaN)), color: P.line, width: 1.8, label: smoothLabel, fmt: fmtU },
            { ys: xs.map((t) => m.dir?.at(t) ?? NaN), color: P.line, label: "From", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
          ]
        : [];
      if (!ADV) void loadAdvisories();
      const zone = zoneOf(d.meta.id);
      const fmtWhen = (t: number) => fmtDate.format(new Date(t * 1000));
      const spans = advisoriesFor(d.meta.id)
        .filter((a) => a.kind in ADV_WIND && a.t1 > x0 && a.t0 < x1)
        .map((a) => ({ x0: a.t0, x1: a.t1, fill: P.advisory[ADV_WIND[a.kind]], title: `${ADV!.kinds[a.kind]}, ${a.zone}: ${fmtWhen(a.t0)} to ${fmtWhen(a.t1)}` }));
      return {
        opts: {
          xs, lines, spans, unit: ` ${u.label}`, zero: true, empty: "No weather data in this window.",
          glyphs: m?.dir ? windGlyphs(xs[0], xs[xs.length - 1], (t) => ({ from: m.dir!.at(t), kt: m.wind?.at(t) ?? NaN, color: P.line })) : undefined,
        },
        legend: [[smoothLabel, P.line, 1], ["Wind, hourly", P.line, 0.35], ["Daily peak gust", P.contrast, 0.55], ...(hh?.wind ? [[HRRR_HIST_LABEL, P.line, 0.7] as [string, string, number]] : [])],
        note: zone ? `red: NWS small craft advisory (light), gale or stronger (dark), zone ${zone}` : undefined,
      };
    },
  },
  air: {
    title: "Air and water temperature",
    label: (d) => (d.kind === "airport" ? "Air temperature" : "Air and water temperature"),
    varies: false,
    in: (k) => k === "temp" || k === "wind",
    sub: "hourly",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.met?.air,
    // Under temperature it sits below the water column (left axis); under wind and waves, beside the wind (right).
    window: (d) => (VK === "wind" ? RIGHT(d) : LEFT(d)),
    maxSpan: 100 * DAY,
    start: (d) => d.met?.air?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const top = d.depths[0];
      const water = d.temp.hourly[top];
      const label = `Water, ${DEPTH_LABEL[top].toLowerCase()}`;
      const noWater = d.kind === "airport"; // an airport has no water sensor
      const lines: Line[] = [
        ...(noWater ? [] : [{ ys: xs.map((t) => water?.at(t) ?? NaN), color: P.depth[top], width: 1.6, label }]),
        { ys: xs.map((t) => d.met?.air?.at(t) ?? NaN), color: P.second, width: 1.3, label: "Air" },
      ];
      const hh = hrrrHist(d.meta.id, xs[0], xs[xs.length - 1], (t) => d.met?.air?.at(t) ?? NaN);
      if (hh?.air) lines.push({ ys: xs.map((t) => (Number.isFinite(d.met?.air?.at(t) ?? NaN) ? NaN : hh.air!.at(t))), color: P.second, width: 1, opacity: 0.7, dash: "4 3", label: "Air, HRRR (last forecast before each hour)" });
      return {
        opts: { xs, lines, unit: "°F", empty: emptyNote(d) },
        legend: [...(noWater ? [] : [[label, P.depth[top], 1] as [string, string, number]]), ["Air", P.second, 1], ...(hh?.air ? [["Air, HRRR before each hour", P.second, 0.7] as [string, string, number]] : [])],
      };
    },
  },
  tide: {
    title: "Departure from prediction",
    sub: "observed minus NOAA's prediction, hourly, feet",
    varies: false,
    in: (k) => k !== "rivers" && k !== "tides",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.level,
    window: (d) => [d.now - 10 * DAY, d.now + 3 * DAY],
    maxSpan: 100 * DAY,
    start: (d) => d.level?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => departureBuilt(d, x0, x1),
  },
  hilo: {
    title: "Highs and lows",
    sub: "each tide, predicted and observed, feet above MLLW",
    varies: false,
    wide: true,
    in: (k) => k === "tides",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "shore",
    window: (d) => [d.now - 35 * DAY, d.now + 7 * DAY],
    maxSpan: 60 * DAY,
    start: (d) => d.level?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => hiloBuilt(d, x0, x1),
  },
  dep: {
    title: "Departure from prediction",
    sub: "observed minus NOAA's prediction, hourly, feet; the same days as above",
    varies: false,
    wide: true,
    in: (k) => k === "tides",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "shore" && !!d.level,
    window: (d) => [d.now - 35 * DAY, d.now + 7 * DAY],
    maxSpan: 60 * DAY,
    start: (d) => d.level?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => departureBuilt(d, x0, x1),
  },
  waves: {
    title: "Waves",
    sub: "significant wave height hourly, with each hour's highest wave",
    varies: false,
    in: (k) => k === "wind",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "buoy" && !!wavesOf(d.meta.id)?.sensor,
    // While the sensor is out, or the server is not publishing it (readings transcribed from the panel), open on the
    // wave model's span (its runs reach about 4 days back and 6 ahead), so recent hours are not a sliver at the end.
    window: (d) => {
      const last = lastWave(d.meta.id);
      const out = !last || obsState({ time: last.time } as LastObs) === "offline" || !WAVE_LIVE[d.meta.id]?.published;
      return out && NWPS ? [d.now - 4 * DAY, d.now + 6 * DAY] : LEFT(d);
    },
    maxSpan: 2 * 366 * DAY,
    start: (d) => d.waves?.hs?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const w = d.waves;
      const u = waveUnit();
      const val = (m: number) => m * u.factor;
      const fmt = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
      if (!NWPS) void loadNwps();
      const model = nwpsSeries(d.meta.id, xs).map(val);
      const hasModel = model.some(Number.isFinite);
      // Beside a model line, measurements take the measured gold (as in the next-48-hours plot); alone, the series colour.
      const measured = hasModel ? P.now : P.line;
      const lines: Line[] = [
        ...(w
          ? [
              { ys: xs.map((t) => val(w.hmax?.at(t) ?? NaN)), color: P.contrast, width: 0.7, opacity: 0.35, label: "Highest wave", fmt },
              { ys: xs.map((t) => val(w.hs?.at(t) ?? NaN)), color: measured, width: 1.6, label: "Significant height", fmt },
              { ys: xs.map((t) => w.tp?.at(t) ?? NaN), color: P.contrast, label: "Dominant period", hidden: true, fmt: (v: number) => `${v.toFixed(1)} s` },
            ]
          : []),
        ...(hasModel ? [{ ys: model, color: P.line, width: 1.2, dash: "5 3", label: "NWS wave model (NWPS)", fmt }] : []),
      ];
      // Earlier NWPS runs, faint and fainter with age (as the HRRR runs in the next-48-hours plot).
      const nruns = hasModel ? nwpsRuns(d.meta.id, x0, x1) : [];
      const older = nruns.slice(0, -1).reverse();
      lines.unshift(...older.map((r, i) => ({
        ys: xs.map((t) => val(nwpsRunAt(r, d.meta.id, t))),
        color: P.line,
        width: 0.8,
        opacity: 0.32 - (0.24 * i) / Math.max(1, older.length - 1),
        label: nwpsLabel(r),
        tip: false,
      })));
      // The run whose line is nearest the pointer at the hovered hour (the slider follows it).
      const pick = (i: number, yv: number) => {
        const vals = nruns.map((r) => ({ r, y: val(nwpsRunAt(r, d.meta.id, xs[i])) })).filter((x) => Number.isFinite(x.y));
        return vals.length ? nwpsLabel(vals.reduce((a, b) => (Math.abs(b.y - yv) < Math.abs(a.y - yv) ? b : a)).r) : null;
      };
      return {
        opts: { xs, lines, unit: ` ${u.label}`, zero: true, hoverDigits: u.digits, pick: hasModel ? pick : undefined, marker: hasModel ? { x: Date.now() / 1000, label: "now" } : undefined, empty: `No wave readings in this window. ${wavesText(d.meta.id)} Full record shows what we hold.` },
        legend: [["Significant height", measured, 1], ["Highest wave", P.contrast, 0.35], ...(hasModel ? [["NWS wave model (NWPS)", P.line, 0.7] as [string, string, number]] : [])],
      };
    },
  },
  pressure: {
    title: "Pressure tendency",
    sub: "change over 3 hours, mb; falling below zero",
    varies: false,
    in: (k) => k === "wind",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.met?.pressure && Number.isFinite(d.met.pressure.lastValid()),
    window: (d) => [d.now - 10 * DAY, d.now + 2 * DAY],
    maxSpan: 100 * DAY,
    start: (d) => d.met?.pressure?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      if (!FCST) void loadForecast();
      const xs = grid(x0, x1).map((t) => Math.round(t / HOUR) * HOUR);
      const p = d.met?.pressure;
      const now = Date.now() / 1000;
      const mb = (v: number) => `${signed(v)} mb`;
      const obs = xs.map((t) => (p && t <= now ? p.at(t) - p.at(t - 3 * HOUR) : NaN));
      const fc = xs.map((t) => {
        if (t <= now) return NaN;
        const a = forecastAt(d.meta.id, t), b = forecastAt(d.meta.id, t - 3 * HOUR);
        return a && b && Number.isFinite(a.pres) && Number.isFinite(b.pres) ? a.pres - b.pres : NaN;
      });
      const hh = hrrrHist(d.meta.id, xs[0], xs[xs.length - 1], (t) => p?.at(t) ?? NaN)?.pressure;
      const past = xs.map((t, i) => (hh && t <= now && !Number.isFinite(obs[i]) ? hh.at(t) - hh.at(t - 3 * HOUR) : NaN));
      const lines: Line[] = [
        ...(hh ? [{ ys: past, color: P.line, width: 1, opacity: 0.7, dash: "4 3", label: HRRR_HIST_LABEL, fmt: mb }] : []),
        { ys: obs, color: P.line, width: 1.5, label: "Change over 3 h", fmt: mb },
        { ys: fc, color: P.line, width: 1.5, dash: "6 3", label: "HRRR forecast", fmt: mb },
        { ys: xs.map((t) => p?.at(t) ?? NaN), color: P.line, label: "Pressure", hidden: true, fmt: (v) => `${v.toFixed(1)} mb` },
      ];
      // The shipping forecast's tendency terms (mb in 3 hours): slowly under 1.6, quickly 3.6 to 6, very rapidly over 6.
      const bands = [
        { y0: -1.6, y1: 1.6, fill: P.bands[0] },
        { y0: -6, y1: -3.6, fill: P.bands[1] },
        { y0: 3.6, y1: 6, fill: P.bands[1] },
      ];
      return {
        opts: { xs, lines, bands, unit: " mb", zero: true, floor: -4, hoverDigits: 1, marker: { x: now, label: "now" }, empty: "No pressure readings in this window." },
        legend: [["Change over 3 h", P.line, 1], ...(hh ? [[HRRR_HIST_LABEL, P.line, 0.7] as [string, string, number]] : []), [`HRRR forecast${(() => { const a = hrrrAsOf(d.meta.id, xs); return a ? `, ${a}` : ""; })()}`, P.line, 0.7]],
        note: "shaded: steady to falling slowly (under 1.6 mb in 3 h), and falling or rising quickly (3.6 to 6); beyond 6 is very rapid",
      };
    },
  },
  flow: {
    title: "Flow against normal",
    sub: "with the median and the usual ranges for each date",
    varies: false,
    in: (k) => k === "rivers",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "river",
    window: LEFT,
    maxSpan: Infinity,
    start: (d) => dailyFlow(d)?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const r = d.river!;
      const id = d.gauge!.id;
      const band = (p: "p10" | "p25" | "p50" | "p75" | "p90") => xs.map((t) => pct(r, id, p, t));
      const fmt = (v: number) => `${cfs(v)} cfs`;
      const g = r.gauges.find((x) => x.id === id);
      const lines: Line[] = [
        { ys: band("p10"), color: P.contrast, width: 0.8, opacity: 0.18, label: "10th to 90th percentile", fmt },
        { ys: band("p90"), color: P.contrast, width: 0.8, opacity: 0.18, label: "10th to 90th percentile (90th)", fmt },
        { ys: band("p25"), color: P.contrast, width: 0.9, opacity: 0.38, label: "Normal, 25th to 75th", fmt },
        { ys: band("p75"), color: P.contrast, width: 0.9, opacity: 0.38, label: "Normal, 25th to 75th (75th)", fmt },
        { ys: band("p50"), color: P.contrast, width: 1.1, opacity: 0.7, label: "Median for the date", fmt },
        { ys: xs.map((t) => riverFlow(r, id, t)), color: P.depth.SFC, width: 1.8, label: `${g?.river ?? id} flow`, fmt },
      ];
      return {
        opts: { xs, lines, unit: " cfs", hoverDigits: 0, zero: true, marker: { x: d.now, label: "now" }, empty: "No flow readings in this window." },
        legend: [[`${g?.river ?? id} flow`, P.depth.SFC, 1], ["Median for the date", P.contrast, 0.7], ["Normal, 25th to 75th", P.contrast, 0.38], ["10th to 90th percentile", P.contrast, 0.18]],
        note: `percentiles of daily flow for each date, from ${r.normals[id]?.sample_count ?? "--"} years of approved record (USGS)`,
      };
    },
  },
  share: {
    title: "All rivers against normal",
    sub: "each river's flow as a percentile for its date; 25 to 75 is normal",
    varies: false,
    in: (k) => k === "rivers",
    wide: true,
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "rivers",
    window: LEFT,
    maxSpan: 2 * 366 * DAY,
    start: (d) => Math.min(...Object.values(d.river?.daily ?? {}).map((s) => s?.t0 ?? Infinity)),
    build: (d, _id, x0, x1) => {
      const xs = grid(x0, x1);
      const r = d.river!;
      const colors = willowRamp(r.gauges.length); // largest basin strongest
      const fmt = (v: number) => (v <= 2.5 ? "under the 5th percentile" : v >= 97.5 ? "over the 95th percentile" : `${ordinal(v)} percentile`);
      const lines: Line[] = r.gauges.map((g, i) => ({
        ys: xs.map((t) => percentileOf(r, g.id, t, riverFlow(r, g.id, t))),
        color: colors[i % colors.length],
        width: g.id === "CONN" ? 2 : 1.1,
        opacity: g.id === "CONN" ? 1 : 0.8,
        label: g.river,
        fmt,
      }));
      return {
        opts: {
          xs, lines, unit: "", hoverDigits: 0, floor: 0, empty: "No flow readings in this window.",
          bands: [
            { y0: 10, y1: 90, fill: P.bands[0] },
            { y0: 25, y1: 75, fill: P.bands[1] },
          ],
        },
        legend: r.gauges.map((g, i) => [g.river, colors[i % colors.length], g.id === "CONN" ? 1 : 0.8] as [string, string, number]),
        note: "inner band: normal (25th to 75th percentile for the date); outer band: 10th to 90th. A storm shows as the rivers rising together",
      };
    },
  },
  rturb: {
    title: "Turbidity",
    label: (d) => (d.kind === "turbidity" ? "River input" : "Turbidity"),
    sub: "hourly, formazin nephelometric units",
    varies: false,
    in: (k) => k === "rivers" || k === "turbidity",
    depthTabs: false,
    seasonal: false,
    // In the section of the gauge with a turbidity sensor, and in the Turbidity view as the river input.
    available: (d) => (d.kind === "turbidity" || (d.kind === "river" && !!d.gauge?.turbidity)) && !!d.river?.turb && Number.isFinite(d.river.turb.lastValid()),
    window: RIGHT,
    maxSpan: 100 * DAY,
    start: (d) => d.river?.turb?.t0 ?? d.now,
    build: (d, _id, x0, x1) => {
      const xs = grid(x0, x1);
      const label = d.kind === "turbidity" ? (d.river?.gauges.find((g) => g.turbidity)?.name ?? "River input") : "Turbidity";
      const lines: Line[] = [{ ys: xs.map((t) => d.river?.turb?.at(t) ?? NaN), color: P.line, width: 1.5, label }];
      return {
        opts: { xs, lines, unit: " FNU", hoverDigits: 1, zero: true, empty: "No turbidity readings in this window." },
        legend: [[label, P.line, 1]],
        note: d.kind === "turbidity" ? "the river input: a USGS sensor, serviced and reviewed, in FNU" : "a USGS sensor, serviced and reviewed; muddy runoff raises it within hours of a storm",
      };
    },
  },
  ryoy: {
    title: "This year against earlier years",
    sub: "daily mean flow, same dates",
    varies: false,
    in: (k) => k === "rivers",
    depthTabs: false,
    seasonal: true,
    available: (d) => d.kind === "river" && !!dailyFlow(d),
    window: LEFT,
    maxSpan: 366 * DAY,
    start: (d) => dailyFlow(d)?.t0 ?? d.now,
    build: (d, _depth, x0, x1, full) =>
      full
        ? timelineBuilt(d, dailyFlow(d), "SFC", grid(x0, x1), { marker: { x: d.now, label: "now" }, zero: true, empty: "No flow in this window." })
        : yearBuilt(d, dailyFlow(d), grid(x0, x1), { marker: { x: d.now, label: "now" }, zero: true, empty: "No flow in this window." }),
  },
  bturb: {
    title: "Turbidity at the buoys",
    sub: "hourly median at 1 m; faint where the day is flagged as likely sensor fouling",
    varies: false,
    in: (k) => k === "turbidity",
    wide: true,
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "turbidity",
    window: LEFT,
    maxSpan: Infinity,
    start: (d) => Math.min(...Object.values(d.turb?.ntu ?? {}).map((s) => s?.t0 ?? Infinity)),
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const t = d.turb!;
      const colors = willowRamp(t.buoys.length); // west to east
      const fmt = (v: number) => `${v.toFixed(1)} NTU`;
      const lines: Line[] = [];
      const cleanVals: number[] = [];
      t.buoys.forEach((b, i) => {
        const ntu = t.ntu[b.id];
        const sus = t.suspect[b.id];
        const clean = xs.map((x) => (sus?.at(x) === 0 ? (ntu?.at(x) ?? NaN) : NaN));
        const flagged = xs.map((x) => (sus?.at(x) === 1 ? (ntu?.at(x) ?? NaN) : NaN));
        clean.forEach((v) => Number.isFinite(v) && cleanVals.push(v));
        const color = colors[i % colors.length];
        lines.push({ ys: flagged, color, width: 0.9, opacity: 0.28, label: `${b.name}, likely fouled`, fmt });
        lines.push({ ys: clean, color, width: 1.5, label: b.name, fmt });
      });
      // The axis follows the bulk of the clean readings (twice their 90th percentile, at least 10 NTU), so a stray
      // unflagged spike does not flatten them; anything above runs along the top edge, with its true value on hover.
      cleanVals.sort((a, b) => a - b);
      const p90 = cleanVals.length ? cleanVals[Math.floor(0.9 * (cleanVals.length - 1))] : 5;
      const cap = Math.max(10, Math.ceil(p90 * 2));
      return {
        opts: { xs, lines, unit: " NTU", hoverDigits: 1, zero: true, ceil: cap, empty: "No turbidity readings in this window." },
        legend: t.buoys.map((b, i) => [b.name, colors[i % colors.length], 1] as [string, string, number]),
        note: `faint: likely fouled; the axis stops at ${cap} NTU and readings above it run along the top edge (hover for the value)`,
      };
    },
  },
  rpct: {
    title: "Percentile for the date",
    sub: "25 to 75 is normal",
    varies: false,
    in: (k) => k === "rivers",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "river",
    window: RIGHT,
    maxSpan: 2 * 366 * DAY,
    start: (d) => dailyFlow(d)?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const r = d.river!;
      const id = d.gauge!.id;
      const fmt = (v: number) => (v <= 2.5 ? "under the 5th percentile" : v >= 97.5 ? "over the 95th percentile" : `${ordinal(v)} percentile`);
      return {
        opts: {
          xs, lines: [{ ys: xs.map((t) => percentileOf(r, id, t, riverFlow(r, id, t))), color: P.depth.SFC, width: 1.6, label: "Percentile", fmt }],
          unit: "", hoverDigits: 0, floor: 0, empty: "No flow readings in this window.",
          bands: [
            { y0: 10, y1: 90, fill: P.bands[0] },
            { y0: 25, y1: 75, fill: P.bands[1] },
          ],
        },
        legend: [["Percentile", P.depth.SFC, 1]],
        note: "inner band: normal (25th to 75th); outer band: 10th to 90th",
      };
    },
  },
};

/** Figure order in a section, left column then right, row by row. */
const ORDER: Kind[] = ["yoy", "chg", "col", "sb", "next48", "hilo", "dep", "wind", "tide", "waves", "pressure", "share", "bturb", "flow", "rpct", "ryoy", "rturb", "air"];

/** A figure's name with the variable it shows, for the zoom title and screen readers. */
const figName = (f: Fig) => (f.varies && VK !== "temp" ? `${V().label}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}` : f.title);

/** Whether a station shows a figure: shore stations measure temperature only, so under salinity or oxygen
 * their variable charts are left out rather than drawn empty. */
const shows = (d: StationData, k: Kind) =>
  (!EMBED || k === EMBED) && FIGS[k].in(VK) && FIGS[k].available(d) && !(FIGS[k].varies && d.kind === "shore" && VK !== "temp");

/** A thin wind line under surface minus bottom (same time axis), so a blow lines up with the mixing it causes. */
const hasWind = (d: StationData) => !!d.met?.wind && Number.isFinite(d.met.wind.lastValid());
const windStripHtml = (id: string) =>
  `<div class="strip-cap">Wind, smoothed: the blow behind a mixing event <button class="fig-info" type="button" data-about="wind" aria-label="About this plot: wind" title="About this plot">i</button></div><div class="plot strip" id="${id}-sb-wind" data-station="${id}" data-fig="wind" title="Wind: click to expand"><svg role="img" aria-label="Wind, smoothed"></svg><div class="plot-labels" aria-hidden="true"></div></div>`;

function drawWindStrip(d: StationData, x0: number, x1: number): void {
  const strip = document.getElementById(`${d.meta.id}-sb-wind`);
  if (!strip) return;
  const b = FIGS.wind.build(d, "", x0, x1, false);
  renderLines(strip, { ...b.opts, lines: b.opts.lines.filter((l) => l.label.startsWith("Wind, smoothed")), empty: "No wind readings in this window." });
}




/** Outline on the map the zones in force at the page's time (the record loads when the cursor goes back). */
async function syncZones(): Promise<void> {
  if (EMBED) return; // no map in an embed
  const t = AT ?? Date.now() / 1000;
  if (!ADV && t < Date.now() / 1000 - HOUR) void loadAdvisories();
  try {
    (await import("./map")).setAdvisoryZones(zonesInForce(t, LIS.zones));
  } catch {
    /* map not loaded */
  }
}



/** The table row whose station the outlook shows, marked. */
function markOutlookRow(): void {
  const on = OUTLOOK.peek ?? OUTLOOK.pin;
  document.querySelectorAll<HTMLTableRowElement>("#status tbody tr").forEach((tr) => {
    const id = tr.querySelector<HTMLAnchorElement>('th a[href^="#"]')?.getAttribute("href")?.slice(1);
    const shown = VK === "tides" && !STATIONS.some((d) => d.meta.id === on && d.kind === "shore") ? LIS.defaults.tideStation : on;
    tr.classList.toggle("ol-on", (VK === "wind" || VK === "tides") && id === shown);
  });
  syncSchematic();
}

/* ---------- Overview: map and status grid ---------- */


/** The overview table and the map pins show the page's time (waterway/cursor.ts): values at a past time are
 * observations from the hourly record; a time after the latest reading shows the forecast where there is one. */
let STATIONS: StationData[] = [];



/** Which table the overview shows: buoys or shore stations (remembered in this browser only). */
type Group = StationData["kind"];
let SG: Group = "buoy";
try {
  if (localStorage.getItem("lhzn-blue-status-tab") === "shore") SG = "shore";
} catch {
  /* private mode: buoys */
}


/** The Turbidity view's overview: each buoy's latest reading and its check, then the river input. */
function turbTable(): string {
  const d = TURB_SECTION;
  if (!d?.turb) return `<p class="note">Turbidity data could not load.</p>`;
  const t = d.turb;
  const rows = t.buoys.map((b) => {
    const at = AT != null ? t.ntu[b.id]?.at(AT) ?? NaN : NaN;
    const o = AT == null ? t.last[b.id] : Number.isFinite(at) ? { time: new Date(AT * 1000).toISOString(), turb_ntu: at } : null;
    const state = AT != null ? (o ? "asof" : "offline") : o ? obsState({ time: o.time } as LastObs) : "offline";
    const sus = t.suspect[b.id];
    const end = AT ?? (sus ? sus.lastValid() : NaN);
    const fouled = Number.isFinite(end) && sus?.at(end) === 1;
    const share = t.share30[b.id];
    const spark = t.ntu[b.id] ? sparklineOf(t.ntu[b.id]!, fouled ? P.delayed : P.depth.SFC, "NTU") : "";
    const value =
      o?.turb_ntu != null && state !== "offline"
        ? `<td class="${fouled ? "delayed" : state}" title="${o.turb_ntu.toFixed(2)} NTU, ${ago(o.time)}">${spark}<b>${o.turb_ntu.toFixed(1)}<small class="g"> NTU</small></b><small>${AT != null ? "observed" : ago(o.time).replace(" ago", "")}</small></td>`
        : `<td class="offline">${spark}<b>--</b><small>${AT != null ? (atFuture() ? "no forecast" : "no reading") : "no current reading"}</small></td>`;
    return `<tr><th scope="row"><a href="#TURB"><i class="dot ${state}"></i>${b.name}</a></th>${value}
      <td><b>${state === "offline" ? "--" : fouled ? "likely fouled" : "clean"}</b><small>by the check, ${AT != null ? "that day" : "today"}</small></td>
      <td><b>${share != null ? Math.round(share * 100) + "%" : "--"}</b><small>of hours flagged</small></td></tr>`;
  });
  const r = d.river;
  // The river input: the gauge with a turbidity sensor, named as it is ("Connecticut River at Thompsonville").
  const tg = r?.gauges.find((g) => g.turbidity);
  const at = tg?.name.split(/ (?:at|near) /).pop() ?? "";
  const connAt = AT != null ? r?.turb?.at(AT) ?? NaN : NaN;
  const conn = AT == null ? (r && tg ? r.last[tg.id] : undefined) : Number.isFinite(connAt) ? { time: new Date(AT * 1000).toISOString(), turb_fnu: connAt, flow_cfs: null } : null;
  const river = conn?.turb_fnu != null
    ? `<tr class="total"><th scope="row">${tg?.river} River</th><td title="USGS, ${at}, ${ago(conn.time)}"><b>${conn.turb_fnu.toFixed(1)}<small class="g"> FNU</small></b><small>${AT != null ? "observed" : ago(conn.time).replace(" ago", "")}</small></td><td colspan="2"><small>the river input at ${at}; a serviced USGS sensor</small></td></tr>`
    : `<tr class="total"><th scope="row">${tg?.river} River</th><td class="offline"><b>--</b><small>${AT != null ? (atFuture() ? "no forecast" : "no reading") : "no current reading"}</small></td><td colspan="2"><small>the river input at ${at}; a serviced USGS sensor</small></td></tr>`;
  return `<table class="status-grid" id="status-panel">
    <caption>${AT != null ? `Turbidity at ${atLabel(AT)}` : "Latest turbidity"}, buoys west to east, then the river input</caption>
    <thead><tr><th></th><th scope="col">Turbidity</th><th scope="col">Sensor check</th><th scope="col">Last 30 days</th></tr></thead>
    <tbody>${rows.join("")}${river}</tbody>
  </table>
  <p class="status-key">Point observations at 1 m. The check flags a day as likely sensor fouling when its quietest readings sit above 5 NTU; flagged readings are kept and drawn faintly. See the note below the table.</p>`;
}

function statusGrid(stations: StationData[]): void {
  if (VK === "turbidity") {
    $("status").innerHTML = turbTable() + usgsWqHtml() + outlookHtml(STATIONS);
    return;
  }
  if (VK === "rivers") {
    $("status").innerHTML = riverTable(RIVER_SECTIONS[0]) + outlookHtml(STATIONS);
    return;
  }
  if (VK === "tides") {
    if (!TIDES) void loadTides();
    $("status").innerHTML = tidesTable(stations) + highestAheadHtml(stations, LIS.defaults.tideStation);
    markOutlookRow();
    return;
  }
  if (!stations.some((d) => d.kind === "shore")) SG = "buoy";
  $("status").innerHTML = `${stationTables(stations, SG)}${isWater(VK) ? usgsWqHtml() : ""}${outlookHtml(stations)}${windAcrossHtml(stations, LIS.called)}`;
  markOutlookRow();
}

/** Tab clicks and arrow keys on the overview table (wired once; the table itself is redrawn often). */
function wireStatusTabs(stations: StationData[]): void {
  const box = $("status");
  const rowId = (e: Event) =>
    (e.target as HTMLElement).closest("tbody tr")?.querySelector<HTMLAnchorElement>('th a[href^="#"]')?.getAttribute("href")?.slice(1) ?? null;
  const redrawOutlook = () => {
    const el = box.querySelector(".outlook");
    if (el) el.outerHTML = outlookHtml(stations);
    const hi = box.querySelector(".hi-ahead");
    if (hi) hi.outerHTML = highestAheadHtml(stations, LIS.defaults.tideStation);
    markOutlookRow();
  };
  box.addEventListener("mouseover", (e) => {
    const id = VK === "wind" || VK === "tides" ? rowId(e) : null;
    if (id && id !== (OUTLOOK.peek ?? OUTLOOK.pin)) {
      OUTLOOK.peek = id;
      redrawOutlook();
    }
  });
  box.addEventListener("mouseleave", () => {
    if (OUTLOOK.peek) {
      OUTLOOK.peek = null;
      redrawOutlook();
    }
  });
  box.addEventListener("focusin", (e) => {
    const id = VK === "wind" || VK === "tides" ? rowId(e) : null;
    if (id) {
      OUTLOOK.peek = id;
      redrawOutlook();
    }
  });
  box.addEventListener("click", (e) => {
    if ((VK !== "wind" && VK !== "tides") || (e.target as HTMLElement).closest("a, button")) return;
    const id = rowId(e);
    if (id) {
      OUTLOOK.pin = id;
      OUTLOOK.peek = null;
      redrawOutlook();
    }
  });
  const pick = (g: Group) => {
    SG = g;
    try {
      localStorage.setItem("lhzn-blue-status-tab", g);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    statusGrid(stations);
    box.querySelector<HTMLButtonElement>(`#stab-${g}`)?.focus();
  };
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".stab");
    if (b) pick(b.dataset.group as Group);
  });
  // A click moves the page's time. Two clicks close together in time and place also open that station's wind chart
  // at that hour (the next 48 hours where it reaches, else the wind record). Counted here, not with dblclick: the
  // first click redraws the strip, so the second lands on a new element and the browser never fires dblclick.
  let last = { at: -Infinity, x: 0, y: 0 };
  box.addEventListener("click", (e) => {
    const p = wsPoint(e);
    if (!p || !timelineModule) return;
    timelineModule.setOffset(Math.round((p.t - Date.now() / 1000) / HOUR));
    const double = e.timeStamp - last.at < 450 && Math.abs(e.clientX - last.x) < 8 && Math.abs(e.clientY - last.y) < 8;
    last = double ? { at: -Infinity, x: 0, y: 0 } : { at: e.timeStamp, x: e.clientX, y: e.clientY };
    if (!double || !p.row) return;
    hideWsTip();
    const sid = p.row.d.meta.id;
    const fig = p.t >= Date.now() / 1000 - 36 * HOUR && document.getElementById(`${sid}-next48`) ? "next48" : "wind";
    if (!document.getElementById(`${sid}-${fig}`)) return;
    navigateTo(`${sid}-${fig}`);
  });
  // The strip's own tooltip: the station's wind at the hour under the pointer.
  box.addEventListener("pointermove", (e) => {
    const p = e.pointerType === "mouse" ? wsPoint(e) : null;
    if (p?.row) showWsTip(p.svg, e, p.row.d, p.t);
    else hideWsTip();
  });
  box.addEventListener("pointerleave", hideWsTip);
  box.addEventListener("keydown", (e) => {
    if (!(e.target as HTMLElement).closest(".stab") || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    pick(SG === "buoy" ? "shore" : "buoy");
  });
}

/** The current-phase strip under the time bar (Wind & waves, hours scale): loaded once, shown or hidden as the view
 * and scale change. */
let phaseLoad: Promise<import("./phase").PhaseFile | null> | null = null;
async function syncPhase(hours: boolean): Promise<void> {
  const show = VK === "wind" && hours;
  const ph = await import("./phase");
  if (show) phaseLoad ??= getJson<import("./phase").PhaseFile>(`${DATA}/current-phase.json`).catch(() => null);
  const u = WIND_UNITS[WU];
  ph.setPhase(show ? await phaseLoad : null, show, { label: u.label, perKt: u.factor, digits: 1 });
}

/** The time bar along the map's foot moves the currents and a rule on every chart (wired once). */
let timelineWired = false;
async function wireTimeline(box: HTMLElement): Promise<void> {
  if (timelineWired) return;
  timelineWired = true;
  const [tl, chart] = await Promise.all([import("./timeline"), import("./chart")]);
  tl.mountTimeline(document.getElementById("map-foot") ?? box);
  timelineModule = tl;
  tl.onAsOf((t) => {
    if (t != null && t * 1000 > Date.now()) void loadForecast();
    syncUrl(true);
    chart.markAsOf(t);
    void showAt(t);
    import("./fields").then((f) => f.setFieldTime(t)).catch(() => undefined);
  });
  tl.setHoursBack(VK === "wind" ? WS_BACK / HOUR : 24); // the view's reach first, or a linked time is clamped to a day
  applyPendingOffset("hours"); // after the listener, so a linked time reaches the charts, the table and the pins
  void syncPhase(tl.position().scale === "hours");
}


/** The masthead advisory's click on this page: switch to the Wind view, as its tab does, without scrolling (the
 * banner stays in sight; the advisories run along "Wind across the Sound" under the table). */
function openWindStrip(): void {
  if (VK !== "wind") document.querySelector<HTMLButtonElement>('.tab[data-var="wind"]')?.click();
}

/** The overview table and the map pins at the cursor's time (or the latest readings at now). */
async function showAt(t: number | null): Promise<void> {
  setAt(t);
  const rowsBox = document.getElementById("sound-rows-box");
  if (rowsBox && VK === "tides") rowsBox.innerHTML = departureRowsSvg(STATIONS);
  if (VK === "tides") for (const d of STATIONS.filter((s) => s.kind === "shore")) { const [a, b] = FIGS.hilo.window(d); drawLadder(d, a, b); }
  if (STATIONS.length) statusGrid(STATIONS);
  void syncZones();
  if (EMBED) return;
  try {
    (await import("./map")).updatePins([...STATIONS.map(stationPin), ...(VK === "rivers" ? gaugePins(RIVER_SECTIONS) : [])]);
  } catch {
    /* map not loaded */
  }
}

async function overviewMap(stations: StationData[]): Promise<void> {
  const box = $("map");
  void wireTimeline(box);
  try {
    const { drawMap } = await import("./map");
    drawMap(
      box,
      stations.map(stationPin),
      (id) => navigateTo(id),
      currentTheme(),
    );
    void syncMap();
  } catch {
    box.innerHTML = `<p class="note">The map could not load.</p>`;
  }
}

/* ---------- Station sections ---------- */

function depthTabsHtml(d: StationData, key: string, active: string): string {
  return `<span class="tabs" role="group" aria-label="${d.kind === "rivers" ? "River" : "Depth"}">${d.meta.series
    .map((s) => `<button class="tab" type="button" data-fig="${key}" data-depth="${s.depth}" aria-pressed="${s.depth === active}">${s.label}</button>`)
    .join("")}</span>`;
}

/** The heading's record line: per depth for the water views; the wave record (or the weather window) for wind. */
function recordLine(d: StationData, perDepth: string): string {
  if (VK === "tides") return "Water level, hourly, the last 100 days; predictions and flood levels from NOAA";
  if (d.kind === "rivers") return "Daily flow from 1990; recent flow hourly";
  if (d.kind === "turbidity") {
    const first = Math.min(...Object.values(d.turb?.ntu ?? {}).map((s) => s?.t0 ?? Infinity));
    return Number.isFinite(first) ? `Hourly from ${new Date(first * 1000).getUTCFullYear()}` : "Hourly, last 100 days";
  }
  if (d.kind === "river") return `Daily flow from ${d.gauge?.record_start?.slice(0, 4) ?? "--"}; recent flow hourly`;
  if (isWater(VK)) return `${VK === "temp" ? "Record" : `${V().label} record`}: ${perDepth}`;
  const id = d.meta.id;
  if (!wavesOf(id)?.sensor) return "Weather: the last 100 days";
  const start = WAVE_META[id]?.record_start;
  const last = lastWave(id);
  return start ? `Waves record: ${fmtDate.format(new Date(start))} to ${last ? fmtDate.format(new Date(last.time)) : "--"}` : "Waves record: loading";
}

function sectionHtml(d: StationData): string {
  const st = d.meta;
  const id = st.id;
  const startOf = (s: MetaSeries) => (VK === "temp" ? s.record_start : s.vars?.[VK]?.record_start);
  const rec = st.series.map((s) => `${s.label.toLowerCase()} from ${startOf(s)?.slice(0, 4) ?? "--"}`).join(", ");
  const kinds = ORDER.filter((k) => shows(d, k));
  const fig = (key: Kind) => {
    const f = FIGS[key];
    return `
    <figure${f.wide ? ' class="wide"' : ""}>
      <figcaption><span class="cap-label"><span class="cap-code">${id}</span>: ${f.label?.(d) ?? f.title}</span><span class="cap-sub">${f.varies ? `${V().label.toLowerCase()}, ` : ""}${f.sub}</span>${f.depthTabs && d.depths.length > 1 ? depthTabsHtml(d, key, d.depths[0]) : ""}
        <span class="fig-actions"><button class="collect-btn" type="button" data-collect="${id}-${key}" data-title="${figName(f)}: ${st.name}" data-kind="plot" aria-pressed="false">+</button>${chainButton(`${id}-${key}`, `this plot: ${figName(f)}, ${st.name}`)}<button class="fig-info" type="button" data-about="${key}" aria-label="About this plot: ${figName(f)}" title="About this plot">i</button>${key === "next48" ? "" : `<button class="expand" type="button" data-station="${id}" data-fig="${key}" data-full="1" aria-label="Full record: ${figName(f)}, ${st.name}">Full record</button>`}<button class="expand" type="button" data-station="${id}" data-fig="${key}" aria-label="Expand: ${figName(f)}, ${st.name}">Expand</button></span></figcaption>
      <div class="plot" id="${id}-${key}" data-station="${id}" data-fig="${key}" title="Click to expand"><svg role="img" aria-label="${figName(f)}"></svg><div class="plot-labels" aria-hidden="true"></div></div>${key === "sb" && hasWind(d) ? windStripHtml(id) : ""}
      <div class="legend" id="${id}-${key}-legend"></div>
    </figure>`;
  };
  // Under the heading only a one-line status, and only for a gap in the data (a quiet station, a dataset the server
  // no longer publishes, a discontinued gauge); the explanations are in the section's About (the (i) by its name).
  const notes = statusLines(d);
  return `
    <section class="station" id="${id}" aria-labelledby="${id}-title">
      <div class="station-head">
        <h2 id="${id}-title"><i class="dot ${overallState(d)}"></i>${st.name}</h2><button class="fig-info head-info" type="button" data-about="station" aria-label="About ${st.name}" title="About ${aboutNoun(d)}">i</button>
        <span class="sid">${d.kind === "turbidity" ? `${LIS.operator} buoys, optical sensors at 1 m` : d.kind === "rivers" ? "USGS stream gauges" : d.kind === "river" ? `USGS ${d.gauge!.usgs_id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W` : `${id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W`}</span>
        <span class="rec">${recordLine(d, rec)}</span>
      </div>
      <p class="station-links"><span>${d.kind === "turbidity" ? "Buoys:" : d.kind === "rivers" || d.kind === "river" ? "At USGS:" : d.kind === "shore" ? (d.meta.operator === "USGS" ? "At USGS:" : "At NOAA:") : d.kind === "airport" ? "At IEM:" : `At ${LIS.operator}:`}</span>${[
        ...(d.kind === "rivers" ? (d.river?.gauges ?? []).map((g) => `<a href="#${g.id}">${g.river}</a>`) : []),
        ...(d.kind === "turbidity" ? (d.turb?.buoys ?? []).map((b) => `<a href="${infoUrl(b.id) ?? "#"}">${b.name}</a>`) : []),
        st.info_url ? `<a href="${st.info_url}">${d.kind === "river" ? "Gauge page" : d.kind === "shore" || d.kind === "airport" ? "Station page" : "About this buoy"}</a>` : "",
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

/** An embed's body: the station's section (only its one figure shows) and a credit line back to the site. */
function embedHtml(d: StationData | undefined): string {
  if (!d) return `<p class="embed-credit">No station ${escHtml(EMBED_STATION)} on this page.</p>`;
  const view = EMBED === "next48" ? "wind" : "temp";
  const link = `https://longhorizon.blue/${LIS.id}/?view=${view}#${d.meta.id}-${EMBED}`;
  return sectionHtml(d) +
    `<p class="embed-credit"><a href="${link}" target="_blank" rel="noopener">${escHtml(d.meta.name)} on longhorizon.blue</a> &middot; live, updated hourly &middot; provisional, not for navigation</p>`;
}

function readouts(d: StationData): void {
  if (d.kind === "turbidity") {
    const t = d.turb!;
    $(`${d.meta.id}-readouts`).innerHTML = t.buoys
      .map((b) => {
        const o = t.last[b.id];
        const state = o ? obsState({ time: o.time } as LastObs) : "offline";
        const sus = t.suspect[b.id];
        const end = sus ? sus.lastValid() : NaN;
        const fouled = Number.isFinite(end) && sus!.at(end) === 1;
        const share = t.share30[b.id];
        const sub = [
          state === "offline" ? "no current reading" : fouled ? "likely fouled today" : "clean by the check",
          share != null ? `${Math.round(share * 100)}% of the last 30 days flagged` : "",
        ].filter(Boolean).join(" &middot; ");
        return `<div class="readout"><div class="num${fouled ? " faint" : ""}">${o?.turb_ntu != null && state !== "offline" ? o.turb_ntu.toFixed(1) : "--"}<small>NTU</small></div><span class="lab">${b.name}</span><span class="sub ${fouled ? "delayed" : state}">${sub}</span></div>`;
      })
      .join("");
    return;
  }
  const river = riverReadoutsHtml(d);
  if (river != null) {
    $(`${d.meta.id}-readouts`).innerHTML = river;
    return;
  }
  $(`${d.meta.id}-readouts`).innerHTML =
    stationReadouts(d).join("") +
    `<span class="band-actions"><button class="collect-btn" type="button" data-collect="${d.meta.id}-readouts" data-title="Readouts: ${d.meta.name}" data-kind="readout row" aria-pressed="false">+</button>` +
    `<button class="fig-info band-info" type="button" data-about="trends" aria-label="About the readouts' trends and %iles" title="About the trends and %iles">i</button></span>`;
  $(`${d.meta.id}-readouts`).classList.add("readouts-row");
}

const activeDepth = (d: StationData, key: Kind): string =>
  document.querySelector<HTMLButtonElement>(`#${d.meta.id} .tab[data-fig="${key}"][aria-pressed="true"]`)?.dataset.depth ?? d.depths[0];

function drawInline(d: StationData, key: Kind): void {
  if (!shows(d, key)) return;
  const [x0, x1] = FIGS[key].window(d);
  const b = FIGS[key].build(d, activeDepth(d, key), x0, x1, false);
  if (key === "hilo") {
    drawLadder(d, x0, x1);
    $(`${d.meta.id}-${key}-legend`).innerHTML =
      `<span class="lg"><svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"><circle r="3" fill="var(--bg)" stroke="var(--ink-mute)"/></svg>predicted</span>` +
      `<span class="lg"><svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"><circle r="3.2" fill="var(--wp-gold)"/></svg>observed</span>` +
      `<span class="lg"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--wp-amber)" stroke-width="2"/></svg>more than 0.5 ft beyond the prediction</span>` +
      `<span class="lg"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--wp-flood)"/></svg>NWS minor flood</span>` +
      `<span class="lg"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--wp-flood)" stroke-dasharray="6 3"/></svg>moderate flood</span>` +
      `<span class="lg"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--faint)" stroke-dasharray="5 4"/></svg>mean higher high water</span>`;
    return;
  }
  renderLines($(`${d.meta.id}-${key}`), b.opts);
  $(`${d.meta.id}-${key}-legend`).innerHTML = legendHtml(b);
  if (key === "next48") mountVintage(d, $(`${d.meta.id}-${key}`), x0, x1);
  if (key === "waves") mountNwpsVintage(d, $(`${d.meta.id}-${key}`), x0, x1);
  if (key === "sb") drawWindStrip(d, x0, x1);
}



const isRiver = (d: StationData) => d.kind === "rivers" || d.kind === "river";


const aboutNoun = (d: StationData) =>
  d.kind === "rivers" ? "these gauges" : d.kind === "river" ? "this gauge" : d.kind === "turbidity" ? "these sensors" : d.kind === "buoy" ? "this buoy" : "this station";

/** A quiet station needs a last reading to date its status from. */
const isQuiet = (d: StationData) => (d.kind === "buoy" || d.kind === "shore") && stationState(d) === "offline" && Number.isFinite(lastSeen(d));

/** The one-line statuses shown under a section's heading: gaps in the data only. */
function statusLines(d: StationData): string[] {
  const g = d.gauge;
  return [
    g?.discontinued ? `No flow published since ${fmtDate.format(new Date(`${g.discontinued}T12:00:00Z`))}.` : "",
    isQuiet(d) ? `No reading since ${fmtDate.format(new Date(lastSeen(d) * 1000))}.` : "",
    !isRiver(d) && !d.live && d.meta.outage_note ? "Not published on the data server; the record shown is our saved copy." : "",
    d.kind === "shore" && isWater(VK) && VK !== "temp" ? `Water temperature only; ${V().label.toLowerCase()} comes from the buoys.` : "",
  ].filter(Boolean);
}





function about(meta: Meta): void {
  $("about-method").innerHTML =
    `The datasets behind each series and their quality checks. How the page works, its sources and methods, are on the ` +
    `<a href="/about/">About</a> page; the science behind it on the <a href="/references/">references</a> page.`;
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


/* ---------- Main ---------- */

/** Units (kt, mph, m/s; waves in ft, or m with m/s): knots by default; the choice is remembered in this browser only. */
function wireUnits(redraw: () => void): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".unit-switch [data-unit]");
  const mark = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === WU)));
  mark();
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      setUnit(b.dataset.unit);
      mark();
      redraw();
      void syncField(); // the currents key follows the unit
    }),
  );
}

/**
 * Keep the reader's place across a re-render of the station sections. Sections change height when the
 * variable changes (shore stations drop their salinity and oxygen charts, notes come and go), so without this
 * the page would slide under the reader. The anchor is what the reader is looking at: a station heading in the
 * top third of the screen (they have just gone to that station), otherwise the chart nearest the middle. It
 * ends up exactly where it was; if a chart is gone after the change, its station's heading is used instead.
 *
 * The place is taken once and kept until the reader scrolls, so switching back and forth (temperature to
 * oxygen and back) always returns to the same spot, even when the first switch removed the chart.
 */
let place: { id: string; y: number }[] | null = null;
let placedAt = NaN; // scroll position after our own correction, to tell it from the reader's scrolling

function takePlace(): { id: string; y: number }[] | null {
  const h = window.innerHeight;
  // A reader at the overview (the map and table fill the top half of the screen) stays put: anchoring to a chart
  // peeking in at the bottom would scroll the masthead away when the map changes height between views.
  const overview = document.querySelector<HTMLElement>(".overview");
  if (overview && overview.getBoundingClientRect().bottom > h / 2) return null;
  const heads = [...document.querySelectorAll<HTMLElement>("#stations .station")].filter((el) => {
    const t = el.getBoundingClientRect().top;
    return t >= 0 && t < h / 3;
  });
  const plots = [...document.querySelectorAll<HTMLElement>("#stations .plot")].filter((el) => {
    const b = el.getBoundingClientRect();
    return b.bottom > 0 && b.top < h;
  });
  if (!heads.length && !plots.length) return null; // the stations are off screen: nothing above the reader moves
  const dist = (el: HTMLElement) => {
    const b = el.getBoundingClientRect();
    return Math.abs((b.top + b.bottom) / 2 - h / 2);
  };
  const anchor = heads[0] ?? plots.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return [anchor, anchor.closest<HTMLElement>(".station")]
    .filter((el): el is HTMLElement => !!el?.id)
    .map((el) => ({ id: el.id, y: el.getBoundingClientRect().top }));
}

function keepPlace(render: () => void): void {
  if (!place || Math.abs(window.scrollY - placedAt) > 2) place = takePlace();
  render();
  if (!place) return;
  for (const m of place) {
    const el = document.getElementById(m.id);
    if (el) {
      window.scrollBy(0, el.getBoundingClientRect().top - m.y);
      break;
    }
  }
  placedAt = window.scrollY;
}

/** Gauge pins for the Rivers view's map. */

/** The map follows the view: basins and gauges in Rivers, the Sound otherwise; and the view's surface field. */
async function syncMap(): Promise<void> {
  if (EMBED) return; // an embed draws no map
  syncSchematic();
  try {
    (await import("./map")).setRiverMode(VK === "rivers", VK === "rivers" ? gaugePins(RIVER_SECTIONS) : []);
  } catch {
    /* map not loaded */
  }
  void syncField();
}

/* ---------- Surface fields on the map ---------- */

const FIELD_CHOICES: { kind: FieldKind | "none"; label: string }[] = [
  { kind: "none", label: "No layer" },
  { kind: "comfort", label: "Comfort index" },
  { kind: "sst", label: "Sea surface temperature" },
  { kind: "chl", label: "Chlorophyll-a" },
  { kind: "kd490", label: "Water clarity (Kd490)" },
  { kind: "currents", label: "Surface currents (model)" },
  { kind: "wind", label: "Wind (HRRR)" },
  { kind: "waves", label: "Waves (NWS model)" },
];
/** The map layers each view offers, and the one it opens with; the others sit under "More layers". */
const VIEW_LAYERS: Record<VarKey, { offer: FieldKind[]; def: FieldKind | "none"; overlay?: boolean }> = {
  temp: { offer: ["sst"], def: "sst" },
  salinity: { offer: ["chl"], def: "none" },
  oxygen: { offer: ["chl"], def: "chl" },
  turbidity: { offer: ["kd490", "chl"], def: "kd490" },
  wind: { offer: ["comfort", "wind", "waves", "currents"], def: "comfort", overlay: true }, // the wind-against-tide overlay
  tides: { offer: [], def: "none" },
  rivers: { offer: [], def: "none" },
};
// A linked layer wins on load; otherwise the view's default. A layer picked by hand lasts until the view changes.
let fieldPick: FieldKind | "none" = (["sst", "chl", "kd490", "currents", "wind", "waves", "comfort"] as const).find((k) => k === LINK.get("layer")) ?? VIEW_LAYERS[VK].def;
/** Overlays on the map's field (Wind & waves only), on by link ("ov=wat,haz") or picked in the layer menu: wind
 * against tide, and the discomfort zones (comfort index 3 and up) for the reader's boat. */
const LINK_OV = (LINK.get("ov") ?? "").split(",");
let overlayWat = LINK_OV.includes("wat") || LINK.get("layer") === "wat";
let overlayHaz = LINK_OV.includes("dz");
/** A linked time ("-6h", "+12h", "-30d"), applied once the time bar has the scale it belongs to. */
let pendingOffset: { hours: number; scale: "hours" | "days" } | null = (() => {
  const m = /^([+-]?\d+)([hd])$/.exec((LINK.get("t") ?? "").replace(/^ /, "+")); // a "+" in a query string reads as a space
  return m ? { hours: Number(m[1]) * (m[2] === "d" ? 24 : 1), scale: m[2] === "d" ? "days" : "hours" } : null;
})();

/** The page's address for what is on screen: view, map layer, time, and optionally a plot ("WLIS-col"). */
function linkUrl(plot?: string): string {
  const p = new URLSearchParams();
  p.set("view", VK); // always: a visitor's remembered view would otherwise win
  if (fieldPick !== "none") p.set("layer", fieldPick);
  const ovs = VIEW_LAYERS[VK].overlay ? [overlayWat && "wat", overlayHaz && "dz"].filter(Boolean) : [];
  if (ovs.length) p.set("ov", ovs.join(","));
  const tl = timelineModule?.position();
  if (tl && tl.offset !== 0) p.set("t", tl.scale === "days" ? `${Math.round(tl.offset / 24)}d` : `${tl.offset > 0 ? "+" : ""}${tl.offset}h`);
  const q = p.toString();
  return `${location.origin}${location.pathname}${q ? `?${q}` : ""}${plot ? `#${plot}` : ""}`;
}

/** Keep the address bar current (no history entries), so it can be shared as it stands. A plot anchor is dropped
 * once the view changes under it. */
function syncUrl(keepHash = false): void {
  const hash = keepHash ? location.hash.slice(1) : "";
  history.replaceState(null, "", linkUrl(hash || undefined));
}

let timelineModule: typeof import("./timeline") | null = null;

/** Apply a linked time once the time bar is on the scale the link was made in. */
function applyPendingOffset(scale: "hours" | "days"): void {
  if (!pendingOffset || !timelineModule || pendingOffset.scale !== scale) return;
  timelineModule.setOffset(pendingOffset.hours);
  pendingOffset = null;
}

/** A click on a row of the status table goes to its station, except in Wind and Tides, where a row picks the station
 * for the outlook under the table (its name still goes to the station). */
function statusRowAnchor(e: MouseEvent): string | null {
  if (VK === "wind" || VK === "tides") return null;
  const a = (e.target as HTMLElement).closest(".status-grid tbody tr")?.querySelector<HTMLAnchorElement>('th a[href^="#"]');
  return a ? decodeURIComponent(a.getAttribute("href")!.slice(1)) : null;
}
let mapWide = false;
try {
  mapWide = localStorage.getItem("lhzn-blue-map-wide") === "1";
} catch {
  /* private mode: the normal map */
}
const FRAME_SPAN: Record<FieldKind | "none", [number, number]> = { none: [0, 0], comfort: [0, 1], currents: [0, 2], wind: [0, 1], waves: [0, 1], wat: [0, 2], sst: [24, 0], chl: [7 * 24, 0], kd490: [7 * 24, 0] };
const fieldCache = new Map<FieldKind, Promise<FieldData>>();

/** Comfort on the map: the models it reads (the NECOFS current only for kayaks), each from its own cache, as one
 * payload object per set so a redraw for the same set keeps the open readout. */
const comfortCache = new Map<string, Promise<FieldData>>();
function comfortData(): Promise<FieldData> {
  const key = BOAT === "kayak" ? "kayak" : "boat";
  if (!comfortCache.has(key)) {
    const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : undefined);
    comfortCache.set(
      key,
      Promise.allSettled([fieldData("wind"), fieldData("waves"), fieldData("wat"), fieldData("sst"), key === "kayak" ? fieldData("currents") : Promise.resolve({} as FieldData)]).then(([w, v, t, s, c]) => {
        const cur = ok(c);
        if (!ok(w)?.wind || !ok(v)?.wind) {
          comfortCache.delete(key); // try again next time
          throw new Error("comfort: wind or waves did not load");
        }
        return { comfort: { wind: ok(w)?.wind, waves: ok(v)?.wind, wat: ok(t)?.wat, sst: ok(s)?.raster, currents: cur?.mesh && cur.currents ? { mesh: cur.mesh, currents: cur.currents } : undefined } };
      }),
    );
  }
  return comfortCache.get(key)!;
}

function fieldData(kind: FieldKind): Promise<FieldData> {
  if (kind === "comfort") return comfortData();
  if (!fieldCache.has(kind)) {
    const load: Promise<FieldData> =
      kind === "wat"
        ? getJson<FieldData["wat"]>(`${DATA}/fields/wind-against-tide.json`).then((wat) => ({ wat }))
        : kind === "currents"
        ? Promise.all([getJson<FieldData["mesh"]>(`${DATA}/fields/currents-mesh.json`), getJson<FieldData["currents"]>(`${DATA}/fields/currents.json`)]).then(([mesh, currents]) => ({ mesh, currents }))
        : kind === "wind" || kind === "waves"
          ? getJson<FieldData["wind"]>(`${DATA}/fields/${kind === "wind" ? "hrrr-wind" : "nwps-waves"}.json`).then((wind) => ({ wind }))
          : getJson<FieldData["raster"]>(`${DATA}/fields/${kind}.json`).then((raster) => ({ raster }));
    fieldCache.set(kind, load.catch((err) => {
      fieldCache.delete(kind); // try again next time
      throw err;
    }));
  }
  return fieldCache.get(kind)!;
}

/** HRRR wind before hrrr-wind.json (14 days back): fetched only when the time bar goes back past the main file. */
let windHistoryLoad: Promise<import("./fields").WindHistory> | null = null;
function windHistoryData(): Promise<import("./fields").WindHistory> {
  windHistoryLoad ??= getJson<import("./fields").WindHistory>(`${DATA}/fields/hrrr-wind-history.json`).catch((err) => {
    windHistoryLoad = null; // try again next time
    throw err;
  });
  return windHistoryLoad;
}

/** The 90-day history behind a satellite layer, loaded after the layer shows (null when it is not published). */
const historyCache = new Map<FieldKind, Promise<RasterHistory | null>>();
function historyData(kind: FieldKind): Promise<RasterHistory | null> {
  if (!historyCache.has(kind)) {
    historyCache.set(
      kind,
      fetch(`${DATA}/fields/${kind}-90d.bin`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${kind} history: HTTP ${r.status}`))))
        .then(async (buf) => (await import("./fields")).decodeHistory(buf))
        .catch((err) => {
          console.error(err);
          historyCache.delete(kind); // try again next time
          return null;
        }),
    );
  }
  return historyCache.get(kind)!;
}

function applyWide(): void {
  document.querySelector(".overview")?.classList.toggle("map-wide", mapWide);
}

async function syncField(): Promise<void> {
  if (EMBED) return;
  applyWide();
  // Wind against tide: over the chosen field, or on its own when no field is chosen.
  let ov: FieldData["wat"];
  if (overlayWat && VIEW_LAYERS[VK].overlay) {
    try {
      ov = (await fieldData("wat")).wat;
    } catch (err) {
      console.error(err);
    }
  }
  const kind: FieldKind | "none" = fieldPick === "none" && ov ? "wat" : fieldPick;
  let hz: FieldData["comfort"];
  if (overlayHaz && VIEW_LAYERS[VK].overlay && kind !== "wat" && kind !== "none") {
    try {
      hz = (await fieldData("comfort")).comfort;
    } catch (err) {
      console.error(err);
    }
  }
  let payload: FieldData = {};
  if (kind !== "none") {
    try {
      payload = kind === "wat" ? { wat: ov } : { ...(await fieldData(kind)), overlay: ov, hazard: hz };
    } catch (err) {
      console.error(err);
    }
  }
  const shown = kind !== "none" && (payload.raster || payload.currents || payload.wind || payload.wat || payload.comfort) ? kind : null;
  // The time bar: days for a satellite layer once its history is in, hours otherwise.
  const tl = await import("./timeline");
  tl.setHoursBack(VK === "wind" ? WS_BACK / HOUR : 24);
  if (shown !== "sst" && shown !== "chl" && shown !== "kd490") tl.setScale("hours");
  // The span each frame covers, shaded on the time bar: a 2h model step, a day of SST, a 7-day composite.
  tl.setFrame(...FRAME_SPAN[shown ?? "none"]);
  void syncPhase(tl.position().scale === "hours");
  try {
    const fields = await import("./fields");
    void fields.showField(shown, payload, fieldControls());
    if (shown === "sst" || shown === "chl" || shown === "kd490") {
      const history = await historyData(shown);
      if (history && fieldPick === shown) {
        tl.setScale("days");
        applyPendingOffset("days");
        void fields.showField(shown, { ...payload, history }, fieldControls());
      }
    }
  } catch (err) {
    console.error(err);
  }
}

function fieldControls(): import("./fields").FieldControls {
  return {
    choices: (() => {
      const offer = VIEW_LAYERS[VK].offer;
      const ordered = [FIELD_CHOICES[0], ...offer.map((k) => FIELD_CHOICES.find((c) => c.kind === k)!)];
      return [...ordered, ...FIELD_CHOICES.filter((c) => !ordered.includes(c)).map((c) => ({ ...c, more: true }))];
    })(),
    chosen: fieldPick,
    boat: BOAT,
    // Wind & waves: a click reads wind, waves and wind against tide at its point, whatever layer shows.
    point: VIEW_LAYERS[VK].overlay
      ? async () => {
          const [w, v, c, t, s, z] = await Promise.allSettled([fieldData("wind"), fieldData("waves"), fieldData("currents"), fieldData("wat"), fieldData("sst"), getJson<NonNullable<import("./fields").PointSources["zones"]>>("/nws-zones-lis.json")]);
          const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : undefined);
          const cur = ok(c);
          return { wind: ok(w)?.wind, waves: ok(v)?.wind, currents: cur?.mesh && cur.currents ? { mesh: cur.mesh, currents: cur.currents } : undefined, wat: ok(t)?.wat, sst: ok(s)?.raster, zones: ok(z) };
        }
      : undefined,
    windHistory: VIEW_LAYERS[VK].overlay ? windHistoryData : undefined,
    overlays: VIEW_LAYERS[VK].overlay
      ? [
          {
            key: "wat",
            label: "Wind against tide",
            on: overlayWat,
            onToggle: (on) => {
              overlayWat = on;
              void syncField();
              syncUrl(true);
            },
          },
          {
            key: "dz",
            label: "Discomfort zones",
            on: overlayHaz,
            onToggle: (on) => {
              overlayHaz = on;
              void syncField();
              syncUrl(true);
            },
          },
        ]
      : undefined,
    onPick: (k) => {
      fieldPick = k;
      void syncField();
      syncUrl(true);
    },
    wide: mapWide,
    speed: currentSpeed(),
    onWide: (w) => {
      mapWide = w;
      try {
        localStorage.setItem("lhzn-blue-map-wide", w ? "1" : "0");
      } catch {
        /* private mode */
      }
      void syncField();
    },
  };
}

/** Pointing at a river in the table (mouse or keyboard) highlights its basin on the map (the map does not move). */


/** The Water switch (temperature, salinity, oxygen): temperature by default; remembered in this browser only.
 * A variable's history loads on first use; the button dims while it loads and the page keeps working. */
function wireWater(live: Live, stations: StationData[], rebuild: () => void): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".var-switch [data-var]");
  // On a phone the switch is a drop-down under one button that names the current view.
  const menu = $("view-menu");
  const setOpen = dropDown(menu, $("var-switch"));
  const mark = () => {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.var === VK)));
    menu.querySelector(".vm-current")!.textContent = [...buttons].find((b) => b.dataset.var === VK)?.textContent ?? "";
  };
  mark();
  buttons.forEach((b) => b.addEventListener("click", () => setOpen(false)));
  buttons.forEach((b) =>
    b.addEventListener("click", async () => {
      const k = b.dataset.var as VarKey;
      if (k === VK) return;
      b.classList.add("loading");
      try {
        await ensureVar(k, live, stations, addSources);
      } catch (err) {
        console.error(err);
        b.title = "Could not load this variable; please try again shortly.";
        return;
      } finally {
        b.classList.remove("loading");
      }
      VK = k;
      fieldPick = VIEW_LAYERS[VK].def; // a new view opens with its own layer
      try {
        localStorage.setItem("lhzn-blue-water-var", VK);
      } catch {
        /* private mode: the choice lasts for this page only */
      }
      mark();
      rebuild();
      syncUrl();
    }),
  );
}




function wireTheme(redraw: () => void): void {
  const btn = $("theme-toggle");
  // A moon in the light theme (switch to night), a sun in the dark one (switch to day).
  const MOON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const SUN = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const label = () => {
    const light = currentTheme() === "light";
    btn.innerHTML = light ? MOON : SUN;
    btn.title = light ? "Dark theme" : "Light theme";
    document.querySelector<HTMLElement>('[data-more="theme"]')!.textContent = light ? "Dark theme" : "Light theme";
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

/** The USGS tidal gauges (usgs-tidal.json): level in ft above MLLW, water quality, our fitted predictions. */


/** A variable's sources, as the adapter loads it, join the notes under About. */
const addSources = (html: string) => $("about-sources").insertAdjacentHTML("beforeend", html);

/** The engine's cells, readouts and figures (waterway/) read the page's view, colours and models through these. */
configureData({ data: DATA, forecastPage: LIS.forecastPage });
OUTLOOK.pin = LIS.defaults.outlookStation;
configureSchematic({ stations: () => STATIONS, redrawTable: () => statusGrid(STATIONS) });
configureModels({
  view: () => VK,
  palette: () => P,
  waveSensor: wavesOf,
  wavePanel: (id) => panelsOf(id).waves,
  wavesText,
  lastWave,
  wavesPublished: (id) => !!WAVE_LIVE[id]?.published,
});

async function main(): Promise<void> {
  P = PALETTES[currentTheme()];
  const extras = startExtras(); // the stations that join after the buoys, loading alongside them
  try {
    const { meta, live, stations } = await load();
    const byId = (id: string) => [...stations, ...RIVER_SECTIONS, ...(TURB_SECTION ? [TURB_SECTION] : [])].find((d) => d.meta.id === id)!;
    // A remembered salinity or oxygen choice loads its history first; if that fails, show temperature.
    if (VK !== "temp") await ensureVar(VK, live, stations, addSources).catch(() => (VK = "temp"));
    /** The stations on screen: the rivers section in the Rivers view, the buoys and shore stations otherwise. */
    const shown = () => (EMBED ? stations.filter((d) => d.meta.id === EMBED_STATION) : VK === "rivers" ? RIVER_SECTIONS : VK === "turbidity" ? (TURB_SECTION ? [TURB_SECTION] : []) : VK === "tides" ? stations.filter((d) => d.kind === "shore") : stations.filter((d) => d.kind !== "airport" || VK === "wind"));
    const drawAll = () => {
      for (const d of shown()) {
        readouts(d);
        (Object.keys(FIGS) as Kind[]).forEach((k) => drawInline(d, k));
      }
      redrawZoom();
    };
    /** Station sections for the selected variable (captions and record lines name it), buoys then shore. */
    const renderSections = () => {
      stations.forEach((d) => useVar(d, VK));
      const group = (kind: StationData["kind"], title: string) => {
        const list = stations.filter((d) => d.kind === kind);
        const grouped = stations.some((d) => d.kind === "shore");
        return list.length ? (grouped ? `<h2 class="station-group">${title}</h2>` : "") + list.map(sectionHtml).join("") : "";
      };
      $("stations").innerHTML = EMBED
        ? embedHtml(stations.find((d) => d.meta.id === EMBED_STATION))
        : VK === "tides"
          ? `<h2 class="station-group">${LIS.groups.shore}</h2>${stations.filter((d) => d.kind === "shore").map(sectionHtml).join("")}`
          : VK === "rivers"
          ? `<h2 class="station-group">${LIS.groups.rivers}</h2>${RIVER_SECTIONS.map(sectionHtml).join("")}`
          : VK === "turbidity"
            ? `<h2 class="station-group">${LIS.groups.turbidity}</h2>${TURB_SECTION ? sectionHtml(TURB_SECTION) : ""}`
            : group("buoy", LIS.groups.buoy) + group("shore", LIS.groups.shore) +
              (VK === "wind" ? group("airport", LIS.groups.airport) : "");
      drawAll();
      for (const d of shown()) {
        for (const k of Object.keys(FIGS) as Kind[]) {
          const legend = document.getElementById(`${d.meta.id}-${k}-legend`);
          if (legend) wireLegend(legend, $(`${d.meta.id}-${k}`));
        }
      }
    };
    renderSections();
    STATIONS = stations;
    statusGrid(stations);
    wireStatusTabs(stations);
    // The stations that join after the buoys, as their files arrive; the map waits for them so every pin is placed once.
    await joinExtras(stations, extras, {
      changed: (table) => {
        renderSections();
        if (table) statusGrid(stations);
      },
      sources: addSources,
      usgs: setUsgsWq,
      history: () => keepPlace(renderSections),
    });
    if (!EMBED) void overviewMap(stations); // an embed draws no map
    wireWater(live, stations, () => {
      ($("zoom") as HTMLDialogElement).close();
      keepPlace(() => {
        renderSections();
        statusGrid(stations);
      });
      void syncMap();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mapWide && !document.querySelector("dialog[open]")) {
        mapWide = false;
        try {
          localStorage.setItem("lhzn-blue-map-wide", "0");
        } catch {
          /* private mode */
        }
        void syncField();
      }
    });
    wireRiverHover();

    // Depth tabs, expand buttons, and a click on any inline chart opens the zoom view.
    $("stations").addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".legend") || target.closest("a")) return;
      const info = target.closest<HTMLElement>("[data-about]");
      if (info) {
        const section = info.closest<HTMLElement>(".station");
        openAbout(info.dataset.about!, section ? byId(section.id) : null);
        return;
      }
      const tab = target.closest<HTMLButtonElement>(".tab");
      if (tab) {
        const section = tab.closest<HTMLElement>(".station")!;
        const key = tab.dataset.fig as Kind;
        section.querySelectorAll(`.tab[data-fig="${key}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b === tab)));
        drawInline(byId(section.id), key);
        return;
      }
      const opener = target.closest<HTMLElement>(".expand, .plot");
      if (opener?.dataset.station) openZoom(byId(opener.dataset.station), opener.dataset.fig!, opener.dataset.full === "1");
    });
    wireZoom({
      fig: (k) => FIGS[k as Kind],
      name: figName,
      varLabel: () => V().label,
      depth: (d, k) => activeDepth(d, k as Kind),
      depthTabs: depthTabsHtml,
      afterDraw: (plot, d, k, x0, x1) => {
        if (k === "next48") mountVintage(d, plot, x0, x1);
        else if (k === "waves") mountNwpsVintage(d, plot, x0, x1);
        else plot.querySelector(".vintage")?.remove();
      },
    });
    wireAbout({
      station: (d) => ({
        title: d.kind === "rivers" ? "The river gauges" : d.kind === "turbidity" ? "Buoy turbidity sensors" : d.meta.name,
        html: isRiver(d) ? gaugeAboutHtml(d) : stationAboutHtml(d, { recordLine, isQuiet }),
      }),
      // A plot on a station can be linked to: the page as it stands, scrolled to that plot.
      link: (key, d) => (d && key in FIGS ? linkUrl(`${d.meta.id}-${key}`) : ""),
      method: (d) => ({
        variable: isWater(VK) ? V().label.toLowerCase() : "the reading",
        varKey: VK,
        station: d?.meta.name ?? "the station",
        stationId: d?.meta.id ?? "",
        kind: d?.kind ?? "",
      }),
      // The comfort index's thresholds, as a table with the reader's boat marked.
      extend: (key, body) => {
        if (key === "comfort") body.querySelector(".about-list")?.insertAdjacentHTML("afterend", comfortTableHtml(BOAT, WU === "ms"));
      },
    });
    window.setTimeout(() => revealLinked(), 300); // after the sections draw
    wireLinks(linkUrl, statusRowAnchor);
    // Back and Forward between the page's own entries (a jump from the wind strip, a station link): the browser
    // restores the scroll; the time comes back from the address.
    window.addEventListener("popstate", () => {
      const m = /^([+-]?\d+)([hd])$/.exec((new URLSearchParams(location.search).get("t") ?? "").replace(/^ /, "+"));
      timelineModule?.setOffset(m ? Number(m[1]) * (m[2] === "d" ? 24 : 1) : 0);
    });
    updatedStrip(meta, live, LIS.outage);
    about(meta);
    wireCollect(meta, live, stations, {
      template: promptTemplate,
      variable: () => (isWater(VK) ? V().label.toLowerCase() : "the reading"),
      isFig: (k) => k in FIGS,
      layer: () => fieldPick,
      layerLabel: () => FIELD_CHOICES.find((c) => c.kind === fieldPick)?.label ?? fieldPick,
      link: linkUrl,
      ...LIS.collect,
    });
    const redraw = () => {
      drawAll();
      statusGrid(stations);
    };
    onModelData(() => {
      drawAll();
      void showAt(AT);
      statusGrid(stations);
    });
    onTides(() => {
      DEPARTURE.clear();
      drawAll();
      void showAt(AT);
      statusGrid(stations);
    });
    void loadTides();
    void loadForecast();
    const mast = document.querySelector(".mast");
    if (mast) {
      const refresh = () => mountAdvisories(mast, openWindStrip).then(() => syncZones());
      void refresh();
      window.setInterval(() => void refresh(), 10 * 60_000);
    }
    wireTheme(redraw);
    wireOutageIcon();
    wireLocate(LIS.called);
    wireBoat(() => void syncField());
    wireUnits(redraw);
    wireMore();
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
    console.error(err); // the full error for anyone debugging; the strip shows a short message
    $("updated").innerHTML = `<b>Unavailable</b>could not load the data (${String(err)}). Please try again shortly.`;
  }
}

wireSuggest();
wireHints();
void main();
