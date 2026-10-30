/** A waterway's page on the engine: the overview (map, time bar, status table, outlook, wind strip), a section per
 * station with its readouts and figures for the selected view, the zoom view, the About dialogs, Collect and the AI
 * prompt. Everything particular to a waterway comes in through mountWaterwayPage: its config (waterways/<id>.ts), its
 * data adapter (adapters/<id>.ts) and its own parts (each station's About, its shore table, its tides diagram). */
import "./places.css";
import { renderLines, YELLOW, type ChartOptions, type Line } from "../chart";
import { wireHints } from "../hints";
import { chainButton, navigateTo, revealLinked, wireLinks } from "../links";
import { compass, windArrow, windGlyphs } from "../wind-dir";
import { comfortTableHtml } from "../comfort-thresholds";
import { smoothByAge } from "../trends";
import type { FieldData, FieldKind, RasterHistory } from "../fields";
import { wireSuggest } from "../suggest";
import {
  COVERAGE_MIN, DAY, DO_LEVELS, HOUR, Hourly, STRAT, dF, getJson, grid, yearLines, type LastObs,
  type Live, type Meta, type MetaSeries,
} from "../series";
import { mountAdvisories } from "../advisory";
import { ago, escHtml, fmtClock, fmtDate, fmtRun, fmtWhenMin, signed } from "./format";
import { AT, atFuture, atLabel, setAt, sparklineOf } from "./cursor";
import { holdRoom } from "./room";
import { pinTimeline } from "./pin-time";
import { DEPTH_LABEL, isWater, noWaterSensor, obsState, overallState, type StationData, stationState, type VarKey, WATER_VARS } from "./station-data";
import { stationPin, stationTables } from "./cells";
import { configureModels } from "./models";
import type { StationDataWaterway } from "./config";
import { type Built, type Fig, legendHtml, openZoom, redrawZoom, visibleYears, wireLegend, wireZoom } from "./figures";
import { stationReadouts } from "./readouts";
import { openAbout, wireAbout } from "./about";
import { configureData, onModelData } from "./data";
import { chooseRun, chosenRun, FCST, forecastAt, HRRR_HIST_LABEL, hrrrAsOf, hrrrHist, loadForecast, mountVintage, runForecastAt } from "./forecast";
import { loadNwps, mountNwpsVintage, NWPS, nwpsLabel, nwpsRunAt, nwpsRuns, nwpsSeries } from "./nwps";
import { OUTLOOK, outlookHtml } from "./outlook";
import { NEXT48 } from "./next48";
import { mountRevisions, setRevisionTime } from "./revisions";
import { ADV, ADV_WIND, advisoriesFor, loadAdvisories, zoneOf, zonesInForce } from "./advisories";
import { fitStripDates, hideWsTip, moveStripCursor, showWsTip, windAcrossHtml, WS_BACK, wsPoint } from "./wind-strip";
import { windRoseHtml } from "./wind-rose";
import { DEPARTURE, loadTides, onTides, TIDES } from "./tides";
import { departureBuilt, departureRowsSvg, drawLadder, highestAheadHtml, hiloAround, hiloBuilt, tidesTable } from "./tides-view";
import { BINS_WINDOW, meterBinsBuilt, type MeterColours, meterFanSvg, meterFlowBuilt, meterRecord, meterStart, METER_WINDOW } from "./meter";
import { cfs, dailyFlow, ordinal, pct, percentileOf, riverFlow } from "./rivers";
import { gaugePins, riverReadoutsHtml, riverTable, wireRiverHover } from "./rivers-view";
import { dropDown, wireMore } from "./phone-bar";
import { updatedStrip, wireOutageIcon } from "./freshness";
import { BOAT, wireBoat } from "./boat";
import { wireLocate } from "./locate";
import { embedMode, PLOT_PAGES, plotSlug, type PlotPage } from "./embed";
import { wireCollect } from "./prompt";
import { currentSpeed, setUnit, waveUnit, WIND_UNITS, windFmt, windVal, WU } from "./units";

/** The waterway this page is mounted for (mountWaterwayPage), and its parts. */
let CFG: StationDataWaterway;
let PARTS: PageParts;
/** Its data adapter. The Sound's is the only one so far, so its shape is the interface; a second adapter makes it one. */
type Adapter = typeof import("../adapters/sound");
let A: Adapter;
/** Station pages (<base><station>/), when the page is mounted with them; the station this page is for (null on the
 * overview). */
let PAGES: { base: string } | null = null;
let STATION_ID: string | null = null;
const onStation = (d: StationData) => !STATION_ID || d.meta.id === STATION_ID;
/** Move to a station's page (or the overview, null) within the page; null until the page has loaded. */
let goToPlace: ((id: string | null, push: boolean) => Promise<void>) | null = null;
/** The masthead and title as the page has them, for the way back to the overview. */
let MAST: { top: string; bottom: string; title: string; canonical: string } | null = null;

let DATA = "";
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
let EMBED: Kind | null = null;
let EMBED_STATION = "";
/** A plot page (/<waterway>/<station>/<plot>/): the one figure, with the time bar and a reading line (waterway/embed.ts). */
let PLOT_PAGE = false;
let PLOT: PlotPage | null = null;
/** The depth an address names ("depth=btm"): a water plot page's, or on a station page the linked plot's (LINKED_PLOT, the
 * address's "#WLIS-yoy"); then a plot page's tabs. Empty: the station's first. */
let PLOT_DEPTH = "";
const LINKED_PLOT = decodeURIComponent(location.hash.slice(1));
/** A water or river plot page: its time bar is on the days scale (90 days back), which its plot's window covers. */
const waterPlotPage = () => PLOT_PAGE && !!EMBED && ((FIGS[EMBED].varies && isWater(VK)) || VK === "rivers");
/** A river gauge, which has plot pages but no station page. */
const isGauge = (id: string | null) => !!id && !!CFG.rivers.gauges?.includes(id);
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

/** A current meter's plot colours: measured gold, and its bins from strong (nearest the meter) to pale. */
function meterColours(): MeterColours {
  const { L, C, h } = P.ramp;
  return { measured: P.now, ramp: (u) => oklch(L[0] + (L[1] - L[0]) * u, C[0] + (C[1] - C[0]) * u, h[0] + (h[1] - h[0]) * u) };
}

/** A meter's plan at the page's time: every bin's current seen from above (meter.ts draws it). */
function drawMeterFan(d: StationData): void {
  const hero = d.meta.id === STATION_ID ? document.getElementById("meter-hero-plot") : null;
  const el = hero ?? document.getElementById(`${d.meta.id}-mfan`);
  if (!el) return;
  // The drawing is 300 units tall and as wide as its box allows, so a unit is the box's height over 300 on screen.
  const [w, h] = [el.clientWidth, el.clientHeight];
  const { svg, legend, note } = meterFanSvg(d, AT, meterColours(), w && h ? w / h : undefined, h ? h / 300 : 1);
  el.innerHTML = svg;
  const lg = document.getElementById(hero ? "meter-hero-legend" : `${d.meta.id}-mfan-legend`);
  if (lg) lg.innerHTML = legend;
  PLOT_NOTES.set(`${d.meta.id}-mfan`, note);
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

type Kind = "yoy" | "chg" | "col" | "sb" | "next48" | "hilo" | "dep" | "mflow" | "mfan" | "mbins" | "wind" | "air" | "tide" | "waves" | "pressure" | "flow" | "share" | "rturb" | "ryoy" | "rpct" | "bturb";

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
  const p = A.panelsOf(d.meta.id);
  const t = A.lastSeen(d);
  const last = Number.isFinite(t) ? `Last reading: ${fmtDate.format(new Date(t * 1000))}. ` : "";
  const panel = p.water_quality ? ` or the <a href="${p.water_quality}">${CFG.operator} water quality panel</a>` : "";
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

let OXYGEN_NOTE = "";

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
    legend: yearsLegend(lines.map((l) => [l.label, l.color, l.opacity ?? 1])),
    note: [coverageNote(d, depth), VK === "oxygen" && extra.bands === undefined ? OXYGEN_NOTE : ""].filter(Boolean).join(" "),
  };
}

/** A legend of years, this year's first: this year, then one entry for the rest ("earlier years", fainter as they go
 * back); each year is in the plot's hover. */
function yearsLegend(entries: [string, string, number][]): [string, string, number, string?][] {
  const desc = [...entries].sort((a, b) => Number(b[0]) - Number(a[0]));
  return desc.length > 2 ? [desc[0], ["", desc[1][1], desc[1][2], "earlier years"]] : desc;
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
    legend: yearsLegend(shown.map((l) => [String(l.year), yearStyle(l.offset, maxOffset).color, yearStyle(l.offset, maxOffset).opacity ?? 1])),
    note: notes.length ? notes.join("; ") : undefined,
  };
}

/** A river's years as runoff added up from the window's first date, in inches of water over the gauged basin: rising
 * lines that seldom cross, so a dry year runs below the others and a flood is a step rather than a spike. A year whose
 * record starts more than 3 days after the first date, or has a longer gap, is left out (its total would not compare);
 * shorter gaps hold the last day's flow. The earlier years' median runs dashed; this year, the median and the wettest
 * and driest earlier years are named at their ends. */
const IN_PER_CFS_DAY_SQMI = (86400 * 0.0283168 * 39.3701) / 2.58999e6; // 1 cfs for a day over 1 sq mi, in inches
function runoffBuilt(d: StationData, xs: number[]): Built {
  const b = yearBuilt(d, dailyFlow(d), xs, { marker: { x: d.now, label: "now" }, empty: "No flow in this window." });
  const step = xs.length > 1 ? xs[1] - xs[0] : HOUR;
  const perStep = (IN_PER_CFS_DAY_SQMI / d.gauge!.drainage_sqmi) * (step / DAY);
  const slack = Math.round((3 * DAY) / step);
  const cumulative = (ys: number[]): number[] | null => {
    const first = ys.findIndex(Number.isFinite);
    let last = ys.length - 1;
    while (last >= 0 && !Number.isFinite(ys[last])) last--;
    if (first < 0 || first > slack) return null;
    let sum = 0, held = NaN, gap = 0;
    const out = ys.map(() => NaN);
    for (let i = first; i <= last; i++) {
      if (Number.isFinite(ys[i])) [held, gap] = [ys[i], 0];
      else if (++gap > slack) return null;
      sum += held * perStep;
      out[i] = sum;
    }
    return out;
  };
  const kept: Line[] = [];
  const dropped: string[] = [];
  for (const l of b.opts.lines) {
    const ys = cumulative(l.ys);
    if (ys) kept.push({ ...l, ys });
    else dropped.push(l.label);
  }
  const year = Math.max(...kept.map((l) => Number(l.label)));
  const earlier = kept.filter((l) => Number(l.label) !== year);
  const median = xs.map((_, i) => {
    const vs = earlier.map((l) => l.ys[i]).filter(Number.isFinite).sort((a, c) => a - c);
    return vs.length >= 3 ? (vs.length % 2 ? vs[(vs.length - 1) / 2] : (vs[vs.length / 2 - 1] + vs[vs.length / 2]) / 2) : NaN;
  });
  const total = (l: Line) => [...l.ys].reverse().find(Number.isFinite) ?? NaN;
  const byTotal = [...earlier].sort((a, c) => total(a) - total(c));
  const named = new Set([byTotal[0], byTotal[byTotal.length - 1]].filter(Boolean));
  // The earlier years faint, as the next 48 hours plot draws its earlier runs, and fainter with age; this year stands
  // out in its own color.
  const oldest = Math.min(...earlier.map((l) => Number(l.label)));
  const faint = (l: Line): Line => {
    const age = (year - Number(l.label) - 1) / Math.max(1, year - oldest - 1);
    return { ...l, color: P.line, width: 0.8, opacity: 0.3 - 0.22 * age };
  };
  const lines: Line[] = [
    ...kept.map((l) => ({ ...(Number(l.label) === year ? l : faint(l)), end: Number(l.label) === year || named.has(l) ? l.label : undefined })),
    ...(earlier.length >= 3 ? [{ ys: median, color: P.contrast, width: 1.1, opacity: 0.8, dash: "4 3", label: "Median of earlier years", end: "median" }] : []),
  ];
  // This year last, drawn on top.
  lines.sort((a, c) => (Number(a.label) === year ? 1 : 0) - (Number(c.label) === year ? 1 : 0));
  return {
    opts: { ...b.opts, lines, unit: " in", hoverDigits: 2, zero: true, floor: 0, bands: [] },
    legend: [
      ...b.legend.filter(([l]) => l === String(year)),
      ["", P.line, 0.3, "earlier years"],
      ["Median of earlier years", P.contrast, 0.8, "median"],
    ],
    note: [
      `runoff added up from ${fmtDate.format(new Date(xs[0] * 1000))}: the daily mean flow, spread over the ${d.gauge!.drainage_sqmi.toLocaleString("en-US")} square miles the gauge drains, as inches of water`,
      dropped.length ? `left out (a record starting after the first date, or a gap of more than 3 days): ${dropped.join(", ")}` : "",
      b.note ?? "",
    ].filter(Boolean).join("; "),
  };
}

const FIGS: Record<Kind, Fig> = {
  yoy: {
    title: "This year against earlier years",
    varies: true,
    in: (k) => isWater(k),
    sub: "same dates each year",
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
    sub: "",
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
    sub: "",
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
    sub: "",
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
    sub: "and each day's peak gust",
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
        legend: [[smoothLabel, P.line, 1, "Wind"], ["Wind, hourly", P.line, 0.35, "Hourly"], ["Daily peak gust", P.contrast, 0.55, "Peak gust"], ...(hh?.wind ? [[HRRR_HIST_LABEL, P.line, 0.7, "HRRR in gaps"] as [string, string, number, string]] : [])],
        note: zone ? `red: NWS small craft advisory (light), gale or stronger (dark), zone ${zone}` : undefined,
      };
    },
  },
  air: {
    title: "Air and water temperature",
    label: (d) => (d.kind === "airport" ? "Air temperature" : "Air and water temperature"),
    varies: false,
    in: (k) => k === "temp" || k === "wind",
    sub: "",
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
        legend: [...(noWater ? [] : [[label, P.depth[top], 1] as [string, string, number]]), ["Air", P.second, 1], ...(hh?.air ? [["Air, HRRR before each hour", P.second, 0.7, "HRRR in gaps"] as [string, string, number, string]] : [])],
      };
    },
  },
  tide: {
    title: "Departure from prediction",
    sub: "observed minus predicted",
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
    sub: "each tide",
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
    sub: "observed minus predicted",
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
  mflow: {
    title: "Current against prediction and model",
    sub: "along the flood direction",
    varies: false,
    wide: true,
    in: (k) => k === "tides",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "meter",
    window: METER_WINDOW,
    maxSpan: 30 * DAY,
    start: meterStart,
    build: (d, _depth, x0, x1) => meterFlowBuilt(d, x0, x1, meterColours()),
  },
  mfan: {
    title: "Seen from above",
    sub: "north up, every bin at the page's time",
    varies: false,
    wide: true,
    in: (k) => k === "tides",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "meter" && d.meta.id !== STATION_ID, // on the meter's own page the plan is the hero
    window: BINS_WINDOW,
    maxSpan: 30 * DAY,
    start: meterStart,
    // Drawn as a plan (drawMeterFan), not a chart: the build is only the bins' timeline, for the prompt and links.
    build: (d, _depth, x0, x1) => meterBinsBuilt(d, x0, x1, meterColours()),
  },
  mbins: {
    title: "Across the channel",
    sub: "every bin of the meter",
    varies: false,
    wide: true,
    in: (k) => k === "tides",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "meter",
    window: BINS_WINDOW,
    maxSpan: 30 * DAY,
    start: meterStart,
    build: (d, _depth, x0, x1) => meterBinsBuilt(d, x0, x1, meterColours()),
  },
  waves: {
    title: "Waves",
    sub: "height and each hour's highest wave",
    varies: false,
    in: (k) => k === "wind",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "buoy" && !!A.wavesOf(d.meta.id)?.sensor,
    // While the sensor is out, or the server is not publishing it (readings transcribed from the panel), open on the
    // wave model's span (its runs reach about 4 days back and 6 ahead), so recent hours are not a sliver at the end.
    window: (d) => {
      const last = A.lastWave(d.meta.id);
      const out = !last || obsState({ time: last.time } as LastObs) === "offline" || !A.WAVE_LIVE[d.meta.id]?.published;
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
        opts: { xs, lines, unit: ` ${u.label}`, zero: true, hoverDigits: u.digits, pick: hasModel ? pick : undefined, marker: hasModel ? { x: Date.now() / 1000, label: "now" } : undefined, empty: `No wave readings in this window. ${A.wavesText(d.meta.id)} Full record shows what we hold.` },
        legend: [["Significant height", measured, 1, "Height"], ["Highest wave", P.contrast, 0.35], ...(hasModel ? [["NWS wave model (NWPS)", P.line, 0.7, "NWPS model"] as [string, string, number, string]] : [])],
      };
    },
  },
  pressure: {
    title: "Pressure tendency",
    sub: "change over 3 h",
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
        legend: [["Change over 3 h", P.line, 1, "Measured"], ...(hh ? [[HRRR_HIST_LABEL, P.line, 0.7, "HRRR in gaps"] as [string, string, number, string]] : []), [`HRRR forecast${(() => { const a = hrrrAsOf(d.meta.id, xs); return a ? `, ${a}` : ""; })()}`, P.line, 0.7, "HRRR forecast"]],
        note: "shaded: steady to falling slowly (under 1.6 mb in 3 h), and falling or rising quickly (3.6 to 6); beyond 6 is very rapid",
      };
    },
  },
  flow: {
    title: "Flow against normal",
    sub: "against the usual range for the date",
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
      // On a log axis (the values drawn are log10 of the flow), so a dry spell is as legible as a flood; the record's
      // percentiles for each date are contours through the year, each named at its end.
      const log = (v: number) => (v > 0 ? Math.log10(v) : NaN);
      const band = (p: "p10" | "p25" | "p50" | "p75" | "p90") => xs.map((t) => log(pct(r, id, p, t)));
      const fmt = (v: number) => `${cfs(10 ** v)} cfs`;
      const g = r.gauges.find((x) => x.id === id);
      const contour = (p: "p10" | "p25" | "p50" | "p75" | "p90", name: string, opacity: number, width = 0.8): Line =>
        ({ ys: band(p), color: P.contrast, width, opacity, label: `${name} percentile for the date`, end: name, fmt });
      const lines: Line[] = [
        contour("p10", "10th", 0.3),
        contour("p90", "90th", 0.3),
        contour("p25", "25th", 0.45),
        contour("p75", "75th", 0.45),
        { ...contour("p50", "median", 0.7, 1.1), label: "Median for the date" },
        { ys: xs.map((t) => log(riverFlow(r, id, t))), color: P.depth.SFC, width: 1.8, label: `${g?.river ?? id} flow`, fmt },
      ];
      // Rules at 1, 2 and 5 of each power of ten ("500 cfs", "2k cfs").
      const at = [0, 1, 2, 3, 4, 5, 6].flatMap((e) => [1, 2, 5].map((m) => Math.log10(m * 10 ** e)));
      const tick = (v: number) => {
        const q = Math.round(10 ** v);
        return `${q >= 1000 ? `${q / 1000}k` : q} cfs`;
      };
      return {
        opts: { xs, lines, unit: " cfs", hoverDigits: 0, marker: { x: d.now, label: "now" }, yTicks: { at, label: tick }, minPad: 0.04, empty: "No flow readings in this window." },
        legend: [[`${g?.river ?? id} flow`, P.depth.SFC, 1], ["Median for the date", P.contrast, 0.7, "Median"]],
        note: `log scale; the grey contours are percentiles of daily flow for each date (10th, 25th, median, 75th, 90th), from ${r.normals[id]?.sample_count ?? "--"} years of approved record (USGS)`,
      };
    },
  },
  share: {
    title: "All rivers against normal",
    sub: "percentile for the date",
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
    sub: "",
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
    sub: "runoff added up over the same dates each year",
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
        : runoffBuilt(d, grid(x0, x1)),
  },
  bturb: {
    title: "Turbidity at the buoys",
    sub: "hourly median at 1 m",
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
    sub: "",
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
const ORDER: Kind[] = ["yoy", "chg", "col", "sb", "next48", "hilo", "dep", "mflow", "mfan", "mbins", "wind", "tide", "waves", "pressure", "share", "bturb", "flow", "rpct", "ryoy", "rturb", "air"];

/** A figure's name with the variable it shows, for the zoom title and screen readers. */
const figName = (f: Fig) => (f.varies && VK !== "temp" ? `${V().label}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}` : f.title);

/** Whether a station shows a figure: shore stations measure temperature only, so under salinity or oxygen
 * their variable charts are left out rather than drawn empty, as they are for a gauge with no water sensor. */
const shows = (d: StationData, k: Kind) =>
  (!EMBED || k === EMBED) && FIGS[k].in(VK) && FIGS[k].available(d) && !(FIGS[k].varies && d.kind === "shore" && (VK !== "temp" || noWaterSensor(d)));

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
    (await import("../map")).setAdvisoryZones(zonesInForce(t, CFG.zones));
  } catch {
    /* map not loaded */
  }
}



/** Where a current meter's page puts its map, a locator inset over the plan: the harbour, the towns either side and
 * the river's mouth on the Sound; centred a little south of the meter, toward the Sound
 * (METER_MAP_SOUTH degrees of latitude, about 2 km), so the mouth is in view. Null on any other page. */
const METER_MAP_ZOOM = 9;
const METER_MAP_SOUTH = 0.018;
function meterPlace(): { lon: number; lat: number; zoom: number } | null {
  const m = STATION_ID ? A.METERS.find((x) => x.id === STATION_ID) : undefined;
  return m ? { lon: m.lon, lat: m.lat - METER_MAP_SOUTH, zoom: METER_MAP_ZOOM } : null;
}

/** How far back the time bar reaches, in hours: as far as the view's data. Two weeks in the Wind view (its strip spans
 * them), on a current meter's page (its plan steps back through the meter's record) and in the Tides view (within the
 * current-phase file's 15 days, so the strip under the bar spans a spring-neap cycle beside the moon's phases); a day
 * elsewhere. */
const METER_HOURS_BACK = 14 * 24;
const hoursBack = () => (VK === "wind" ? WS_BACK / HOUR : meterPlace() || VK === "tides" ? METER_HOURS_BACK : 24);

/** The Tides view's diagram is the Sound's gauges; a current meter's page shows the map in its place. */
function syncDiagram(): void {
  if (meterPlace()) document.querySelector("#map .schematic")?.remove();
  else PARTS.diagram?.sync();
  syncMeterHero();
}

/** A current meter's page leads with its plan, large, in the map's place: the map shrinks to a locator inset over the
 * plan's corner (the east bank, land in the plan), and the empty status column folds away. Other pages are as they
 * were; leaving the meter's page puts the map back. */
function syncMeterHero(): void {
  const overview = document.querySelector<HTMLElement>(".overview");
  const col = document.querySelector<HTMLElement>(".map-col");
  if (!overview || !col) return;
  const on = !!meterPlace() && !EMBED;
  if (overview.classList.contains("meter-page") !== on) {
    overview.classList.toggle("meter-page", on);
    // The map's box has just changed size: fit it, and centre it again on the meter (or leave it where it was).
    const place = meterPlace();
    void import("../map").then((m) => {
      m.refitMap();
      if (place) void m.focusOn(place, true);
    });
  }
  let hero = document.getElementById("meter-hero");
  if (!on) {
    hero?.remove();
    return;
  }
  if (!hero) {
    hero = document.createElement("div");
    hero.id = "meter-hero";
    hero.className = "meter-hero";
    hero.innerHTML =
      `<div class="meter-hero-cap"><span class="cap-label">Seen from above</span><span class="cap-sub">north up, every bin at the page's time</span>` +
      `<button class="fig-info" type="button" data-about="mfan" aria-label="About this plan" title="About this plan">i</button></div>` +
      `<div class="plot" id="meter-hero-plot" data-fig="mfan"></div><div class="legend" id="meter-hero-legend"></div>`;
    col.insertBefore(hero, col.firstChild);
  }
  const d = STATIONS.find((s) => s.meta.id === STATION_ID && s.kind === "meter");
  if (d) drawMeterFan(d);
}

/** The table row whose station the outlook shows, marked. */
function markOutlookRow(): void {
  const on = OUTLOOK.peek ?? OUTLOOK.pin;
  document.querySelectorAll<HTMLTableRowElement>("#status tbody tr").forEach((tr) => {
    const id = tr.querySelector<HTMLAnchorElement>('th a[href^="#"]')?.getAttribute("href")?.slice(1);
    const shown = VK === "tides" && !STATIONS.some((d) => d.meta.id === on && d.kind === "shore") ? CFG.defaults.tideStation : on;
    tr.classList.toggle("ol-on", (VK === "wind" || VK === "tides") && id === shown);
  });
  syncDiagram();
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
  const d = A.TURB_SECTION;
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

/** The status column at the cursor's time, for the view on screen. `survey` leaves out the wind across the waterway (by
 * far the costliest part to draw; its height is held from the column as drawn). */
function statusHtml(all: StationData[], survey = false): string {
  const stations = all.filter(onStation);
  if (VK === "turbidity") return turbTable() + PARTS.shoreTable() + outlookHtml(STATIONS);
  if (VK === "rivers") return riverTable(A.RIVER_SECTIONS[0]) + outlookHtml(STATIONS);
  if (VK === "tides") return STATION_ID && stations[0]?.kind === "meter" ? "" : tidesTable(stations) + highestAheadHtml(stations, CFG.defaults.tideStation);
  const group = STATION_ID ? (stations[0]?.kind === "shore" ? "shore" : "buoy") : SG;
  // An airport is in neither table: its page leads with the outlook. The shore gauges' own table is the overview's.
  const table = STATION_ID && stations[0]?.kind === "airport" ? "" : stationTables(stations, group);
  // The wind across the whole waterway is the overview's: a station's page keeps to the station, with its wind roses.
  const across = STATION_ID ? windRoseHtml(stations[0], VK) : survey ? "" : windAcrossHtml(all, CFG.called);
  return `${table}${stationPhoto()}${isWater(VK) && !STATION_ID ? PARTS.shoreTable() : ""}${outlookHtml(all)}${across}`;
}

/** The times the room in the status column is surveyed at: now and the page's time, then one of each kind across the
 * time bar's reach (the forecast near and far, the last day, the last week and month; a fresh column is drawn at these
 * before it paints), then the whole reach (90 days back, 72 hours ahead), closer together near now. */
function roomTimes(): (number | null)[] {
  const now = Math.round(Date.now() / 3.6e6);
  const hours = [3, -24, 48, -3, -7 * 24, -30 * 24, 1, 2];
  for (let h = 6; h <= 72; h += 3) hours.push(h, -h);
  for (let h = 84; h <= 336; h += 12) hours.push(-h);
  for (let h = 384; h <= 90 * 24; h += 48) hours.push(-h);
  return [null, AT, ...hours.map((h) => (now + h) * 3600)];
}

/** Draw the status column; `timeOnly` when only the time moved (the room it holds stays as surveyed). When only the
 * time moved, the wind across the waterway is kept as drawn and only its cursor moves: nothing else on it depends on
 * the page's time, and it is by far the costliest part to draw. */
function statusGrid(all: StationData[], timeOnly = false): void {
  if (VK === "tides" && !TIDES) void loadTides();
  if (!all.filter(onStation).some((d) => d.kind === "shore")) SG = "buoy";
  const box = $("status");
  const strip = timeOnly && !STATION_ID ? box.querySelector<HTMLElement>("section.ws") : null;
  const keep = strip && moveStripCursor(strip) ? strip : null;
  box.innerHTML = statusHtml(all, !!keep);
  if (keep) box.append(keep);
  else fitStripDates(box);
  if (VK !== "turbidity" && VK !== "rivers") markOutlookRow();
  if (!EMBED) holdRoom(box, `${VK}|${STATION_ID}|${SG}|${box.clientWidth}`, !timeOnly, () => statusHtml(all, true), roomTimes);
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
    if (hi) hi.outerHTML = highestAheadHtml(stations, CFG.defaults.tideStation);
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
    // The (i) in the table's corner shows or hides the key to its dots and lines (kept open as the table redraws).
    if ((e.target as HTMLElement).closest(".key-info")) box.classList.toggle("key-open");
    // The outlook's (i): its source and verification, and how to pick its station.
    if ((e.target as HTMLElement).closest(".ol-info")) box.classList.toggle("ol-open");
  });
  // A click moves the page's time. Two clicks close together in time and place also open that station's wind chart
  // at that hour (the next 48 hours where it reaches, else the wind record). Counted here, not with dblclick: the
  // strip can be redrawn between the clicks (in a new hour, or as data arrives), and the second would land on a new
  // element, where the browser fires no dblclick.
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

/** The current-phase strip under the time bar (Tides, hours scale): loaded once, shown or hidden as the view and
 * scale change. The moon's phases are on the time bar's dates in every view. */
let phaseLoad: Promise<import("../phase").PhaseFile | null> | null = null;
async function syncPhase(hours: boolean): Promise<void> {
  // A plot page keeps its height for the plot; a current meter's page has the same comparison, measured, in its plots.
  const show = VK === "tides" && hours && !PLOT_PAGE && !meterPlace();
  const ph = await import("../phase");
  if (show) phaseLoad ??= getJson<import("../phase").PhaseFile>(`${DATA}/current-phase.json`).catch(() => null);
  const u = WIND_UNITS[WU];
  ph.setPhase(show ? await phaseLoad : null, show, { label: u.label, perKt: u.factor, digits: 1 });
}

/** The time bar across the top of the page moves the map, the table and a rule on every chart (wired once). */
let timelineWired = false;
async function wireTimeline(box: HTMLElement): Promise<void> {
  if (timelineWired) return;
  timelineWired = true;
  const [tl, chart] = await Promise.all([import("../timeline"), import("../chart")]);
  tl.mountTimeline(document.getElementById("timebar") ?? document.getElementById("map-foot") ?? box);
  const root = tl.timelineRoot();
  if (root && !EMBED) pinTimeline(root); // in reach while the page scrolls
  if (PLOT_PAGE) tl.showWeekday(true); // a plot page states its time once, here
  timelineModule = tl;
  tl.onAsOf((t) => {
    if (t != null && t * 1000 > Date.now()) void loadForecast();
    syncUrl(true);
    chart.markAsOf(t);
    void showAt(t);
    setRevisionTime(t); // the next 48 hours plot's Revisions follow the page's time
    if (PLOT_PAGE) plotReading();
    import("../fields").then((f) => f.setFieldTime(t)).catch(() => undefined);
  });
  tl.setHoursBack(hoursBack()); // the view's reach first, or a linked time is clamped to a day
  if (waterPlotPage()) tl.setScale("days"); // a water plot spans months: its time moves by days
  applyPendingOffset(tl.position().scale); // after the listener, so a linked time reaches the charts, the table and the pins
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
  if (VK === "tides") STATIONS.filter((s) => s.kind === "meter").forEach(drawMeterFan);
  if (STATIONS.length) statusGrid(STATIONS, true);
  void syncZones();
  if (EMBED) return;
  try {
    (await import("../map")).updatePins([...STATIONS.map(stationPin), ...(VK === "rivers" ? gaugePins(A.RIVER_SECTIONS) : [])]);
  } catch {
    /* map not loaded */
  }
}

async function overviewMap(stations: StationData[]): Promise<void> {
  const box = $("map");
  void wireTimeline(box);
  try {
    const { drawMap } = await import("../map");
    drawMap(
      box,
      stations.map(stationPin),
      // With station pages a pin opens its station's page; without them it goes to the station's section.
      (id) => (PAGES ? void (id !== STATION_ID && hasPage(id) && goToPlace?.(id, true)) : navigateTo(id)),
      currentTheme(),
      meterPlace() ?? STATIONS.find((d) => d.meta.id === STATION_ID)?.meta,
    );
    void syncMap();
  } catch {
    box.innerHTML = `<p class="note">The map could not load.</p>`;
  }
}

/* ---------- Station sections ---------- */

/** A water plot page's views, in its caption beside the depth tabs (the top bar has no room for them on a phone): the
 * station's views the plot is drawn in, where there are two or more. Each works the view switch's own button. */
function plotViewTabs(d: StationData): string {
  const views = (CFG.stationPages?.views[d.kind] ?? []).filter((v) => PLOT?.views.includes(v));
  if (!waterPlotPage() || views.length < 2) return "";
  const label = (v: string) => document.querySelector(`.var-switch [data-var="${v}"]`)?.textContent ?? v;
  return `<span class="tabs plot-views" role="group" aria-label="View">${views
    .map((v) => `<button class="tab" type="button" data-plot-view="${v}" aria-pressed="${v === VK}">${escHtml(label(v))}</button>`)
    .join("")}</span>`;
}

function depthTabsHtml(d: StationData, key: string, active: string): string {
  return `<span class="tabs" role="group" aria-label="${d.kind === "rivers" ? "River" : "Depth"}">${d.meta.series
    .map((s) => `<button class="tab" type="button" data-fig="${key}" data-depth="${s.depth}" aria-pressed="${s.depth === active}">${s.label}</button>`)
    .join("")}</span>`;
}

/** The heading's record line: per depth for the water views; the wave record (or the weather window) for wind. */
function recordLine(d: StationData, perDepth: string): string {
  if (d.kind === "meter") return meterRecord(d);
  if (VK === "tides") return "Water level, hourly, the last 100 days; predictions and flood levels from NOAA";
  if (d.kind === "rivers") return "Daily flow from 1990; recent flow hourly";
  if (d.kind === "turbidity") {
    const first = Math.min(...Object.values(d.turb?.ntu ?? {}).map((s) => s?.t0 ?? Infinity));
    return Number.isFinite(first) ? `Hourly from ${new Date(first * 1000).getUTCFullYear()}` : "Hourly, last 100 days";
  }
  if (d.kind === "river") return `Daily flow from ${d.gauge?.record_start?.slice(0, 4) ?? "--"}; recent flow hourly`;
  if (isWater(VK) && noWaterSensor(d)) return "Water level only; no water temperature sensor";
  if (isWater(VK)) return `${VK === "temp" ? "Record" : `${V().label} record`}: ${perDepth}`;
  const id = d.meta.id;
  if (!A.wavesOf(id)?.sensor) return "Weather: the last 100 days";
  const start = A.WAVE_META[id]?.record_start;
  const last = A.lastWave(id);
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
      <figcaption><span class="cap-label">${STATION_ID ? "" : `<span class="cap-code">${id}</span>: `}${f.label?.(d) ?? f.title}</span>${f.sub ? `<span class="cap-sub">${f.sub}</span>` : ""}${PLOT_PAGE && key === EMBED ? plotViewTabs(d) : ""}${f.depthTabs && d.depths.length > 1 ? depthTabsHtml(d, key, ((PLOT_PAGE && key === EMBED) || LINKED_PLOT === `${id}-${key}`) && d.depths.includes(PLOT_DEPTH) ? PLOT_DEPTH : d.depths[0]) : ""}
        <span class="fig-actions"><button class="collect-btn" type="button" data-collect="${id}-${key}" data-title="${figName(f)}: ${st.name}" data-kind="plot" aria-pressed="false">+</button>${chainButton(`${id}-${key}`, `this plot: ${figName(f)}, ${st.name}`)}<button class="fig-info" type="button" data-about="${key}" aria-label="About this plot: ${figName(f)}" title="About this plot">i</button>${key === "next48" || key === "mfan" ? "" : `<button class="expand" type="button" data-station="${id}" data-fig="${key}" data-full="1" aria-label="Full record: ${figName(f)}, ${st.name}">Full record</button>`}${key === "mfan" ? "" : `<button class="expand" type="button" data-station="${id}" data-fig="${key}" aria-label="Expand: ${figName(f)}, ${st.name}">Expand</button>`}</span></figcaption>
      <div class="plot" id="${id}-${key}" data-station="${id}" data-fig="${key}"${PLOT_PAGE || key === "mfan" ? "" : ' title="Click to expand"'}><svg role="img" aria-label="${figName(f)}"></svg><div class="plot-labels" aria-hidden="true"></div></div>${key === "sb" && hasWind(d) ? windStripHtml(id) : ""}
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
        <span class="sid">${d.kind === "turbidity" ? `${CFG.operator} buoys, optical sensors at 1 m` : d.kind === "rivers" ? "USGS stream gauges" : d.kind === "river" ? `USGS ${d.gauge!.usgs_id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W` : `${id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W`}</span>
        <span class="rec">${recordLine(d, rec)}</span>
      </div>
      <p class="station-links"><span>${d.kind === "turbidity" ? "Buoys:" : d.kind === "rivers" || d.kind === "river" ? "At USGS:" : d.kind === "shore" ? (d.meta.operator === "USGS" ? "At USGS:" : "At NOAA:") : d.kind === "meter" ? "At NOAA:" : d.kind === "airport" ? "At IEM:" : `At ${CFG.operator}:`}</span>${[
        ...(d.kind === "rivers" ? (d.river?.gauges ?? []).map((g) => `<a href="#${g.id}">${g.river}</a>`) : []),
        ...(d.kind === "turbidity" ? (d.turb?.buoys ?? []).map((b) => `<a href="${A.infoUrl(b.id) ?? "#"}">${b.name}</a>`) : []),
        st.info_url ? `<a href="${st.info_url}">${d.kind === "river" ? "Gauge page" : d.kind === "shore" || d.kind === "airport" || d.kind === "meter" ? "Station page" : "About this buoy"}</a>` : "",
        A.panelsOf(id).weather ? `<a href="${A.panelsOf(id).weather}">Weather panel</a>` : "",
        A.panelsOf(id).water_quality ? `<a href="${A.panelsOf(id).water_quality}">Water quality panel</a>` : "",
        A.panelsOf(id).waves ? `<a href="${A.panelsOf(id).waves}">Wave panel</a>` : "",
      ]
        .filter(Boolean)
        .join("")}</p>
      ${notes.length ? `<p class="station-note">${notes.join(" ")}</p>` : ""}
      <div class="band" id="${id}-readouts"></div>
      <div class="figs">${kinds.map(fig).join("")}</div>
    </section>`;
}

/** An embed's body: the station's section (only its one figure shows) and a credit line back to the site. A plot
 * page's: the section, the reading at the page's time, and the way to the station's own page. */
function embedHtml(d: StationData | undefined): string {
  if (!d) return `<p class="embed-credit">No station ${escHtml(EMBED_STATION)} on this page.</p>`;
  // A gauge's plots are in the Rivers view of the overview, under its name (at the page's time).
  const riverUrl = () => {
    const q = new URLSearchParams(location.search);
    q.set("view", "rivers");
    q.delete("depth");
    return `${PAGES?.base ?? ""}?${q}#${d.meta.id}`;
  };
  const every = `<a href="${isGauge(d.meta.id) ? riverUrl() : placeUrl(d.meta.id)}">${escHtml(d.meta.name)}: every plot</a>`;
  if (PLOT && !shows(d, EMBED!)) return `<p class="embed-credit">${escHtml(d.meta.name)} has no ${escHtml(PLOT.name.toLowerCase())} plot. ${every}</p>`;
  if (PLOT_PAGE)
    return `<p class="plot-reading" id="plot-reading" aria-live="polite"></p>` + sectionHtml(d) +
      `<p class="embed-credit">${every} &middot; tap or drag the plot to move the time &middot; provisional, not for navigation</p>`;
  // An embed links to the plot's own page, or for an embed by name, to the plot on the waterway's page.
  const link = PLOT
    ? `https://longhorizon.blue${location.pathname}?view=${VK}`
    : `https://longhorizon.blue/${CFG.id}/?view=${EMBED === "next48" ? "wind" : "temp"}#${d.meta.id}-${EMBED}`;
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

/** Each plot's note from its last drawing ("<station>-<plot>"), shown at the top of the plot's (i). */
const PLOT_NOTES = new Map<string, string>();
/** A plot page's plot as last drawn: its window (each plot's holds the time bar's reach), and what it drew, for the
 * reading line. */
let PLOT_DRAWN: { x0: number; x1: number; b: Built } | null = null;

function drawInline(d: StationData, key: Kind): void {
  if (!shows(d, key)) return;
  let [x0, x1] = FIGS[key].window(d);
  // A water plot page's time reaches 90 days back: its plot does too (the 7-day change and surface minus bottom show 60).
  if (key === EMBED && waterPlotPage()) x0 = Math.min(x0, d.now - 90 * DAY);
  const b = FIGS[key].build(d, activeDepth(d, key), x0, x1, false);
  if (PLOT_PAGE && key === EMBED) PLOT_DRAWN = { x0, x1, b };
  if (key === "sb") drawWindStrip(d, x0, x1);
  if (key === "mfan") return drawMeterFan(d);
  if (key === "hilo") {
    drawLadder(d, x0, x1);
    // The flood levels and MHHW are labelled on the ladder itself; the legend keeps the marks that are not.
    $(`${d.meta.id}-${key}-legend`).innerHTML =
      `<span class="lg"><svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"><circle r="3" fill="var(--bg)" stroke="var(--ink-mute)"/></svg>predicted</span>` +
      `<span class="lg"><svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"><circle r="3.2" fill="var(--wp-gold)"/></svg>observed</span>` +
      `<span class="lg" title="More than 0.5 ft beyond the prediction"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--wp-amber)" stroke-width="2"/></svg>0.5 ft or more off</span>`;
    return;
  }
  renderLines($(`${d.meta.id}-${key}`), b.opts);
  $(`${d.meta.id}-${key}-legend`).innerHTML = legendHtml(b);
  PLOT_NOTES.set(`${d.meta.id}-${key}`, b.note ?? "");
  if (key === "next48") {
    mountVintage(d, $(`${d.meta.id}-${key}`), x0, x1);
    mountRevisions(d, $(`${d.meta.id}-${key}`), x0, x1);
  }
  if (key === "waves") mountNwpsVintage(d, $(`${d.meta.id}-${key}`), x0, x1);
}



/* ---------- Plots drawn as they near the screen ---------- */

/** Sections within about a screen of view (their plots draw at once), and the plots waiting in the others: a section's
 * waiting plots draw as it scrolls near. A page draws a few sections' plots at load rather than every one of them, and
 * again each time more data arrives. */
const NEAR = new Set<string>();
const WAITING = new Map<string, Set<Kind>>();
let sectionWatch: IntersectionObserver | null = null;
let sectionOf: (id: string) => StationData | undefined = () => undefined;

function drawWhenNear(d: StationData, key: Kind): void {
  if (EMBED || !sectionWatch || NEAR.has(d.meta.id)) return drawInline(d, key);
  let waiting = WAITING.get(d.meta.id);
  if (!waiting) WAITING.set(d.meta.id, (waiting = new Set()));
  waiting.add(key);
}

/** Watch the sections just written into the page (their plots wait until each comes near). */
function watchSections(byId: (id: string) => StationData | undefined): void {
  if (typeof IntersectionObserver === "undefined") return;
  sectionOf = byId;
  sectionWatch ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).id;
        if (!e.isIntersecting) {
          NEAR.delete(id);
          continue;
        }
        NEAR.add(id);
        const waiting = WAITING.get(id);
        const d = waiting && sectionOf(id);
        WAITING.delete(id);
        if (d) waiting.forEach((k) => drawInline(d, k));
      }
    },
    { rootMargin: "800px 0px" },
  );
  sectionWatch.disconnect();
  NEAR.clear();
  WAITING.clear();
  document.querySelectorAll<HTMLElement>("#stations section.station[id]").forEach((s) => sectionWatch!.observe(s));
}

const isRiver = (d: StationData) => d.kind === "rivers" || d.kind === "river";


const aboutNoun = (d: StationData) =>
  d.kind === "rivers" ? "these gauges" : d.kind === "river" ? "this gauge" : d.kind === "turbidity" ? "these sensors" : d.kind === "buoy" ? "this buoy" : d.kind === "meter" ? "this current meter" : "this station";

/** A quiet station needs a last reading to date its status from. */
const isQuiet = (d: StationData) => (d.kind === "buoy" || d.kind === "shore") && stationState(d) === "offline" && Number.isFinite(A.lastSeen(d));

/** The one-line statuses shown under a section's heading: gaps in the data only. */
function statusLines(d: StationData): string[] {
  const g = d.gauge;
  return [
    g?.discontinued ? `No flow published since ${fmtDate.format(new Date(`${g.discontinued}T12:00:00Z`))}.` : "",
    isQuiet(d) ? `No reading since ${fmtDate.format(new Date(A.lastSeen(d) * 1000))}.` : "",
    !isRiver(d) && !d.live && d.meta.outage_note ? "Not published on the data server; the record shown is our saved copy." : "",
    d.kind === "shore" && isWater(VK) && VK !== "temp" ? `Water temperature only; ${V().label.toLowerCase()} comes from the buoys.` : "",
  ].filter(Boolean);
}





function about(meta: Meta): void {
  $("about-method").innerHTML =
    `Below are the datasets behind each series and the quality checks applied to them. For how the page works and ` +
    `where its data come from, see the <a href="/about/">About</a> page; for the science behind it, the ` +
    `<a href="/references/">references</a> page.`;
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
  syncDiagram();
  try {
    (await import("../map")).setRiverMode(VK === "rivers", VK === "rivers" ? gaugePins(A.RIVER_SECTIONS) : []);
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
let fieldPick: FieldKind | "none" = "none";
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
  if (fieldPick !== "none" && !EMBED) p.set("layer", fieldPick); // a plot page or an embed has no map
  const ovs = VIEW_LAYERS[VK].overlay ? [overlayWat && "wat", overlayHaz && "dz"].filter(Boolean) : [];
  if (ovs.length && !EMBED) p.set("ov", ovs.join(","));
  const tl = timelineModule?.position();
  if (tl && tl.offset !== 0) p.set("t", tl.scale === "days" ? `${Math.round(tl.offset / 24)}d` : `${tl.offset > 0 ? "+" : ""}${tl.offset}h`);
  if (PLOT_PAGE && PLOT_DEPTH) p.set("depth", PLOT_DEPTH.toLowerCase()); // a plot page's depth tab
  // A link to one plot ("WLIS-yoy") keeps the depth its tabs show, where that is not the first.
  const [, pid, pkey] = /^([A-Z0-9]+)-([a-z0-9]+)$/.exec(plot ?? "") ?? [];
  const pd = !PLOT_PAGE && pid && FIGS[pkey as Kind]?.depthTabs ? STATIONS.find((s) => s.meta.id === pid) : undefined;
  if (pd && activeDepth(pd, pkey as Kind) !== pd.depths[0]) p.set("depth", activeDepth(pd, pkey as Kind).toLowerCase());
  // A plot page or an embed: the run a reader fixed (its UTC hour, "2026102811"), and that it is an embed.
  const run = EMBED ? chosenRun(EMBED_STATION) : null;
  if (run != null) p.set("run", new Date(run * 1000).toISOString().slice(0, 13).replace(/\D/g, ""));
  if (EMBED && LINK.get("embed")) p.set("embed", LINK.get("embed")!);
  const q = p.toString();
  return `${location.origin}${location.pathname}${q ? `?${q}` : ""}${plot ? `#${plot}` : ""}`;
}

/** Keep the address bar current (no history entries), so it can be shared as it stands. A plot anchor is dropped
 * once the view changes under it. */
function syncUrl(keepHash = false): void {
  const hash = keepHash ? location.hash.slice(1) : "";
  history.replaceState(null, "", linkUrl(hash || undefined));
}

let timelineModule: typeof import("../timeline") | null = null;

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

/** The map layer the page opens on, asked for before the map is drawn (alongside the shore and airport files). */
function prefetchField(): void {
  if (EMBED) return;
  if (overlayWat && VIEW_LAYERS[VK].overlay) void fieldData("wat").catch(() => undefined);
  if (fieldPick !== "none") void fieldData(fieldPick).catch(() => undefined);
}

/** HRRR wind before hrrr-wind.json (14 days back): fetched only when the time bar goes back past the main file. */
let windHistoryLoad: Promise<import("../fields").WindHistory> | null = null;
function windHistoryData(): Promise<import("../fields").WindHistory> {
  windHistoryLoad ??= getJson<import("../fields").WindHistory>(`${DATA}/fields/hrrr-wind-history.json`).catch((err) => {
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
        .then(async (buf) => (await import("../fields")).decodeHistory(buf))
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
  const tl = await import("../timeline");
  tl.setHoursBack(hoursBack());
  if (shown !== "sst" && shown !== "chl" && shown !== "kd490") tl.setScale("hours");
  // The span each frame covers, shaded on the time bar: a 2h model step, a day of SST, a 7-day composite.
  tl.setFrame(...FRAME_SPAN[shown ?? "none"]);
  void syncPhase(tl.position().scale === "hours");
  try {
    const fields = await import("../fields");
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

function fieldControls(): import("../fields").FieldControls {
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
          const [w, v, c, t, s, z] = await Promise.allSettled([fieldData("wind"), fieldData("waves"), fieldData("currents"), fieldData("wat"), fieldData("sst"), getJson<NonNullable<import("../fields").PointSources["zones"]>>("/nws-zones-lis.json")]);
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
        await A.ensureVar(k, live, stations, addSources);
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
      if (PLOT_PAGE) plotReading();
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
      (await import("../map")).setMapTheme(next);
    } catch {
      /* map not loaded */
    }
  });
}

/** The USGS tidal gauges (usgs-tidal.json): level in ft above MLLW, water quality, our fitted predictions. */


/** A variable's sources, as the adapter loads it, join the notes under About. */
const addSources = (html: string) => $("about-sources").insertAdjacentHTML("beforeend", html);

/** The engine's cells, readouts and figures (waterway/) read the page's view, colours and models through these. */

async function main(): Promise<void> {
  P = PALETTES[currentTheme()];
  const extras = A.startExtras(); // the stations that join after the buoys, loading alongside them
  if (isWater(VK)) A.wantShoreHistory(); // a water view opens with the shore stations' records loading from the start
  // The files the first draw waits for (the view's own, or for Tides the predictions) load alongside the buoys' files.
  A.prefetchVar(VK);
  if (VK === "tides") void loadTides();
  try {
    const { meta, live, stations } = await A.load();
    STATIONS = stations;
    // A station's page: only its views (the first is its default), and the outlook on it.
    if (STATION_ID) {
      const kind = stations.find((d) => d.meta.id === STATION_ID)?.kind ?? (A.SHORE.some((s) => s.id === STATION_ID) ? "shore" : A.METERS.some((m) => m.id === STATION_ID) ? "meter" : "airport");
      const views: VarKey[] = isGauge(STATION_ID) ? ["rivers"] : (CFG.stationPages?.views[kind] ?? []);
      if (!views.includes(VK)) {
        VK = views[0] ?? VK;
        if (!LINK.get("layer")) fieldPick = VIEW_LAYERS[VK].def;
      }
      showViews(views);
      OUTLOOK.pin = STATION_ID;
    }
    const byId = (id: string) => [...stations, ...A.RIVER_SECTIONS, ...(A.TURB_SECTION ? [A.TURB_SECTION] : [])].find((d) => d.meta.id === id)!;
    // A remembered salinity or oxygen choice loads its history first; if that fails, show temperature.
    if (VK !== "temp") await A.ensureVar(VK, live, stations, addSources).catch(() => (VK = "temp"));
    /** The stations on screen: the rivers section in the Rivers view, the buoys and shore stations otherwise. */
    const shown = () => (EMBED ? [...stations, ...A.RIVER_SECTIONS].filter((d) => d.meta.id === EMBED_STATION) : VK === "rivers" ? A.RIVER_SECTIONS : VK === "turbidity" ? (A.TURB_SECTION ? [A.TURB_SECTION] : []) : VK === "tides" ? stations.filter((d) => d.kind === "shore" || d.kind === "meter") : stations.filter((d) => (d.kind !== "airport" || VK === "wind") && d.kind !== "meter")).filter(onStation);
    const drawAll = () => {
      for (const d of shown()) {
        readouts(d);
        (Object.keys(FIGS) as Kind[]).forEach((k) => drawWhenNear(d, k));
      }
      redrawZoom();
      if (PLOT_PAGE) plotReading();
      if (meterPlace()) syncMeterHero();
    };
    /** Station sections for the selected variable (captions and record lines name it), buoys then shore. */
    const renderSections = () => {
      if (isWater(VK)) A.wantShoreHistory(); // the shore stations' water records, for the views that show them
      stations.forEach((d) => A.useVar(d, VK));
      const group = (kind: StationData["kind"], title: string) => {
        const list = stations.filter((d) => d.kind === kind);
        const grouped = stations.some((d) => d.kind === "shore");
        return list.length ? (grouped ? `<h2 class="station-group">${title}</h2>` : "") + list.map(sectionHtml).join("") : "";
      };
      if (STATION_ID && !EMBED) $("stations").innerHTML = shown().map(sectionHtml).join("");
      else $("stations").innerHTML = EMBED
        ? embedHtml([...stations, ...A.RIVER_SECTIONS].find((d) => d.meta.id === EMBED_STATION))
        : VK === "tides"
          ? `<h2 class="station-group">${CFG.groups.shore}</h2>${stations.filter((d) => d.kind === "shore").map(sectionHtml).join("")}` +
            (CFG.groups.meter && stations.some((d) => d.kind === "meter") ? `<h2 class="station-group">${CFG.groups.meter}</h2>${stations.filter((d) => d.kind === "meter").map(sectionHtml).join("")}` : "")
          : VK === "rivers"
          ? `<h2 class="station-group">${CFG.groups.rivers}</h2>${A.RIVER_SECTIONS.map(sectionHtml).join("")}`
          : VK === "turbidity"
            ? `<h2 class="station-group">${CFG.groups.turbidity}</h2>${A.TURB_SECTION ? sectionHtml(A.TURB_SECTION) : ""}`
            : group("buoy", CFG.groups.buoy) + group("shore", CFG.groups.shore) +
              (VK === "wind" ? group("airport", CFG.groups.airport) : "");
      // A plot page's plot sets the page's time on a tap or a drag (chart.ts).
      if (PLOT_PAGE) document.querySelectorAll<HTMLElement>("#stations .plot").forEach((p) => (p.dataset.timePick = "1"));
      watchSections((id) => [...stations, ...A.RIVER_SECTIONS, ...(A.TURB_SECTION ? [A.TURB_SECTION] : [])].find((d) => d.meta.id === id));
      drawAll();
      for (const d of shown()) {
        for (const k of Object.keys(FIGS) as Kind[]) {
          const legend = document.getElementById(`${d.meta.id}-${k}-legend`);
          if (legend) wireLegend(legend, $(`${d.meta.id}-${k}`));
        }
      }
      drawPlaces();
    };
    renderSections();
    STATIONS = stations;
    statusGrid(stations);
    wireStatusTabs(stations);
    // Once the page has drawn: the map's code and its layer, and the forecast, while the other stations load (the map
    // itself waits for them, so every pin is placed once).
    if (!EMBED) void import("../map").catch(() => undefined);
    prefetchField();
    void loadForecast();
    // The stations that join after the buoys, as their files arrive; the map waits for them so every pin is placed once.
    await A.joinExtras(stations, extras, {
      changed: (table) => {
        renderSections();
        if (table) statusGrid(stations);
      },
      sources: addSources,
      usgs: (u) => PARTS.shoreData(u),
      history: () => keepPlace(renderSections),
    });
    markStationPage();
    if (!EMBED) void overviewMap(stations); // an embed draws no map
    else if (PLOT_PAGE) void wireTimeline($("timebar")); // a plot page has no map, but the time bar
    wireWater(live, stations, () => {
      ($("zoom") as HTMLDialogElement).close();
      keepPlace(() => {
        renderSections();
        statusGrid(stations);
      });
      void syncMap();
    });
    // Between stations within the page: all is loaded, so only what shows changes. A station without the view on screen
    // opens on its first one (loaded first, if it has not been).
    goToPlace = async (id, push) => {
      if (id === STATION_ID) return;
      const d = id ? stations.find((s) => s.meta.id === id) : undefined;
      if (id && !d) return;
      const views = d ? (CFG.stationPages?.views[d.kind] ?? []) : null;
      if (views && !views.includes(VK)) {
        const k = views[0];
        try {
          await A.ensureVar(k, live, stations, addSources);
        } catch {
          return; // the view could not load: stay where we are
        }
        VK = k;
        fieldPick = VIEW_LAYERS[VK].def;
      }
      STATION_ID = id;
      if (push) history.pushState(null, "", placeUrl(id));
      OUTLOOK.pin = id ?? CFG.defaults.outlookStation;
      showViews(views);
      markStationPage();
      ($("zoom") as HTMLDialogElement).close();
      renderSections();
      statusGrid(stations);
      syncUrl();
      void syncMap();
      void import("../map").then((m) => m.focusOn(meterPlace() ?? (d ? { lon: d.meta.lon, lat: d.meta.lat } : null), true));
    };
    // A link from before station pages (#EXRX, or ?view=wind#EXRX-wind, on the overview) opens that station's page,
    // keeping a plot's anchor so the page still scrolls to it.
    const old = PAGES && !STATION_ID && !EMBED ? decodeURIComponent(location.hash.slice(1)) : "";
    const oldId = old.split("-")[0];
    if (oldId && hasPage(oldId)) {
      await goToPlace(oldId, false);
      if (STATION_ID === oldId) history.replaceState(null, "", `${placeUrl(oldId)}${old === oldId ? "" : `#${old}`}`);
    }
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
      const view = target.closest<HTMLElement>("[data-plot-view]");
      if (view) {
        document.querySelector<HTMLButtonElement>(`.var-switch [data-var="${view.dataset.plotView}"]`)?.click();
        return;
      }
      const tab = target.closest<HTMLButtonElement>(".tab");
      if (tab) {
        const section = tab.closest<HTMLElement>(".station")!;
        const key = tab.dataset.fig as Kind;
        section.querySelectorAll(`.tab[data-fig="${key}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b === tab)));
        drawInline(byId(section.id), key);
        if (PLOT_PAGE && key === EMBED) {
          PLOT_DEPTH = tab.dataset.depth ?? "";
          plotReading();
          syncUrl(true);
        }
        return;
      }
      const opener = target.closest<HTMLElement>(".expand, .plot");
      if (!opener?.dataset.station || PLOT_PAGE || opener.dataset.fig === "mfan") return; // the plan has no expanded view // a plot page's plot sets the time instead
      // On a phone, a plot with a page of its own opens it (Back returns); elsewhere, the expanded view, which links to it.
      const page = plotPageUrl(opener.dataset.station, opener.dataset.fig!);
      if (page && opener.dataset.full !== "1" && window.matchMedia("(max-width: 560px), (max-height: 500px)").matches) {
        location.assign(page);
        return;
      }
      openZoom(byId(opener.dataset.station), opener.dataset.fig!, opener.dataset.full === "1");
    });
    wireZoom({
      fig: (k) => FIGS[k as Kind],
      name: figName,
      varLabel: () => V().label,
      depth: (d, k) => activeDepth(d, k as Kind),
      depthTabs: depthTabsHtml,
      pageUrl: (d, k) => plotPageUrl(d.meta.id, k),
      afterDraw: (plot, d, k, x0, x1) => {
        if (k === "next48") {
          mountVintage(d, plot, x0, x1);
          mountRevisions(d, plot, x0, x1);
        }
        else if (k === "waves") mountNwpsVintage(d, plot, x0, x1);
        else plot.querySelector(".vintage")?.remove();
      },
    });
    wireAbout({
      station: (d) => ({
        title: d.kind === "rivers" ? "The river gauges" : d.kind === "turbidity" ? "Buoy turbidity sensors" : d.meta.name,
        html: isRiver(d) ? PARTS.gaugeAbout(d) : PARTS.stationAbout(d, { recordLine, isQuiet }),
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
      extend: (key, body, d) => {
        if (key === "comfort") body.querySelector(".about-list")?.insertAdjacentHTML("afterend", comfortTableHtml(BOAT, WU === "ms"));
        // The plot's own note (what its shading or a colour means, years left out), from its last drawing.
        const note = d ? PLOT_NOTES.get(`${d.meta.id}-${key}`) : undefined;
        if (note) body.insertAdjacentHTML("afterbegin", `<p class="about-plot-note">${note}</p>`);
      },
    });
    window.setTimeout(() => revealLinked(), 300); // after the sections draw
    wireLinks(linkUrl, statusRowAnchor);
    // Back and Forward between the page's own entries (a jump from the wind strip, a station link): the browser
    // restores the scroll; the time comes back from the address.
    window.addEventListener("popstate", () => {
      if (PAGES && goToPlace) void goToPlace(placeFromPath(), false);
      const m = /^([+-]?\d+)([hd])$/.exec((new URLSearchParams(location.search).get("t") ?? "").replace(/^ /, "+"));
      timelineModule?.setOffset(m ? Number(m[1]) * (m[2] === "d" ? 24 : 1) : 0);
    });
    updatedStrip(meta, live, CFG.outage);
    about(meta);
    wireCollect(meta, live, stations, {
      template: PARTS.promptTemplate,
      variable: () => (isWater(VK) ? V().label.toLowerCase() : "the reading"),
      isFig: (k) => k in FIGS,
      layer: () => fieldPick,
      layerLabel: () => FIELD_CHOICES.find((c) => c.kind === fieldPick)?.label ?? fieldPick,
      link: linkUrl,
      ...CFG.collect,
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
    wireLocate(CFG.called);
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

/* ---------- Station pages ---------- */

/** A station has a page where its kind has views there. */
const hasPage = (id: string) => {
  const d = STATIONS.find((s) => s.meta.id === id);
  return !!d && !!CFG.stationPages?.views[d.kind]?.length;
};

/** A station's page (or the overview, for null), keeping the page's time and view. */
const placeUrl = (id: string | null) => `${PAGES!.base}${id ? `${id.toLowerCase()}/` : ""}${location.search}`;
/** A station's plot page (/<waterway>/<station>/<plot>/), keeping the page's time, view and units; not the map's layer,
 * which a plot page does not draw. */
const plotUrl = (id: string, slug: string, depth = "") => {
  const q = new URLSearchParams(location.search);
  q.delete("layer");
  q.delete("ov");
  if (depth) q.set("depth", depth.toLowerCase());
  else q.delete("depth");
  const s = q.toString();
  return `${PAGES!.base}${id.toLowerCase()}/${slug}/${s ? `?${s}` : ""}`;
};
/** A figure's own page at a station, where both have one, at the depth its tabs show (if not the first). */
const plotPageUrl = (id: string, fig: string): string | null => {
  const slug = plotSlug(fig);
  const d = STATIONS.find((s) => s.meta.id === id);
  const depth = d && FIGS[fig as Kind]?.depthTabs ? activeDepth(d, fig as Kind) : "";
  return slug && PAGES && (hasPage(id) || isGauge(id)) ? plotUrl(id, slug, d && depth !== d.depths[0] ? depth : "") : null;
};

/** A plot page: the top bar names the plot beside the place; a tap or drag on the plot moves the page's time; the
 * run slider's choice goes into the address. The reading follows each. */
function wirePlotPage(): void {
  document.getElementById("place-panel")?.insertAdjacentHTML("afterend", `<span class="plot-name">${escHtml(PLOT?.name ?? "")}</span>`);
  // The way back: to the overview when the reader came from it, else to the station's page (a gauge's plots are in the
  // overview's Rivers view), at the page's time and view when followed.
  const fromOverview = (() => {
    try {
      const r = new URL(document.referrer);
      return r.origin === location.origin && r.pathname === PAGES?.base;
    } catch {
      return false;
    }
  })();
  const gauge = !!STATION_ID && isGauge(STATION_ID);
  const back = document.createElement("a");
  back.className = "plot-back";
  back.textContent = "\u2039";
  const name = () =>
    fromOverview || gauge ? "the overview" : (STATIONS.find((s) => s.meta.id === STATION_ID)?.meta.name ?? "the station's page");
  const backUrl = () => {
    back.title = `Back to ${name()}`;
    back.setAttribute("aria-label", back.title);
    if (!gauge) return placeUrl(fromOverview ? null : STATION_ID);
    const q = new URLSearchParams(location.search);
    q.set("view", "rivers");
    q.delete("depth");
    return `${PAGES?.base ?? ""}?${q}#${STATION_ID}`;
  };
  back.href = backUrl();
  for (const type of ["click", "pointerenter", "focus"]) back.addEventListener(type, () => (back.href = backUrl()), true);
  document.getElementById("place-pick")?.before(back);
  const pick = (t: number) => timelineModule?.setOffset(Math.round(t / HOUR - Math.round(Date.now() / 1000 / HOUR)));
  document.addEventListener("timepick", (e) => pick((e as CustomEvent<number>).detail));
  // The tide ladder is drawn apart from the charts: a tap or drag on it sets the time the same way.
  const ladder = (e: PointerEvent) => {
    const svg = (e.target as Element).closest<SVGSVGElement>('.plot[data-fig="hilo"] svg');
    if (!svg || !PLOT_DRAWN || (e.type === "pointermove" && !e.buttons && e.pointerType === "mouse")) return;
    const box = svg.getBoundingClientRect();
    pick(PLOT_DRAWN.x0 + ((e.clientX - box.left) / Math.max(1, box.width)) * (PLOT_DRAWN.x1 - PLOT_DRAWN.x0));
  };
  document.addEventListener("pointerdown", ladder);
  document.addEventListener("pointermove", ladder);
  document.addEventListener("input", (e) => {
    if (!(e.target as HTMLElement).closest(".vg-range")) return;
    plotReading();
    syncUrl(true);
  });
}

/** A plot page's reading at the page's time (which the time bar states, with its weekday): slots of equal, fixed width
 * on one line, each always there ("--" where there is no value), so none moves as the time does; the full statement
 * of each is its hover text. */
function plotReading(): void {
  const el = document.getElementById("plot-reading");
  const d = [...STATIONS, ...A.RIVER_SECTIONS].find((s) => s.meta.id === EMBED_STATION);
  if (!el || !d || !EMBED) return;
  const slots = EMBED === "next48" || EMBED === "wind" ? windReading(d) : EMBED === "hilo" ? hiloReading(d) : lineReading(d, EMBED);
  el.style.setProperty("--pr-n", String(Math.max(2, slots.length)));
  el.innerHTML = slots.join("");
}

/** A reading slot: its key in small capitals, the value, and the full statement as hover text. On a phone "Measured"
 * reads "Obs". */
const prSlot = (key: string, body: string, title: string) =>
  `<span class="pr-slot" title="${escHtml(title)}"><span class="pr-k">${key === "Measured" ? '<span class="wide-only">Measured</span><span class="narrow-only">Obs</span>' : key}</span> ${body}</span>`;
const PR_NONE = `<span class="pr-none">--</span>`;
/** A value's number and its unit ("1028.4", " mb"; a salinity "27.20" has none); text that does not start with a
 * number is all number. */
const splitUnit = (s: string): [string, string] => {
  const m = /^([+\-\u2212]?[\d.,]*\d)(\D.*)?$/.exec(s);
  return m ? [m[1], m[2] ?? ""] : [s, ""];
};
/** A value with its number held at a width of `w` characters (the line is monospaced), right-aligned, so what follows
 * it in the slot stays put as its digits change; the unit after it, left out on a phone (the axis has it). */
const prVal = (text: string, w: number, split = true) => {
  const [num, u] = split ? splitUnit(text) : [text, ""];
  return `<b style="--w:${w}">${num}</b>${u ? `<span class="pr-u wide-only">${u}</span>` : ""}`;
};
/** A length to one decimal, with a true minus sign (and none on a zero); its number at most "\u221210.2". */
const ft1 = (v: number) => `${(Math.abs(v) < 0.05 ? 0 : v).toFixed(1).replace(/^-/, "\u2212")} ft`;
const FT1_W = 5;

/** What a plot page reads from its plot's own lines: per slot, the lines that can fill it, in order (a label's start);
 * the first with a value at the time fills it, marked with its source when that is a model. */
const READING: Partial<Record<Kind, (b: Built) => [string, string[]][]>> = {
  pressure: () => [["Pressure", ["Pressure"]], ["3 h", ["Change over 3 h", HRRR_HIST_LABEL, "HRRR forecast"]]],
  waves: () => [["Height", ["Significant height", "NWS wave model"]], ["Highest", ["Highest wave"]], ["Period", ["Dominant period"]]],
  air: (b) => [["Air", ["Air"]], ...(b.legend[0][0] !== "Air" ? [["Water", [b.legend[0][0]]] as [string, string[]]] : [])],
  dep: () => [["Departure", ["Observed minus predicted"]]],
  // The water column: each depth's hourly reading, else its 36-hour mean ("Mid-depth" keyed "Mid").
  col: (b) => b.legend.map(([l]) => [l.split("-")[0], [`${l} hourly`, `${l} 36h`]] as [string, string[]]),
  sb: () => [["Hourly", ["hourly"]], ["36 h mean", ["36h mean"]]],
};

/** The plot's point for the page's time: its index on the plot's grid (or -1 outside it), and how many points back a
 * value may stand for it. On a water or river plot page, whose lines end with the last reading (an hour or more before
 * now), a value up to 12 hours before the time stands for it (3 days for a river's daily means, which come a day or two
 * behind), its hover naming its time. */
function readAt(xs: number[], t: number, hours = 12): { i: number; back: number } {
  const step = xs.length > 1 ? xs[1] - xs[0] : HOUR;
  const i = Math.round((t - xs[0]) / step);
  const inside = i >= 0 && i < xs.length && Math.abs(xs[i] - t) <= step / 2;
  return { i: inside ? i : -1, back: waterPlotPage() ? Math.ceil((hours * HOUR) / step) : 0 };
}
/** A line's value at index i, or the latest within `back` points before it: its index, or -1. */
const lastAt = (ys: number[], i: number, back: number): number => {
  for (let j = i; j >= 0 && j >= i - back; j--) if (Number.isFinite(ys[j])) return j;
  return -1;
};
const fmtAtHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric" });

function lineReading(d: StationData, key: Kind): string[] {
  const drawn = PLOT_DRAWN;
  if (!drawn) return [];
  if (key === "yoy" || key === "chg" || key === "ryoy") return yearReading(key);
  if (key === "flow" || key === "rpct") return flowReading(d);
  const { xs, lines, unit = "", hoverDigits = 1 } = drawn.b.opts;
  const t = AT ?? Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const { i, back } = readAt(xs, t);
  const spec = READING[key]?.(drawn.b) ?? drawn.b.legend.filter(([l]) => l).map(([l, , , shown]) => [shown ?? l, [l]] as [string, string[]]);
  const fmt = (l: (typeof lines)[number], v: number) => (l.fmt ? l.fmt(v) : `${v.toFixed(hoverDigits).replace(/^-/, "\u2212")}${unit}`);
  const slots = spec.map(([k, starts]) => {
    const can = lines.filter((l) => starts.some((s) => l.label.startsWith(s)));
    // The slot's width: the longest number any of its lines takes in the plot's window.
    let w = 2;
    for (const l of can) for (const v of l.ys) if (Number.isFinite(v)) w = Math.max(w, splitUnit(fmt(l, v))[0].length);
    const line = i < 0 ? undefined : can.find((l) => lastAt(l.ys, i, back) >= 0);
    if (!line) return prSlot(k, PR_NONE, `${k}: no value at this hour`);
    const j = lastAt(line.ys, i, back);
    const text = fmt(line, line.ys[j]);
    const model = /HRRR|NWPS|model/.test(line.label) ? `<small class="pr-src">${/NWPS|wave model/.test(line.label) ? "NWPS" : "HRRR"}</small>` : "";
    return prSlot(k, `${prVal(text, w)}${model}`, `${line.label}: ${text}${j < i ? `, at ${fmtAtHour.format(new Date(xs[j] * 1000))}` : ""}`);
  });
  // The departure page also states the water's level at the hour.
  if (key === "dep") {
    const lv = d.level?.at(t) ?? NaN;
    slots.unshift(prSlot("Level", Number.isFinite(lv) ? prVal(ft1(lv), FT1_W) : PR_NONE, Number.isFinite(lv) ? `Measured water level: ${ft1(lv)} above MLLW` : "No level reading at this hour"));
  }
  return slots;
}

/** A river's flow and percentile pages: the flow at the time, the median for the date, and where the flow stands among
 * the record's flows for the date (its percentile), read from the gauge's records on the plot's own grid. */
function flowReading(d: StationData): string[] {
  const { xs } = PLOT_DRAWN!.b.opts;
  const t = AT ?? Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const { i, back } = readAt(xs, t);
  const r = d.river!;
  const id = d.gauge!.id;
  const flows = xs.map((x) => riverFlow(r, id, x));
  const medians = xs.map((x) => pct(r, id, "p50", x));
  const w = Math.max(2, cfs(Math.max(...[...flows, ...medians].filter(Number.isFinite))).length); // the highest is widest
  const j = i >= 0 ? lastAt(flows, i, back) : -1;
  const q = j >= 0 ? flows[j] : NaN;
  const m = i >= 0 ? medians[i] : NaN;
  const p = Number.isFinite(q) ? percentileOf(r, id, xs[j], q) : NaN;
  const pText = (v: number) => (v <= 2.5 ? "<5th" : v >= 97.5 ? ">95th" : ordinal(v));
  return [
    Number.isFinite(q) ? prSlot("Flow", prVal(`${cfs(q)} cfs`, w), `${d.gauge!.river} flow: ${cfs(q)} cfs${j < i ? `, at ${fmtAtHour.format(new Date(xs[j] * 1000))}` : ""}`) : prSlot("Flow", PR_NONE, "No flow reading at this time"),
    Number.isFinite(m) ? prSlot("Median", prVal(`${cfs(m)} cfs`, w), `Median flow for the date: ${cfs(m)} cfs`) : prSlot("Median", PR_NONE, "No median for this date"),
    Number.isFinite(p) ? prSlot("Pctile", prVal(escHtml(pText(p)), 5, false), `The flow is at the ${pText(p)} percentile of the record's flows for the date`) : prSlot("Pctile", PR_NONE, "No percentile at this time"),
  ];
}

/** The year pages (this year, 7-day change, a river's this year): this year's value at the time, the mean of the
 * earlier years drawn on the same date, and (this year) how far the one is from the other; for a river's runoff, the
 * earlier years' median and this year's rank among them. */
function yearReading(key: "yoy" | "chg" | "ryoy"): string[] {
  const { xs, lines, unit = "", hoverDigits = 1 } = PLOT_DRAWN!.b.opts;
  const t = AT ?? Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const { i, back } = readAt(xs, t, key === "ryoy" ? 72 : 12);
  const year = Math.max(...lines.map((l) => Number(l.label)).filter(Number.isFinite));
  const cur = lines.find((l) => Number(l.label) === year);
  const earlier = lines.filter((l) => l !== cur && Number.isFinite(Number(l.label))); // the years, not a median line
  // Grouped thousands for a river's flow ("12,400 cfs").
  const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: hoverDigits, maximumFractionDigits: hoverDigits });
  const num = (v: number, sign = false) => `${sign && v > 0 ? "+" : ""}${nf.format(Math.abs(v) < 0.5 * 10 ** -hoverDigits ? 0 : v).replace(/^-/, "\u2212")}${unit}`;
  // Each value's width: the widest it takes in the plot's window, its lowest or highest (this year's line, and the
  // earlier years' mean on each date; a difference can take a sign more).
  const width = (ys: number[]) => {
    let [lo, hi] = [Infinity, -Infinity];
    for (const v of ys) if (Number.isFinite(v)) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    return Math.max(2, ...[lo, hi].filter(Number.isFinite).map((v) => splitUnit(num(v, key === "chg"))[0].length));
  };
  const meanAt = (k: number) => {
    const vs = earlier.map((l) => l.ys[k]).filter(Number.isFinite);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN;
  };
  const w = width(cur?.ys ?? []);
  const wMean = width(xs.map((_, k) => meanAt(k)));
  const j = cur && i >= 0 ? lastAt(cur.ys, i, back) : -1;
  const now = j >= 0 ? cur!.ys[j] : NaN;
  const at = j >= 0 ? j : i; // the earlier years on the same date as this year's reading
  const others = at >= 0 ? earlier.map((l) => l.ys[at]).filter(Number.isFinite) : [];
  const mean = others.length ? others.reduce((a, b) => a + b, 0) / others.length : NaN;
  const what = key === "ryoy" ? "runoff to this date" : key === "yoy" ? V().label.toLowerCase() : `7-day change in ${V().label.toLowerCase()}`;
  const first = prSlot(String(year), Number.isFinite(now) ? prVal(num(now, key === "chg"), w) : PR_NONE, Number.isFinite(now) ? `${year}, ${what}: ${num(now, key === "chg")}${j < i ? `, at ${fmtAtHour.format(new Date(xs[j] * 1000))}` : ""}` : `${year}: no value on this date`);
  // A river's runoff: the earlier years' median (the dashed line) and this year's place among them, lowest first.
  if (key === "ryoy") {
    const sorted = [...others].sort((a, b) => a - b);
    const med = sorted.length >= 3 ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : NaN;
    const rank = 1 + others.filter((v) => v < now).length;
    const n = others.length + 1;
    return [
      first,
      prSlot("Median", Number.isFinite(med) ? prVal(num(med), wMean) : PR_NONE, Number.isFinite(med) ? `Median of ${others.length} earlier years to this date: ${num(med)}` : "Too few earlier years for a median"),
      prSlot("Rank", Number.isFinite(now) && others.length ? prVal(`${rank}/${n}`, 5, false) : PR_NONE, Number.isFinite(now) && others.length ? `${year} is the ${ordinal(rank)} lowest of ${n} years to this date (1: the driest)` : "No ranking on this date"),
    ];
  }
  const slots = [
    first,
    Number.isFinite(mean)
      ? prSlot("Earlier", prVal(num(mean, key === "chg"), wMean), `Mean of ${others.length} earlier years on this date: ${num(mean, key === "chg")} (${num(Math.min(...others))} to ${num(Math.max(...others))})`)
      : prSlot("Earlier", PR_NONE, "No earlier year on this date"),
  ];
  if (key === "yoy") {
    const diff = now - mean;
    slots.push(Number.isFinite(diff) ? prSlot("Diff", prVal(num(diff, true), Math.max(w, wMean) + 1), `${year} against the earlier years' mean: ${num(diff, true)}`) : prSlot("Diff", PR_NONE, "No comparison on this date"));
  }
  return slots;
}

/** The highs and lows page: the predicted tide before the time and the one after, each with what the water did. */
function hiloReading(d: StationData): string[] {
  const t = AT ?? Date.now() / 1000;
  const { before, after } = hiloAround(d, t);
  const one = (key: string, e: typeof before) => {
    if (!e) return prSlot(key, PR_NONE, `${key}: no prediction`);
    const kind = e.type === "H" ? "High" : "Low";
    const when = fmtWhenMin.format(new Date(e.t * 1000));
    const obs = Number.isFinite(e.o) ? `, observed ${ft1(e.o)}` : "";
    return prSlot(key, `${e.type} ${prVal(ft1(e.ft), FT1_W)} <small class="pr-t">${fmtClock.format(new Date(e.t * 1000)).replace(/ ([AP])M$/, (_m, p: string) => p.toLowerCase())}</small>`, `${kind} ${when}: predicted ${ft1(e.ft)}${obs}`);
  };
  return [one("Before", before), one("After", after)];
}

/** The wind pages' reading: what was measured and what HRRR said, wind, gust and direction, in the reader's unit;
 * HRRR from the run the reader fixed, else the newest run that reaches the hour. */
function windReading(d: StationData): string[] {
  const u = WIND_UNITS[WU].label;
  // As a mariner says it: the direction, then the wind to its gusts ("NE 6–10"); the unit is the axis's and the
  // menu's, and in full in the hover text.
  type W = [number | null | undefined, number | null | undefined, number | null | undefined];
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  // The direction and the speeds each held at their widest ("NNE", "11–17"), so nothing in the slot moves.
  const wind = ([dir, spd, gust]: W) =>
    `<span class="pr-dir">${ok(dir) ? `${windArrow(dir)}${compass(dir)}` : ""}</span> ${prVal(`${windFmt(spd ?? NaN)}${ok(gust) && windFmt(gust) !== windFmt(spd ?? NaN) ? `&ndash;${windFmt(gust)}` : ""}`, 5, false)}`;
  const words = ([dir, spd, gust]: W) =>
    `${ok(dir) ? `from ${compass(dir)}, ` : ""}${windFmt(spd ?? NaN)} ${u}${ok(gust) ? `, gusts ${windFmt(gust)} ${u}` : ""}`;
  const slot = prSlot, none = PR_NONE;
  const m = d.met;
  const nowH = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  // Measured: the latest reading at now (with its age), the hour's reading at a past time, nothing ahead.
  const last: W | null = AT == null && m?.last?.wind_kt != null ? [m.last.dir_deg, m.last.wind_kt, m.last.gust_kt] : null;
  const atHour: W | null = AT != null && Number.isFinite(m?.wind?.at(AT) ?? NaN) ? [m!.dir?.at(AT), m!.wind!.at(AT), m!.gust?.at(AT)] : null;
  const measured = last
    ? slot("Measured", `${wind(last)} <small class="pr-t">${ago(m!.last!.time).replace(" ago", "")}</small>`, `Measured ${ago(m!.last!.time)}: ${words(last)}`)
    : atHour
      ? slot("Measured", wind(atHour), `Measured at this hour: ${words(atHour)}`)
      : slot("Measured", none, (AT ?? nowH) > nowH ? "Ahead of now: not yet measured" : "No reading at this hour");
  const t = AT ?? nowH;
  const run = chosenRun(d.meta.id);
  const fixed = run != null ? runForecastAt(d.meta.id, run, t) : null;
  const f = fixed ?? forecastAt(d.meta.id, t);
  // The fixed run may end before the hour (most runs reach 18 h): then the newest run that reaches it, marked "*".
  const short = run != null && !fixed && f;
  const runName = (issue: number) => fmtRun.format(new Date(issue * 1000));
  const forecast = f
    ? slot("HRRR", `${wind([f.dir, f.spd, f.gust])} <small class="pr-t">${runName(f.issue).replace(/^\w+, /, "")}${short ? "*" : ""}</small>`,
        `HRRR, the ${runName(f.issue)} run: ${words([f.dir, f.spd, f.gust])}${short ? `; the ${runName(run!)} run you fixed ends before this hour` : ""}`)
    : slot("HRRR", none, "No HRRR run reaches this hour");
  return [measured, forecast];
}

/** The places row: Overview, the stations shown as their own links, and a menu of the rest, in groups; the current one
 * marked. Drawn as stations join. */
function drawPlaces(): void {
  const box = document.getElementById("places");
  const sp = CFG.stationPages;
  if (!box || !PAGES || !sp) return;
  const here = (id: string | null) => (id === STATION_ID ? ' aria-current="page"' : "");
  const link = (id: string | null, label: string) => `<a class="tab place" href="${placeUrl(id)}" data-place="${id ?? ""}"${here(id)}>${escHtml(label)}</a>`;
  const withPage = STATIONS.filter((d) => sp.views[d.kind]?.length);
  const groups = sp.menu
    .map((g) => ({ title: g.title, list: withPage.filter((d) => g.kinds.includes(d.kind)) }))
    .filter((g) => g.list.length);
  const current = groups.flatMap((g) => g.list).find((d) => d.meta.id === STATION_ID);
  const menu = groups.length
    ? `<details class="place-menu"><summary class="tab${current ? " current" : ""}">${escHtml(current?.meta.name ?? "Stations")}</summary><div class="place-pop">${groups
        .map((g) => `<p class="place-group">${escHtml(g.title)}</p>${g.list.map((d) => `<a href="${placeUrl(d.meta.id)}" data-place="${d.meta.id}"${here(d.meta.id)}>${escHtml(d.meta.name)}</a>`).join("")}`)
        .join("")}</div></details>`
    : "";
  box.innerHTML = link(null, "Overview") + withPage.filter((d) => sp.chips.includes(d.kind)).map((d) => link(d.meta.id, d.meta.name)).join("") + menu;
  // The top bar's picker: the place in words, and the same places as one list under it.
  const pick = document.getElementById("place-pick");
  const panel = document.getElementById("place-panel");
  if (!pick || !panel) return;
  pick.hidden = false;
  pick.querySelector(".vm-current")!.textContent = STATION_ID ? ([...STATIONS, ...A.RIVER_SECTIONS].find((d) => d.meta.id === STATION_ID)?.meta.name ?? STATION_ID) : "Overview";
  const item = (id: string | null, label: string) => `<a href="${placeUrl(id)}" data-place="${id ?? ""}"${here(id)}>${escHtml(label)}</a>`;
  const chips = withPage.filter((d) => sp.chips.includes(d.kind));
  panel.innerHTML =
    item(null, "Overview") +
    (chips.length ? `<p class="place-group">Buoys</p>${chips.map((d) => item(d.meta.id, d.meta.name)).join("")}` : "") +
    groups.map((g) => `<p class="place-group">${escHtml(g.title)}</p>${g.list.map((d) => item(d.meta.id, d.meta.name)).join("")}`).join("");
}

/** Where the place and the view are chosen: the band under the masthead on a wide screen; once it has scrolled away,
 * and always on a phone, the top bar's two pickers ("Execution Rocks ⌄ · Wind & waves ⌄"). */
function wireCompact(): void {
  const band = document.querySelector<HTMLElement>(".pick-band");
  const bar = document.querySelector<HTMLElement>(".topbar");
  const phone = window.matchMedia("(max-width: 560px)");
  let queued = false;
  const check = () => {
    queued = false;
    const away = !!band && (band.offsetParent === null || band.getBoundingClientRect().bottom <= (bar?.offsetHeight ?? 0)); // hidden (a plot page) or scrolled past
    document.documentElement.classList.toggle("sel-compact", phone.matches || away);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  phone.addEventListener("change", queue);
  check();
}

/** On a phone the masthead is one line (the waterway and "Not for navigation"); its (i) opens the rest: the byline,
 * the data notice and the boat, and the caveat in full. */
function wireMast(): void {
  const mast = document.querySelector<HTMLElement>(".mast");
  const btn = mast?.querySelector<HTMLButtonElement>(".mast-more");
  btn?.addEventListener("click", () => btn.setAttribute("aria-expanded", String(mast!.classList.toggle("open"))));
}

/** Place links carry the page's time and view at the moment they are followed; the menu closes on a click outside it
 * or Escape; a station's name in the table opens its page. */
function wirePlaces(): void {
  const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  const pick = document.getElementById("place-pick");
  const panel = document.getElementById("place-panel");
  const setPanel = pick && panel ? dropDown(pick, panel) : null;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLAnchorElement>("a[data-place]");
    const menu = document.querySelector<HTMLDetailsElement>(".place-menu");
    if (menu?.open && (!menu.contains(t) || a)) menu.open = false;
    if (a && panel?.contains(a)) setPanel?.(false);
    if (!a) return;
    if (PLOT_PAGE) {
      // A plot page: the same plot at the place picked, where it has one, else the place's own page (the overview has
      // no plot pages), loaded in full.
      const to = a.dataset.place || null;
      const d = to ? STATIONS.find((s) => s.meta.id === to) : undefined;
      a.href = (d && EMBED && shows(d, EMBED) && plotPageUrl(d.meta.id, EMBED)) || placeUrl(to);
      return;
    }
    a.href = placeUrl(a.dataset.place || null);
    if (plain(e) && goToPlace) {
      e.preventDefault();
      void goToPlace(a.dataset.place || null, true);
    }
  }, true);
  document.addEventListener("keydown", (e) => {
    const menu = document.querySelector<HTMLDetailsElement>(".place-menu");
    if (e.key === "Escape" && menu?.open) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
  document.getElementById("status")?.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('th a[href^="#"]');
    const id = a?.getAttribute("href")?.slice(1);
    if (!a || !id || id === STATION_ID || !hasPage(id)) return;
    e.preventDefault();
    e.stopPropagation();
    if (plain(e) && goToPlace) void goToPlace(id, true);
    else if (plain(e)) location.assign(placeUrl(id));
    else window.open(placeUrl(id), "_blank");
  }, true);
}

/** A station's page names it: the waterway above, the station in the wordmark and the title, and its own address as
 * the canonical one. An unknown station goes back to the overview. */
function markStationPage(): void {
  const top = document.querySelector(".wm-top");
  const bottom = document.querySelector(".wm-bottom");
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  MAST ??= { top: top?.textContent ?? "", bottom: bottom?.textContent ?? "", title: document.title, canonical: canonical?.href ?? "" };
  document.body.classList.toggle("on-station", !!STATION_ID); // a phone's masthead keeps the waterway's line only
  if (!STATION_ID) {
    if (top) top.textContent = MAST.top;
    if (bottom) bottom.textContent = MAST.bottom;
    document.title = MAST.title;
    if (canonical) canonical.href = MAST.canonical;
    return;
  }
  // A gauge has plot pages only, which keep the waterway's canonical address.
  const gauge = PLOT_PAGE && isGauge(STATION_ID);
  const d = [...STATIONS, ...(gauge ? A.RIVER_SECTIONS : [])].find((s) => s.meta.id === STATION_ID);
  if (!d || !(hasPage(d.meta.id) || gauge)) {
    location.replace(placeUrl(null));
    return;
  }
  if (top) top.textContent = CFG.name.toUpperCase();
  if (bottom) bottom.textContent = d.meta.name.toUpperCase();
  document.title = `${PLOT_PAGE && EMBED ? `${d.meta.name}, ${FIGS[EMBED].title.toLowerCase()}` : d.meta.name} | ${CFG.name} (alpha) | longhorizon.blue`;
  // A plot page's canonical address is its station's page (one page per station for search engines).
  if (canonical && MAST.canonical && !gauge) canonical.href = new URL(`${d.meta.id.toLowerCase()}/`, MAST.canonical).href;
}

/** The station an address is for (null on the overview). */
function placeFromPath(): string | null {
  return PAGES && location.pathname.startsWith(PAGES.base) ? location.pathname.slice(PAGES.base.length).split("/")[0].toUpperCase() || null : null;
}

/** The view buttons a page offers: a station's own (null: all of them), the one on screen marked. */
function showViews(views: VarKey[] | null): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".var-switch [data-var]");
  buttons.forEach((b) => {
    b.hidden = !!views && !views.includes(b.dataset.var as VarKey);
    b.setAttribute("aria-pressed", String(b.dataset.var === VK));
  });
  const current = document.querySelector(".view-menu .vm-current");
  if (current) current.textContent = [...buttons].find((b) => b.dataset.var === VK)?.textContent ?? "";
}

/** On a station's page, our photo of it (where we have one) under its row in the table, with when it was taken and the
 * credit. */
function stationPhoto(): string {
  const d = STATION_ID ? STATIONS.find((s) => s.meta.id === STATION_ID) : undefined;
  const ph = d && CFG.photos?.[d.meta.id];
  if (d?.kind === "buoy" && !ph) {
    // An ask for one: a message to the waterway's address, with what the credit needs.
    const mail = `mailto:${CFG.collect.mailTo}?subject=${encodeURIComponent(`Photo: ${d.meta.name}`)}&body=${encodeURIComponent(`A photo of the ${d.meta.name} buoy, attached.

Taken (month and year): 
Credit as: 
`)}`;
    return `<figure class="station-photo none"><div class="photo-none"><span>No photo of this buoy yet</span><a href="${escHtml(mail)}">Send us a photo</a></div></figure>`;
  }
  if (!ph || !d) return "";
  return `<figure class="station-photo"><img src="${ph.src}" alt="${escHtml(ph.alt)}" decoding="async"><figcaption>${escHtml(d.meta.name)}, ${escHtml(ph.when)}. Photo: Long Horizon Observatory.</figcaption></figure>`;
}

/** What a waterway brings to the page besides its config: its data adapter, the prompt template, each station's About,
 * the shore table under the overview (if it has one), and a diagram for the tides view (if it has one). */
export interface PageParts {
  adapter: Adapter;
  promptTemplate: string;
  stationAbout(d: StationData, page: { recordLine(d: StationData, perDepth: string): string; isQuiet(d: StationData): boolean }): string;
  gaugeAbout(d: StationData): string;
  shoreTable(): string;
  shoreData(u: unknown): void;
  diagram?: { configure(host: { stations(): StationData[]; redrawTable(): void }): void; sync(): void };
}

/** Mount the page for a waterway: its config and its parts, then the page as it loads. */
export function mountWaterwayPage(config: StationDataWaterway, parts: PageParts, opts: { stationPages?: { base: string } } = {}): void {
  CFG = config;
  PARTS = parts;
  A = parts.adapter;
  PAGES = opts.stationPages ?? null;
  STATION_ID = placeFromPath();
  if (PAGES) wirePlaces();
  wireMast();
  DATA = CFG.data;
  // A plot page's address names its plot after the station (/long-island-sound/exrx/next-48h/).
  const slug = PAGES && STATION_ID ? location.pathname.slice(PAGES.base.length).split("/")[1]?.toLowerCase() : "";
  PLOT = slug ? PLOT_PAGES[slug] ?? null : null;
  PLOT_DEPTH = (LINK.get("depth") ?? "").toUpperCase();
  // A river gauge's plot page (/long-island-sound/conn/flow/): the gauge's figure, in the Rivers view.
  const gauge = !!PLOT && isGauge(STATION_ID);
  let fig: string | null;
  ({ fig, station: EMBED_STATION, page: PLOT_PAGE } = embedMode(LINK, CFG.defaults.embedStation, PLOT && STATION_ID ? { fig: (gauge && PLOT.river) || PLOT.fig, station: STATION_ID } : null));
  EMBED = fig as Kind | null;
  // The plot's view: the link's, if the plot is drawn in it, else its first (an embed by name: next48 in Wind, yoy in
  // Temperature).
  const linked = LINK.get("view") ?? "";
  if (gauge) VK = "rivers";
  else if (PLOT) VK = (PLOT.views.includes(linked) ? linked : PLOT.views[0]) as VarKey;
  else if (EMBED) VK = EMBED === "next48" ? "wind" : "temp";
  // A linked run ("run=2026102811", its UTC hour) stays the plot's run as the time moves.
  const runLink = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(LINK.get("run") ?? "");
  if (runLink && EMBED_STATION) chooseRun(EMBED_STATION, Date.UTC(+runLink[1], +runLink[2] - 1, +runLink[3], +runLink[4]) / 1000);
  if (PLOT_PAGE) wirePlotPage();
  wireCompact(); // after the plot page is known: it has no band, so its top bar shows the picker from the start
  OXYGEN_NOTE = `shading: under ${DO_LEVELS.anoxic} mg/L anoxic, under ${DO_LEVELS.hypoxic} hypoxic (${CFG.oxygenAuthority}), under ${DO_LEVELS.growth} below EPA's growth criterion`;
  fieldPick = (["sst", "chl", "kd490", "currents", "wind", "waves", "comfort"] as const).find((k) => k === LINK.get("layer")) ?? VIEW_LAYERS[VK].def;
  configureData({ data: DATA, forecastPage: CFG.forecastPage });
  OUTLOOK.pin = CFG.defaults.outlookStation;
  PARTS.diagram?.configure({ stations: () => STATIONS, redrawTable: () => statusGrid(STATIONS) });
  configureModels({
    view: () => VK,
    palette: () => P,
    waveSensor: A.wavesOf,
    wavePanel: (id) => A.panelsOf(id).waves,
    wavesText: A.wavesText,
    lastWave: A.lastWave,
    wavesPublished: (id) => !!A.WAVE_LIVE[id]?.published,
  });
  wireSuggest();
  wireHints();
  void main();
}
