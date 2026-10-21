/** Long Island Sound page: overview (map and status grid), readouts and views per station, a zoom view,
 * and the bring-your-own-AI prompt. */
import "./site.css";
import "./away-links";

import promptTemplate from "../../../configs/prompts/visitor_prompt.txt?raw";
import registry from "../../../stations/stations.json";
import shoreRegistry from "../../../stations/shore.json";
import asosRegistry from "../../../stations/asos.json";
import { emphasise, highlight, renderLines, YELLOW, type ChartOptions, type Line } from "./chart";
import { wireHints } from "./hints";
import { BUOY_SENSORS, METHODS, methodHtml, REF_LABELS } from "./methods";
import { BOATS, boatIcon, boatLabel, boatPickerHtml, comfortTableHtml } from "./comfort-thresholds";
import { mountCollect } from "./collect";
import { percentileText, SEASONS, seasonalPercentile, smoothByAge, trend, trendText, TRENDS, veerText } from "./trends";
import type { Pin } from "./map";
import type { FieldData, FieldKind, RasterHistory } from "./fields";
import { wireSuggest } from "./suggest";
import {
  COVERAGE_MIN, DAY, DO_LEVELS, HOUR, Hourly, STRAT, dF, fToC, getJson, grid, oxygenStatus, stratStatus, yearLines,
  type Encoded, type History, type LastObs, type Live, type Meta, type MetaSeries, type MetaStation, type MetObs, type MetWindow,
  type ShoreFrame, type ShoreHistory, type ShoreLive, type ShoreMetaStation, type TideEvent, type VarHistory, type WaveFrame,
  type WaveHistory, type MetHistory, type WaveLive, type WaveObs, type YearLine, Daily, type RiverHistory, type RiverLive, type TurbHistory, type TurbFrame,
} from "./series";
import { alertsNow, mountAdvisories, WIND_STRIP_HASH } from "./advisory";

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
const DEPTHS = ["SFC", "MID", "BTM"] as const;
const DEPTH_LABEL: Record<string, string> = { SFC: "Surface", MID: "Mid", BTM: "Bottom" };
const DELAYED_HOURS = 3; // older than this: delayed
const OFFLINE_HOURS = 24; // older than this: offline
const fmtUtc = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";
const etClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const etDayClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const etKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
/** New York time, short: "2:20 PM" today, "Oct 8, 3:15 AM" otherwise. */
function fmtEt(iso: string): string {
  const d = new Date(iso);
  return etKey.format(d) === etKey.format(new Date()) ? etClock.format(d) : etDayClock.format(d);
}
/** A short span between two times: "12m", "3h 5m", "4d". */
function span(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.round((toMs - fromMs) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" });

function ago(iso: string | number): string {
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m ago`;
  const days = Math.round(h / 24);
  return days < 120 ? `${days}d ago` : `since ${fmtDate.format(new Date(t))}`;
}
const hoursOld = (iso: string) => (Date.now() - Date.parse(iso)) / 3.6e6;
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "--");
const signed = (v: number, d = 1) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}` : "--");
const cToF = (c: number) => (c * 9) / 5 + 32;

type State = "live" | "delayed" | "offline";

/**
 * Water variables. The reader picks one for the whole page (status grid and the year, change, water
 * column and surface-minus-bottom charts); temperature is the default. Salinity and oxygen histories
 * load on first use, so the first view costs the same two requests as before.
 */
type VarKey = "temp" | "salinity" | "oxygen" | "turbidity" | "wind" | "rivers" | "tides";
interface WaterVar {
  label: string;
  unit: string; // appended to values on axes and in tooltips
  digits: number;
  file: string;
  obs: (o: LastObs) => number | null; // the latest raw reading, in this variable's units
}
const WATER_VARS: Record<VarKey, WaterVar> = {
  temp: { label: "Water temperature", unit: "°F", digits: 1, file: "history.json", obs: (o) => (o.temperature_c == null ? null : cToF(o.temperature_c)) },
  salinity: { label: "Salinity", unit: "", digits: 2, file: "history-salinity.json", obs: (o) => o.salinity },
  oxygen: { label: "Dissolved oxygen", unit: " mg/L", digits: 1, file: "history-oxygen.json", obs: (o) => o.oxygen_mg_l },
  // Not a water variable: the view of weather and waves at the stations (see FIGS and statusGrid).
  wind: { label: "Wind and waves", unit: "", digits: 1, file: "history-waves.json", obs: () => null },
  // Turbidity: the buoys' point observations with their reliability, and the river input (see turbTable). The
  // home of the turbidity field to come: a surface map from satellite, then a modelled field.
  turbidity: { label: "Turbidity", unit: " NTU", digits: 1, file: "history-turbidity.json", obs: () => null },
  // The rivers into the Sound (see RIVER_FIGS, riverTable): not a buoy variable either.
  rivers: { label: "Rivers", unit: " cfs", digits: 0, file: "rivers-history.json", obs: () => null },
  tides: { label: "Tides", unit: " ft", digits: 2, file: "shore-tides.json", obs: () => null },
};
const isWater = (k: VarKey) => k === "temp" || k === "salinity" || k === "oxygen";
let VK: VarKey = "wind"; // a first visit opens on Wind & waves (the comfort map); a link or a remembered view wins
/** What a link asked for: ?view=oxygen&layer=sst&t=-30d#WLIS-col (see linkUrl). */
const LINK = new URLSearchParams(location.search);
try {
  const saved = LINK.get("view") ?? localStorage.getItem("lhzn-blue-water-var");
  if (saved && saved in WATER_VARS) VK = saved as VarKey;
} catch {
  /* private mode: Wind & waves */
}
/** Embed mode (?embed=next48&station=WLIS, optionally &theme=dark or light): one station's one figure, live, for
 * another site to frame; the rest of the page is hidden and the map is not drawn. */
const EMBED = (["next48", "yoy"] as const).find((k) => k === LINK.get("embed")) ?? null;
const EMBED_STATION = (LINK.get("station") ?? "WLIS").toUpperCase();
if (EMBED) {
  VK = EMBED === "next48" ? "wind" : "temp";
  document.body.classList.add("embed");
  // The framing page sizes the iframe to the figure: {lhznEmbed: {height}} whenever the content's height changes.
  new ResizeObserver(() => {
    if (window.parent !== window) window.parent.postMessage({ lhznEmbed: { fig: EMBED, station: EMBED_STATION, height: document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight } }, "*");
  }).observe(document.body);
  const th = LINK.get("theme");
  if (th === "dark") delete document.documentElement.dataset.theme;
  else if (th === "light") document.documentElement.dataset.theme = "light";
}
const V = () => WATER_VARS[VK];
/** Axis label for the variable: salinity has no unit (practical salinity scale), so it is named instead. */
const unitName = (k: VarKey) => (k === "temp" ? "°F" : k === "salinity" ? "practical salinity" : "mg/L");

/** One variable's series for a station, per depth, with its derived views. */
interface VarView {
  hourly: Record<string, Hourly | null>;
  m36: Record<string, Hourly | null>;
  chg: Record<string, Hourly | null>;
  delta: Hourly | null; // surface minus bottom, hourly
  delta36: Hourly | null;
}

interface StationData {
  kind: "buoy" | "shore" | "airport" | "rivers" | "river" | "turbidity"; // rivers: the all-rivers summary; river: one gauge; airport: coastal ASOS weather
  meta: MetaStation;
  depths: string[]; // depths this station has, top to bottom
  // The selected variable's views (see useVar); `temp` always holds temperature, for stratification and air.
  hourly: Record<string, Hourly | null>;
  m36: Record<string, Hourly | null>;
  chg: Record<string, Hourly | null>;
  delta: Hourly | null; // surface minus bottom, hourly
  delta36: Hourly | null;
  temp: VarView;
  views: Partial<Record<VarKey, VarView>>;
  obs: Record<string, LastObs | null>; // latest reading per depth (live, or the last one we hold)
  live: boolean; // any series still published by the server
  now: number; // the current hour: year comparisons are always about this time of year
  anchor: number; // end of the recent timelines: now for live stations, the last reading otherwise
  met: Met | null; // weather at the station, recent window only
  metLong?: { wind: Hourly | null; air: Hourly | null; pressure: Hourly | null }; // daily history under the window, for the %iles
  level: Hourly | null; // shore stations: water level, feet above MLLW
  tides: TideEvent[]; // shore stations: predicted highs and lows
  levelNow: { time: string; ft: number } | null;
  waves: Waves | null; // buoys with a wave sensor: the live window, then the full record once loaded
  river?: RiverData; // the rivers sections
  gauge?: Gauge; // a river section's gauge
  turb?: TurbData; // the buoy turbidity section
}

/** Buoy turbidity: hourly median and fouling flag per buoy, the latest reading, and the recent share flagged. */
interface TurbData {
  buoys: { id: string; name: string }[];
  ntu: Record<string, Hourly | null>;
  suspect: Record<string, Hourly | null>;
  last: Record<string, { time: string; turb_ntu: number | null } | null>;
  share30: Record<string, number | null>;
  qc: string;
}

function turbSection(stations: StationData[], live: Live, hist: TurbHistory | null): StationData | null {
  const lt = live.turbidity ?? {};
  const buoys = stations.filter((d) => d.kind === "buoy" && lt[d.meta.id]).map((d) => ({ id: d.meta.id, name: d.meta.name }));
  if (!buoys.length) return null;
  const col = (f: TurbFrame | undefined, l: TurbFrame | undefined, k: "turb_ntu" | "suspect") =>
    Hourly.merge(Hourly.fromArray(f?.t0, f?.[k]), Hourly.fromArray(l?.t0, l?.[k]));
  const turb: TurbData = {
    buoys,
    ntu: Object.fromEntries(buoys.map((b) => [b.id, col(hist?.stations[b.id], lt[b.id], "turb_ntu")])),
    suspect: Object.fromEntries(buoys.map((b) => [b.id, col(hist?.stations[b.id], lt[b.id], "suspect")])),
    last: Object.fromEntries(buoys.map((b) => [b.id, lt[b.id]?.last_obs ?? null])),
    share30: Object.fromEntries(buoys.map((b) => [b.id, lt[b.id]?.suspect_30d ?? null])),
    qc: hist?.qc ?? "",
  };
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const empty = { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null };
  return {
    kind: "turbidity",
    meta: {
      id: "TURB", name: "Turbidity at the buoys", operator: "LISICOS", lat: 41, lon: -73, info_url: null, series: [],
      note:
        `Point observations from the optical turbidity channel of each buoy's surface sensor, a Sea-Bird <a href="https://www.seabird.com/eco-fluorometer/product-details?id=60429374754">ECO FLNTU</a> ` +
        "(chlorophyll fluorescence and turbidity) at about 1 m, in the buoys' 2019 configuration as LISICOS describes it. In warm water the sensor's window fouls within weeks: a film of algae, then barnacles, " +
        "scatters light back into the sensor, so the reading climbs steadily (from 1 to 2 NTU after servicing to tens of NTU by late summer) " +
        "though the water has not changed, and servicing drops it back to baseline in one step. Readings that repeat one value for 2 hours or more " +
        "are dropped as stuck. A day whose quietest tenth of readings sits above 5 NTU is flagged as likely fouling and drawn faintly: clean open " +
        "water in the Sound sits near 1 NTU between storms, and a storm stirring up the bottom leaves a day's quietest readings low, while a fouled " +
        "window lifts them all. This is a working rule, to be checked against the operator's servicing dates; early in a fouling climb it can " +
        "miss days. The river input beside it, the USGS sensor on the Connecticut River, is serviced and reviewed. NTU (these buoys) and FNU (the USGS " +
        "sensor) are close but not identical units. This view will carry the turbidity field as it comes: a surface map first, then a modelled field. " +
        `Nearshore, in the Sound's bays and harbors, <a href="/references/#sts_monitoring">Save the Sound</a>'s Unified Water Study measures turbidity, oxygen and chlorophyll.`,
    },
    depths: buoys.map((b) => b.id),
    ...empty,
    temp: empty,
    views: {},
    obs: Object.fromEntries(buoys.map((b) => [b.id, turb.last[b.id] ? { time: turb.last[b.id]!.time, depth_m: 1, temperature_c: null, salinity: null, oxygen_mg_l: null } : null])),
    live: true,
    now,
    anchor: now,
    met: null,
    level: null,
    tides: [],
    levelNow: null,
    waves: null,
    turb,
  };
}

/* ---------- Rivers ---------- */

type Gauge = RiverHistory["meta"]["gauges"][number];
interface RiverData {
  gauges: Gauge[]; // largest gauged basin first
  flow: Record<string, Hourly | null>; // cfs, hourly, last 100 days
  daily: Record<string, Daily | null>; // cfs, daily means from 1990
  normals: RiverHistory["normals"];
  turb: Hourly | null; // Connecticut at Thompsonville, FNU
  last: Record<string, { time: string; flow_cfs: number | null; turb_fnu: number | null } | null>;
}

/** Index of a time's Eastern calendar date in a leap year (0 to 365), for the day-of-year percentiles. */
const etMonthDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" });
function dayOfYear(t: number): number {
  const p = Object.fromEntries(etMonthDay.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(2024, Number(p.month) - 1, Number(p.day)) - Date.UTC(2024, 0, 1)) / 86400000);
}

/** Flow at a time: the hourly window where it reaches, the daily means before it. */
const riverFlow = (r: RiverData, id: string, t: number) => {
  const h = r.flow[id]?.at(t) ?? NaN;
  return Number.isFinite(h) ? h : (r.daily[id]?.at(t) ?? NaN);
};
type Pct = "p5" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95";
const pct = (r: RiverData, id: string, p: Pct, t: number) => r.normals[id]?.[p]?.[dayOfYear(t)] ?? NaN;

/**
 * Where a flow sits among the date's percentiles (5th to 95th), interpolated between them in log flow (flow
 * spreads by ratios). Below the 5th it reads 2.5 and above the 95th 97.5: beyond those the record says only
 * that the flow is rarer than one year in twenty for the date.
 */
const PCTS: [number, Pct][] = [[5, "p5"], [10, "p10"], [25, "p25"], [50, "p50"], [75, "p75"], [90, "p90"], [95, "p95"]];
function percentileOf(r: RiverData, id: string, t: number, flow: number): number {
  if (!Number.isFinite(flow) || flow <= 0) return NaN;
  const pts = PCTS.map(([q, k]) => [q, pct(r, id, k, t)] as [number, number]).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (pts.length < 2) return NaN;
  if (flow <= pts[0][1]) return 2.5;
  if (flow >= pts[pts.length - 1][1]) return 97.5;
  for (let i = 1; i < pts.length; i++) {
    const [qa, va] = pts[i - 1];
    const [qb, vb] = pts[i];
    if (flow <= vb) return vb === va ? qb : qa + ((qb - qa) * Math.log(flow / va)) / Math.log(vb / va);
  }
  return NaN;
}

/** USGS's flow classes against the day-of-year percentiles of the gauge's approved record. */
function riverClass(r: RiverData, id: string, t: number, flow: number): string {
  if (!Number.isFinite(flow)) return "";
  const at = (p: "p10" | "p25" | "p75" | "p90") => pct(r, id, p, t);
  if (!Number.isFinite(at("p25"))) return "";
  if (flow < at("p10")) return "much below normal";
  if (flow < at("p25")) return "below normal";
  if (flow <= at("p75")) return "normal";
  if (flow <= at("p90")) return "above normal";
  return "much above normal";
}
/** A percentile for a readout: beyond the 5th and 95th the record says only that it is rarer than that. */
const pctText = (v: number) => (!Number.isFinite(v) ? "--" : v <= 2.5 ? "<5<small>th</small>" : v >= 97.5 ? "&gt;95<small>th</small>" : ordinal(v).replace(/(\D+)$/, "<small>$1</small>"));

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st... */
const ordinal = (n: number) => {
  const r = Math.round(n);
  const s = r % 100 >= 11 && r % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[r % 10] ?? "th";
  return `${r}${s}`;
};
const cfs = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "--");

let RIVER_SECTIONS: StationData[] = [];
let TURB_SECTION: StationData | null = null;

/** The Rivers view's sections: an all-rivers summary, then one section per gauge, west to east. */
function riverSections(rl: RiverLive, rh: RiverHistory): StationData[] {
  // Largest gauged basin first: the order of the table, the sections and the all-rivers chart.
  const gauges = [...rh.meta.gauges].sort((a, b) => b.drainage_sqmi - a.drainage_sqmi);
  const river: RiverData = {
    gauges,
    flow: Object.fromEntries(gauges.map((g) => [g.id, Hourly.fromArray(rl.gauges[g.id]?.t0, rl.gauges[g.id]?.flow_cfs)])),
    daily: Object.fromEntries(gauges.map((g) => [g.id, Daily.fromArray(rh.daily[g.id]?.t0, rh.daily[g.id]?.flow_cfs)])),
    normals: rh.normals,
    turb: Hourly.fromArray(rl.gauges.CONN?.t0, rl.gauges.CONN?.turb_fnu),
    last: Object.fromEntries(gauges.map((g) => [g.id, rl.gauges[g.id]?.last_obs ?? null])),
  };
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const area = gauges.reduce((a, g) => a + g.drainage_sqmi, 0);
  const empty = { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null };
  const obsOf = (g: Gauge): LastObs | null =>
    river.last[g.id] ? { time: river.last[g.id]!.time, depth_m: null, temperature_c: null, salinity: null, oxygen_mg_l: null } : null;
  const base = { ...empty, temp: empty, views: {}, live: true, now, anchor: now, met: null, level: null, tides: [], levelNow: null, waves: null, river };
  const summary: StationData = {
    ...base,
    kind: "rivers",
    meta: {
      id: "RIVERS", name: "All rivers", operator: "USGS", lat: 41.5, lon: -72.6, info_url: null, series: [],
      note:
        `${gauges.length} USGS stream gauges draining ${Math.round(area).toLocaleString("en-US")} square miles, about three quarters of it the Connecticut River above Thompsonville. ` +
        `On Long Island most fresh water reaches the Sound as groundwater, which stream gauges do not measure, so the north shore is under-represented here.`,
    },
    depths: gauges.map((g) => g.id),
    obs: Object.fromEntries(gauges.map((g) => [g.id, obsOf(g)])),
  };
  const sections = gauges.map(
    (g): StationData => ({
      ...base,
      kind: "river",
      gauge: g,
      meta: {
        id: g.id, name: `${g.river} River`, operator: "USGS", lat: g.lat, lon: g.lon, info_url: `https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/`,
        note: [`${g.name}, draining ${g.drainage_sqmi.toLocaleString("en-US")} square miles; reaches the Sound at ${g.mouth}.`, g.status_note ?? "Values are provisional until USGS approves them."].join(" "),
        series: [{ key: g.id, depth: "SFC", label: "Flow", depth_m: [], record_start: g.record_start, hours: 0, sources: [], live: true, archived_last_obs: null }],
      },
      depths: ["SFC"],
      obs: { SFC: obsOf(g) },
    }),
  );
  return [summary, ...sections];
}

/** A river's daily mean flow, as a series for the year comparison (a value per day, the same at every hour). */
const dailyFlow = (d: StationData): Series | null => (d.gauge && d.river?.daily[d.gauge.id]) || null;

/** Hourly waves: heights in metres, periods in seconds. */
interface Waves {
  hs: Hourly | null;
  hmax: Hourly | null;
  tp: Hourly | null;
}

function wavesFrom(hist: WaveFrame | undefined, live: WaveFrame | undefined): Waves | null {
  const col = (k: "hs_m" | "hmax_m" | "tp_s") => Hourly.merge(Hourly.fromArray(hist?.t0, hist?.[k]), Hourly.fromArray(live?.t0, live?.[k]));
  const w = { hs: col("hs_m"), hmax: col("hmax_m"), tp: col("tp_s") };
  return w.hs || w.hmax ? w : null;
}

/** Wave status per buoy: the hourly check in live.json, and the full record's metadata once loaded. */
let WAVE_LIVE: Record<string, WaveLive> = {};
let WAVE_META: WaveHistory["meta"] = {};

interface Met {
  wind: Hourly | null; // knots
  gust: Hourly | null; // knots, hourly peak
  dir: Hourly | null; // degrees the wind blows from
  air: Hourly | null; // F
  pressure: Hourly | null; // mbar
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
    pressure: Hourly.fromArray(w.t0, w.pressure_mb),
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

/** Speed units for wind and currents: buoy data arrives in knots; the reader picks how it is shown (remembered per browser). */
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
/** The current speed unit for the map's currents (stored in cm/s): 1 cm/s is 0.0194384 kt. */
const currentSpeed = () => ({ label: WIND_UNITS[WU].label, perCms: 0.0194384 * WIND_UNITS[WU].factor, digits: 1 });
const waveUnit = () => (WU === "ms" ? { label: "m", factor: 1, digits: 2 } : { label: "ft", factor: 3.28084, digits: 1 });
const waveFmt = (m: number | null | undefined) => (m == null || !Number.isFinite(m) ? "--" : (m * waveUnit().factor).toFixed(waveUnit().digits));
const windFmt = (kt: number | null | undefined) =>
  kt == null || !Number.isFinite(kt) ? "--" : windVal(kt).toFixed(WIND_UNITS[WU].digits);

/** A variable's views for one station: history overlaid with the live window, then the derived series. */
function viewOf(st: MetaStation, hist: Record<string, Encoded>, live: Record<string, Encoded> | undefined): VarView {
  const hourly: Record<string, Hourly | null> = {};
  const m36: Record<string, Hourly | null> = {};
  const chg: Record<string, Hourly | null> = {};
  for (const s of st.series) {
    const h = Hourly.merge(Hourly.decode(hist[s.key]), Hourly.decode(live?.[s.key]));
    hourly[s.depth] = h;
    m36[s.depth] = h ? h.rolling(36, 24) : null;
    chg[s.depth] = m36[s.depth]?.change(168) ?? null;
  }
  const delta = hourly.SFC && hourly.BTM ? hourly.SFC.minus(hourly.BTM) : null;
  return { hourly, m36, chg, delta, delta36: delta ? delta.rolling(36, 24) : null };
}

/** Show a variable: its views become the station's current series. */
function useVar(d: StationData, k: VarKey): void {
  const v = d.views[k] ?? (k === "temp" ? d.temp : { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null });
  Object.assign(d, { hourly: v.hourly, m36: v.m36, chg: v.chg, delta: v.delta, delta36: v.delta36 });
}

/** Load a variable's history (once) and build its views for every station. */
const loaded = new Set<VarKey>(["temp"]);
async function ensureVar(k: VarKey, live: Live, stations: StationData[]): Promise<void> {
  if (loaded.has(k)) return;
  if (k === "tides") {
    await loadTides();
    loaded.add(k);
    return;
  }
  if (k === "rivers") {
    const [rl, rh] = await Promise.all([getJson<RiverLive>(`${DATA}/rivers.json`), getJson<RiverHistory>(`${DATA}/${WATER_VARS.rivers.file}`)]);
    RIVER_SECTIONS = riverSections(rl, rh);
    $("about-sources").insertAdjacentHTML(
      "beforeend",
      ` Rivers: <a href="https://waterdata.usgs.gov/">USGS</a> stream gauges (${rh.meta.gauges.map((g) => `${g.name}, ${g.usgs_id}`).join("; ")}). ` +
        `Recent flow is hourly means of 15-minute readings; earlier flow is daily means; the ranges for each date are percentiles of daily mean ` +
        `flow over each gauge's approved record, computed by USGS. ${rh.meta.qc}`,
    );
    loaded.add(k);
    return;
  }
  if (k === "turbidity") {
    await ensureVar("rivers", live, stations).catch(() => undefined); // the river input; the buoys show without it
    const th = await getJson<TurbHistory>(`${DATA}/${WATER_VARS.turbidity.file}`).catch(() => null); // the live 100 days still show
    TURB_SECTION = turbSection(stations, live, th);
    if (TURB_SECTION) TURB_SECTION.river = RIVER_SECTIONS[0]?.river;
    if (th) $("about-sources").insertAdjacentHTML("beforeend", ` ${th.qc}`);
    loaded.add(k);
    return;
  }
  if (k === "wind") {
    const [hist, met] = await Promise.all([
      getJson<WaveHistory>(`${DATA}/${WATER_VARS.wind.file}`),
      getJson<MetHistory>(`${DATA}/history-met.json`).catch(() => null), // the %iles wait for it; the rest shows without
    ]);
    WAVE_META = hist.meta;
    for (const d of stations) if (d.kind === "buoy") d.waves = wavesFrom(hist.stations[d.meta.id], live.waves?.[d.meta.id]);
    if (met) {
      for (const d of stations) {
        const h = d.kind === "buoy" ? met.stations[d.meta.id] : undefined;
        if (!h?.t0) continue;
        const long = (vals: (number | null)[] | undefined, recent: Hourly | null | undefined) =>
          Hourly.merge(Daily.fromArray(h.t0, vals)?.toHourly() ?? null, recent ?? null);
        d.metLong = { wind: long(h.wind_kt, d.met?.wind), air: long(h.air_f, d.met?.air), pressure: long(h.pressure_mb, d.met?.pressure) };
      }
    }
    $("about-sources").insertAdjacentHTML("beforeend", ` ${hist.qc}${met ? ` ${met.qc}` : ""}`);
    loaded.add(k);
    return;
  }
  const hist = await getJson<VarHistory>(`${DATA}/${WATER_VARS[k].file}`);
  const liveVar = k === "temp" ? live.series : live[k];
  for (const d of stations) d.views[k] = viewOf(d.meta, hist.series, liveVar);
  loaded.add(k);
}

async function load(): Promise<{ meta: Meta; live: Live; stations: StationData[] }> {
  const [hist, live] = await Promise.all([getJson<History>(`${DATA}/history.json`), getJson<Live>(`${DATA}/live.json`)]);
  const meta = hist.meta;
  // West to east, everywhere: the status grid, the station sections, and the AI prompt.
  meta.stations.sort((a, b) => a.lon - b.lon);
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const stations = meta.stations.map((st) => {
    const temp = viewOf(st, hist.series, live.series);
    const obs: Record<string, LastObs | null> = {};
    for (const s of st.series) obs[s.depth] = live.series[s.key]?.last_obs ?? s.archived_last_obs ?? null;
    const isLive = st.series.some((s) => s.live);
    const lastData = Math.max(...Object.values(temp.hourly).map((h) => (h ? h.lastValid() : -Infinity)));
    return {
      kind: "buoy" as const,
      meta: st,
      depths: DEPTHS.filter((d) => st.series.some((s) => s.depth === d)),
      ...temp,
      temp,
      views: { temp },
      obs,
      live: isLive,
      now,
      anchor: isLive || !Number.isFinite(lastData) ? now : lastData,
      met: metOf(live.met?.[st.id]),
      level: null,
      tides: [],
      levelNow: null,
      waves: wavesFrom(undefined, live.waves?.[st.id]),
    };
  });
  WAVE_LIVE = live.waves ?? {};
  return { meta, live, stations };
}

/**
 * A shore station as a one-depth station: water temperature (history from shore-history.json once it
 * arrives, overlaid with the live window), the station's weather, and water level with tide predictions.
 */
function shoreStation(st: ShoreMetaStation, frame: ShoreFrame | undefined, hist: Encoded | undefined): StationData {
  const series: MetaSeries = {
    key: st.id, depth: "SFC", label: "Water", depth_m: [], record_start: hist?.t0 ?? st.record_start,
    hours: hist?.values.length ?? 0, sources: [], live: true, archived_last_obs: null,
  };
  const meta: MetaStation = { id: st.id, name: st.name, operator: st.operator, lat: st.lat, lon: st.lon, note: st.note ?? null, info_url: st.info_url, series: [series] };
  const liveWater: Encoded | undefined = frame?.t0 ? { t0: frame.t0, step: 3600, unit: "degF", values: frame.water_f ?? [] } : undefined;
  const temp = viewOf(meta, hist ? { [st.id]: hist } : {}, liveWater ? { [st.id]: liveWater } : undefined);
  const o = frame?.last_obs ?? null;
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  return {
    kind: "shore",
    meta,
    depths: ["SFC"],
    ...temp,
    temp,
    views: { temp },
    obs: { SFC: o && o.water_f != null ? { time: o.time, depth_m: null, temperature_c: fToC(o.water_f), salinity: null, oxygen_mg_l: null } : null },
    live: true,
    now,
    anchor: now,
    met: frame ? metOf({ ...frame, last_obs: o, dataset: frame.coops_id } as MetWindow) : null,
    level: Hourly.fromArray(frame?.t0, frame?.level_ft),
    tides: frame?.tides ?? [],
    levelNow: o && o.level_ft != null ? { time: o.time, ft: o.level_ft } : null,
    waves: null,
  };
}

/** The next predicted high or low after now. */
const nextTide = (d: StationData): TideEvent | undefined => d.tides.find((e) => Date.parse(e.t) > Date.now());
const fmtClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
/** Feet to one decimal, with a true minus sign and no "-0.0". */
const feet = (v: number) => (Math.abs(v) < 0.05 ? "0.0" : `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`);
const tideText = (e: TideEvent) => `${e.type === "H" ? "high" : "low"} ${fmtClock.format(new Date(e.t)).toLowerCase()}, ${feet(e.ft)} ft`;

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
  if (d.kind === "airport") return d.met?.last ? obsState({ time: d.met.last.time } as LastObs) : "offline";
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
function stratNow(d: StationData): { deltaC: number; status: string } {
  const delta = d.temp.delta;
  const end = delta ? delta.lastValid() : NaN;
  const deltaC = delta && Number.isFinite(end) ? (delta.mean(end - 23 * HOUR, end) * 5) / 9 : NaN;
  return { deltaC, status: stratStatus(deltaC) };
}

/* ---------- Figures: one builder per view, used inline and in the zoom view ---------- */

type Kind = "yoy" | "chg" | "col" | "sb" | "next48" | "hilo" | "dep" | "wind" | "air" | "tide" | "waves" | "pressure" | "flow" | "share" | "rturb" | "ryoy" | "rpct" | "bturb";

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
  varies: boolean; // follows the selected water variable
  in: (k: VarKey) => boolean; // the views that show this figure
  wide?: boolean; // spans both columns
  label?: (d: StationData) => string; // a title that depends on where the figure sits
  depthTabs: boolean;
  seasonal: boolean; // compares years on the same dates (anchored at now); otherwise a recent timeline
  available: (d: StationData) => boolean;
  window: (d: StationData) => [number, number];
  maxSpan: number; // widest zoom in the normal view
  start?: (d: StationData) => number; // earliest data for this figure, if not the water record
  build: (d: StationData, depth: string, x0: number, x1: number, full: boolean) => Built;
}

const recordStart = (d: StationData) => {
  const t = Math.min(...Object.values(d.hourly).filter((h): h is Hourly => !!h).map((h) => h.t0));
  return Number.isFinite(t) ? t : d.now - 2 * DAY;
};

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
  if (d.kind === "airport") return d.met?.last ? Date.parse(d.met.last.time) / 1000 : -Infinity;
  return Math.max(...d.depths.map((dep) => (d.obs[dep] ? Date.parse(d.obs[dep]!.time) / 1000 : -Infinity)));
}

/**
 * Waves, stated fairly per buoy: LISICOS lists wave data for Western Sound, Execution Rocks and Central
 * Sound only, so ARTG has no wave sensor rather than an outage. For the others the ingest asks the server
 * for the wave dataset every hour; the status comes from that check, and the date is the last wave reading
 * we hold (from the server or our saved downloads), so it is when the data stops, not when we looked.
 */
type WaveSensor = { sensor: boolean; dataset?: string };
const wavesOf = (id: string): WaveSensor | null =>
  ((registry.stations as { id: string; waves?: WaveSensor }[]).find((s) => s.id === id)?.waves ?? null);

/** The last wave reading we hold for a buoy: the live window's, or the full record's once loaded. */
const lastWave = (id: string): WaveObs | null => WAVE_LIVE[id]?.last_obs ?? WAVE_META[id]?.last_obs ?? null;

function wavesText(id: string, short = false): string {
  const w = wavesOf(id);
  if (!w) return "";
  if (!w.sensor) return short ? "no sensor" : "Waves: no wave sensor on this buoy.";
  const status = WAVE_LIVE[id];
  const last = lastWave(id);
  const fresh = last && hoursOld(last.time) < OFFLINE_HOURS;
  if (status?.published && fresh) return short ? "published" : "Waves: published on the data server.";
  const when = last ? fmtDate.format(new Date(last.time)) : "";
  const where = status?.published ? "published but not updating" : "not published on the data server (checked hourly)";
  return short
    ? `offline${when ? `, last reading ${when.replace(/, \d{4}$/, "")}` : ""}`
    : `Waves: ${where}${when ? `; last reading ${when}` : ""}. LISICOS posts a wave panel as an image.`;
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
  if (d.kind === "shore" && isWater(VK) && VK !== "temp") return `${d.meta.name} measures water temperature only; ${V().label.toLowerCase()} comes from the buoys.`;
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

const OXYGEN_NOTE = `shading: under ${DO_LEVELS.anoxic} mg/L anoxic, under ${DO_LEVELS.hypoxic} hypoxic (Long Island Sound Partnership), under ${DO_LEVELS.growth} below EPA's growth criterion`;

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
  next48: {
    title: "The next 48 hours",
    varies: false,
    wide: true, // the plot a reader looks ahead with: the full width, like the map and table above
    in: (k) => k === "wind",
    sub: "wind and gusts, measured and forecast",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "buoy" || d.kind === "shore" || d.kind === "airport", // every station has HRRR runs; drawn once they load
    window: () => {
      const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
      return [now - 36 * HOUR, now + 48 * HOUR];
    },
    maxSpan: 7 * DAY,
    build: (d, _depth, x0, x1) => {
      if (!FCST) void loadForecast();
      const xs = grid(x0, x1, 400).map((t) => Math.round(t / HOUR) * HOUR);
      const u = WIND_UNITS[WU];
      const fmtU = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
      const now = Date.now() / 1000;
      const runs = FCST?.runs[d.meta.id] ?? [];
      const newest = runs.find((r) => r.issue <= now);
      const at = (r: FcRun, t: number) => {
        const i = r.leads.indexOf(Math.round((t - r.issue) / HOUR));
        const uu = r.u[i], vv = r.v[i];
        return i < 0 || uu == null || vv == null ? NaN : Math.hypot(uu, vv) * MS_KT;
      };
      // Earlier runs, faint and fainter with age: where they agree the forecast is settled; where they fan out it is not.
      const older = vintageRuns(d.meta.id, x0, x1).filter((r) => r !== newest).reverse();
      const runLines: Line[] = older.map((r, i) => ({
        ys: xs.map((t) => windVal(at(r, t))),
        color: P.line,
        width: 0.8,
        opacity: 0.32 - (0.24 * i) / Math.max(1, older.length - 1),
        label: `HRRR run ${fmtRun.format(new Date(r.issue * 1000))}`,
        tip: false,
      }));
      // Ahead of now: for each hour, the newest run that reaches it (most runs reach 18 h, the 00, 06, 12 and 18 UTC
      // runs 48 h), with that lead's typical error.
      const ahead = xs.map((t) => (t >= Math.floor(now / HOUR) * HOUR ? forecastAt(d.meta.id, t) : null));
      const fc = ahead.map((f) => (f ? f.spd : NaN));
      const err = (t: number) => ahead[xs.indexOf(t)]?.err ?? NaN;
      const m = d.met;
      const lines: Line[] = [
        ...runLines,
        { ys: fc.map((_, i) => err(xs[i])), color: P.miss, label: "Typical miss at the buoys", hidden: true, fmt: (v) => `&plusmn;${windFmt(v)} ${u.label}` },
        { ys: ahead.map((f) => (f ? windVal(f.gust) : NaN)), color: P.contrast, opacity: 0.5, label: "Forecast gust", dots: true, fmt: fmtU },
        { ys: fc.map((v) => windVal(v)), color: P.line, width: 2, dash: "6 3", label: "Stitched forecast", fmt: fmtU },
        { ys: xs.map((t) => windVal(m?.gust?.at(t) ?? NaN)), color: P.contrast, opacity: 0.55, label: "Gust, measured", dots: true, fmt: fmtU },
        { ys: xs.map((t) => windVal(m?.wind?.at(t) ?? NaN)), color: P.now, width: 2.2, label: "Wind, measured", fmt: fmtU },
        { ys: xs.map((t) => m?.dir?.at(t) ?? NaN), color: P.line, label: "From", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
      ];
      // The run whose line is nearest the pointer at the hovered hour (the vintage slider follows it).
      const pick = (i: number, yv: number) => {
        const vals = vintageRuns(d.meta.id, x0, x1).map((r) => ({ r, y: windVal(at(r, xs[i])) })).filter((x) => Number.isFinite(x.y));
        if (!vals.length) return null;
        return vintageLabel(d.meta.id, vals.reduce((a, b) => (Math.abs(b.y - yv) < Math.abs(a.y - yv) ? b : a)).r);
      };
      return {
        opts: {
          xs, lines, unit: ` ${u.label}`, zero: true, marker: { x: now, label: "now" }, empty: "No forecast or measurement in this window.", pick,
          areas: [{ lo: fc.map((v, i) => windVal(Math.max(0, v - err(xs[i])))), hi: fc.map((v, i) => windVal(v + err(xs[i]))), fill: P.miss, opacity: 0.22 }],
        },
        legend: [["Measured", P.now, 1], ["Stitched forecast", P.line, 1], ["Typical miss (shaded)", P.miss, 0.5], ["Gusts", P.contrast, 0.55], ["Earlier forecasts", P.line, 0.3]],
        note: `NOAA HRRR, raw &middot; the shading is HRRR's typical miss at each lead, ${verTag()}`,
      };
    },
  },
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
        opts: { xs, lines, spans, unit: ` ${u.label}`, zero: true, empty: "No weather data in this window." },
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
    // In a Connecticut River section, and in the Turbidity view as the river input.
    available: (d) => (d.kind === "turbidity" || (d.kind === "river" && !!d.gauge?.turbidity)) && !!d.river?.turb && Number.isFinite(d.river.turb.lastValid()),
    window: RIGHT,
    maxSpan: 100 * DAY,
    start: (d) => d.river?.turb?.t0 ?? d.now,
    build: (d, _id, x0, x1) => {
      const xs = grid(x0, x1);
      const label = d.kind === "turbidity" ? "Connecticut River at Thompsonville" : "Turbidity";
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

/* ---------- Tides: NOAA predictions, datums and flood levels at the shore stations ---------- */

interface TideStation {
  pred?: { t0: string; step: number; ft: (number | null)[] };
  hilo?: { t: string; ft: number; type: "H" | "L" }[];
  datums_ft?: Record<string, number>;
  flood_ft?: Record<string, number | null>;
}
let TIDES: Record<string, TideStation> | null = null;
let USGS_TIDES: Record<string, TideStation> = {}; // our fitted predictions at the USGS gauges, merged into TIDES
let MOON: { t: string; phase: string }[] = [];
let tidesLoading: Promise<void> | null = null;
let tidesRedraw: () => void = () => undefined;
const DEPARTURE = new Map<string, Hourly | null>();
const TIDES_PAGE = "/long-island-sound/tides/"; // "Reading the tides": unlinked until it returns
void TIDES_PAGE;

function loadTides(): Promise<void> {
  tidesLoading ??= getJson<{ stations: Record<string, TideStation>; moon?: { t: string; phase: string }[] }>(`${DATA}/shore-tides.json`)
    .then((j) => {
      TIDES = { ...j.stations, ...USGS_TIDES };
      MOON = j.moon ?? [];
      DEPARTURE.clear();
      tidesRedraw();
    })
    .catch(() => undefined);
  return tidesLoading;
}

/** NOAA's predicted level at the middle of the hour starting at t (4-point interpolation), the time an observed
 * hourly mean stands for. Measured against Kings Point's record, this alignment leaves the least twice-daily ripple
 * in the departure (about 0.3 ft, the predictions' own timing error there). */
function predictedHour(id: string, t: number): number {
  const p = TIDES?.[id]?.pred;
  if (!p) return NaN;
  const i = Math.round((t - Date.parse(p.t0) / 1000) / p.step);
  const [a, b, c, e] = [p.ft[i - 1], p.ft[i], p.ft[i + 1], p.ft[i + 2]];
  if (b == null || c == null) return NaN;
  return a == null || e == null ? (b + c) / 2 : (-a + 9 * b + 9 * c - e) / 16;
}

/** Observed minus predicted, hourly, feet: what the weather adds to the tide. */
function departure(d: StationData): Hourly | null {
  if (!TIDES || !d.level) return null;
  if (!DEPARTURE.has(d.meta.id)) {
    const lv = d.level;
    const v = new Float64Array(lv.v.length);
    lv.v.forEach((x, i) => (v[i] = x - predictedHour(d.meta.id, lv.t0 + i * HOUR)));
    DEPARTURE.set(d.meta.id, v.some(Number.isFinite) ? new Hourly(lv.t0, v) : null);
  }
  return DEPARTURE.get(d.meta.id) ?? null;
}
const lastValue = (h: Hourly | null) => {
  const t = h ? h.lastValid() : NaN;
  return h && Number.isFinite(t) ? h.at(t) : NaN;
};
const signedFt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;

/** The departure plot: observed minus predicted, above the prediction in amber, below in willow. */
function departureBuilt(d: StationData, x0: number, x1: number): Built {
  if (!TIDES) void loadTides();
  const xs = grid(x0, x1);
  const dep = departure(d);
  const ys = xs.map((t) => dep?.at(Math.floor(t / HOUR) * HOUR) ?? NaN);
  const ft = (v: number) => `${signedFt(v)} ft`;
  const lines: Line[] = [{ ys, color: P.line, width: 1.5, label: "Observed minus predicted", fmt: ft }];
  return {
    opts: { xs, lines, unit: " ft", zero: true, marker: { x: Date.now() / 1000, label: "now" }, empty: TIDES ? "No water level in this window." : "Loading the predictions." },
    legend: [["Observed minus predicted", P.line, 1]],
  };
}

/** Highs and lows: NOAA's predicted (faint) and the water's (bold) at each tide, with mean higher high water and
 * the NWS minor flood level. The observed extreme is the highest or lowest hourly mean within 2 h of the prediction. */
function hiloBuilt(d: StationData, x0: number, x1: number): Built {
  if (!TIDES) void loadTides();
  const xs = grid(x0, x1);
  const step = xs.length > 1 ? xs[1] - xs[0] : HOUR;
  const tide = TIDES?.[d.meta.id];
  const pred = xs.map(() => NaN);
  const obs = xs.map(() => NaN);
  for (const e of tide?.hilo ?? d.tides) {
    const t = Date.parse(e.t) / 1000;
    const i = Math.round((t - xs[0]) / step);
    if (i < 0 || i >= xs.length) continue;
    pred[i] = e.ft;
    if (d.level) {
      const near = [-2, -1, 0, 1, 2].map((k) => d.level!.at(Math.round(t / HOUR) * HOUR + k * HOUR)).filter(Number.isFinite);
      if (near.length >= 3) obs[i] = e.type === "H" ? Math.max(...near) : Math.min(...near);
    }
  }
  const ft = (v: number) => `${v.toFixed(1)} ft`;
  const minor = tide?.flood_ft?.nws_minor ?? null;
  const mhhw = tide?.datums_ft?.MHHW ?? null;
  const flat = (v: number | null) => xs.map(() => (v == null ? NaN : v));
  const lines: Line[] = [
    { ys: flat(minor), color: P.delayed, width: 1, opacity: 0.7, label: "NWS minor flood", tip: false },
    { ys: flat(mhhw), color: P.contrast, width: 0.8, opacity: 0.35, dash: "4 3", label: "Mean higher high water", tip: false },
    { ys: pred, color: P.contrast, opacity: 0.45, label: "Predicted", dots: true, fmt: ft },
    { ys: obs, color: P.now, label: "Observed", dots: true, fmt: ft },
  ];
  return {
    opts: { xs, lines, unit: " ft", marker: { x: Date.now() / 1000, label: "now" }, empty: "No tides in this window." },
    legend: [["Observed", P.now, 1], ["Predicted", P.contrast, 0.45], ["NWS minor flood", P.delayed, 0.7], ["MHHW (dashed)", P.contrast, 0.35]],
  };
}

/** The Sound, station by station: the departure from the prediction at each shore station, west to east, the
 * last 30 days on one time axis and one vertical scale; amber above the prediction, willow below. The timeline's
 * cursor is drawn across all rows. */
function soundRowsSvg(stations: StationData[]): string {
  const shore = stations.filter((d) => d.kind === "shore");
  const deps = shore.map((d) => [d, departure(d)] as const).filter((p): p is readonly [StationData, Hourly] => !!p[1]);
  if (!deps.length) return `<p class="note">Loading the predictions.</p>`;
  const t1 = Math.floor(Date.now() / 1000 / HOUR) * HOUR, t0 = t1 - 30 * DAY;
  const W = 900, rowH = 46, left = 96, top = 6, H = top + deps.length * rowH + 22;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - 8);
  let lim = 0.5;
  for (const [, h] of deps) for (let t = t0; t <= t1; t += HOUR) { const v = h.at(t); if (Number.isFinite(v)) lim = Math.max(lim, Math.abs(v)); }
  lim = Math.ceil(lim * 2) / 2;
  const rows = deps.map(([d, h], i) => {
    const y0 = top + i * rowH + rowH / 2;
    const y = (v: number) => y0 - (v / lim) * (rowH / 2 - 3);
    const area = (sign: 1 | -1) => {
      let p = "", open = false;
      for (let t = t0; t <= t1; t += HOUR) {
        const v = h.at(t);
        if (!Number.isFinite(v)) { if (open) { p += `L${x(t - HOUR).toFixed(1)},${y0}Z`; open = false; } continue; }
        const c = sign > 0 ? Math.max(0, v) : Math.min(0, v);
        if (!open) { p += `M${x(t).toFixed(1)},${y0}`; open = true; }
        p += `L${x(t).toFixed(1)},${y(c).toFixed(1)}`;
      }
      if (open) p += `L${x(t1).toFixed(1)},${y0}Z`;
      return p;
    };
    return `<text x="${left - 10}" y="${y0 + 3}" text-anchor="end" class="sr-name">${d.meta.name}</text>` +
      `<line x1="${left}" x2="${W - 8}" y1="${y0}" y2="${y0}" stroke="currentColor" opacity="0.18"/>` +
      `<path d="${area(1)}" fill="${P.delayed}" opacity="0.55"/><path d="${area(-1)}" fill="${P.line}" opacity="0.5"/>`;
  }).join("");
  let ticks = "";
  for (let k = 0; k <= 30; k += 7) {
    const t = t1 - k * DAY;
    ticks += `<text x="${x(t).toFixed(1)}" y="${H - 4}" text-anchor="${k === 0 ? "end" : "middle"}" class="sr-tick">${fmtDate.format(new Date(t * 1000)).replace(/, \d{4}$/, "")}</text>`;
  }
  const cur = AT != null && AT >= t0 && AT <= t1 ? `<line x1="${x(AT).toFixed(1)}" x2="${x(AT).toFixed(1)}" y1="${top}" y2="${H - 18}" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>` : "";
  return `<svg class="sound-rows" viewBox="0 0 ${W} ${H}" role="img" aria-label="Departure from the predicted tide at each shore station, the last 30 days">${rows}${ticks}${cur}<text x="${W - 8}" y="${top + 2}" text-anchor="end" class="sr-tick">each row &plusmn;${lim.toFixed(1)} ft</text></svg>`;
}


/** A moon phase glyph, as on the tides page: a thin circle with the dark part filled in the muted ink. */
function moonGlyph(phase: string, r = 4): string {
  const ink = "var(--ink-mute)";
  const half = phase === "first_quarter" || phase === "last_quarter" ? `<path d="M0,${-r} A${r},${r} 0 0 ${phase === "first_quarter" ? 0 : 1} 0,${r} Z" fill="${ink}"/>` : "";
  return `<circle r="${r}" fill="${phase === "new" ? ink : "var(--bg)"}" stroke="${ink}" stroke-width="1"/>${half}`;
}
const phaseName = (p: string) => ({ new: "new moon", first_quarter: "first quarter", full: "full moon", last_quarter: "last quarter" })[p] ?? p;

/** The tide ladder for one station, as on the tides page: each high and low as NOAA's prediction (open circle) and
 * what the water did (gold dot), joined by a stem; amber where the water ran more than 0.5 ft beyond the prediction in
 * the direction that matters (higher at a high, lower at a low). Flood levels in muted red, mean higher high water
 * dashed, the moon's phases along the top, the hours ahead shaded. Drawn on the same time axis as the departure. */
function drawLadder(d: StationData, x0: number, x1: number): void {
  const plot = document.getElementById(`${d.meta.id}-hilo`);
  const svg = plot?.querySelector("svg");
  if (!plot || !svg) return;
  if (!TIDES) void loadTides();
  const W = Math.max(200, svg.clientWidth || plot.clientWidth - 44), H = Math.max(120, svg.clientHeight || 200);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const tide = TIDES?.[d.meta.id];
  const events = (tide?.hilo ?? d.tides).map((e) => ({ t: Date.parse(e.t) / 1000, ft: e.ft, type: e.type })).filter((e) => e.t >= x0 && e.t <= x1);
  if (!events.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="ld-note">${TIDES ? "No tides in this window." : "Loading the predictions."}</text>`;
    return;
  }
  const obsAt = (e: { t: number; type: string }) => {
    if (!d.level || e.t > Date.now() / 1000) return NaN;
    const near = [-2, -1, 0, 1, 2].map((k) => d.level!.at(Math.round(e.t / HOUR) * HOUR + k * HOUR)).filter(Number.isFinite);
    return near.length >= 3 ? (e.type === "H" ? Math.max(...near) : Math.min(...near)) : NaN;
  };
  const rows = events.map((e) => ({ ...e, o: obsAt(e) }));
  const fl = (tide?.flood_ft ?? {}) as Record<string, number | null | undefined>;
  const minor = fl.nws_minor ?? NaN, moderate = fl.nws_moderate ?? NaN, mhhw = tide?.datums_ft?.MHHW ?? NaN;
  const vals = rows.flatMap((r) => [r.ft, r.o]).filter(Number.isFinite);
  const hi = Math.max(...vals, [moderate, minor, mhhw, 0].find(Number.isFinite) ?? 0) + 0.3;
  const lo = Math.min(-1, Math.min(...vals) - 0.3);
  const top = 18, bot = 18;
  const x = (t: number) => ((t - x0) / (x1 - x0)) * W;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
  const now = Date.now() / 1000;
  const xn = Math.min(W, Math.max(0, x(now)));
  let g = `<rect x="${xn.toFixed(1)}" y="${top}" width="${(W - xn).toFixed(1)}" height="${H - top - bot}" fill="var(--panel)" opacity="0.75"/>`;
  const step = hi - lo > 8 ? 2.5 : hi - lo > 4 ? 1 : 0.5;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    g += `<line x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--chart-grid)"/><text x="${W + 6}" y="${(y(v) + 3).toFixed(1)}" class="ld-tick">${+v.toFixed(1)} ft</text>`;
  }
  // A label each Monday, at the same place and in the same words as the departure plot's (UTC dates at midnight).
  const fmtTick = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  for (let t = Math.ceil(x0 / DAY) * DAY; t <= x1; t += DAY) {
    const day = new Date(t * 1000);
    if (day.getUTCDay() !== 1) continue;
    g += `<text x="${x(t).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="ld-tick">${fmtTick.format(day)}</text>`;
  }
  const ref = (v: number, color: string, dash: string, label: string, above: boolean, left = false) => {
    if (!Number.isFinite(v)) return "";
    const yy = y(v).toFixed(1);
    return `<line x1="0" x2="${W}" y1="${yy}" y2="${yy}" stroke="${color}" stroke-width="1"${dash ? ` stroke-dasharray="${dash}"` : ""}/>` +
      `<text x="${left ? 2 : W - 2}" y="${(y(v) + (above ? -4 : 11)).toFixed(1)}" text-anchor="${left ? "start" : "end"}" class="ld-ref">${label}</text>`;
  };
  g += ref(moderate, "var(--wp-flood)", "6 3", "moderate flood", true);
  g += ref(minor, "var(--wp-flood)", "", "minor flood", false);
  g += ref(mhhw, "var(--faint)", "5 4", "MHHW", false, true);
  g += ref(0, "var(--faint)", "2 3", "MLLW", false, true);
  if (now >= x0 && now <= x1) g += `<line x1="${xn.toFixed(1)}" x2="${xn.toFixed(1)}" y1="${top - 4}" y2="${H - bot}" stroke="var(--wp-gold)" stroke-width="1.2"/><text x="${(xn + 5).toFixed(1)}" y="${H - bot - 6}" class="ld-ref">ahead: predicted</text>`;
  const beyond = (r: (typeof rows)[number]) => Number.isFinite(r.o) && (r.type === "H" ? r.o - r.ft : r.ft - r.o) > 0.5;
  for (const r of rows) if (Number.isFinite(r.o)) g += `<line x1="${x(r.t).toFixed(1)}" x2="${x(r.t).toFixed(1)}" y1="${y(r.ft).toFixed(1)}" y2="${y(r.o).toFixed(1)}" stroke="${beyond(r) ? "var(--wp-amber)" : "var(--wp-willow)"}" stroke-width="${beyond(r) ? 2 : 1.4}"/>`;
  for (const r of rows) {
    const when = fmtWhenMin.format(new Date(r.t * 1000));
    const kind = r.type === "H" ? "High" : "Low";
    g += `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.ft).toFixed(1)}" r="2.8" fill="var(--bg)" stroke="var(--ink-mute)" stroke-width="1"><title>${kind} ${when}: predicted ${r.ft.toFixed(1)} ft</title></circle>`;
    if (Number.isFinite(r.o)) g += `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.o).toFixed(1)}" r="3.1" fill="${beyond(r) ? "var(--wp-amber)" : "var(--wp-gold)"}"><title>${kind} ${when}: observed ${r.o.toFixed(1)} ft, predicted ${r.ft.toFixed(1)} ft (${r.o >= r.ft ? "+" : "-"}${Math.abs(r.o - r.ft).toFixed(1)} ft)</title></circle>`;
  }
  for (const m of MOON) {
    const t = Date.parse(m.t) / 1000;
    if (t >= x0 && t <= x1) g += `<g transform="translate(${x(t).toFixed(1)},7)"><title>${phaseName(m.phase)}, ${fmtWhen.format(new Date(t * 1000))}</title>${moonGlyph(m.phase)}</g>`;
  }
  if (AT != null && AT >= x0 && AT <= x1) g += `<line x1="${x(AT).toFixed(1)}" x2="${x(AT).toFixed(1)}" y1="${top}" y2="${H - bot}" stroke="var(--ink)" opacity="0.6"/>`;
  svg.innerHTML = g;
}

/** The highest predicted tide each day for the next five weeks at one station, as on the tides page: a bar per day
 * (amber 0.8 ft or more above mean higher high water, willow above it, pale below), the NWS minor flood level and
 * MHHW as labelled lines, the moon's phases above. */
function highestAheadHtml(stations: StationData[]): string {
  const pick = OUTLOOK_PEEK ?? OUTLOOK_PIN;
  const d = stations.find((s) => s.meta.id === pick && s.kind === "shore") ?? stations.find((s) => s.meta.id === "KPTN");
  const tide = d ? TIDES?.[d.meta.id] : undefined;
  if (!d || !tide?.hilo) return "";
  const now = Date.now() / 1000;
  const t0 = now - 14 * DAY, t1 = now + 35 * DAY;
  // The highest predicted tide each day, two weeks back to five weeks ahead; and the water's own highest in the past.
  const byDay = new Map<string, { t: number; ft: number; obs: number }>();
  for (const e of tide.hilo) {
    const t = Date.parse(e.t) / 1000;
    if (e.type !== "H" || t < t0 || t > t1) continue;
    const k = fmtDate.format(new Date(t * 1000));
    if (!byDay.has(k) || byDay.get(k)!.ft < e.ft) byDay.set(k, { t, ft: e.ft, obs: NaN });
  }
  if (d.level) for (const day of byDay.values()) {
    if (day.t > now) continue;
    let m = -Infinity;
    for (let h = Math.floor(day.t / HOUR) * HOUR - 2 * HOUR; h <= day.t + 2 * HOUR; h += HOUR) m = Math.max(m, d.level.at(h));
    day.obs = Number.isFinite(m) ? m : NaN;
  }
  const days = [...byDay.values()].sort((a, b) => a.t - b.t);
  const mhhw = tide.datums_ft?.MHHW ?? NaN, minor = tide.flood_ft?.nws_minor ?? NaN;
  if (days.length < 5 || !Number.isFinite(mhhw)) return "";
  const W = 480, H = 124, L = 34, top = 16, bot = 14, pw = W - L - 4;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * pw;
  const vals = days.flatMap((e) => [e.ft, e.obs]).filter(Number.isFinite);
  const lo = mhhw - 1.5, hi = Math.max(Number.isFinite(minor) ? minor : mhhw, ...vals) + 0.3;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
  const bw = Math.max(1.2, (pw / ((t1 - t0) / DAY)) * 0.55);
  let g = `<rect x="${x(now).toFixed(1)}" y="${top}" width="${(W - 4 - x(now)).toFixed(1)}" height="${H - top - bot}" class="hi-ahead-band"/>`;
  for (let v = Math.ceil(lo); v <= hi; v += 1) g += `<text x="${L - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v} ft</text>`;
  for (const e of days) {
    const c = e.ft >= mhhw + 0.8 ? "var(--wp-bar-high)" : e.ft >= mhhw ? "var(--wp-bar-mid)" : "var(--wp-bar-low)";
    const yt = y(Math.max(lo, e.ft));
    g += `<rect x="${(x(e.t) - bw / 2).toFixed(1)}" y="${yt.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - bot - yt).toFixed(1)}" fill="${c}"${e.t < now ? ' opacity="0.55"' : ""}><title>${fmtWhenMin.format(new Date(e.t * 1000))}: ${e.ft.toFixed(1)} ft predicted${Number.isFinite(e.obs) ? `, ${e.obs.toFixed(1)} ft observed` : ""}</title></rect>`;
    if (Number.isFinite(e.obs)) g += `<line x1="${(x(e.t) - bw / 2).toFixed(1)}" x2="${(x(e.t) + bw / 2).toFixed(1)}" y1="${y(e.obs).toFixed(1)}" y2="${y(e.obs).toFixed(1)}" class="hi-obs"/>`;
  }
  const ref = (v: number, color: string, dash: string, label: string) => (Number.isFinite(v)
    ? `<line x1="${L}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${color}"${dash ? ` stroke-dasharray="${dash}"` : ""}/><text x="${W - 2}" y="${(y(v) - 4).toFixed(1)}" text-anchor="end" class="ld-ref">${label}</text>`
    : "");
  g += ref(minor, "var(--wp-flood)", "", "NWS minor flood") + ref(mhhw, "var(--faint)", "5 4", "MHHW");
  const fmtTick = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", weekday: "short" });
  for (const e of days) {
    const parts = fmtTick.format(new Date(e.t * 1000));
    if (parts.startsWith("Mon")) g += `<text x="${x(e.t).toFixed(1)}" y="${H - 3}" text-anchor="middle">${parts.replace(/^Mon, /, "")}</text>`;
  }
  for (const m of MOON) {
    const t = Date.parse(m.t) / 1000;
    if (t >= t0 && t <= t1) g += `<g transform="translate(${x(t).toFixed(1)},6)"><title>${phaseName(m.phase)}, ${fmtWhen.format(new Date(t * 1000))}</title>${moonGlyph(m.phase, 3.5)}</g>`;
  }
  const cur = AT ?? now;
  if (cur >= t0 && cur <= t1) g += `<line x1="${x(cur).toFixed(1)}" x2="${x(cur).toFixed(1)}" y1="${top - 2}" y2="${H - bot}" class="hi-cursor"/>`;
  const ahead = days.filter((e) => e.t >= now);
  const peak = (ahead.length ? ahead : days).reduce((a, b) => (b.ft > a.ft ? b : a));
  const sw = (c: string) => `<i style="display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px;background:${c}"></i>`;
  return `<section class="hi-ahead" aria-label="Highest tides at ${d.meta.name}">
    <p class="ol-title">Highest tide each day &middot; ${d.meta.name} <span class="ol-hint">pick a row above</span></p>
    <svg viewBox="0 0 ${W} ${H}" class="hi-svg" role="img" aria-label="Highest tide each day, two weeks back to five weeks ahead">${g}</svg>
    <p class="status-key">highest ahead ${peak.ft.toFixed(1)} ft, ${fmtWhenMin.format(new Date(peak.t * 1000))}${Number.isFinite(minor) ? `; ${(minor - peak.ft).toFixed(1)} ft below minor flood` : ""}</p>
    <p class="status-key">${sw("var(--wp-bar-high)")}0.8 ft or more above MHHW ${sw("var(--wp-bar-mid)")}above ${sw("var(--wp-bar-low)")}below; <i style="display:inline-block;width:10px;height:0;border-top:1.6px solid var(--wp-gold);vertical-align:3px;margin-right:4px"></i>observed</p>
  </section>`;
}

/** The table's caption in the Tides view: the moon at the cursor's time (or now), then the time. */
function moonCaption(t: number): string {
  const ev = MOON.map((m) => ({ ...m, t: Date.parse(m.t) / 1000 }));
  const when = AT != null ? atLabel(AT) : "Now";
  if (!ev.length) return when;
  const near = ev.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const days = Math.round((t - near.t) / DAY);
  const name = phaseName(near.phase).replace(/^(first|last) quarter$/, "$1 quarter moon");
  const phrase = days === 0 ? `${name[0].toUpperCase()}${name.slice(1)}` : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "after" : "before"} the ${name}`;
  return `<svg class="cap-moon" width="11" height="11" viewBox="-5.5 -5.5 11 11" aria-hidden="true">${moonGlyph(near.phase, 4.2)}</svg>${phrase} &middot; ${when}`;
}

/** The Tides view's table: per shore station, the water against the prediction, the next high and low, and how far
 * the next high would stay below minor flooding if the current departure held. */
function tidesTable(stations: StationData[]): string {
  const shore = stations.filter((d) => d.kind === "shore");
  const at = AT ?? Date.now() / 1000;
  const rows = shore.map((d) => {
    const dep = departure(d);
    const depNow = AT != null ? (dep?.at(Math.floor(AT / HOUR) * HOUR) ?? NaN) : lastValue(dep);
    const next = (type: "H" | "L") => d.tides.find((e) => e.type === type && Date.parse(e.t) / 1000 > at);
    const hi = next("H"), lo = next("L");
    const minor = TIDES?.[d.meta.id]?.flood_ft?.nws_minor ?? null;
    const reach = hi && Number.isFinite(depNow) ? hi.ft + depNow : NaN;
    const ev = (e?: TideEvent) => (e ? `<td><b>${e.ft.toFixed(1)}<small class="g"> ft</small></b><small>${fmtWhenMin.format(new Date(e.t))}</small></td>` : `<td class="na">&middot;</td>`);
    const depCell = Number.isFinite(depNow) ? `<td title="Observed minus NOAA's prediction"><b>${signedFt(depNow)}<small class="g"> ft</small></b><small>vs prediction</small></td>` : `<td class="na">&middot;</td>`;
    const margin = minor != null && Number.isFinite(reach)
      ? `<td title="NWS minor flood ${minor.toFixed(1)} ft; next high ${hi!.ft.toFixed(1)} ft predicted, ${reach.toFixed(1)} ft with the current departure"><b>${(minor - reach).toFixed(1)}<small class="g"> ft</small></b><small>below</small></td>`
      : `<td class="na">&middot;</td>`;
    return `<tr><th scope="row"><a href="#${d.meta.id}"><i class="dot shore ${overallState(d)}"></i>${d.meta.name}</a></th>${levelCell(d)}${depCell}${ev(hi)}${ev(lo)}${margin}</tr>`;
  });
  return `<table class="status-grid" id="status-panel"><caption>${moonCaption(AT ?? Date.now() / 1000)}</caption>
    <thead><tr><th></th><th scope="col">Level</th><th scope="col">Departure</th><th scope="col">Next high</th><th scope="col">Next low</th><th scope="col">Below flood</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>
    <p class="status-key">feet above MLLW, preliminary; highs and lows predicted; below flood: the next high plus the current departure, against NWS minor flood</p>`;
}

/* ---------- The HRRR forecast at the stations ---------- */

/** The forecast job's runs at each station (the last 78 hours of HRRR cycles) and the verification of those
 * forecasts at the buoys. Loaded when a reader first looks ahead or opens Wind and waves. Values are raw HRRR,
 * never blended with observations: a time before now shows only what was measured. */
interface FcRun { issue: number; leads: number[]; u: (number | null)[]; v: (number | null)[]; gust: (number | null)[]; t2m: (number | null)[]; mslp: (number | null)[] }
interface FcStats { mae: number | null; air_mae: number | null; pressure_mae: number | null }
interface Verification { leads: number[]; by_lead: Record<string, { all: FcStats; buoys: Record<string, FcStats> }> }
interface FcValue { spd: number; dir: number; gust: number; air: number; pres: number; lead: number; issue: number; err: number; airErr: number }
let FCST: { runs: Record<string, FcRun[]>; ver: Verification | null; generated: number } | null = null;
let fcstLoading: Promise<void> | null = null;
let fcstRedraw: () => void = () => undefined;
let fcstPending = 0;
/** Data arriving together (eight station histories, the forecasts, the advisories) costs one redraw, a moment after the
 * last arrival, not one each. */
function requestFcstRedraw(): void {
  window.clearTimeout(fcstPending);
  fcstPending = window.setTimeout(() => fcstRedraw(), 60);
}
const MS_KT = 1.943844;
const fmtRun = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });

function loadForecast(): Promise<void> {
  fcstLoading ??= Promise.all([
    getJson<{ generated_at: string; cycles: Record<string, { leads: number[]; points: Record<string, Record<string, (number | null)[]>> }> }>(`${DATA}/forecast-hrrr.json`),
    getJson<Verification>(`${DATA}/forecast-verification.json`).catch(() => null),
  ])
    .then(([page, ver]) => {
      const runs: Record<string, FcRun[]> = {};
      for (const [key, c] of Object.entries(page.cycles)) {
        const issue = Date.parse(key.replace(/Z$/, ":00Z")) / 1000;
        for (const [id, f] of Object.entries(c.points)) {
          const none = c.leads.map(() => null);
          (runs[id] ??= []).push({ issue, leads: c.leads, u: f.u10 ?? none, v: f.v10 ?? none, gust: f.gust ?? none, t2m: f.t2m ?? none, mslp: f.mslp ?? none });
        }
      }
      Object.values(runs).forEach((r) => r.sort((a, b) => b.issue - a.issue));
      FCST = { runs, ver, generated: Date.parse(page.generated_at) / 1000 };
      requestFcstRedraw();
    })
    .catch(() => undefined);
  return fcstLoading;
}

/** HRRR's last forecast before each hour at a station (lead 1 to 3 h, from 2024; the jobs' hrrr_history.py): the
 * model's stand-in for the record where the station is out. Loaded per station when a plot first asks. */
const HRRR_HIST = new Map<string, Met | null>();
const hrrrHistLoading = new Set<string>();
type HistFile = { t0: string | null; wind_kt?: (number | null)[]; gust_kt?: (number | null)[]; dir_deg?: (number | null)[]; air_f?: (number | null)[]; pressure_mb?: (number | null)[] };
const RECENT_HIST = 99 * DAY; // the recent file holds 100 days (the inline plots reach 96 back); a day to spare

/** A station's HRRR history file ("WLIS" or "WLIS-recent"), loaded once; undefined while loading. A missing recent
 * file falls back to the full one. */
function histFile(name: string, id: string): Met | null | undefined {
  if (HRRR_HIST.has(name)) return HRRR_HIST.get(name);
  if (!hrrrHistLoading.has(name)) {
    hrrrHistLoading.add(name);
    const get = (n: string) => getJson<HistFile>(`${DATA}/hrrr-history/${n}.json`);
    get(name)
      .catch((err) => (name !== id ? get(id) : Promise.reject(err)))
      .then((h) => {
        HRRR_HIST.set(name, {
          wind: Hourly.fromArray(h.t0, h.wind_kt),
          gust: Hourly.fromArray(h.t0, h.gust_kt),
          dir: Hourly.fromArray(h.t0, h.dir_deg),
          air: Hourly.fromArray(h.t0, h.air_f),
          pressure: Hourly.fromArray(h.t0, h.pressure_mb),
          last: null,
        });
        requestFcstRedraw();
      })
      .catch(() => HRRR_HIST.set(name, null));
  }
  return undefined;
}

/** HRRR's last forecast before each hour, for a plot from x0 to x1: fetched only when the window has past hours
 * without a reading (the last 3 h are left out, as readings arrive late), from the recent file when the window lies
 * within it and the full one otherwise (a zoomed plot at full range). */
function hrrrHist(id: string, x0: number, x1: number, observed: (t: number) => number): Met | null {
  const nowS = Date.now() / 1000;
  const end = Math.min(x1, nowS - 3 * HOUR);
  let gap = false;
  for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= end; t += HOUR) {
    if (!Number.isFinite(observed(t))) {
      gap = true;
      break;
    }
  }
  if (!gap) return null;
  if (x0 >= nowS - RECENT_HIST) return histFile(`${id}-recent`, id) ?? null;
  // The full file; the recent one, if already in, meanwhile.
  return histFile(id, id) ?? HRRR_HIST.get(`${id}-recent`) ?? null;
}
const HRRR_HIST_LABEL = "HRRR, last forecast before each hour"; // drawn only where the station has no reading

/** The typical error (mean absolute, verified at the buoys) at a lead, between the verified leads. */
function typicalError(id: string, lead: number, key: keyof FcStats): number {
  const v = FCST?.ver;
  if (!v) return NaN;
  const at = (L: number) => (v.by_lead[L]?.buoys[id]?.[key] ?? v.by_lead[L]?.all[key] ?? NaN) as number;
  const ls = v.leads;
  if (lead <= ls[0]) return at(ls[0]);
  for (let i = 1; i < ls.length; i++) {
    if (lead <= ls[i]) return at(ls[i - 1]) + ((at(ls[i]) - at(ls[i - 1])) * (lead - ls[i - 1])) / (ls[i] - ls[i - 1]);
  }
  return at(ls[ls.length - 1]);
}

/** The newest run's forecast for a station and hour (epoch seconds), or null where no run reaches it. */
function forecastAt(id: string, t: number): FcValue | null {
  for (const r of FCST?.runs[id] ?? []) {
    const lead = Math.round((t - r.issue) / HOUR);
    if (lead < 1 || Math.abs(t - r.issue - lead * HOUR) > 60) continue;
    const i = r.leads.indexOf(lead);
    const u = r.u[i], v = r.v[i];
    if (i < 0 || u == null || v == null) continue;
    return {
      spd: Math.hypot(u, v) * MS_KT,
      dir: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360,
      gust: r.gust[i] != null ? r.gust[i]! * MS_KT : NaN,
      air: r.t2m[i] != null ? ((r.t2m[i]! - 273.15) * 9) / 5 + 32 : NaN,
      pres: r.mslp[i] != null ? r.mslp[i]! / 100 : NaN,
      lead,
      issue: r.issue,
      err: typicalError(id, lead, "mae"),
      airErr: (typicalError(id, lead, "air_mae") * 9) / 5,
    };
  }
  return null;
}

/* ---------- Wind across the Sound (the Wind view, under the table) ----------
 * One row per station that measures wind, west to east, grouped by NWS zone; each hour coloured by speed on the
 * map's wind scale. Measured hours first; where a buoy is out, the newest HRRR run fills in, hatched as a model; the
 * next 48 h are HRRR's forecast. A red ribbon over each zone marks the NWS advisories; a rule marks the page's time. */

const WS_STOPS: Record<Theme, [number, string][]> = {
  light: [[0, "#f1edf8"], [6, "#d9cdee"], [12, "#b7a2dd"], [18, "#9070c6"], [25, "#6a47a8"], [35, "#3f2477"]],
  dark: [[0, "#2b2440"], [6, "#3f3366"], [12, "#5d4a92"], [18, "#8167bd"], [25, "#a990dd"], [35, "#d6c7f5"]],
};
const WS_BACK = 14 * DAY, WS_AHEAD = 48 * HOUR;
const WS_REACH = { back: WS_BACK, ahead: 72 * HOUR }; // the time slider's hours scale in this view (timeline.ts)
const WS = { W: 480, L: 34, R: 4, top: 12, row: 8, ribbon: 3, gap: 7, bot: 13 };

function windColour(kt: number): string {
  const st = WS_STOPS[currentTheme()];
  const v = Math.max(0, Math.min(kt, st[st.length - 1][0]));
  let i = 1;
  while (i < st.length - 1 && v > st[i][0]) i++;
  const [k0, c0] = st[i - 1], [k1, c1] = st[i];
  const f = (v - k0) / (k1 - k0 || 1);
  const ch = (c: string, j: number) => parseInt(c.slice(1 + 2 * j, 3 + 2 * j), 16);
  return `rgb(${[0, 1, 2].map((j) => Math.round(ch(c0, j) + (ch(c1, j) - ch(c0, j)) * f)).join(",")})`;
}

/** The strip's time span (whole hours), shared by the drawing and the click handler. */
function windStripSpan(): { t0: number; t1: number } {
  const now = hourOf(Date.now() / 1000);
  return { t0: now - WS_BACK, t1: now + WS_AHEAD };
}

function soundWindHtml(stations: StationData[]): string {
  if (VK !== "wind") return "";
  if (!ADV) void loadAdvisories();
  if (!FCST) void loadForecast();
  // Buoys always (an outage is shown, not hidden); shore stations only where they measure wind (New London does not).
  const hasWind = (d: StationData) => !!d.met?.wind && Number.isFinite(d.met.wind.lastValid());
  const rows = stations.filter((d) => d.kind === "buoy" || ((d.kind === "shore" || d.kind === "airport") && hasWind(d))).sort((a, b) => a.meta.lon - b.meta.lon);
  if (!rows.length) return "";
  // Zones in the order their first station appears, west to east; stations keep their order within a zone.
  const zoneOrder: string[] = [];
  for (const d of rows) {
    const z = zoneOf(d.meta.id) ?? "";
    if (!zoneOrder.includes(z)) zoneOrder.push(z);
  }
  const groups = zoneOrder.map((z) => ({ z, rows: rows.filter((d) => (zoneOf(d.meta.id) ?? "") === z) }));
  const { W, L: X0, R: XR, top, row, ribbon, gap, bot } = WS;
  const nowS = Date.now() / 1000;
  const { t0, t1 } = windStripSpan();
  const pw = W - X0 - XR;
  const x = (t: number) => X0 + ((t - t0) / (t1 - t0)) * pw;
  const H = top + groups.reduce((h, g) => h + ribbon + 2 + g.rows.length * row, 0) + gap * (groups.length - 1) + bot;
  const u = WIND_UNITS[WU];
  const fmtU = (kt: number) => `${windFmt(kt)} ${u.label}`;
  let g = `<defs><pattern id="ws-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" class="ws-hatch-line"/></pattern></defs>`;
  g += `<rect x="${x(nowS).toFixed(1)}" y="${top - 2}" width="${(W - XR - x(nowS)).toFixed(1)}" height="${H - top - bot + 2}" class="hi-ahead-band"/>`;
  let y = top;
  for (const grp of groups) {
    // The zone's advisory ribbon.
    g += `<rect x="${X0}" y="${y}" width="${pw}" height="${ribbon}" class="ws-ribbon"/>`;
    if (grp.z) {
      g += `<text x="${X0 - 4}" y="${y + ribbon + 0.5}" text-anchor="end" class="ws-zone">${grp.z}</text>`;
      const name = ADV?.zones[grp.z]?.name ?? grp.z;
      for (const a of advisoriesFor(grp.rows[0].meta.id)) {
        if (!(a.kind in ADV_WIND) || a.t1 <= t0 || a.t0 >= t1) continue;
        const xa = x(Math.max(t0, a.t0)), xb = x(Math.min(t1, a.t1));
        g += `<rect x="${xa.toFixed(1)}" y="${y}" width="${Math.max(0.8, xb - xa).toFixed(1)}" height="${ribbon}" class="ws-adv${ADV_WIND[a.kind] ? " ws-adv-hi" : ""}"><title>${ADV!.kinds[a.kind]}, ${grp.z} (${name}): ${fmtWhenMin.format(new Date(a.t0 * 1000))} to ${fmtWhenMin.format(new Date(a.t1 * 1000))}</title></rect>`;
      }
    }
    y += ribbon + 2;
    for (const d of grp.rows) {
      g += `<text x="${X0 - 4}" y="${(y + row - 1.5).toFixed(1)}" text-anchor="end"><title>${d.meta.name}</title>${d.meta.id}</text>`;
      // Hours merged into runs of the same whole-knot speed and source, so the strip stays a few hundred shapes.
      type Run = { a: number; b: number; kt: number; src: "obs" | "model" | "fcst"; lead?: number };
      const runs: Run[] = [];
      for (let h = t0; h < t1; h += HOUR) {
        const obs = h <= nowS ? d.met?.wind?.at(h) ?? NaN : NaN;
        let kt = obs, src: Run["src"] = "obs", lead: number | undefined;
        if (!Number.isFinite(kt)) {
          // Past hours: a model only where a buoy is out; a shore station's gap stays a gap. Ahead: the forecast.
          if (h <= nowS && d.kind !== "buoy") continue;
          const f = forecastAt(d.meta.id, h);
          if (!f) continue;
          kt = f.spd;
          src = h > nowS ? "fcst" : "model";
          lead = f.lead;
        }
        const q = Math.round(kt);
        const last = runs[runs.length - 1];
        if (last && last.b === h && last.kt === q && last.src === src) last.b = h + HOUR;
        else runs.push({ a: h, b: h + HOUR, kt: q, src, lead });
      }
      for (const r of runs) {
        const xa = x(r.a), w = Math.max(0.6, x(r.b) - xa);
        const what = r.src === "obs" ? "measured" : r.src === "model" ? "HRRR at the station, the newest run for the hour; a model, not a measurement" : "HRRR forecast";
        g += `<rect x="${xa.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${row - 1}" fill="${windColour(r.kt)}"${r.src === "fcst" ? ' opacity="0.8"' : ""}><title>${d.meta.name}: ${fmtU(r.kt)}, ${fmtWhenMin.format(new Date(r.a * 1000))}${r.b - r.a > HOUR ? ` to ${fmtWhenMin.format(new Date(r.b * 1000))}` : ""} (${what})</title></rect>`;
        if (r.src === "model") g += `<rect x="${xa.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${row - 1}" fill="url(#ws-hatch)" pointer-events="none"/>`;
      }
      y += row;
    }
    y += gap;
  }
  // Days: a tick at each Eastern midnight, labelled on Mondays; "now" and the page's time.
  const fmtTick = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", weekday: "short", hour: "numeric", hourCycle: "h23" });
  for (let h = t0; h <= t1; h += HOUR) {
    const p = fmtTick.formatToParts(new Date(h * 1000));
    if (p.find((q) => q.type === "hour")?.value !== "00") continue;
    g += `<line x1="${x(h).toFixed(1)}" x2="${x(h).toFixed(1)}" y1="${H - bot}" y2="${H - bot + 2.5}" class="ws-tick"/>`;
    if (p.find((q) => q.type === "weekday")?.value === "Mon")
      g += `<text x="${x(h).toFixed(1)}" y="${H - 2}" text-anchor="middle">${p.find((q) => q.type === "month")!.value} ${p.find((q) => q.type === "day")!.value}</text>`;
  }
  g += `<line x1="${x(nowS).toFixed(1)}" x2="${x(nowS).toFixed(1)}" y1="${top - 4}" y2="${H - bot}" class="ws-now"/><text x="${x(nowS).toFixed(1)}" y="${top - 5}" text-anchor="middle" class="ws-zone">now</text>`;
  const cur = AT ?? null;
  if (cur != null && cur >= t0 && cur <= t1) g += `<line x1="${x(cur).toFixed(1)}" x2="${x(cur).toFixed(1)}" y1="${top - 2}" y2="${H - bot}" class="hi-cursor"/>`;
  // The span the time slider reaches (all of it, in this view): the part a click acts on.
  const r0 = Math.max(t0, nowS - WS_REACH.back), r1 = Math.min(t1, nowS + WS_REACH.ahead);
  g += `<rect x="${x(r0).toFixed(1)}" y="${top - 2}" width="${(x(r1) - x(r0)).toFixed(1)}" height="${H - top - bot + 2}" class="ws-hit"><title>Click to move the page's time</title></rect>`;
  const sw = (fill: string, extra = "") => `<svg width="10" height="9" class="ws-sw" aria-hidden="true"><rect width="10" height="9" fill="${fill}"${extra}/></svg>`;
  const ramp = `<svg width="64" height="9" class="ws-sw" aria-hidden="true"><defs><linearGradient id="ws-ramp">${WS_STOPS[currentTheme()].map(([k, c]) => `<stop offset="${(k / 35).toFixed(3)}" stop-color="${c}"/>`).join("")}</linearGradient></defs><rect width="64" height="9" fill="url(#ws-ramp)"/></svg>`;
  return `<section class="ws" id="${WIND_STRIP_HASH.slice(1)}" aria-label="Wind across the Sound">
    <p class="ol-title">Wind across the Sound <span class="ol-src">west to east, by NWS zone; two weeks back, 48 h ahead &middot; click to move the time</span></p>
    <svg viewBox="0 0 ${W} ${H}" class="hi-svg ws-svg" role="img" aria-label="Hourly wind at each station, two weeks back to 48 hours ahead, with NWS advisories">${g}</svg>
    <p class="status-key">0 ${ramp} ${fmtU(35)} &middot; <svg width="10" height="9" class="ws-sw" aria-hidden="true"><rect width="10" height="9" fill="${windColour(16)}"/><rect width="10" height="9" fill="url(#ws-hatch)"/></svg>model where a buoy is out &middot; past now: HRRR forecast${(() => { const a = hrrrAsOf(rows[0].meta.id, Array.from({ length: 48 }, (_, i) => hourOf(nowS) + (i + 1) * HOUR)); return a ? `, ${a}` : ""; })()} &middot; ${sw("var(--advisory)", ' opacity="0.45"')}small craft ${sw("var(--advisory)")}gale or stronger (NWS)</p>
  </section>`;
}

/** A table cell holding a forecast: marked as HRRR, with its typical error, never as a measurement. */
function fcCell(f: FcValue, shown: string, title: string, errText: string): string {
  return `<td class="fcst" title="${title}. HRRR forecast from the ${fmtRun.format(new Date(f.issue * 1000))} run, ${f.lead} h ahead; typically within ${errText} at this lead (verified at the buoys)."><b>${shown}</b><small>HRRR ${errText}</small></td>`;
}

/** The forecast's vintage over some hours at a station: the HRRR run behind each stretch, in order (the hourly runs
 * reach 18 h, the 00, 06, 12 and 18 UTC runs 48 h, so a 48 h forecast is usually two runs). "" before the runs load. */
function hrrrAsOf(id: string, ts: number[]): string {
  const segs: { issue: number; from: number }[] = [];
  const nowH = hourOf(Date.now() / 1000);
  for (const t of ts) {
    if (t < nowH) continue;
    const f = forecastAt(id, hourOf(t));
    if (!f) continue;
    if (segs[segs.length - 1]?.issue !== f.issue) segs.push({ issue: f.issue, from: hourOf(t) });
  }
  if (!segs.length) return "";
  const run = (issue: number) => `${fmtRun.format(new Date(issue * 1000))} run`;
  return `as of the ${run(segs[0].issue)}${segs.slice(1, 3).map((g) => `, then the ${run(g.issue)} from ${fmtWhenMin.format(new Date(g.from * 1000))}`).join("")}`;
}

/** The newest NWS wave model run: "as of the Fri 8 PM run". */
function nwpsAsOf(): string {
  const r = NWPS?.runs[0];
  return r ? `as of the ${fmtRun.format(new Date(r.issue * 1000))} run` : "";
}

/* ---------- Model stand-ins while a buoy's sensors are out ----------
 * For an hour with no reading, the newest model run that covers it, at the buoy: HRRR (3 km) for wind, air and
 * pressure; NWS NWPS (SWAN, about 1.8 km) for waves. Shown under the fault, never in its place, and labelled as a
 * model; the outage stays an open fault. */

interface NwpsRun { issue: number; steps: number[]; points: Record<string, Record<string, (number | null)[]>> }
interface NwpsValue { hs: number; tp: number; dir: number; lead: number; issue: number }
let NWPS: { runs: NwpsRun[]; cells: Record<string, { lat: number; lon: number; km: number }> } | null = null;
let nwpsLoading: Promise<void> | null = null;

function loadNwps(): Promise<void> {
  nwpsLoading ??= getJson<{ cells: Record<string, { lat: number; lon: number; km: number }>; runs: Record<string, { steps: number[]; points: NwpsRun["points"] }> }>(`${DATA}/waves-nwps.json`)
    .then((p) => {
      const runs = Object.entries(p.runs).map(([k, r]) => ({ issue: Date.parse(k.replace(/Z$/, ":00Z")) / 1000, steps: r.steps, points: r.points }));
      runs.sort((a, b) => b.issue - a.issue);
      NWPS = { runs, cells: p.cells };
      requestFcstRedraw();
    })
    .catch(() => undefined);
  return nwpsLoading;
}

/** The newest NWPS run's waves at a buoy for an hour (epoch seconds), or null where no run covers it. */
function nwpsAt(id: string, t: number): NwpsValue | null {
  for (const r of NWPS?.runs ?? []) {
    const lead = Math.round((t - r.issue) / HOUR);
    if (lead < 0 || Math.abs(t - r.issue - lead * HOUR) > 60) continue;
    const i = r.steps.indexOf(lead);
    const p = r.points[id];
    const hs = i < 0 || !p ? null : p.hs?.[i];
    if (hs == null) continue;
    return { hs, tp: p.tp?.[i] ?? NaN, dir: p.dir?.[i] ?? NaN, lead, issue: r.issue };
  }
  return null;
}

/** NWPS waves on a time grid (for the wave plot): the newest run covering each hour, linear between hours. */
function nwpsSeries(id: string, xs: number[]): number[] {
  return xs.map((t) => {
    const h = Math.floor(t / HOUR) * HOUR;
    const a = nwpsAt(id, h), b = nwpsAt(id, h + HOUR);
    if (!a) return NaN;
    return b ? a.hs + ((b.hs - a.hs) * (t - h)) / HOUR : a.hs;
  });
}

const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;

/* ---------- NWS marine advisories (M14) ----------
 * Warnings and advisories NWS New York issued for each station's forecast zone, from the IEM VTEC archive. Before
 * April 2021 the eastern Sound was one zone (ANZ330), whose events stand for both of today's eastern zones. */

interface Advisories {
  kinds: Record<string, string>;
  zones: Record<string, { name: string; stations: string[] }>;
  retired: Record<string, { until: string; into: string[]; name: string }>;
  events: Record<string, [string, string, string, string][]>;
}
interface Advisory { kind: string; t0: number; t1: number; zone: string }
let ADV: Advisories | null = null;
let advLoading: Promise<void> | null = null;
const ADV_CACHE = new Map<string, Advisory[]>();
// Shaded behind the wind: small craft (lighter), gale and stronger (darker). Fog and the rest are not about wind.
const ADV_WIND: Record<string, 0 | 1> = { "SC.Y": 0, "SE.W": 0, "GL.W": 1, "SR.W": 1, "HF.W": 1, "TR.W": 1, "HU.W": 1 };

function loadAdvisories(): Promise<void> {
  advLoading ??= getJson<Advisories>(`${DATA}/advisories.json`)
    .then((a) => {
      ADV = a;
      ADV_CACHE.clear();
      requestFcstRedraw();
    })
    .catch(() => undefined);
  return advLoading;
}

const advTime = (s: string) => Date.parse(s.replace(/Z$/, ":00Z")) / 1000;

function zoneOf(id: string): string | null {
  for (const [z, v] of Object.entries(ADV?.zones ?? {})) if (v.stations.includes(id)) return z;
  return null;
}

/** A station's advisories, oldest first: its zone's, and the retired zone's before the split. */
function advisoriesFor(id: string): Advisory[] {
  if (!ADV) return [];
  const hit = ADV_CACHE.get(id);
  if (hit) return hit;
  const z = zoneOf(id);
  const out: Advisory[] = [];
  if (z) {
    for (const [old, r] of Object.entries(ADV.retired ?? {})) {
      if (!r.into.includes(z)) continue;
      const until = advTime(r.until);
      for (const e of ADV.events[old] ?? []) if (advTime(e[1]) < until) out.push({ kind: e[0], t0: advTime(e[1]), t1: Math.min(advTime(e[2]), until), zone: old });
    }
    for (const e of ADV.events[z] ?? []) out.push({ kind: e[0], t0: advTime(e[1]), t1: advTime(e[2]), zone: z });
  }
  out.sort((a, b) => a.t0 - b.t0);
  ADV_CACHE.set(id, out);
  return out;
}

/** The HRRR stand-in for a buoy at a time: only for buoys, and only where the newest run reaches the hour. */
function hrrrStandIn(d: StationData, t: number): FcValue | null {
  if (d.kind !== "buoy") return null;
  if (!FCST) void loadForecast();
  return forecastAt(d.meta.id, hourOf(t));
}

function runText(issue: number, lead: number): string {
  return `${fmtRun.format(new Date(issue * 1000))} run, ${lead} h ahead`;
}

const SOUND_ZONES = ["ANZ335", "ANZ331", "ANZ332"];

/** The Sound's zones with a wind advisory in force at a time (epoch seconds): from NWS's active alerts for the
 * present (the hourly file), from the daily record for earlier times; the most severe per zone. */
function zonesInForce(t: number): { id: string; strong: boolean; title: string }[] {
  const out = new Map<string, { id: string; strong: boolean; title: string; rank: number }>();
  const put = (id: string, kind: string, name: string, t0: number, t1: number) => {
    if (!(kind in ADV_WIND) || t < t0 || t >= t1) return;
    const rank = ADV_WIND[kind];
    if ((out.get(id)?.rank ?? -1) >= rank) return;
    out.set(id, { id, strong: rank > 0, rank, title: `${name}, ${id}: ${fmtWhenMin.format(new Date(t0 * 1000))} to ${fmtWhenMin.format(new Date(t1 * 1000))}` });
  };
  const now = alertsNow();
  for (const a of now?.alerts ?? []) {
    for (const z of a.zones) {
      const sp = a.by_zone?.[z];
      const t0 = sp?.from ? Date.parse(sp.from) / 1000 : Date.parse(now!.generated_at) / 1000;
      const t1 = Date.parse(sp?.until ?? a.ends ?? "") / 1000;
      if (Number.isFinite(t1)) put(z, a.kind, a.event, t0, t1);
    }
  }
  if (ADV) {
    for (const z of SOUND_ZONES) {
      const own = (ADV.events[z] ?? []).map((e) => [e[0], advTime(e[1]), advTime(e[2])] as const);
      const old = Object.entries(ADV.retired ?? {}).filter(([, r]) => r.into.includes(z))
        .flatMap(([o, r]) => (ADV!.events[o] ?? []).map((e) => [e[0], advTime(e[1]), Math.min(advTime(e[2]), advTime(r.until))] as const));
      for (const [kind, t0, t1] of [...old, ...own]) put(z, kind, ADV.kinds[kind] ?? kind, t0, t1);
    }
  }
  return [...out.values()].map(({ id, strong, title }) => ({ id, strong, title }));
}

/** Outline on the map the zones in force at the page's time (the record loads when the cursor goes back). */
async function syncZones(): Promise<void> {
  if (EMBED) return; // no map in an embed
  const t = AT ?? Date.now() / 1000;
  if (!ADV && t < Date.now() / 1000 - HOUR) void loadAdvisories();
  try {
    (await import("./map")).setAdvisoryZones(zonesInForce(t));
  } catch {
    /* map not loaded */
  }
}

/** A fault cell with the model's value under it: the fault first ("--", why), then the model, marked as such. */
function standInCell(fault: string, faultTitle: string, model: string, modelTitle: string, cls = ""): string {
  return `<td class="offline standin${cls ? ` ${cls}` : ""}" title="${faultTitle}"><b>--</b><small>${fault}</small><small class="model" title="${modelTitle}. A model value, not a measurement; the buoy's own sensor is out.">${model}</small></td>`;
}

function windModelCell(d: StationData, t: number, fault: string, faultTitle: string): string | null {
  const f = hrrrStandIn(d, t);
  if (!f) return null;
  const u = WIND_UNITS[WU].label;
  return standInCell(fault, faultTitle, `model ${compass(f.dir)} ${windFmt(f.spd)} ${u}`, `HRRR at the buoy: wind ${windFmt(f.spd)} ${u} from ${compass(f.dir)}, gusts ${windFmt(f.gust)} ${u}; ${runText(f.issue, f.lead)}, typically within ${windFmt(f.err)} ${u}`);
}

const FORECAST_PAGE = "/long-island-sound/forecast/";
/** The verification tag: HRRR's typical miss at the buoys for this hour's lead at a station (the first in the table), linked to the page. */
function verTag(t?: number, id?: string): string {
  const f = t != null && id ? forecastAt(id, hourOf(t)) : null;
  const n = FCST?.ver ? Object.values(FCST.ver.by_lead).reduce((a, b) => a + ((b.all as FcStats & { n?: number }).n ?? 0), 0) : 0;
  const what = f ? `typical miss &plusmn;${windFmt(f.err)} ${WIND_UNITS[WU].label} at ${f.lead} h ahead` : "verified at the buoys";
  return `<a class="ver-tag" href="${FORECAST_PAGE}" title="HRRR scored against the buoys${n ? ` over ${n.toLocaleString("en-US")} forecast hours` : ""}">${what}</a>`;
}

/* ---------- Outlook: the next 48 hours at one station ---------- */

// "Sat 1 PM": the weekday and the hour, without Intl's comma.
const noComma = (f: Intl.DateTimeFormat) => ({ format: (d: Date) => f.format(d).replace(",", "") });
const fmtWhen = noComma(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" }));
const fmtWhenMin = noComma(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }));
const fmtHourET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
/** "Sat 1p", "Fri 3:34a": short times for the outlook's text column. */
const shortWhen = (ms: number, minutes = false) =>
  (minutes ? fmtWhenMin : fmtWhen).format(new Date(ms)).replace(/:00 /, " ").replace(" AM", "a").replace(" PM", "p");

let OUTLOOK_PIN = "EXRX"; // the station the outlook shows: Execution Rocks until a reader picks another row
let OUTLOOK_PEEK: string | null = null; // the row under the pointer, shown while it is there
const OL_W = 160;
const OL_H = 22;

/** The nearest NOAA tide gauge to a station (a shore station is its own). */
function tideGauge(d: StationData, stations: StationData[]): StationData | undefined {
  if (d.kind === "shore") return d;
  const shore = stations.filter((s) => s.kind === "shore");
  const k = Math.cos((d.meta.lat * Math.PI) / 180);
  const dist = (s: StationData) => (s.meta.lat - d.meta.lat) ** 2 + ((s.meta.lon - d.meta.lon) * k) ** 2;
  return shore.length ? shore.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : undefined;
}

const olX = (t: number, t0: number) => ((t - t0) / (48 * HOUR)) * OL_W;

/** Midnights (Eastern) as faint ticks, so every row reads on the same days. */
function olDays(t0: number): string {
  let out = "";
  for (let h = 1; h < 48; h++) {
    const t = t0 + h * HOUR;
    if (fmtHourET.format(new Date(t * 1000)) === "0") out += `<line x1="${olX(t, t0).toFixed(1)}" x2="${olX(t, t0).toFixed(1)}" y1="0" y2="${OL_H}" stroke="currentColor" opacity="0.18"/>`;
  }
  return out;
}

/** One quantity over the next 48 hours on the outlook's shared time axis, its peak (or low) marked by a tick. */
function olSpark(ts: number[], ys: number[], t0: number, mark: "max" | "min"): string {
  const ok = ys.filter(Number.isFinite);
  if (ok.length < 2) return `<span class="ol-spark"></span>`;
  const a = Math.min(...ok), b = Math.max(...ok);
  const y = (v: number) => OL_H - 3 - ((v - a) / Math.max(1e-6, b - a)) * (OL_H - 6);
  let path = "";
  let pen = false;
  ts.forEach((t, i) => {
    const v = ys[i];
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${olX(t, t0).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const k = ys.indexOf(mark === "max" ? b : a);
  return `<svg class="ol-spark" viewBox="0 0 ${OL_W} ${OL_H}" preserveAspectRatio="none" aria-hidden="true">${olDays(t0)}<path d="${path}" fill="none" stroke="${P.line}" stroke-width="1.4" vector-effect="non-scaling-stroke"/><line x1="${olX(ts[k], t0).toFixed(1)}" x2="${olX(ts[k], t0).toFixed(1)}" y1="${(y(ys[k]) - 5).toFixed(1)}" y2="${(y(ys[k]) + 5).toFixed(1)}" stroke="${P.line}" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
}

/** The tide on the same axis: NOAA's predicted water level as a curve (it shows the unequal highs of the day), with
 * a tick at each high, amber where the high comes within 1 ft of the NWS minor flood level. */
function olTides(g: StationData | undefined, t0: number): string {
  const p = g ? TIDES?.[g.meta.id]?.pred : undefined;
  if (!g || !p) return `<span class="ol-spark"></span>`;
  const p0 = Date.parse(p.t0) / 1000;
  const ts: number[] = [];
  const ys: number[] = [];
  for (let t = t0; t <= t0 + 48 * HOUR; t += p.step) {
    const v = p.ft[Math.round((t - p0) / p.step)];
    ts.push(t);
    ys.push(v == null ? NaN : v);
  }
  const ok = ys.filter(Number.isFinite);
  if (ok.length < 4) return `<span class="ol-spark"></span>`;
  const a = Math.min(...ok), b = Math.max(...ok);
  const y = (v: number) => OL_H - 3 - ((v - a) / Math.max(1e-6, b - a)) * (OL_H - 6);
  let path = "";
  let pen = false;
  ts.forEach((t, i) => {
    if (!Number.isFinite(ys[i])) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${olX(t, t0).toFixed(1)},${y(ys[i]).toFixed(1)}`;
    pen = true;
  });
  const minor = TIDES?.[g.meta.id]?.flood_ft?.nws_minor ?? null;
  const ticks = g.tides
    .filter((e) => e.type === "H" && Date.parse(e.t) / 1000 > t0 && Date.parse(e.t) / 1000 <= t0 + 48 * HOUR)
    .map((e) => {
      const x = olX(Date.parse(e.t) / 1000, t0).toFixed(1);
      const c = minor != null && minor - e.ft < 1 ? P.delayed : P.line;
      return `<line x1="${x}" x2="${x}" y1="${(y(e.ft) - 5).toFixed(1)}" y2="${(y(e.ft) + 5).toFixed(1)}" stroke="${c}" stroke-width="1.2" vector-effect="non-scaling-stroke"><title>High ${e.ft.toFixed(1)} ft, ${shortWhen(Date.parse(e.t), true)}</title></line>`;
    })
    .join("");
  return `<svg class="ol-spark" viewBox="0 0 ${OL_W} ${OL_H}" preserveAspectRatio="none" aria-hidden="true">${olDays(t0)}<path d="${path}" fill="none" stroke="${P.line}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>${ticks}</svg>`;
}

/** The range of the recent runs' forecasts for one station and hour: how far they disagree. */
function runSpread(id: string, t: number): [number, number] | null {
  const now = Date.now() / 1000;
  const vals = (FCST?.runs[id] ?? [])
    .filter((r) => r.issue <= now)
    .map((r) => {
      const i = r.leads.indexOf(Math.round((t - r.issue) / HOUR));
      const u = r.u[i], v = r.v[i];
      return i < 0 || u == null || v == null ? NaN : Math.hypot(u, v) * MS_KT;
    })
    .filter(Number.isFinite);
  return vals.length >= 3 ? [Math.min(...vals), Math.max(...vals)] : null;
}

/** The Outlook, in Wind and waves only: the next 48 hours at one station, every row on the same time axis.
 * Empty until the forecast has loaded. */
function outlookHtml(stations: StationData[]): string {
  if (VK !== "wind") return "";
  if (!FCST) {
    void loadForecast();
    return "";
  }
  const id = OUTLOOK_PEEK ?? OUTLOOK_PIN;
  const d = stations.find((s) => s.meta.id === id) ?? stations.find((s) => s.kind === "buoy");
  if (!d) return "";
  const t0 = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const ts = Array.from({ length: 48 }, (_, h) => t0 + (h + 1) * HOUR);
  const fs = ts.map((t) => forecastAt(d.meta.id, t));
  if (fs.filter(Boolean).length < 6) return "";
  const col = (f: (v: FcValue) => number) => fs.map((v) => (v ? f(v) : NaN));
  const spd = col((v) => v.spd), gust = col((v) => v.gust), pres = col((v) => v.pres), air = col((v) => v.air);
  const at = (ys: number[], best: number) => ts[ys.indexOf(best)] * 1000;
  const fin = (ys: number[]) => ys.filter(Number.isFinite);
  const u = WIND_UNITS[WU].label;
  const pk = Math.max(...fin(spd)), gk = Math.max(...fin(gust)), pl = Math.min(...fin(pres));
  const pkF = fs[spd.indexOf(pk)]!;
  const spread = runSpread(d.meta.id, ts[spd.indexOf(pk)]);
  const g = tideGauge(d, stations);
  const hi = (g?.tides ?? []).find((e) => e.type === "H" && Date.parse(e.t) > Date.now());
  const airs = fin(air);
  const rows: [string, string, string][] = [
    ["Wind", olSpark(ts, spd.map(windVal), t0, "max"),
      `${windFmt(pk)} ${u} ${shortWhen(at(spd, pk))} ${compass(pkF.dir)}${spread ? ` <small>runs ${windFmt(spread[0])} to ${windFmt(spread[1])}</small>` : ""}`],
    ["Gusts", olSpark(ts, gust.map(windVal), t0, "max"), `${windFmt(gk)} ${u} ${shortWhen(at(gust, gk))}`],
    ["Pressure", olSpark(ts, pres, t0, "min"), `${pl.toFixed(0)} mb ${shortWhen(at(pres, pl))}`],
    ["Air", olSpark(ts, air, t0, "max"), airs.length ? `${Math.round(Math.min(...airs))} to ${Math.round(Math.max(...airs))}&deg;F` : "--"],
  ];
  // Waves: the NWS wave model at a buoy (the newest run for each hour), in place of the tide curve; a shore station,
  // which the wave model does not reach, keeps its tide row. The next high tide stays as a line under the rows.
  if (!NWPS) void loadNwps();
  const hs = d.kind === "buoy" ? ts.map((t) => nwpsAt(d.meta.id, t)?.hs ?? NaN) : [];
  const hsOk = fin(hs);
  const tideText = hi ? `high ${hi.ft.toFixed(1)} ft ${shortWhen(Date.parse(hi.t), true)}` : "--";
  if (hsOk.length >= 6) {
    const wu = waveUnit();
    const hk = Math.max(...hsOk);
    const pkW = nwpsAt(d.meta.id, ts[hs.indexOf(hk)]);
    rows.push([`Waves <small>model</small>`, olSpark(ts, hs.map((m) => m * wu.factor), t0, "max"),
      `${waveFmt(hk)} ${wu.label} ${shortWhen(at(hs, hk))}${pkW && Number.isFinite(pkW.tp) ? ` &middot; ${pkW.tp.toFixed(0)} s` : ""} <small>NWPS, ${nwpsAsOf().replace(/^as of the /, "")}</small>`]);
  } else {
    rows.push([g && g !== d ? `Tide <small>${g.meta.name}</small>` : "Tide", olTides(g, t0), tideText]);
  }
  const tideLine = hsOk.length >= 6 && hi
    ? `<p class="status-key ol-tide">Next high tide ${g && g !== d ? `at ${g.meta.name} ` : ""}${hi.ft.toFixed(1)} ft, ${shortWhen(Date.parse(hi.t), true)}</p>`
    : "";
  return `<section class="outlook" aria-label="The next 48 hours at ${d.meta.name}">
    <p class="ol-title">Next 48 h &middot; ${d.meta.name} <span class="ol-hint">pick a row above</span><span class="ol-src">NOAA HRRR, raw${(() => { const a = hrrrAsOf(d.meta.id, ts); return a ? `, ${a}` : ""; })()} &middot; <a href="${FORECAST_PAGE}">verified at the buoys</a></span></p>
    ${rows.map(([k, sp, txt]) => `<div class="ol-row"><span class="ol-k">${k}</span>${sp}<span class="ol-v">${txt}</span></div>`).join("")}
    ${tideLine}
  </section>`;
}

/** The table row whose station the outlook shows, marked. */
function markOutlookRow(): void {
  const on = OUTLOOK_PEEK ?? OUTLOOK_PIN;
  document.querySelectorAll<HTMLTableRowElement>("#status tbody tr").forEach((tr) => {
    const id = tr.querySelector<HTMLAnchorElement>('th a[href^="#"]')?.getAttribute("href")?.slice(1);
    const shown = VK === "tides" && !STATIONS.some((d) => d.meta.id === on && d.kind === "shore") ? "KPTN" : on;
    tr.classList.toggle("ol-on", (VK === "wind" || VK === "tides") && id === shown);
  });
  syncSchematic();
}
/* ---------- The schematic Sound (Tides view) ---------- */

/** The Tides view draws the Sound as a diagram over the map box: the gauges are points, and a basemap would invite
 * the eye to read the water between them, which is not measured. The outline (public/schematic-lis.json, from
 * scripts/build-schematic.py) is the currents model's coastline smoothed at 1 km, north up, at true scale, in km east
 * and north of Kings Point. Each gauge on the site carries its level and its departure from NOAA's prediction at the
 * timeline's time (ahead of the record, the predicted level); live USGS gauges not yet on the site are drawn as
 * dashed rings. */
interface Schematic {
  north: [number, number][];
  south: [number, number][];
  gauges: { id: string; name: string; side: "N" | "S"; kind: "site" | "usgs"; usgs?: string; at: [number, number] }[];
  islands?: [number, number][][];
  rivers?: { name: string; line: [number, number][] }[];
  fine?: { north: [number, number][]; south: [number, number][] };
}
let SCHEM: Schematic | null = null;
let schemLoading: Promise<void> | null = null;
let schemWired = false;
let tiltMode: "dep" | "level" = "dep"; // the diagram's tilt band: departure from prediction, or level from mean sea level
let tiltShore: "both" | "N" | "S" = "both"; // which shore's gauges the band joins (each shore its own line)
// The diagram's pan and zoom (k: scale, tx/ty: offset in px); while it moves, labels keep their offsets from their pins.
let schemView = { k: 1, tx: 0, ty: 0 };
let schemMoving = false;
let schemIdle = 0;
const schemRel = new Map<string, { dx0: number; dy0: number; dx1: number; dy1: number }>();
let schemLayout: { key: string; boxes: Map<string, { x0: number; y0: number; x1: number; y1: number }> } | null = null;

function syncSchematic(): void {
  const map = document.getElementById("map");
  if (!map) return;
  let box = map.querySelector<HTMLElement>(".schematic");
  if (VK !== "tides") {
    box?.remove();
    return;
  }
  if (!SCHEM) {
    schemLoading ??= getJson<Schematic>("/schematic-lis.json")
      .then((s) => {
        SCHEM = s;
        syncSchematic();
      })
      .catch(() => undefined);
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.className = "schematic";
    box.innerHTML = `<div class="sc-draw"></div><div class="sc-tilt-mode" role="group" aria-label="Tilt"><button type="button" data-mode="dep" aria-pressed="true">departure</button><button type="button" data-mode="level" aria-pressed="false">level</button><span class="sc-sep"></span><button type="button" data-shore="both" aria-pressed="true">both</button><button type="button" data-shore="N" aria-pressed="false">north shore</button><button type="button" data-shore="S" aria-pressed="false">Long Island</button></div><button type="button" class="sc-reset" hidden>Reset</button><button type="button" class="sc-ibtn" aria-expanded="false" aria-controls="sc-info" title="About this diagram">i</button><div class="sc-info" id="sc-info" hidden></div>`;
    map.appendChild(box);
    const btn = box.querySelector<HTMLButtonElement>(".sc-ibtn")!;
    const info = box.querySelector<HTMLElement>(".sc-info")!;
    const toggle = (open: boolean) => {
      info.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(info.hidden !== false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !info.hidden) toggle(false);
    });
    document.addEventListener("click", (e) => {
      if (!info.hidden && !info.contains(e.target as Node)) toggle(false);
    });
    box.querySelector(".sc-tilt-mode")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (b.dataset.mode) tiltMode = b.dataset.mode as "dep" | "level";
      if (b.dataset.shore) tiltShore = b.dataset.shore as "both" | "N" | "S";
      box!.querySelectorAll<HTMLButtonElement>(".sc-tilt-mode button[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.mode === tiltMode)));
      box!.querySelectorAll<HTMLButtonElement>(".sc-tilt-mode button[data-shore]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.shore === tiltShore)));
      syncSchematic();
    });
    const drawEl = box.querySelector<HTMLElement>(".sc-draw")!;
    const resetBtn = box.querySelector<HTMLButtonElement>(".sc-reset")!;
    const moved = () => {
      const w = drawEl.clientWidth, h = drawEl.clientHeight;
      const v = schemView;
      v.k = Math.min(8, Math.max(1, v.k));
      v.tx = Math.min(w * 0.25, Math.max(w * (1 - v.k) - w * 0.25, v.tx));
      v.ty = Math.min(h * 0.25, Math.max(h * (1 - v.k) - h * 0.25, v.ty));
      if (v.k === 1 && Math.abs(v.tx) < 1 && Math.abs(v.ty) < 1) v.tx = v.ty = 0;
      resetBtn.hidden = v.k === 1 && v.tx === 0 && v.ty === 0;
      schemMoving = true;
      requestAnimationFrame(syncSchematic);
      clearTimeout(schemIdle);
      schemIdle = window.setTimeout(() => {
        schemMoving = false;
        syncSchematic();
      }, 220);
    };
    const zoomAt = (cx: number, cy: number, f: number) => {
      const v = schemView;
      const k = Math.min(8, Math.max(1, v.k * f));
      v.tx = cx - ((cx - v.tx) * k) / v.k;
      v.ty = cy - ((cy - v.ty) * k) / v.k;
      v.k = k;
      moved();
    };
    drawEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = drawEl.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let pinch = 0;
    drawEl.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragged = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    drawEl.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (pointers.size === 1) {
        if (!dragged && Math.hypot(dx, dy) < 4) return;
        if (!dragged) drawEl.setPointerCapture(e.pointerId);
        dragged = true;
        schemView.tx += dx;
        schemView.ty += dy;
        p.x = e.clientX;
        p.y = e.clientY;
        moved();
      } else if (pointers.size === 2) {
        p.x = e.clientX;
        p.y = e.clientY;
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = drawEl.getBoundingClientRect();
        if (pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch);
        pinch = d;
        dragged = true;
      }
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
    };
    drawEl.addEventListener("pointerup", up);
    drawEl.addEventListener("pointercancel", up);
    drawEl.addEventListener("click", (e) => {
      if (dragged) {
        e.stopPropagation();
        dragged = false;
      }
    }, true);
    const reset = () => {
      schemView = { k: 1, tx: 0, ty: 0 };
      moved();
    };
    drawEl.addEventListener("dblclick", reset);
    resetBtn.addEventListener("click", reset);
    const idOf = (e: Event) => (e.target as Element).closest<SVGGElement>("g[data-id]")?.dataset.id ?? null;
    box.addEventListener("mouseover", (e) => {
      const id = idOf(e);
      if (id && id !== (OUTLOOK_PEEK ?? OUTLOOK_PIN)) {
        OUTLOOK_PEEK = id;
        statusGrid(STATIONS);
      }
    });
    box.addEventListener("mouseleave", () => {
      if (OUTLOOK_PEEK) {
        OUTLOOK_PEEK = null;
        statusGrid(STATIONS);
      }
    });
    box.addEventListener("click", (e) => {
      const id = idOf(e);
      if (id) {
        OUTLOOK_PIN = id;
        OUTLOOK_PEEK = null;
        statusGrid(STATIONS);
      }
    });
  }
  if (!schemWired) {
    schemWired = true;
    let frame = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncSchematic);
    });
  }
  const draw = box.querySelector<HTMLElement>(".sc-draw")!;
  draw.innerHTML = schematicSvg(SCHEM, draw.clientWidth || 800, draw.clientHeight || 500);
  box.querySelector<HTMLElement>(".sc-info")!.innerHTML = schematicInfo(SCHEM);
}

/** What the diagram is and how to read it: kept off the drawing, behind the (i). */
function schematicInfo(sc: Schematic): string {
  const sw = (inner: string) => `<svg width="16" height="12" viewBox="-8 -6 16 12" aria-hidden="true">${inner}</svg>`;
  const lastS = [...sc.gauges].filter((q) => q.side === "S" && q.kind === "site").sort((a, b) => b.at[0] - a.at[0])[0]
    ?? [...sc.gauges].filter((q) => q.side === "S").sort((a, b) => b.at[0] - a.at[0])[0];
  const end = sc.south[sc.south.length - 1];
  const gap = lastS ? Math.round(Math.hypot(end[0] - lastS.at[0], end[1] - lastS.at[1]) / 5) * 5 : 0;
  return `<p><b>Water level at the tide gauges.</b> The gauges are points; nothing is drawn between them, because the water there is not measured.</p>
    <ul class="sc-key">
      <li>${sw('<circle r="3.8" style="fill:var(--wp-gold)"/>')}observed level, ft above MLLW</li>
      <li>${sw('<circle r="3.6" style="fill:var(--bg);stroke:var(--ink-mute)"/>')}predicted level, ahead of the record (NOAA's; ours at the USGS gauges, fitted to each gauge's own record)</li>
      <li>${sw('<line y1="5" y2="-5" style="stroke:var(--wp-willow);stroke-width:2.6"/>')}observed minus predicted; up is higher</li>
      <li>${sw('<line y1="5" y2="-5" style="stroke:var(--wp-amber);stroke-width:2.6"/>')}more than 0.5 ft from the prediction</li>
      <li>${sw('<circle r="3.6" style="fill:var(--bg);stroke:var(--ink-mute);stroke-dasharray:2 1.6"/>')}USGS tide gauge, not shown on this site</li>
    </ul>
    <p>${gap ? `No gauge on Long Island's shore for about ${gap} km east of ${lastS.name}. ` : ""}Outline: the Census Bureau's TIGER shoreline (public domain), smoothed at 0.75 km (finer when zoomed in); north up, to scale; islands at the mouth drawn by their north shores. Drag to pan, scroll or pinch to zoom.</p>`;
}

function schematicSvg(sc: Schematic, W: number, H: number): string {
  const nar = W < 560;
  const [xmin, xmax, ymin, ymax] = [-4, 160, -3, 61];
  const pad = { l: nar ? 22 : 84, r: nar ? 14 : 40, t: nar ? 40 : 60, b: nar ? 46 : 70 };
  // The tilt band takes the foot; the drawing (rivers included) is fitted and centred in the area above it, with a gap
  // for Long Island's callouts and the band's title.
  const topKm = Math.max(ymax, ...(sc.rivers ?? []).flatMap((r) => r.line.map((p) => p[1])));
  const bandY1 = H - 58, bandY0 = bandY1 - Math.min(150, Math.max(90, H * 0.18));
  // What hangs below a Long Island pin: a label at twice the bar scale plus its two lines, then the band's title.
  const sWide = (W - pad.l - pad.r) / (xmax - xmin);
  const gap = 2 * Math.max(14, sWide * 4) + 6 + 30 + 22;
  const area = nar ? { t: pad.t, b: H - pad.b } : { t: 18, b: bandY0 - gap };
  const s = Math.min(sWide, (area.b - area.t) / ((nar ? ymax : topKm) - ymin));
  const ox = pad.l + (W - pad.l - pad.r - (xmax - xmin) * s) / 2;
  const oy = nar
    ? pad.t + (H - pad.t - pad.b - (ymax - ymin) * s) / 2
    : area.t + (area.b - area.t - (topKm - ymin) * s) / 2 + (topKm - ymax) * s;
  const { k: zk, tx, ty } = schemView;
  const X = (x: number) => (ox + (x - xmin) * s) * zk + tx;
  const Y = (y: number) => (oy + (ymax - y) * s) * zk + ty;
  const f1 = (v: number) => v.toFixed(1);
  const path = (pts: [number, number][]) => "M" + pts.map(([x, y]) => `${f1(X(x))},${f1(Y(y))}`).join("L");
  const shore = zk >= 2.5 && sc.fine ? sc.fine : sc; // closer in, the outline smoothed at 0.35 km
  const lines = [shore.north, shore.south, ...(sc.islands ?? [])];
  let g = (sc.rivers ?? []).map((r) => `<path d="${path(r.line)}" class="sc-river"><title>${r.name}</title></path>`).join("");
  g += lines.map((l, i) => `<path d="${path(l)}" class="${i < 2 ? "sc-shore" : "sc-isle"}"/>`).join("");

  // Label placement: each label tries spots around its mark and takes the one that crosses the fewest shore points,
  // overlaps no other label or mark, and stays in the frame.
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const pts: [number, number][] = [];
  lines.forEach((l, k) => { for (let i = 0; i < l.length; i += k < 2 ? 2 : 1) pts.push([X(l[i][0]), Y(l[i][1])]); });
  for (const r of sc.rivers ?? []) for (const [x, y] of r.line) pts.push([X(x), Y(y)]);
  const taken: Box[] = [];
  const CW = 6.15, LH = 12;
  // Each label tries spots out on its shore's land side (near, then farther into the open space) and takes the one that
  // keeps clear of the shore, of other labels and marks, and whose leader line crosses the least shore.
  const leads: [number, number, number, number][] = [];
  const shoreSegs: [number, number, number, number][] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) shoreSegs.push([X(l[i - 1][0]), Y(l[i - 1][1]), X(l[i][0]), Y(l[i][1])]);
  const cross = (a: [number, number, number, number], c: [number, number, number, number]) => {
    const o = (p: number, q: number, r: number, t: number, u: number, v: number) => Math.sign((r - p) * (v - q) - (t - q) * (u - p));
    return o(a[0], a[1], a[2], a[3], c[0], c[1]) !== o(a[0], a[1], a[2], a[3], c[2], c[3]) && o(c[0], c[1], c[2], c[3], a[0], a[1]) !== o(c[0], c[1], c[2], c[3], a[2], a[3]);
  };
  // Leaders are vertical: a label sits straight above (north shore) or below (south shore) its pin, slid sideways
  // only as far as keeps the pin under the label.
  const anchorOf = (px: number, py: number, b: Box): [number, number] => [px, py < b.y0 ? b.y0 : b.y1];
  // Spots are worked out once per size, from fixed-width templates, and reused at every time, so moving the time
  // never moves a label.
  const sizeKey = `${W}x${H}:${zk.toFixed(3)}:${Math.round(tx)}:${Math.round(ty)}`;
  if (!schemLayout || schemLayout.key !== sizeKey) schemLayout = { key: sizeKey, boxes: new Map() };
  const memo = schemLayout.boxes;
  const place = (key: string, px: number, py: number, rows: string[], side: "N" | "S", far = false): { b: Box; lead: boolean } => {
    const rel = schemRel.get(key);
    const kept = memo.get(key) ?? (schemMoving && rel ? { x0: px + rel.dx0, y0: py + rel.dy0, x1: px + rel.dx1, y1: py + rel.dy1 } : undefined);
    if (kept) {
      taken.push(kept);
      leads.push([px, py, ...anchorOf(px, py, kept)]);
      return { b: kept, lead: true };
    }
    const w = Math.max(...rows.map((r) => r.length)) * CW + 6, h = rows.length * LH + 3;
    // The site's gauges at one distance, just clear of the largest bar; the USGS gauges farther out, stepping on.
    const dists = far ? [56, 72, 88, 104, 122, 140] : [Math.max(9, 2 * FT) + 6, Math.max(9, 2 * FT) + 22];
    const xs = [-w / 2, -8, -w + 8, -w * 0.25, -w * 0.75];
    let best: { b: Box; score: number; lead: boolean } | null = null;
    dists.forEach((d, di) => xs.forEach((dx, xi) => {
      const y0 = side === "N" ? py - d - h : py + d;
      const bx = { x0: px + dx, y0, x1: px + dx + w, y1: y0 + h };
      let score = di * 1.5 + xi * 0.4;
      if (bx.x0 < 2 || bx.y0 < 2 || bx.x1 > W - 2 || bx.y1 > H - 2) score += 1000;
      for (const t of taken) if (bx.x0 < t.x1 + 4 && t.x0 < bx.x1 + 4 && bx.y0 < t.y1 + 3 && t.y0 < bx.y1 + 3) score += 1000;
      const [ax, ay] = anchorOf(px, py, bx);
      for (const [x, y] of pts) if (x > bx.x0 - 6 && x < bx.x1 + 6 && y > bx.y0 - 6 && y < bx.y1 + 6) score += 4;
      for (const [lx, ly0, , ly1] of leads) if (lx > bx.x0 - 3 && lx < bx.x1 + 3 && Math.max(Math.min(ly0, ly1), bx.y0) < Math.min(Math.max(ly0, ly1), bx.y1)) score += 300;
      // The leader may not pass through another label, or cross a shore.
      for (const t of taken) if (ax > t.x0 && ax < t.x1 && Math.max(Math.min(py, ay), t.y0) < Math.min(Math.max(py, ay), t.y1)) score += 300;
      const seg: [number, number, number, number] = [px, py + (ay - py) * 0.15, ax, ay];
      for (const sh of shoreSegs) if (cross(seg, sh)) { score += 600; break; }
      if (!best || score < best.score) best = { b: bx, score, lead: true };
    }));
    taken.push(best!.b);
    leads.push([px, py, ...anchorOf(px, py, best!.b)]);
    memo.set(key, best!.b);
    schemRel.set(key, { dx0: best!.b.x0 - px, dy0: best!.b.y0 - py, dx1: best!.b.x1 - px, dy1: best!.b.y1 - py });
    return best!;
  };
  const text = (b: Box, rows: string[], cls: string[]) =>
    rows.map((r, i) => `<text x="${f1(b.x0 + 3)}" y="${f1(b.y0 + 10 + i * LH)}" class="${cls[i] ?? cls[0]} sc-halo">${r}</text>`).join("");
  const leader = (px: number, py: number, b: Box, gap = 5) => {
    const [, ay] = anchorOf(px, py, b);
    const sy = py + Math.sign(ay - py) * gap;
    return Math.abs(ay - sy) < 4 ? "" : `<line x1="${f1(px)}" y1="${f1(sy)}" x2="${f1(px)}" y2="${f1(ay)}" class="sc-lead"/>`;
  };

  // The tilt band at the foot, on the diagram's own x axis: each gauge's point straight under its pin. Kept clear of
  // labels.
  const band = nar ? null : { y0: bandY0, y1: bandY1 };
  if (band) taken.push({ x0: 0, y0: band.y0 - 14, x1: W, y1: band.y1 + 4 });
  // Marks first (so labels keep off them), then labels.
  const on = OUTLOOK_PEEK ?? OUTLOOK_PIN;
  const shown = sc.gauges.some((q) => q.id === on && q.kind === "site") ? on : "KPTN";
  const FT = Math.max(14, s * 4); // px per foot of departure
  type Mark = { q: Schematic["gauges"][number]; x: number; y: number; svg: string; rows: string[]; cls: string[]; title: string };
  const marks: Mark[] = [];
  for (const q of sc.gauges) {
    const x = X(q.at[0]), y = Y(q.at[1]);
    if (x < -10 || x > W + 10 || y < -10 || y > H + 10) continue; // panned out of view
    if (q.kind === "usgs") {
      if (nar) continue;
      marks.push({ q, x, y, svg: `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.6" class="sc-cand"/>`, rows: [q.name], cls: ["sc-cname"], title: `${q.name}: USGS tide gauge ${q.usgs}, not shown on this site` });
      taken.push({ x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5 });
      continue;
    }
    const d = STATIONS.find((st) => st.meta.id === q.id && st.kind === "shore");
    if (!d) continue;
    let lv = NaN, dep = NaN, how = "observed";
    if (AT == null) {
      lv = d.levelNow?.ft ?? NaN;
      dep = lastValue(departure(d));
    } else {
      const h = Math.floor(AT / HOUR) * HOUR;
      lv = d.level?.at(h) ?? NaN;
      dep = departure(d)?.at(h) ?? NaN;
      if (!Number.isFinite(lv)) {
        lv = predictedLevel(d, AT);
        dep = NaN;
        how = "predicted";
      }
    }
    const val = Number.isFinite(lv) ? `${feet(lv)} ft${Number.isFinite(dep) ? ` ${signedFt(dep)}` : how === "predicted" ? " pred." : ""}` : "no reading";
    const beyond = Number.isFinite(dep) && Math.abs(dep) > 0.5;
    const bar = Number.isFinite(dep) ? `<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(y)}" y2="${f1(y - dep * FT)}" class="sc-bar${beyond ? " beyond" : ""}"/>` : "";
    const dot = how === "predicted" || !Number.isFinite(lv) ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.6" class="sc-pred"/>` : `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.8" class="sc-obs"/>`;
    const ring = q.id === shown ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="8" class="sc-on"/>` : "";
    taken.push({ x0: x - 9, y0: y - Math.max(9, 2 * FT), x1: x + 9, y1: y + Math.max(9, 2 * FT) });
    const title = `${q.name}: ${Number.isFinite(lv) ? `${feet(lv)} ft above MLLW, ${how}` : "no reading"}${Number.isFinite(dep) ? `, ${signedFt(dep)} ft against the prediction` : ""}${AT != null ? `, ${atLabel(AT)}` : ""}`;
    marks.push({ q, x, y, svg: `${bar}${ring}${dot}<circle cx="${f1(x)}" cy="${f1(y)}" r="12" class="sc-hit"/>`, rows: [q.name, val], cls: ["sc-nm", "sc-val"], title });
  }
  // The site's gauges claim their spots first, then the candidates, then the named places.
  for (const m of [...marks].sort((a, b) => (a.q.kind === "site" ? 0 : 1) - (b.q.kind === "site" ? 0 : 1))) {
    const p = place(m.q.id, m.x, m.y, m.q.kind === "site" ? [m.q.name, "-00.0 ft +0.0 pred."] : m.rows, m.q.side, m.q.kind !== "site");
    const body = `<title>${m.title}</title>${p.lead ? leader(m.x, m.y, p.b) : ""}${m.svg}${text(p.b, m.rows, m.cls)}`;
    g += m.q.kind === "site" ? `<g data-id="${m.q.id}" class="sc-g">${body}</g>` : `<g data-usgs="${m.q.usgs}">${body}</g>`;
  }
  if (band) g += tiltBand(sc, X, W, band);
  // Scale bar and north arrow, at the foot.
  const km = zk >= 4 ? 5 : zk >= 2 ? 10 : 20; // a bar of about the same length at any zoom
  const sk = s * zk;
  const sx = W - (nar ? 14 : 40) - km * sk - 40, sy = H - 18;
  g += `<g class="sc-scale"><line x1="${f1(sx)}" x2="${f1(sx + km * sk)}" y1="${sy}" y2="${sy}"/>` +
    [0, km / 2, km].map((t) => `<line x1="${f1(sx + t * sk)}" x2="${f1(sx + t * sk)}" y1="${sy - 3}" y2="${sy + 3}"/><text x="${f1(sx + t * sk)}" y="${sy - 7}" text-anchor="middle">${t === km ? `${km} km` : t}</text>`).join("") +
    `<path d="M${f1(sx + km * sk + 28)},${sy + 3} V${sy - 15} M${f1(sx + km * sk + 24.5)},${sy - 9} L${f1(sx + km * sk + 28)},${sy - 16} L${f1(sx + km * sk + 31.5)},${sy - 9}"/>` +
    `<text x="${f1(sx + km * sk + 36)}" y="${sy}">N</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Long Island Sound in outline, with water level at the tide gauges">${g}</svg>`;
}

/** The Sound's tilt: at the cursor's hour (and faintly the six before), each site gauge's departure from its
 * prediction, or its level from mean sea level, joined west to east. Points sit under their pins (shared x). */
function tiltBand(sc: Schematic, X: (x: number) => number, W: number, band: { y0: number; y1: number }): string {
  const lim = tiltMode === "dep" ? 2 : 5;
  const mid = (band.y0 + band.y1) / 2;
  const y = (v: number) => mid - (Math.max(-lim, Math.min(lim, v)) / lim) * ((band.y1 - band.y0) / 2);
  const T = Math.floor((AT ?? Date.now() / 1000 - HOUR) / HOUR) * HOUR;
  const gauges = sc.gauges.filter((q) => q.kind === "site").map((q) => ({ q, d: STATIONS.find((st) => st.meta.id === q.id && st.kind === "shore") }))
    .filter((p): p is { q: typeof p.q; d: StationData } => !!p.d).sort((a, b) => a.q.at[0] - b.q.at[0]);
  const value = (d: StationData, h: number) => {
    if (tiltMode === "dep") return departure(d)?.at(h) ?? NaN;
    const msl = TIDES?.[d.meta.id]?.datums_ft?.MSL ?? NaN;
    const lv = d.level?.at(h);
    return (lv != null && Number.isFinite(lv) ? lv : predictedLevel(d, h + HOUR / 2)) - msl;
  };
  const f1 = (v: number) => v.toFixed(1);
  let g = `<line x1="${f1(X(-3))}" x2="${f1(X(160))}" y1="${f1(mid)}" y2="${f1(mid)}" class="tb-zero"/>`;
  g += `<text x="${f1(X(-3) - 6)}" y="${f1(band.y0 + 4)}" text-anchor="end" class="tb-tick">+${lim}</text><text x="${f1(X(-3) - 6)}" y="${f1(mid + 3)}" text-anchor="end" class="tb-tick">0</text><text x="${f1(X(-3) - 6)}" y="${f1(band.y1 + 2)}" text-anchor="end" class="tb-tick">−${lim}</text>`;
  g += `<text x="${f1(X(-3))}" y="${f1(band.y0 - 6)}" class="tb-tick">${tiltMode === "dep" ? "departure from prediction, ft" : "level from mean sea level, ft"}</text>`;
  // One line per shore (north solid, Long Island dashed), so the band never zigzags across the Sound.
  for (const side of (tiltShore === "both" ? ["N", "S"] : [tiltShore]) as ("N" | "S")[]) {
    const own = gauges.filter(({ q }) => q.side === side);
    for (let k = 6; k >= 0; k--) {
      const h = T - k * HOUR;
      const pts = own.map(({ q, d }) => [X(q.at[0]), value(d, h)] as [number, number]).filter((p) => Number.isFinite(p[1]));
      if (pts.length < 2) continue;
      g += `<path d="M${pts.map(([px, v]) => `${f1(px)},${f1(y(v))}`).join("L")}" class="${k ? "tb-trail" : "tb-now"}${side === "S" ? " tb-south" : ""}"${k ? ` style="opacity:${(0.5 - k * 0.06).toFixed(2)}"` : ""}/>`;
      if (!k) for (const [px, v] of pts) g += `<circle cx="${f1(px)}" cy="${f1(y(v))}" r="2.6" class="tb-dot"/>`;
    }
  }
  if (tiltShore === "both") {
    const lx = X(160), ly = band.y0 - 9;
    g += `<line x1="${f1(lx - 196)}" x2="${f1(lx - 178)}" y1="${f1(ly)}" y2="${f1(ly)}" class="tb-now"/><text x="${f1(lx - 172)}" y="${f1(ly + 3)}" class="tb-tick">north shore</text>` +
      `<line x1="${f1(lx - 90)}" x2="${f1(lx - 72)}" y1="${f1(ly)}" y2="${f1(ly)}" class="tb-now tb-south"/><text x="${f1(lx - 66)}" y="${f1(ly + 3)}" class="tb-tick">Long Island</text>`;
  }
  for (const { q } of gauges.filter(({ q }) => tiltShore === "both" || q.side === tiltShore)) g += `<line x1="${f1(X(q.at[0]))}" x2="${f1(X(q.at[0]))}" y1="${f1(band.y1 + 2)}" y2="${f1(band.y1 + 6)}" class="tb-zero"/>`;
  void W;
  return `<g class="tilt-band">${g}</g>`;
}

const WATER_PAGE = "/long-island-sound/tides/"; // "Reading the tides": unlinked until it returns
void WATER_PAGE;

/* ---------- Overview: map and status grid ---------- */

/**
 * The last 7 days of hourly temperature as a tiny line, scaled to its own week's range: the vertical
 * exaggeration makes a 1-degree swing visible. The range is in the tooltip, so the shape is never read
 * as an absolute value.
 */
function sparkline(d: StationData, depth: string, color: string): string {
  const h = d.hourly[depth];
  return h ? sparklineOf(h, color, unitName(VK), V().digits) : "";
}

/** The time the overview table and the map pins show: null for now (the latest readings), else the timeline
 * cursor (epoch seconds). Values at a past time are observations from the hourly record; there are no station
 * forecasts yet, so a time after the latest reading shows "--". */
let AT: number | null = null;
let STATIONS: StationData[] = [];
const atFuture = () => AT != null && AT * 1000 > Date.now();
const fmtAtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });
function atLabel(t: number): string {
  const ms = t * 1000;
  return `${fmtAtWhen.format(new Date(ms)).replace(",", "")}, ${ms < Date.now() ? `${span(ms, Date.now())} ago` : `in ${span(Date.now(), ms)}`}`;
}
/** A table cell at the cursor's time: the observed value where the record covers it, "--" otherwise. */
function atCell(v: number, shown: string, title: string, spark = "", extra = ""): string {
  if (!Number.isFinite(v)) return `<td class="offline">${spark}<b>--</b><small>${atFuture() ? "no forecast" : "no reading"}</small></td>`;
  return `<td class="asof" title="${title}, observed ${atLabel(AT!)}">${spark}<b>${shown}</b><small>${extra || "observed"}</small></td>`;
}
/** A station's observed value of a variable at a depth and time (temperature in &deg;F): the hourly record where it
 * covers the time, NaN otherwise (no station forecasts before M8). The table, the pins and both prompts read values
 * at the cursor through this, so they agree. A variable not yet loaded (its view never opened) gives NaN. */
function valueAt(d: StationData, k: VarKey, depth: string, t: number): number {
  const h = k === VK ? d.hourly : (k === "temp" ? d.temp : d.views[k])?.hourly;
  return h?.[depth]?.at(t) ?? NaN;
}
/** A pin's water value: the view's variable with its unit. */
const pinValue = (k: VarKey, v: number) => (k === "temp" ? `${f1(v)}&deg;F` : k === "salinity" ? `salinity ${v.toFixed(2)}` : `oxygen ${v.toFixed(1)} mg/L`);

function sparklineOf(h: Hourly, color: string, unit: string, digits = 1): string {
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
  const title = `last 7 days: ${lo.toFixed(digits)} to ${hi.toFixed(digits)} ${unit} (scaled to this range)`;
  const mx = AT != null && AT >= xs[0] && AT <= xs[xs.length - 1] ? ((AT - xs[0]) / (xs[xs.length - 1] - xs[0])) * W : NaN;
  const tick = Number.isFinite(mx) ? `<line x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="0" y2="${H}" stroke="currentColor" stroke-width="1" opacity="0.55"/>` : "";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}"><title>${title}</title><path d="${path}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/>${tick}</svg>`;
}

/** A reading transcribed from the LISICOS panel image (while their server is down): tagged in the cell and noted in
 * its tooltip and readout. LISICOS's observation, read by us; provisional until the server's own record returns. */
const PANEL_NOTE = "transcribed from the LISICOS station panel image while their data server is down; provisional";
const panelTag = (o?: { source?: string } | null) => (o?.source === "panel" ? " &middot; panel" : "");
const panelTitle = (o?: { source?: string } | null) => (o?.source === "panel" ? `; ${PANEL_NOTE}` : "");

function cellHtml(d: StationData, depth: string): string {
  if (d.kind === "shore" && VK !== "temp") return `<td class="na" title="Not measured at this station">&middot;</td>`;
  if (!d.depths.includes(depth)) return `<td class="na" title="No ${DEPTH_LABEL[depth].toLowerCase()} sensor published">&middot;</td>`;
  if (AT != null) {
    const v = valueAt(d, VK, depth, AT);
    return atCell(v, v.toFixed(V().digits) + (VK === "temp" ? "&deg;" : ""), `${DEPTH_LABEL[depth]}: ${v.toFixed(V().digits)} ${unitName(VK)}`, sparkline(d, depth, P.now));
  }
  const o = d.obs[depth];
  const state = obsState(o);
  const value = o ? V().obs(o) : null;
  if (!o || value == null) return `<td class="offline">--</td>`;
  if (state === "offline") {
    // An old reading is not a current condition: show the outage, not the value.
    const since = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", year: "numeric" }).format(new Date(o.time));
    return `<td class="offline" title="${DEPTH_LABEL[depth]}: last reading ${fmtUtc(o.time)}"><b>--</b><small>since ${since}</small></td>`;
  }
  const shown = value.toFixed(V().digits) + (VK === "temp" ? "&deg;" : "");
  // Oxygen under the hypoxia level is marked in the cell, not only by color.
  const low = VK === "oxygen" && value < DO_LEVELS.hypoxic;
  const status = VK === "oxygen" ? `, ${oxygenStatus(value)}` : "";
  return `<td class="${state}${low ? " low" : ""}" title="${DEPTH_LABEL[depth]}: ${value.toFixed(V().digits)} ${unitName(VK)}${status}, ${ago(o.time)}${panelTitle(o)}">${sparkline(d, depth, state === "live" ? P.now : P.delayed)}<b>${shown}</b><small>${low ? oxygenStatus(value) + " &middot; " : ""}${ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

/** Latest buoy wind: mean and gust in the chosen unit, a downwind arrow with the compass point it comes
 * from, and air temperature, with a 7-day wind sparkline. */
function windCell(d: StationData): string {
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f) {
      const u = WIND_UNITS[WU].label;
      return fcCell(f, `${windArrow(f.dir)}${compass(f.dir)} ${windFmt(f.spd)}<small class="g">${u}</small>`, `Wind ${windFmt(f.spd)} ${u} from ${compass(f.dir)}, gusts ${windFmt(f.gust)} ${u}`, `&plusmn;${windFmt(f.err)} ${u}`);
    }
  }
  if (AT != null) {
    const m = d.met;
    const atV = m?.wind?.at(AT) ?? NaN;
    if (!Number.isFinite(atV)) {
      const mc = windModelCell(d, AT, "no reading", `No wind reading at ${atLabel(AT)}`);
      if (mc) return mc;
    }
    if (!m?.wind) return `<td class="na">&middot;</td>`;
    const v = m.wind.at(AT);
    const dir = m.dir?.at(AT) ?? NaN;
    const gust = m.gust?.at(AT) ?? NaN;
    const u = WIND_UNITS[WU].label;
    const from = Number.isFinite(dir) ? compass(dir) : "";
    return atCell(v, `${Number.isFinite(dir) ? windArrow(dir) : ""}${from} ${windFmt(v)}<small class="g">${u}</small>`, `Wind ${windFmt(v)} ${u} from ${from || "--"}, gusts ${windFmt(gust)} ${u}`, sparklineOf(m.wind, P.line, "kt"), `gusts ${windFmt(gust)}`);
  }
  const o = d.met?.last;
  const nowState = o && o.wind_kt != null ? obsState({ time: o.time } as LastObs) : "offline";
  if (nowState === "offline") {
    const mc = windModelCell(d, Date.now() / 1000, "no recent wind", o ? `No wind reading since ${fmtDate.format(new Date(o.time))}` : "No wind reading");
    if (mc) return mc;
  }
  if (!o || o.wind_kt == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent wind</small></td>`;
  const u = WIND_UNITS[WU].label;
  const dir = o.dir_deg != null ? compass(o.dir_deg) : "";
  const title = `Wind ${windFmt(o.wind_kt)} ${u}, gusts ${windFmt(o.gust_kt)} ${u}, from ${dir || "--"}; air ${f1(o.air_f ?? NaN)} F; ${ago(o.time)}${panelTitle(o)}`;
  const spark = d.met?.wind ? sparklineOf(d.met.wind, P.line, "kt") : "";
  return `<td class="${state} wind" title="${title}">${spark}<b>${o.dir_deg != null ? windArrow(o.dir_deg) : ""}${dir} ${windFmt(o.wind_kt)}<small class="g">${u}</small></b><small>gusts ${windFmt(o.gust_kt)} &middot; ${ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

/** Waves: the latest significant height and period where published, the outage with its last reading where
 * not, and "no sensor" where the buoy has none. */
function wavesCell(d: StationData): string {
  const w = wavesOf(d.meta.id);
  if (!w) return `<td class="na">&middot;</td>`;
  const panel = panelsOf(d.meta.id).waves;
  if (!w.sensor) return `<td class="na" title="${wavesText(d.meta.id)}"><small>no sensor</small></td>`;
  if (!NWPS) void loadNwps();
  const waveModel = (t: number, fault: string, faultTitle: string): string | null => {
    const m = nwpsAt(d.meta.id, hourOf(t));
    if (!m) return null;
    const u = waveUnit().label;
    return standInCell(fault, faultTitle, `model ${waveFmt(m.hs)} ${u}${Number.isFinite(m.tp) ? ` &middot; ${m.tp.toFixed(0)} s` : ""}`,
      `NWS nearshore wave model (NWPS) at the buoy: significant height ${waveFmt(m.hs)} ${u}${Number.isFinite(m.tp) ? `, period ${m.tp.toFixed(1)} s` : ""}${Number.isFinite(m.dir) ? ` from ${compass(m.dir)}` : ""}; ${runText(m.issue, m.lead)}, forced by NWS forecast winds`, "waves");
  };
  if (AT != null) {
    const v = d.waves?.hs?.at(AT) ?? NaN;
    if (!Number.isFinite(v) && !atFuture()) {
      const mc = waveModel(AT, "no reading", `No wave reading at ${atLabel(AT)}`);
      if (mc) return mc;
    }
    return atCell(v, `${waveFmt(v)}<small class="g"> ${waveUnit().label}</small>`, `Significant wave height ${waveFmt(v)} ${waveUnit().label}`);
  }
  const last = lastWave(d.meta.id);
  const state = last ? obsState({ time: last.time } as LastObs) : "offline";
  if ((WAVE_LIVE[d.meta.id]?.published || last?.source === "panel") && last && state !== "offline") {
    const spark = d.waves?.hs ? sparklineOf(d.waves.hs, P.line, "m significant height", 2) : "";
    return `<td class="${state}" title="Significant wave height ${waveFmt(last.hs_m)} ${waveUnit().label}, highest ${waveFmt(last.hmax_m)}, period ${last.tp_s ?? "--"} s; ${ago(last.time)}${panelTitle(last)}">${spark}<b>${waveFmt(last.hs_m)}<small class="g"> ${waveUnit().label}</small></b><small>${last.tp_s != null ? last.tp_s.toFixed(0) + " s &middot; " : ""}${ago(last.time).replace(" ago", "")}${panelTag(last)}</small></td>`;
  }
  const mc = waveModel(Date.now() / 1000, wavesText(d.meta.id, true).replace("offline, last reading", "out since"), wavesText(d.meta.id));
  if (mc) return mc;
  const inner = `<b>--</b><small>${wavesText(d.meta.id, true)}</small>`;
  return `<td class="offline waves" title="${wavesText(d.meta.id)}">${panel ? `<a href="${panel}">${inner}</a>` : inner}</td>`;
}

/** Air temperature at the station, and pressure with its change over the last 3 hours (the forecaster's tendency). */
function airCell(d: StationData): string {
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f && Number.isFinite(f.air)) return fcCell(f, `${Math.round(f.air)}&deg;`, `Air ${f1(f.air)} F`, `&plusmn;${f.airErr.toFixed(0)}&deg;`);
  }
  if (AT != null) {
    if (!Number.isFinite(d.met?.air?.at(AT) ?? NaN)) {
      const f = hrrrStandIn(d, AT);
      if (f && Number.isFinite(f.air)) return standInCell("no reading", `No air temperature at ${atLabel(AT)}`, `model ${Math.round(f.air)}&deg;`, `HRRR at the buoy: air ${f1(f.air)} F; ${runText(f.issue, f.lead)}, typically within ${f.airErr.toFixed(0)} F`);
    }
    if (!d.met?.air) return `<td class="na">&middot;</td>`;
    const v = d.met.air.at(AT);
    return atCell(v, `${Math.round(v)}&deg;`, `Air ${f1(v)} F`);
  }
  const o = d.met?.last;
  if (!o || o.air_f == null || obsState({ time: o.time } as LastObs) === "offline") {
    const f = hrrrStandIn(d, Date.now() / 1000);
    if (f && Number.isFinite(f.air)) return standInCell("offline", "No recent air temperature", `model ${Math.round(f.air)}&deg;`, `HRRR at the buoy: air ${f1(f.air)} F; ${runText(f.issue, f.lead)}, typically within ${f.airErr.toFixed(0)} F`);
  }
  if (!o || o.air_f == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b></td>`;
  return `<td class="${state}" title="Air ${f1(o.air_f)} F, ${ago(o.time)}${panelTitle(o)}"><b>${Math.round(o.air_f)}&deg;</b><small>${ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

function pressureCell(d: StationData): string {
  const o = d.met?.last;
  const p = d.met?.pressure;
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f && Number.isFinite(f.pres)) {
      const back = forecastAt(d.meta.id, AT - 3 * HOUR);
      const tend = back && back.issue === f.issue && Number.isFinite(back.pres) ? `${signed(f.pres - back.pres)} in 3h, ` : "";
      return fcCell(f, `${f.pres.toFixed(0)}<small class="g"> mb</small>`, `Pressure ${f.pres.toFixed(1)} mbar`, `${tend}&plusmn;${(typicalError(d.meta.id, f.lead, "pressure_mae")).toFixed(0)}`);
    }
  }
  if (AT != null) {
    if (!Number.isFinite(p?.at(AT) ?? NaN)) {
      const f = hrrrStandIn(d, AT);
      if (f && Number.isFinite(f.pres)) return standInCell("no reading", `No pressure at ${atLabel(AT)}`, `model ${f.pres.toFixed(0)} mb`, `HRRR at the buoy: pressure ${f.pres.toFixed(1)} mbar; ${runText(f.issue, f.lead)}`);
    }
    if (!p) return `<td class="na">&middot;</td>`;
    const v = p.at(AT);
    const tend = p.at(AT) - p.at(AT - 3 * HOUR);
    return atCell(v, `${v.toFixed(0)}<small class="g"> mb</small>`, `Pressure ${v.toFixed(1)} mbar`, "", Number.isFinite(tend) ? `${signed(tend)} in 3h` : "");
  }
  if (!o || o.pressure_mb == null || obsState({ time: o.time } as LastObs) === "offline") {
    const f = hrrrStandIn(d, Date.now() / 1000);
    if (f && Number.isFinite(f.pres)) return standInCell("offline", "No recent pressure", `model ${f.pres.toFixed(0)} mb`, `HRRR at the buoy: pressure ${f.pres.toFixed(1)} mbar; ${runText(f.issue, f.lead)}`);
  }
  if (!o || o.pressure_mb == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b></td>`;
  const end = p ? p.lastValid() : NaN;
  const trend = p && Number.isFinite(end) ? p.at(end) - p.at(end - 3 * HOUR) : NaN;
  const tend = Number.isFinite(trend) ? `${signed(trend)} in 3h` : "";
  return `<td class="${state}" title="Pressure ${o.pressure_mb.toFixed(1)} mbar${tend ? `, ${tend}` : ""}; ${ago(o.time)}${panelTitle(o)}"><b>${o.pressure_mb.toFixed(0)}<small class="g"> mb</small></b><small>${tend || ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

/** NOAA's predicted water level at a time (ft above MLLW), linear between its hourly values; NaN outside them. */
function predictedLevel(d: StationData, t: number): number {
  const p = TIDES?.[d.meta.id]?.pred;
  if (!p) return NaN;
  const k = (t - Date.parse(p.t0) / 1000) / p.step, i = Math.floor(k);
  const a = p.ft[i], b = p.ft[i + 1];
  return a == null || b == null ? NaN : a + (b - a) * (k - i);
}

/** Shore station cells: the latest water level with a 7-day line (the tides), and the next predicted tide. */
function levelCell(d: StationData): string {
  if (AT != null) {
    if (!d.level) return `<td class="na">&middot;</td>`;
    const v = d.level.at(AT);
    const dep = departure(d);
    const spark = dep ? sparklineOf(dep, P.line, "ft against the prediction", 1) : "";
    const p = predictedLevel(d, AT);
    if (!Number.isFinite(v) && Number.isFinite(p))
      return `<td class="fcst" title="Water level ${feet(p)} ft above MLLW, NOAA's prediction">${spark}<b>${feet(p)}<small class="g"> ft</small></b><small>predicted</small></td>`;
    return atCell(v, `${feet(v)}<small class="g"> ft</small>`, `Water level ${feet(v)} ft above MLLW (preliminary)`, spark);
  }
  const lv = d.levelNow;
  if (!lv) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: lv.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent level</small></td>`;
  const dep = departure(d);
  const spark = dep ? sparklineOf(dep, P.line, "ft against the prediction", 1) : "";
  return `<td class="${state}" title="Water level ${feet(lv.ft)} ft above MLLW (preliminary), ${ago(lv.time)}">${spark}<b>${feet(lv.ft)}<small class="g"> ft</small></b><small>${ago(lv.time).replace(" ago", "")}</small></td>`;
}

function tideCell(d: StationData): string {
  // At the cursor's time: the next predicted tide after it (predictions reach a few days ahead).
  const e = AT != null ? d.tides.find((x) => Date.parse(x.t) > AT! * 1000) : nextTide(d);
  if (!e) return `<td class="na">&middot;</td>`;
  return `<td class="tide" title="Next predicted ${tideText(e)} above MLLW"><b>${e.type === "H" ? "High" : "Low"}</b><small>${fmtClock.format(new Date(e.t)).toLowerCase()} &middot; ${feet(e.ft)} ft</small></td>`;
}

/** Which table the overview shows: buoys or shore stations (remembered in this browser only). */
type Group = StationData["kind"];
let SG: Group = "buoy";
try {
  if (localStorage.getItem("lhzn-blue-status-tab") === "shore") SG = "shore";
} catch {
  /* private mode: buoys */
}

/** The Rivers view's overview: each gauge's flow, where it sits for the date, and river turbidity. */
function riverTable(): string {
  const d = RIVER_SECTIONS[0];
  if (!d?.river) return `<p class="note">River data could not load.</p>`;
  const r = d.river;
  let total = 0;
  let medians = 0;
  let complete = true;
  const rows = r.gauges.map((g) => {
    const flowAt = AT != null ? riverFlow(r, g.id, AT) : NaN;
    const o =
      AT == null
        ? r.last[g.id]
        : Number.isFinite(flowAt)
          ? { time: new Date(AT * 1000).toISOString(), flow_cfs: flowAt, turb_fnu: g.turbidity ? (Number.isFinite(r.turb?.at(AT) ?? NaN) ? r.turb!.at(AT) : null) : null }
          : null;
    if (!o || o.flow_cfs == null) {
      if (!g.discontinued) complete = false; // a discontinued gauge is left out of the total, and the total says so
      const why = g.discontinued && (AT == null || AT * 1000 > Date.parse(g.discontinued))
        ? `discontinued ${new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(g.discontinued))}`
        : AT != null ? (atFuture() ? "no forecast" : "no reading") : "no recent reading";
      return `<tr data-gauge="${g.id}"><th scope="row"><a href="#${g.id}"><i class="dot offline"></i>${g.river}</a></th><td class="offline" title="${g.status_note ?? ""}"><b>--</b><small>${why}</small></td><td class="na">&middot;</td><td class="na"><small>${g.turbidity ? "--" : "no sensor"}</small></td></tr>`;
    }
    const t = Date.parse(o.time) / 1000;
    const state = AT != null ? "asof" : obsState({ time: o.time } as LastObs);
    const cls = riverClass(r, g.id, t, o.flow_cfs);
    const med = pct(r, g.id, "p50", t);
    total += o.flow_cfs;
    medians += Number.isFinite(med) ? med : NaN;
    const spark = r.flow[g.id] ? sparklineOf(r.flow[g.id]!, P.depth.SFC, "cfs", 0) : "";
    const turb = !g.turbidity
      ? `<td class="na" title="This gauge has no turbidity sensor"><small>no sensor</small></td>`
      : o.turb_fnu != null
        ? `<td title="River turbidity at ${g.name.split(/ (?:at|near) /).pop()}, ${ago(o.time)}"><b>${o.turb_fnu.toFixed(1)}<small class="g"> FNU</small></b></td>`
        : `<td class="offline"><b>--</b><small>no recent reading</small></td>`;
    return `<tr data-gauge="${g.id}"><th scope="row" title="${g.name} (USGS ${g.usgs_id})"><a href="#${g.id}"><i class="dot ${state}"></i>${g.river}</a></th>
      <td class="${state}" title="${cfs(o.flow_cfs)} cfs, ${ago(o.time)}">${spark}<b>${cfs(o.flow_cfs)}<small class="g"> cfs</small></b><small>${AT != null ? "observed" : ago(o.time).replace(" ago", "")}</small></td>
      <td class="river-class ${cls.replace(/ /g, "-")}" title="Median for the date ${cfs(med)} cfs"><b>${cls || "--"}</b><small>median ${cfs(med)}</small></td>${turb}</tr>`;
  });
  const off = r.gauges.filter((g) => g.discontinued).length;
  const share =
    (complete && Number.isFinite(medians) && medians > 0 ? `${Math.round((100 * total) / medians)}% of the summed medians for the date` : "") +
    (off ? `; the ${off === 1 ? "discontinued gauge is" : `${off} discontinued gauges are`} left out` : "");
  return `<table class="status-grid" id="status-panel">
    <caption>${AT != null ? `River flow at ${atLabel(AT)}` : "Latest river flow"}, largest basin first: cubic feet per second, against normal for the date</caption>
    <thead><tr><th></th><th scope="col">Flow</th><th scope="col">For the date</th><th scope="col">Turbidity</th></tr></thead>
    <tbody>${rows.join("")}<tr class="total"><th scope="row">All ${r.gauges.length - off}</th><td>${complete ? `<b>${cfs(total)}<small class="g"> cfs</small></b>` : "--"}</td><td colspan="2"><small>${share}</small></td></tr></tbody>
  </table>
  <p class="status-key">USGS classes: normal is the 25th to 75th percentile of daily flow for the date; much below and much above are under the 10th and over the 90th. Values are provisional. Point at a river to see its watershed on the map.</p>`;
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
  const connAt = AT != null ? r?.turb?.at(AT) ?? NaN : NaN;
  const conn = AT == null ? r?.last.CONN : Number.isFinite(connAt) ? { time: new Date(AT * 1000).toISOString(), turb_fnu: connAt, flow_cfs: null } : null;
  const river = conn?.turb_fnu != null
    ? `<tr class="total"><th scope="row">Connecticut River</th><td title="USGS, Thompsonville, ${ago(conn.time)}"><b>${conn.turb_fnu.toFixed(1)}<small class="g"> FNU</small></b><small>${AT != null ? "observed" : ago(conn.time).replace(" ago", "")}</small></td><td colspan="2"><small>the river input at Thompsonville; a serviced USGS sensor</small></td></tr>`
    : `<tr class="total"><th scope="row">Connecticut River</th><td class="offline"><b>--</b><small>${AT != null ? (atFuture() ? "no forecast" : "no reading") : "no current reading"}</small></td><td colspan="2"><small>the river input at Thompsonville; a serviced USGS sensor</small></td></tr>`;
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
    $("status").innerHTML = riverTable() + outlookHtml(STATIONS);
    return;
  }
  if (VK === "tides") {
    if (!TIDES) void loadTides();
    $("status").innerHTML = tidesTable(stations) + highestAheadHtml(stations);
    markOutlookRow();
    return;
  }
  const buoys = stations.filter((d) => d.kind === "buoy");
  const shore = stations.filter((d) => d.kind === "shore");
  if (!shore.length) SG = "buoy";
  const name = (d: StationData) => `<th scope="row"><a href="#${d.meta.id}"><i class="dot${d.kind === "shore" ? " shore" : ""} ${overallState(d)}"></i>${d.meta.name}</a></th>`;
  const wind = `wind (${WIND_UNITS[WU].label})`;
  const what = `${V().label.toLowerCase()} (${VK === "temp" ? "&deg;F" : unitName(VK)})`;
  // Each view has its own columns: water views show the water; Wind and waves shows the weather and the sea.
  const head = (cols: string[]) => `<thead><tr><th></th>${cols.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead>`;
  const open = (g: Group) => `<table class="status-grid" id="status-panel" role="tabpanel" aria-labelledby="stab-${g}">`;
  const air = "air (&deg;F), pressure (mbar)";
  const table =
    SG === "buoy"
      ? isWater(VK)
        ? `${open("buoy")}<caption>${AT != null ? `${V().label} at ${atLabel(AT)}, west to east (${VK === "temp" ? "&deg;F" : unitName(VK)})` : `Latest readings, west to east: ${what}`}</caption>${head(DEPTHS.map((d) => DEPTH_LABEL[d]))}
      <tbody>${buoys.map((d) => `<tr>${name(d)}${DEPTHS.map((dep) => cellHtml(d, dep)).join("")}</tr>`).join("")}</tbody></table>`
        : `${open("buoy")}<caption>${AT != null ? `${atFuture() ? "Forecast" : "Weather and waves"} at ${atLabel(AT)}` : "Latest readings"}, west to east: ${wind}, ${air} and waves (${waveUnit().label})${AT != null && atFuture() ? ` &middot; HRRR, raw${(() => { const f = stations.length ? forecastAt(stations[0].meta.id, hourOf(AT!)) : null; return f ? `, the ${fmtRun.format(new Date(f.issue * 1000))} run` : ""; })()} &middot; ${verTag(AT!, stations[0]?.meta.id)}` : ""}</caption>${head(["Wind", "Air", "Pressure", "Waves"])}
      <tbody>${buoys.map((d) => `<tr>${name(d)}${windCell(d)}${airCell(d)}${pressureCell(d)}${wavesCell(d)}</tr>`).join("")}</tbody></table>`
      : isWater(VK)
        ? `${open("shore")}<caption>${AT != null ? `Water at ${atLabel(AT)}` : "Latest readings"}, west to east: ${VK === "temp" ? "water temperature (&deg;F)" : `water temperature only (no ${V().label.toLowerCase()} sensors)`} and water level</caption>${head(["Water", "Level", "Next tide"])}
      <tbody>${shore.map((d) => `<tr>${name(d)}${cellHtml(d, "SFC")}${levelCell(d)}${tideCell(d)}</tr>`).join("")}</tbody></table>`
        : `${open("shore")}<caption>${AT != null ? `${atFuture() ? "Forecast" : "Weather"} at ${atLabel(AT)}` : "Latest readings"}, west to east: ${wind}, ${air} and the next tide${AT != null && atFuture() ? ` &middot; HRRR, raw${(() => { const f = stations.length ? forecastAt(stations[0].meta.id, hourOf(AT!)) : null; return f ? `, the ${fmtRun.format(new Date(f.issue * 1000))} run` : ""; })()} &middot; ${verTag(AT!, stations[0]?.meta.id)}` : ""}</caption>${head(["Wind", "Air", "Pressure", "Next tide"])}
      <tbody>${shore.map((d) => `<tr>${name(d)}${windCell(d)}${airCell(d)}${pressureCell(d)}${tideCell(d)}</tr>`).join("")}</tbody></table>`;
  const tab = (g: Group, label: string, n: number) =>
    `<button type="button" role="tab" class="stab" id="stab-${g}" data-group="${g}" aria-selected="${SG === g}" aria-controls="status-panel" tabindex="${SG === g ? 0 : -1}">${label}<small>${n}</small></button>`;
  const key =
    SG === "buoy"
      ? `<i class="dot live"></i>under ${DELAYED_HOURS}h old <i class="dot delayed"></i>under ${OFFLINE_HOURS}h <i class="dot partial"></i>weather only <i class="dot offline"></i>offline`
      : `<i class="dot shore live"></i>under ${DELAYED_HOURS}h old <i class="dot shore delayed"></i>under ${OFFLINE_HOURS}h <i class="dot shore offline"></i>offline &middot; levels in feet above mean lower low water, preliminary; tides are NOAA predictions`;
  $("status").innerHTML = `
    ${shore.length ? `<div class="status-tabs" role="tablist" aria-label="Stations">${tab("buoy", "Buoys", buoys.length)}${tab("shore", "Shore stations", shore.length)}</div>` : ""}
    ${table}
    <p class="status-key">${key} &middot; lines: last 7 days, each stretched to its own range</p>${isWater(VK) ? usgsWqHtml() : ""}${outlookHtml(stations)}${soundWindHtml(stations)}`;
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
    if (hi) hi.outerHTML = highestAheadHtml(stations);
    markOutlookRow();
  };
  box.addEventListener("mouseover", (e) => {
    const id = VK === "wind" || VK === "tides" ? rowId(e) : null;
    if (id && id !== (OUTLOOK_PEEK ?? OUTLOOK_PIN)) {
      OUTLOOK_PEEK = id;
      redrawOutlook();
    }
  });
  box.addEventListener("mouseleave", () => {
    if (OUTLOOK_PEEK) {
      OUTLOOK_PEEK = null;
      redrawOutlook();
    }
  });
  box.addEventListener("focusin", (e) => {
    const id = VK === "wind" || VK === "tides" ? rowId(e) : null;
    if (id) {
      OUTLOOK_PEEK = id;
      redrawOutlook();
    }
  });
  box.addEventListener("click", (e) => {
    if ((VK !== "wind" && VK !== "tides") || (e.target as HTMLElement).closest("a, button")) return;
    const id = rowId(e);
    if (id) {
      OUTLOOK_PIN = id;
      OUTLOOK_PEEK = null;
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
  box.addEventListener("click", (e) => {
    const svg = (e.target as Element).closest<SVGSVGElement>(".ws-svg");
    if (!svg || !timelineModule || !(e.target as Element).closest(".ws-hit")) return;
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * WS.W;
    const { t0, t1 } = windStripSpan();
    const t = t0 + ((vx - WS.L) / (WS.W - WS.L - WS.R)) * (t1 - t0);
    if (t < t0 || t > t1) return;
    timelineModule.setOffset(Math.round((t - Date.now() / 1000) / HOUR));
  });
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
  applyPendingOffset("hours"); // after the listener, so a linked time reaches the charts, the table and the pins
  void syncPhase(tl.position().scale === "hours");
}

/** A station's map pin: its latest readings, or its observations at the timeline cursor's time. */
function stationPin(d: StationData): Pin {
  if (d.kind === "airport") return airportPin(d);
  const dep = d.depths.includes("SFC") ? "SFC" : d.depths[0];
  const kind = d.kind === "shore" ? ("shore" as const) : ("buoy" as const);
  const base = { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, kind };
  const k: VarKey = d.kind === "shore" || !isWater(VK) ? "temp" : VK;
  if (VK === "tides" && d.kind === "shore") {
    if (AT == null) {
      const lv = d.levelNow;
      const dep = lastValue(departure(d));
      const hi = d.tides.find((e) => e.type === "H" && Date.parse(e.t) > Date.now());
      const label = [
        lv ? `Water ${feet(lv.ft)} ft, ${ago(lv.time)}` : "no recent level",
        Number.isFinite(dep) ? `${signedFt(dep)} ft against the prediction` : "",
        hi ? `next high ${hi.ft.toFixed(1)} ft ${fmtWhenMin.format(new Date(hi.t))}` : "",
      ].filter(Boolean).join("<br>");
      return { ...base, state: overallState(d), label, bar: dep };
    }
    const h = Math.floor(AT / HOUR) * HOUR;
    const dep = departure(d)?.at(h) ?? NaN;
    const lv = d.level?.at(h) ?? NaN;
    const label = Number.isFinite(lv)
      ? `Water ${feet(lv)} ft, ${Number.isFinite(dep) ? `${signedFt(dep)} ft against the prediction` : ""}<br>observed ${atLabel(AT)}`
      : `predicted ${feet(predictedHour(d.meta.id, h))} ft<br>${atLabel(AT)}`;
    return { ...base, state: overallState(d), label, bar: dep };
  }
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f) {
      const u = WIND_UNITS[WU].label;
      const label = `Forecast: wind ${compass(f.dir)} ${windFmt(f.spd)} ${u}, gusts ${windFmt(f.gust)}${Number.isFinite(f.air) ? `<br>air ${Math.round(f.air)}&deg;F` : ""}<br>HRRR, ${f.lead} h ahead, typically &plusmn;${windFmt(f.err)} ${u}<br>${atLabel(AT)}`;
      return { ...base, state: overallState(d), label };
    }
  }
  if (AT != null) {
    const water = valueAt(d, k, dep, AT);
    const wind = d.met?.wind?.at(AT) ?? NaN;
    const dir = d.met?.dir?.at(AT) ?? NaN;
    const parts = [
      Number.isFinite(water) ? `${d.kind === "shore" ? "Water" : DEPTH_LABEL[dep]} ${pinValue(k, water)}` : "",
      Number.isFinite(wind) ? `wind ${Number.isFinite(dir) ? compass(dir) + " " : ""}${windFmt(wind)} ${WIND_UNITS[WU].label}` : "",
    ].filter(Boolean);
    // A buoy without its own wind at that hour: the model under the fault, marked as such.
    const f = !Number.isFinite(wind) ? hrrrStandIn(d, AT) : null;
    const model = f ? `<i>Model, not measured: wind ${compass(f.dir)} ${windFmt(f.spd)} ${WIND_UNITS[WU].label} (HRRR)</i>` : "";
    const label = parts.length
      ? `${parts.join("<br>")}<br>observed ${atLabel(AT)}${model ? `<br>${model}` : ""}`
      : `no ${atFuture() ? "forecast" : "reading"} at ${atLabel(AT)}${model ? `<br>${model}` : ""}`;
    return { ...base, state: parts.length ? overallState(d) : "offline", label };
  }
  const o = d.obs[dep];
  const lv = o ? WATER_VARS[k].obs(o) : null;
  const state = overallState(d);
  const w = d.met?.last;
  const wind = w && w.wind_kt != null ? `wind ${w.dir_deg != null ? compass(w.dir_deg) + " " : ""}${windFmt(w.wind_kt)} ${WIND_UNITS[WU].label}, ${ago(w.time)}` : "";
  const reading =
    state === "partial"
      ? `Weather live: ${wind}<br>Water quality offline${o ? ` since ${fmtDate.format(new Date(o.time))}` : ""}`
      : o && lv != null
        ? `${DEPTH_LABEL[dep]} ${pinValue(k, lv)}, ${ago(o.time)}${wind ? `<br>${wind}` : ""}`
        : "no reading";
  const waves = wavesText(d.meta.id, true);
  let label = waves ? `${reading}<br>Waves: ${waves}` : reading.replace(/^Surface /, d.kind === "shore" ? "Water " : "Surface ");
  if (d.kind === "buoy" && (!w || obsState({ time: w.time } as LastObs) === "offline")) {
    const f = hrrrStandIn(d, Date.now() / 1000);
    const m = nwpsAt(d.meta.id, hourOf(Date.now() / 1000));
    const model = [
      f ? `wind ${compass(f.dir)} ${windFmt(f.spd)} ${WIND_UNITS[WU].label} (HRRR)` : "",
      m && wavesOf(d.meta.id)?.sensor ? `waves ${waveFmt(m.hs)} ${waveUnit().label} (NWPS)` : "",
    ].filter(Boolean);
    if (model.length) label += `<br><i>Model, not measured: ${model.join(", ")}</i>`;
  }
  const tide = d.kind === "shore" && nextTide(d) ? `<br>Next ${tideText(nextTide(d)!)}` : "";
  return { ...base, state, label: label + tide };
}

/** The masthead advisory's click on this page: switch to the Wind view, as its tab does, without scrolling (the
 * banner stays in sight; the advisories run along "Wind across the Sound" under the table). */
function openWindStrip(): void {
  if (VK !== "wind") document.querySelector<HTMLButtonElement>('.tab[data-var="wind"]')?.click();
}

/** The overview table and the map pins at the cursor's time (or the latest readings at now). */
async function showAt(t: number | null): Promise<void> {
  AT = t;
  const rowsBox = document.getElementById("sound-rows-box");
  if (rowsBox && VK === "tides") rowsBox.innerHTML = soundRowsSvg(STATIONS);
  if (VK === "tides") for (const d of STATIONS.filter((s) => s.kind === "shore")) { const [a, b] = FIGS.hilo.window(d); drawLadder(d, a, b); }
  if (STATIONS.length) statusGrid(STATIONS);
  void syncZones();
  if (EMBED) return;
  try {
    (await import("./map")).updatePins([...STATIONS.map(stationPin), ...(VK === "rivers" ? gaugePins() : [])]);
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
      (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }),
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
      <figcaption><span class="cap-label">${f.label?.(d) ?? f.title}</span><span class="cap-sub">${f.varies ? `${V().label.toLowerCase()}, ` : ""}${f.sub}</span>${f.depthTabs && d.depths.length > 1 ? depthTabsHtml(d, key, d.depths[0]) : ""}
        <span class="fig-actions"><button class="collect-btn" type="button" data-collect="${id}-${key}" data-title="${figName(f)}: ${st.name}" data-kind="plot" aria-pressed="false">+</button><button class="fig-info" type="button" data-about="${key}" aria-label="About this plot: ${figName(f)}" title="About this plot">i</button>${key === "next48" ? "" : `<button class="expand" type="button" data-station="${id}" data-fig="${key}" data-full="1" aria-label="Full record: ${figName(f)}, ${st.name}">Full record</button>`}<button class="expand" type="button" data-station="${id}" data-fig="${key}" aria-label="Expand: ${figName(f)}, ${st.name}">Expand</button></span></figcaption>
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
        <span class="sid">${d.kind === "turbidity" ? "LISICOS buoys, optical sensors at 1 m" : d.kind === "rivers" ? "USGS stream gauges" : d.kind === "river" ? `USGS ${d.gauge!.usgs_id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W` : `${id} &middot; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W`}</span>
        <span class="rec">${recordLine(d, rec)}</span>
      </div>
      <p class="station-links"><span>${d.kind === "turbidity" ? "Buoys:" : d.kind === "rivers" || d.kind === "river" ? "At USGS:" : d.kind === "shore" ? (d.meta.operator === "USGS" ? "At USGS:" : "At NOAA:") : d.kind === "airport" ? "At IEM:" : "At LISICOS:"}</span>${[
        ...(d.kind === "rivers" ? (d.river?.gauges ?? []).map((g) => `<a href="#${g.id}">${g.river}</a>`) : []),
        ...(d.kind === "turbidity" ? (d.turb?.buoys ?? []).map((b) => `<a href="${(registry.stations as { id: string; info_url?: string }[]).find((s) => s.id === b.id)?.info_url ?? "#"}">${b.name}</a>`) : []),
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
  const link = `https://longhorizon.blue/long-island-sound/?view=${view}#${d.meta.id}-${EMBED}`;
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
  if (d.kind === "river") {
    const r = d.river!;
    const g = d.gauge!;
    const o = r.last[g.id];
    const t = o ? Date.parse(o.time) / 1000 : NaN;
    const items = [
      o?.flow_cfs != null
        ? `<div class="readout"><div class="num">${cfs(o.flow_cfs)}<small>cfs</small></div><span class="lab">Flow</span><span class="sub ${obsState({ time: o.time } as LastObs)}">${ago(o.time)}</span></div>`
        : `<div class="readout"><div class="num">--</div><span class="lab">Flow</span><span class="sub offline">no recent reading</span></div>`,
      o?.flow_cfs != null
        ? `<div class="readout"><div class="num">${pctText(percentileOf(r, g.id, t, o.flow_cfs))}</div><span class="lab">Percentile for the date</span><span class="sub">${riverClass(r, g.id, t, o.flow_cfs)} &middot; median ${cfs(pct(r, g.id, "p50", t))} cfs</span></div>`
        : "",
      g.turbidity && o?.turb_fnu != null
        ? `<div class="readout"><div class="num">${o.turb_fnu.toFixed(1)}<small>FNU</small></div><span class="lab">Turbidity</span><span class="sub">${ago(o.time)}</span></div>`
        : "",
    ];
    $(`${d.meta.id}-readouts`).innerHTML = items.join("");
    return;
  }
  if (d.kind === "rivers") {
    const r = d.river!;
    const conn = r.last.CONN;
    const t = conn ? Date.parse(conn.time) / 1000 : NaN;
    const total = r.gauges.filter((g) => !g.discontinued).reduce((a, g) => a + (r.last[g.id]?.flow_cfs ?? NaN), 0);
    $(`${d.meta.id}-readouts`).innerHTML = [
      `<div class="readout"><div class="num">${cfs(total)}<small>cfs</small></div><span class="lab">All ${r.gauges.filter((g) => !g.discontinued).length} live gauges</span><span class="sub">the sum of the latest readings</span></div>`,
      conn?.flow_cfs != null
        ? `<div class="readout"><div class="num">${cfs(conn.flow_cfs)}<small>cfs</small></div><span class="lab">Connecticut River</span><span class="sub">${riverClass(r, "CONN", t, conn.flow_cfs)} for the date &middot; ${ago(conn.time)}</span></div>`
        : "",
      conn?.turb_fnu != null
        ? `<div class="readout"><div class="num">${conn.turb_fnu.toFixed(1)}<small>FNU</small></div><span class="lab">Connecticut turbidity</span><span class="sub">at Thompsonville &middot; ${ago(conn.time)}</span></div>`
        : "",
    ].join("");
    return;
  }
  $(`${d.meta.id}-readouts`).innerHTML =
    stationReadouts(d).join("") +
    `<span class="band-actions"><button class="collect-btn" type="button" data-collect="${d.meta.id}-readouts" data-title="Readouts: ${d.meta.name}" data-kind="readout row" aria-pressed="false">+</button>` +
    `<button class="fig-info band-info" type="button" data-about="trends" aria-label="About the readouts' trends and %iles" title="About the trends and %iles">i</button></span>`;
  $(`${d.meta.id}-readouts`).classList.add("readouts-row");
}

/** One readout: the big figure, its label (which opens the plot's explanation) and a line of small print. */
function readoutHtml(num: string, label: string, about: string, sub: string, state = "", context = ""): string {
  return `<div class="readout"><div class="num">${num}</div><span class="lab"><button type="button" class="ro-about" data-about="${about}" title="About: ${label}">${label}</button></span>${context ? `<span class="trend">${context}</span>` : ""}<span class="sub${state ? ` ${state}` : ""}">${sub}</span></div>`;
}

/** Direction over the quantity's window, then the seasonal %ile (from `season.long` when the series has a longer
 * record than its recent window): "↗ +0.6°F in 24h · 74th %ile". */
function contextLine(s: Hourly | null | undefined, trendKey: string, fmt: (v: number) => string, season?: { key: string; what?: string; long?: Hourly | null }): string {
  const spec = TRENDS[trendKey];
  const parts = [trendText(trend(s, spec), spec, fmt)];
  if (season) parts.push(percentileText(seasonalPercentile(season.long ?? s, SEASONS[season.key]), season.what));
  return parts.filter(Boolean).join(" &middot; ");
}

/** The change in the view's water variable, in display units. */
const waterDelta = (v: number) => (VK === "temp" ? `${v.toFixed(1)}&deg;F` : VK === "salinity" ? v.toFixed(2) : `${v.toFixed(1)} mg/L`);

/** A reading at one depth, or why there is none. */
function depthReadout(d: StationData, depth: string, value: (o: LastObs) => number | null | undefined, fmt: (v: number) => string, labelFor: (depthLabel: string) => string, about: string, extra?: (o: LastObs, v: number) => string, context?: string): string {
  const o = d.obs[depth];
  const depthLabel = d.meta.series.find((s) => s.depth === depth)?.label ?? depth;
  const label = labelFor(depthLabel);
  const v = o ? value(o) : null;
  if (!o || v == null || !Number.isFinite(v)) return readoutHtml("--", label, about, "no recent reading");
  const state = obsState(o);
  // An old reading is not a current condition: keep it out of the big figure.
  if (state === "offline") return readoutHtml("--", label, about, `no current reading &middot; last ${fmt(v).replace(/<[^>]+>/g, " ")}, ${fmtDate.format(new Date(o.time))}`, "offline");
  return readoutHtml(fmt(v), label, about, `${o.depth_m ?? "--"} m &middot; ${extra ? extra(o, v) + " &middot; " : ""}${ago(o.time)}${o.source === "panel" ? " &middot; transcribed from the LISICOS panel" : ""}`, state, context);
}

/** Direction and %ile of the view's water variable at one depth, from its 36h mean. */
const waterContext = (d: StationData, depth: string) => contextLine(d.m36[depth], VK, waterDelta, { key: "water" });

/** Surface minus bottom of the view's variable, as its latest 36h mean. */
function deltaReadout(d: StationData, fmt: (v: number) => string): string {
  const offline = stationState(d) === "offline";
  if (VK === "temp") {
    const sb = stratNow(d);
    if (!Number.isFinite(sb.deltaC)) return readoutHtml("--", "Surface minus bottom", "sb", "no recent reading");
    return offline
      ? readoutHtml("--", "Surface minus bottom", "sb", `no current reading &middot; last ${signed(sb.deltaC, 2)}&deg;C, ${sb.status}`, "offline")
      : readoutHtml(`${signed(sb.deltaC, 2)}&deg;C`, "Surface minus bottom", "sb", `${sb.status} (alpha definition) &middot; 24h mean`, "", stratContext(d));
  }
  const s = d.delta36;
  const end = s ? s.lastValid() : NaN;
  if (!s || !Number.isFinite(end)) return readoutHtml("--", "Surface minus bottom", "sb", "no recent reading");
  const v = s.at(end);
  return offline
    ? readoutHtml("--", "Surface minus bottom", "sb", `no current reading &middot; last ${fmt(v)}`, "offline")
    : readoutHtml(fmt(v), "Surface minus bottom", "sb", "36h mean", "", contextLine(s, VK, waterDelta));
}

/** Stratifying or mixing: the size of the last day's mean surface-bottom temperature difference against the day
 * before's (sizes of the means, so hours flipping sign around zero do not read as layering). */
function stratContext(d: StationData): string {
  const s = d.temp.delta;
  const end = s ? s.lastValid() : NaN;
  if (!s || !Number.isFinite(end)) return "";
  const spec = TRENDS.stratification;
  const w = spec.window * HOUR;
  const now = Math.abs(s.mean(end - w + HOUR, end));
  const before = Math.abs(s.mean(end - 2 * w + HOUR, end - w));
  if (!Number.isFinite(now) || !Number.isFinite(before)) return "";
  const delta = now - before;
  const t = { dir: (Math.abs(delta) < spec.dead ? 0 : delta > 0 ? 1 : -1) as 1 | -1 | 0, delta };
  return trendText(t, spec, (v) => `${((v * 5) / 9).toFixed(2)}&deg;C`);
}

const fmtTempF = (c: number) => `${f1(cToF(c))}&deg;F<small>${c.toFixed(1)}&deg;C</small>`;
const fmtSal = (v: number) => v.toFixed(2);
const fmtDo = (v: number) => `${v.toFixed(1)}<small>mg/L</small>`;

/** Wind, waves, pressure and air at the station (the Wind and waves view). */
function weatherReadouts(d: StationData): string[] {
  const out: string[] = [];
  const o = d.met?.last;
  const state = o ? obsState({ time: o.time } as LastObs) : "offline";
  const u = WIND_UNITS[WU].label;
  if (o?.wind_kt != null && state !== "offline") {
    const dir = o.dir_deg != null ? `from ${compass(o.dir_deg)}` : "";
    out.push(readoutHtml(`${windFmt(o.wind_kt)}<small>${u}</small>`, "Wind", "wind", `${dir}${dir ? " &middot; " : ""}gusts ${windFmt(o.gust_kt)} ${u} &middot; ${ago(o.time)}${o.source === "panel" ? " &middot; transcribed from the LISICOS panel" : ""}`, state,
      [contextLine(d.met?.wind, "wind", (v) => `${windFmt(v)} ${u}`), veerText(d.met?.dir, d.met?.wind), percentileText(seasonalPercentile(d.metLong?.wind ?? d.met?.wind, SEASONS.wind), "last 3 days")]
        .filter(Boolean)
        .join(" &middot; ")));
  } else {
    out.push(readoutHtml("--", "Wind", "wind", "no recent reading", "offline"));
    const f = hrrrStandIn(d, Date.now() / 1000);
    if (f) out.push(readoutHtml(`<span class="model-num">${windFmt(f.spd)}</span><small>${u}</small>`, "Wind, model", "model", `HRRR at the buoy, from ${compass(f.dir)}, gusts ${windFmt(f.gust)} ${u} &middot; ${runText(f.issue, f.lead)} &middot; not a measurement`, "model"));
  }
  if (d.kind === "buoy" && wavesOf(d.meta.id)?.sensor) {
    const w = lastWave(d.meta.id);
    const live = (WAVE_LIVE[d.meta.id]?.published || w?.source === "panel") && w && obsState({ time: w.time } as LastObs) !== "offline";
    out.push(
      live
        ? readoutHtml(`${waveFmt(w!.hs_m)}<small>${waveUnit().label}</small>`, "Waves", "waves", `${w!.tp_s != null ? `${w!.tp_s.toFixed(0)} s period &middot; ` : ""}${ago(w!.time)}${w!.source === "panel" ? " &middot; transcribed from the LISICOS panel" : ""}`, "",
            contextLine(d.waves?.hs, "waves", (v) => `${waveFmt(v)} ${waveUnit().label}`, { key: "waves", what: "last 3 days" }))
        : readoutHtml("--", "Waves", "waves", wavesText(d.meta.id, true), "offline"),
    );
    if (!live) {
      if (!NWPS) void loadNwps();
      const m = nwpsAt(d.meta.id, hourOf(Date.now() / 1000));
      if (m) out.push(readoutHtml(`<span class="model-num">${waveFmt(m.hs)}</span><small>${waveUnit().label}</small>`, "Waves, model", "model", `NWS wave model (NWPS) at the buoy${Number.isFinite(m.tp) ? `, ${m.tp.toFixed(0)} s period` : ""} &middot; ${runText(m.issue, m.lead)} &middot; not a measurement`, "model"));
    }
  }
  if (o?.pressure_mb != null && state !== "offline") {
    const ctx = contextLine(d.met?.pressure, "pressure", (v) => `${v.toFixed(1)} mb`, { key: "pressure", what: "last day", long: d.metLong?.pressure });
    out.push(readoutHtml(`${o.pressure_mb.toFixed(0)}<small>mb</small>`, "Pressure", "pressure", ago(o.time), state, ctx));
  }
  if (o?.air_f != null && state !== "offline")
    out.push(readoutHtml(`${f1(o.air_f)}&deg;F`, "Air", "air", ago(o.time), state, contextLine(d.met?.air, "air", (v) => `${v.toFixed(0)}&deg;F`, { key: "air", what: "last day", long: d.metLong?.air })));
  return out;
}

function levelReadout(d: StationData): string {
  const e = nextTide(d);
  const lv = d.levelNow;
  return readoutHtml(`${lv ? lv.ft.toFixed(1) : "--"}<small>ft</small>`, "Water level", "tide", `above MLLW${lv ? ` &middot; ${ago(lv.time)}` : ""}${e ? ` &middot; next ${tideText(e)}` : ""}`);
}

/** The Tides view's readouts for a shore station: what is unusual first (the water against NOAA's prediction), then
 * the level, then the margin to minor flooding at the next high if the departure held. */
function tidesReadouts(d: StationData): string[] {
  const lv = d.levelNow;
  const state = lv ? obsState({ time: lv.time } as LastObs) : "offline";
  const dep = lastValue(departure(d));
  const out: string[] = [];
  out.push(Number.isFinite(dep) && state !== "offline"
    ? readoutHtml(`${signedFt(dep)}<small>ft</small>`, "Departure from prediction", "dep", `observed minus ${d.meta.operator === "USGS" ? "our fitted prediction" : "NOAA's prediction"}${lv ? ` &middot; ${ago(lv.time)}` : ""}`, state,
        contextLine(departure(d), "departure", (v) => `${v.toFixed(1)} ft`))
    : readoutHtml("--", "Departure from prediction", "dep", "no current reading", "offline"));
  out.push(readoutHtml(`${lv ? lv.ft.toFixed(1) : "--"}<small>ft</small>`, "Water level", "tide", `above MLLW${lv ? ` &middot; ${ago(lv.time)}` : ""}`, state));
  const hi = d.tides.find((e) => e.type === "H" && Date.parse(e.t) > Date.now());
  const minor = TIDES?.[d.meta.id]?.flood_ft?.nws_minor ?? null;
  if (hi && minor != null) {
    const reach = hi.ft + (Number.isFinite(dep) ? dep : 0);
    out.push(readoutHtml(`${(minor - reach).toFixed(1)}<small>ft</small>`, "Below minor flood", "hilo",
      `next high ${hi.ft.toFixed(1)} ft predicted, ${fmtWhenMin.format(new Date(hi.t))}${Number.isFinite(dep) ? `, ${signedFt(dep)} ft departure` : ""} &middot; NWS minor ${minor.toFixed(1)} ft`));
  }
  return out;
}

/** The readouts at the top of a buoy or shore station section follow the view, mirroring the plots below them.
 * Mid-depth stays out: the water-column plot carries it. */
function stationReadouts(d: StationData): string[] {
  const depths = d.depths.filter((dep) => dep !== "MID");
  if (d.kind === "airport") return weatherReadouts(d);
  if (d.kind === "shore") {
    if (VK === "wind") return [...weatherReadouts(d), levelReadout(d)];
    if (VK === "tides") return tidesReadouts(d);
    return [depthReadout(d, d.depths[0], (o) => o.temperature_c, fmtTempF, () => "Water temperature", "col", undefined, d.kind === "shore" ? contextLine(d.m36[d.depths[0]] ?? d.temp.m36[d.depths[0]], "temp", (v) => `${v.toFixed(1)}&deg;F`, { key: "water" }) : undefined), levelReadout(d)];
  }
  if (VK === "wind") return weatherReadouts(d);
  if (VK === "salinity") {
    const items = depths.map((dep) => depthReadout(d, dep, (o) => o.salinity, fmtSal, (l) => `${l} salinity`, "col", undefined, waterContext(d, dep)));
    return d.delta ? [...items, deltaReadout(d, (v) => signed(v, 2))] : items;
  }
  if (VK === "oxygen") {
    const bottomFirst = [...depths].reverse();
    const items = bottomFirst.map((dep) => depthReadout(d, dep, (o) => o.oxygen_mg_l, fmtDo, (l) => `${l} dissolved oxygen`, "col", (_o, v) => oxygenStatus(v), waterContext(d, dep)));
    return d.delta ? [...items, deltaReadout(d, (v) => `${signed(v, 1)}<small>mg/L</small>`)] : items;
  }
  const items = depths.map((dep) => depthReadout(d, dep, (o) => o.temperature_c, fmtTempF, (l) => l, "col", undefined, waterContext(d, dep)));
  return d.temp.delta ? [...items, deltaReadout(d, () => "")] : items;
}

const activeDepth = (d: StationData, key: Kind): string =>
  document.querySelector<HTMLButtonElement>(`#${d.meta.id} .tab[data-fig="${key}"][aria-pressed="true"]`)?.dataset.depth ?? d.depths[0];

/* ---------- Forecast vintage: which run's forecast the next-48-hours plot emphasises ---------- */

const VINTAGE = new Map<string, number>(); // station id -> the chosen run's issue time (epoch seconds)
const VINTAGE_LISTENERS = new WeakMap<HTMLElement, (e: Event) => void>();

const RECENT_RUNS = 24; // the last day's hourly runs; before them, only the 48 h runs (00, 06, 12 and 18 UTC)

/** The runs the plot draws for a station between x0 and x1, oldest first: the newest run (the dashed line), the
 * hourly runs before it for a day, and the 48 h runs before those (the page file keeps them for a week). A run is
 * drawn when any of its hours falls in the window. */
function vintageRuns(id: string, x0 = -Infinity, x1 = Infinity): FcRun[] {
  const now = Date.now() / 1000;
  const last = (r: FcRun) => r.issue + r.leads[r.leads.length - 1] * HOUR;
  return (FCST?.runs[id] ?? [])
    .filter((r) => r.issue <= now)
    .filter((r, k) => (k <= RECENT_RUNS || r.leads[r.leads.length - 1] > 18) && last(r) >= x0 && r.issue < x1)
    .reverse();
}
/** A run's line label in the plot: the newest is the stitched forecast's line, the others "HRRR run <time>". */
function vintageLabel(id: string, r: FcRun): string {
  const now = Date.now() / 1000;
  return r === (FCST?.runs[id] ?? []).find((q) => q.issue <= now) ? "Stitched forecast" : `HRRR run ${fmtRun.format(new Date(r.issue * 1000))}`;
}

function mountVintage(d: StationData, plot: HTMLElement, x0?: number, x1?: number): void {
  mountRunSlider(plot, { store: d.meta.id, model: "HRRR", runs: vintageRuns(d.meta.id, x0, x1), lineLabel: (r) => vintageLabel(d.meta.id, r as FcRun) });
}

/** The NWPS runs the Waves plot draws for a buoy between x0 and x1, oldest first (the newest is the stitched line). */
function nwpsRuns(id: string, x0 = -Infinity, x1 = Infinity): NwpsRun[] {
  return (NWPS?.runs ?? [])
    .filter((r) => r.points[id] && r.issue < x1 && r.issue + r.steps[r.steps.length - 1] * HOUR >= x0)
    .reverse();
}
/** An NWPS run's line label: the newest is the stitched model line, the others "NWPS run <time>". */
function nwpsLabel(r: NwpsRun): string {
  return r === NWPS?.runs[0] ? "NWS wave model (NWPS)" : `NWPS run ${fmtRun.format(new Date(r.issue * 1000))}`;
}
/** One NWPS run's significant height at a buoy for a time, linear between its hours. */
function nwpsRunAt(r: NwpsRun, id: string, t: number): number {
  const f = (t - r.issue) / HOUR;
  const a = Math.floor(f);
  const hs = r.points[id]?.hs;
  const at = (lead: number) => {
    const i = r.steps.indexOf(lead);
    return i < 0 ? NaN : hs?.[i] ?? NaN;
  };
  const va = at(a);
  return f === a ? va : va + (at(a + 1) - va) * (f - a);
}
function mountNwpsVintage(d: StationData, plot: HTMLElement, x0?: number, x1?: number): void {
  mountRunSlider(plot, { store: `${d.meta.id}:nwps`, model: "NWPS", runs: nwpsRuns(d.meta.id, x0, x1), lineLabel: (r) => nwpsLabel(r as NwpsRun) });
}

/** A version slider on a plot: picks one of a model's runs (oldest to newest), shows only "<model>, as of <run>", and
 * emphasises that run's line; hovering a run's line moves it. The choice is kept per plot (store key). */
function mountRunSlider(plot: HTMLElement, o: { store: string; model: string; runs: { issue: number }[]; lineLabel: (r: { issue: number }) => string }): void {
  plot.querySelector(".vintage")?.remove();
  const runs = o.runs;
  if (runs.length < 2) return;
  const chosen = runs.findIndex((r) => r.issue === VINTAGE.get(o.store));
  const k0 = chosen >= 0 ? chosen : runs.length - 1;
  const box = document.createElement("div");
  box.className = "vintage";
  box.innerHTML = `<input class="vg-range" type="range" min="0" max="${runs.length - 1}" step="1" value="${k0}" aria-label="Forecast run"><span class="vg-label"></span>`;
  plot.append(box);
  // In the expanded chart a drag pans and the wheel zooms: not when they start on the slider.
  for (const type of ["pointerdown", "mousedown", "touchstart", "wheel"]) box.addEventListener(type, (e) => e.stopPropagation());
  const range = box.querySelector<HTMLInputElement>(".vg-range")!;
  const label = box.querySelector<HTMLElement>(".vg-label")!;
  const set = (k: number, picked: boolean) => {
    const r = runs[k];
    label.textContent = `${o.model}, as of ${fmtRun.format(new Date(r.issue * 1000))}`;
    range.value = String(k);
    range.setAttribute("aria-valuetext", label.textContent);
    if (picked) VINTAGE.set(o.store, r.issue);
    emphasise(plot, picked || chosen >= 0 ? o.lineLabel(r) : null);
  };
  set(k0, false);
  range.addEventListener("input", () => set(Number(range.value), true));
  // The plot element outlives each drawing: one hover listener at a time.
  const old = VINTAGE_LISTENERS.get(plot);
  if (old) plot.removeEventListener("linepick", old);
  const onPick = (e: Event) => {
    const k = runs.findIndex((r) => o.lineLabel(r) === (e as CustomEvent<string>).detail);
    if (k >= 0) {
      VINTAGE.set(o.store, runs[k].issue);
      set(k, true);
    }
  };
  VINTAGE_LISTENERS.set(plot, onPick);
  plot.addEventListener("linepick", onPick);
}

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
  if (zoom.key === "next48") mountVintage(zoom.d, $("zoom-plot"), zoom.x0, zoom.x1);
  else if (zoom.key === "waves") mountNwpsVintage(zoom.d, $("zoom-plot"), zoom.x0, zoom.x1);
  else $("zoom-plot").querySelector(".vintage")?.remove();
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
  const whole = f.seasonal ? "everything we hold, each year in its color; gaps are periods with no data" : "everything we hold; gaps are periods with no data";
  $("zoom-sub").textContent = full ? whole : `${f.varies ? `${V().label.toLowerCase()}, ` : ""}${f.sub}`;
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
  $("zoom-title").textContent = `${figName(f)} · ${d.meta.name}`;
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
  // The server itself down (the jobs could not connect at all): one plain note instead of a list of datasets, dated
  // from the last fetch that worked. Only while the newest attempt failed, and only after 12 hours without a good fetch,
  // so a passing hiccup does not raise the notice (a shorter gap shows in the strip as a failed fetch).
  const lastOk = Object.values(live.datasets)
    .map((s) => s.last_ok)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const unreachable = Object.values(live.datasets).some((s) => s.last_error?.includes("ServerUnreachable") && (!s.last_ok || s.last_error.slice(0, 20) > s.last_ok));
  const down = unreachable && (!lastOk || Date.parse(live.generated_at) - Date.parse(lastOk) > 12 * 3600e3);
  const outage = $("outage");
  const since = (t: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(t));
  // What UConn reported about the outage (by email, Oct 16, 2026); shown only while the server is unreachable.
  const OPERATOR_NOTE = "UConn reports its data server is being upgraded, expected back by mid-November 2026; the Western Sound buoy has a hardware fault awaiting ship time (as of Oct 16).";
  // While the server is down, the newest readings may be transcribed from LISICOS's panel images.
  const transcribed = Object.values(live.series ?? {}).some((s) => s.last_obs?.source === "panel") ||
    Object.values(live.met ?? {}).some((m) => m.last_obs?.source === "panel");
  if (down) {
    outage.textContent = `Buoy data unavailable from the server since ${lastOk ? since(lastOk) : "the last update"}.${transcribed ? " Readings since then are transcribed from the LISICOS station panels (provisional)." : ""} ${OPERATOR_NOTE}`;
    // On phones the note is an icon in the masthead that opens it (styled in site.css).
    $("outage-dialog-text").textContent = outage.textContent;
    $("outage-pop").textContent = outage.textContent;
    $("outage-icon").hidden = false;
    outage.hidden = false;
  }
  const draw = () => {
    // How stale the buoys were when the data was fetched, as a delta, rather than a second timestamp.
    const fetched = Date.parse(live.generated_at);
    const parts = [
      `<b>Updated</b>${fmtEt(live.generated_at)} <span class="ago">(${span(fetched, Date.now())} ago)</span>`,
      latest ? `buoys ${span(Date.parse(latest), fetched)} behind` : "no recent buoy reading",
    ];
    if (down) parts.push(`<span class="warn">buoy data unavailable since ${lastOk ? since(lastOk) : "the last update"}</span>`);
    else if (failing.length) parts.push(`<span class="warn">fetch failed: ${failing.join(", ")}</span>`);
    $("updated").innerHTML = parts.join(`<span class="sep">&middot;</span>`);
    // The bar: a dot and the age; the buoys' lag only past its usual hour or two; the exact times in the hint.
    const fresh = $("fresh");
    const age = Date.now() - fetched;
    const lag = latest ? fetched - Date.parse(latest) : Infinity;
    const lagging = lag > 2 * 3600_000;
    const state = age > 24 * 3600_000 ? "offline" : failing.length || lagging || age > 3 * 3600_000 ? "delayed" : "live";
    const note = down ? "buoys unavailable" : failing.length ? "fetch failed" : !latest ? "no recent buoy reading" : lagging ? `buoys ${span(Date.parse(latest), fetched)} behind` : "";
    fresh.innerHTML = `<i class="dot ${state}"></i>${span(fetched, Date.now())}<span class="fresh-long">&nbsp;ago</span>${note ? `<span class="lag">${note}</span>` : ""}`;
    fresh.title =
      `Fetched ${fmtEt(live.generated_at)}` + (latest ? ` · latest buoy reading ${fmtEt(latest)}` : "") + ` · history rebuilt ${fmtEt(meta.generated_at)} (New York time)`;
    fresh.setAttribute("aria-label", `Data fetched ${span(fetched, Date.now())} ago${note ? `, ${note}` : ""}`);
    $("updated").title =
      `Fetched ${fmtEt(live.generated_at)}` +
      (latest ? `; latest buoy reading ${fmtEt(latest)}` : "") +
      `; history rebuilt ${fmtEt(meta.generated_at)} (New York time)` +
      (down ? "; buoy data unavailable" : failing.length ? `; the last fetch failed for ${failing.join(", ")}, so those show the last good values` : "") +
      ".";
  };
  draw();
  window.setInterval(draw, 60_000);
  dropDown($("fresh"), $("updated"));
}

/** The phone menu: About (the drawer), Collect (the tray, which shows the "+" marks), units and the theme. While
 * plots are collected the menu button carries their count, so the tray stays one tap away. */
function wireMore(): void {
  const btn = $("more-menu");
  const setOpen = dropDown(btn, $("more-pop"));
  $("more-pop").addEventListener("click", (e) => {
    const what = (e.target as HTMLElement).closest<HTMLElement>("[data-more]")?.dataset.more;
    if (!what) return;
    setOpen(false);
    if (what === "theme") $("theme-toggle").click();
    else if (what === "collect") window.setTimeout(() => $("collect-open").click());
    else if (what === "locate") return; // its own handler (wireLocate)
    // "About" is a link to /about/; "Forecast verification" a link too.
  });
  const count = $("collect-count");
  const show = () => {
    const n = count.textContent?.trim() ?? "";
    if (n) btn.dataset.count = n;
    else delete btn.dataset.count;
    $("more-pop").querySelector(".more-count")!.textContent = n ? ` (${n})` : "";
  };
  new MutationObserver(show).observe(count, { childList: true, characterData: true, subtree: true });
  show();
}

/** The About dialog: one entry from methods.ts, for a plot, a readout or a map layer. */
let aboutLink = "";

const isRiver = (d: StationData) => d.kind === "rivers" || d.kind === "river";
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sqmi = (n: number) => `${n.toLocaleString("en-US")} square miles`;
const PROVISIONAL = "Values are provisional until USGS approves them.";

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

/** A buoy, shore station or the turbidity section's About: what it is, its record and every note, as labelled rows. */
function stationAboutHtml(d: StationData): string {
  const st = d.meta;
  const row = (label: string, html: string) => `<dt>${label}</dt><dd>${html}</dd>`;
  const links = [
    st.info_url ? `<a href="${st.info_url}">${d.kind === "buoy" ? "about this buoy" : "station page"}</a>` : "",
    panelsOf(st.id).weather ? `<a href="${panelsOf(st.id).weather}">weather panel</a>` : "",
    panelsOf(st.id).water_quality ? `<a href="${panelsOf(st.id).water_quality}">water quality panel</a>` : "",
    panelsOf(st.id).waves ? `<a href="${panelsOf(st.id).waves}">wave panel</a>` : "",
  ].filter(Boolean);
  let rows = "";
  if (d.kind !== "turbidity") {
    rows += row(d.kind === "buoy" ? "Buoy" : "Station", `${escHtml(st.name)} (${st.id}), ${escHtml(st.operator)}; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W${links.length ? ` (${links.join(", ")})` : ""}.`);
  }
  const startOf = (s: MetaSeries) => (VK === "temp" ? s.record_start : s.vars?.[VK]?.record_start);
  const record = recordLine(d, st.series.map((s) => `${s.label.toLowerCase()} from ${startOf(s)?.slice(0, 4) ?? "--"}`).join(", "));
  rows += row("Record", `${record.replace(/^Record: (.)/, (_, c: string) => c.toUpperCase())}.`); // the row is already labelled
  if (st.note) rows += row("Notes", st.note); // our own text (it may carry a link)
  if (d.kind === "shore" && isWater(VK) && VK !== "temp") rows += row("Measures", `Water temperature only; ${V().label.toLowerCase()} on this page comes from the buoys.`);
  const status = [
    !d.live && st.outage_note ? st.outage_note : "",
    isQuiet(d)
      ? `No reading since ${fmtDate.format(new Date(lastSeen(d) * 1000))}, so there is no line for this year and the recent charts are empty. ` +
        `The year charts show this time of year in the years we hold; Full record shows everything we have kept.` +
        (d.kind === "buoy" ? " For recent conditions, see the LISICOS panels (images on their site)." : "")
      : "",
  ].filter(Boolean);
  if (status.length) rows += row("Status", status.join(" "));
  if (d.kind === "buoy" && wavesOf(st.id)) rows += row("Waves", escHtml(wavesText(st.id).replace(/^Waves: /, "")).replace(/^./, (c) => c.toUpperCase()));
  const s = d.kind === "buoy" ? BUOY_SENSORS[st.id] : undefined;
  if (s) {
    const parts = [["Topside", s.topside], ["Surface", s.surface], ["Mid-depth", s.mid], ["Bottom", s.bottom]].filter(([, v]) => v);
    rows += row(
      "Sensors",
      `${escHtml(s.platform)}, as LISICOS lists its 2019 configuration (<a href="/references/#lisicos">reference</a>).` +
        `<ul class="about-sensors">${parts.map(([l, v]) => `<li><b>${l}:</b> ${escHtml(v!)}</li>`).join("")}</ul>`,
    );
  }
  return `<dl class="about-list">${rows}</dl><p class="about-foot">Times are stored in UTC and labelled in New York time. All data are provisional and may be revised.</p>`;
}

/** A river section's About: the gauge (or, for All rivers, every gauge) from rivers.json, as labelled rows. */
function gaugeAboutHtml(d: StationData): string {
  const row = (label: string, html: string) => `<dt>${label}</dt><dd>${html}</dd>`;
  const gauges = d.river?.gauges ?? [];
  let rows: string;
  if (d.kind === "rivers") {
    const area = gauges.reduce((a, g) => a + g.drainage_sqmi, 0);
    const conn = gauges.find((g) => g.id === "CONN");
    rows =
      row("Gauges", `${gauges.length} USGS stream gauges, largest basin first:<ul class="about-sensors">${gauges
        .map((g) => `<li><a href="#${g.id}">${escHtml(g.river)}</a>: ${sqmi(g.drainage_sqmi)}${g.discontinued ? " (no flow published since " + escHtml(fmtDate.format(new Date(`${g.discontinued}T12:00:00Z`))) + ")" : ""}</li>`)
        .join("")}</ul>`) +
      row("Drains", `${sqmi(Math.round(area))} in all${conn ? `, about ${Math.round((100 * conn.drainage_sqmi) / area / 5) * 5}% of it the Connecticut River above Thompsonville` : ""}. The Naugatuck joins the Housatonic below the Stevenson gauge, so the two add without double counting.`) +
      row("Not measured", "On Long Island most fresh water reaches the Sound as groundwater, which stream gauges do not measure, so the north shore is under-represented here.") +
      row("Caveats", PROVISIONAL);
  } else {
    const g = d.gauge!;
    const note = g.status_note ?? "";
    rows =
      row("Gauge", `${escHtml(g.name)}, USGS ${g.usgs_id} (<a href="https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/">gauge page</a>)`) +
      row("Drains", sqmi(g.drainage_sqmi)) +
      row("Reaches the Sound", `At ${escHtml(g.mouth)}.`) +
      row("Record", g.discontinued
        ? `Daily mean flow from ${g.record_start ? g.record_start.slice(0, 4) : "1990"} to ${fmtDate.format(new Date(`${g.discontinued}T12:00:00Z`))}.`
        : `Daily mean flow from ${g.record_start ? g.record_start.slice(0, 4) : "1990"}; recent flow hourly, from 15-minute readings.`) +
      (note ? row(g.discontinued ? "Status" : "Notes", escHtml(note.replace(PROVISIONAL, "").trim())) : "") +
      row("Caveats", PROVISIONAL);
  }
  return `<dl class="about-list">${rows}</dl><p class="about-foot">Times are stored in UTC and labelled in New York time. All data are provisional and may be revised.</p>`;
}

function openAbout(key: string, d: StationData | null): void {
  if (key === "station" && d) {
    const dialog = $("about-dialog") as HTMLDialogElement;
    aboutLink = "";
    ($("about-link") as HTMLButtonElement).hidden = true;
    $("about-dialog-title").textContent = d.kind === "rivers" ? "The river gauges" : d.kind === "turbidity" ? "Buoy turbidity sensors" : d.meta.name;
    $("about-dialog-body").innerHTML = isRiver(d) ? gaugeAboutHtml(d) : stationAboutHtml(d);
    if (!dialog.open) dialog.showModal();
    return;
  }
  const m = METHODS[key];
  if (!m) return;
  const dialog = $("about-dialog") as HTMLDialogElement;
  // A plot on a station can be linked to: the page as it stands, scrolled to that plot.
  const plotId = d && key in FIGS ? `${d.meta.id}-${key}` : "";
  aboutLink = plotId ? linkUrl(plotId) : "";
  const linkBtn = $("about-link") as HTMLButtonElement;
  linkBtn.hidden = !aboutLink;
  linkBtn.textContent = "Copy link";
  $("about-dialog-title").textContent = d && !key.startsWith("map-") ? `${m.title}: ${d.meta.name}` : m.title;
  $("about-dialog-body").innerHTML = methodHtml(key, {
    variable: isWater(VK) ? V().label.toLowerCase() : "the reading",
    varKey: VK,
    station: d?.meta.name ?? "the station",
    stationId: d?.meta.id ?? "",
    kind: d?.kind ?? "",
  });
  // The comfort index's thresholds, as a table with the reader's boat marked.
  if (key === "comfort") $("about-dialog-body").querySelector(".about-list")?.insertAdjacentHTML("afterend", comfortTableHtml(BOAT, WU === "ms"));
  if (!dialog.open) dialog.showModal();
}

function wireAbout(): void {
  const dialog = $("about-dialog") as HTMLDialogElement;
  $("about-close").addEventListener("click", () => dialog.close());
  // A link to a section of this page (the river list in the gauges' About) closes the dialog on the way.
  $("about-dialog-body").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest('a[href^="#"]')) dialog.close();
  });
  $("about-link").addEventListener("click", async () => {
    const btn = $("about-link") as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(aboutLink);
      btn.textContent = "Copied";
    } catch {
      window.prompt("Copy this link:", aboutLink); // clipboard refused: show it to copy by hand
    }
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
  // The map key's (i) (fields.ts) asks for its layer's entry.
  document.addEventListener("lhzn-about", (e) => openAbout((e as CustomEvent<{ key: string }>).detail.key, null));
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

/** Shore station sources, added to the notes once their data loads. */
function aboutShore(qc: string): void {
  const names = SHORE.map((s) => `${s.name} (${s.coops_id}, water temperature from ${s.record_start?.slice(0, 4)})`).join(", ");
  $("about-sources").insertAdjacentHTML(
    "beforeend",
    ` Shore stations: <a href="https://tidesandcurrents.noaa.gov/">NOAA CO-OPS</a> water level stations at ${names}. ` +
      `Their water temperature history is the reading at the top of each hour; the recent window, air temperature, wind, pressure and ` +
      `water level are hourly means of 6-minute readings, and tides are NOAA predictions. Water levels are preliminary until NOAA verifies them. ${qc}`,
  );
}

/* ---------- Bring your own AI ---------- */

/** The prompt's line for the timeline cursor: the observations the table and the pins show at that time. */
function atPromptLine(d: StationData, t: number): string {
  const when = `${fmtUtc(new Date(t * 1000).toISOString())} (${atLabel(t)})`;
  const parts = d.meta.series
    .map((s) => {
      const vals = (["temp", "salinity", "oxygen"] as VarKey[])
        .map((k) => [k, valueAt(d, k, s.depth, t)] as const)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => (k === "temp" ? `${f1(v)} F` : k === "salinity" ? `salinity ${v.toFixed(2)}` : `dissolved oxygen ${v.toFixed(2)} mg/L`));
      return vals.length ? `${s.label.toLowerCase()} ${vals.join(", ")}` : "";
    })
    .filter(Boolean);
  const wind = d.met?.wind?.at(t) ?? NaN;
  const dir = d.met?.dir?.at(t) ?? NaN;
  if (Number.isFinite(wind)) parts.push(`wind ${f1(wind)} kt${Number.isFinite(dir) ? ` from ${compass(dir)}` : ""}`);
  const none = `no observations at that time${t * 1000 > Date.now() ? " (no station forecasts are available)" : ""}`;
  return `  At the page's timeline cursor, ${when}: ${parts.length ? `observed ${parts.join("; ")}` : none}.`;
}

function promptData(stations: StationData[]): string {
  const out: string[] = [];
  for (const d of stations) {
    const st = d.meta;
    const xs = grid(d.now - 96 * DAY, d.now + 14 * DAY, Infinity);
    out.push(`Station ${st.id}, ${st.name} (${st.operator}), ${st.lat.toFixed(2)} N, ${Math.abs(st.lon).toFixed(2)} W.${st.note ? " " + st.note : ""}${!d.live && st.outage_note ? " " + st.outage_note : ""}`);
    if (AT != null) out.push(atPromptLine(d, AT));
    for (const s of st.series) {
      const o = d.obs[s.depth];
      const m = d.temp.m36[s.depth];
      out.push(`  ${s.label} (sensor depth ${s.depth_m.join(" and ")} m; hourly record from ${s.record_start?.slice(0, 10) ?? "unknown"}${s.live ? "" : "; not published on the server now"}):`);
      if (o && o.temperature_c != null) {
        const extra = [
          o.salinity != null ? `salinity ${o.salinity.toFixed(2)}` : "",
          o.oxygen_mg_l != null ? `dissolved oxygen ${o.oxygen_mg_l.toFixed(2)} mg/L (${oxygenStatus(o.oxygen_mg_l)})` : "",
        ].filter(Boolean);
        out.push(`    ${s.live ? "latest" : "last"} observation ${fmtUtc(o.time)} (${ago(o.time)}): ${f1(cToF(o.temperature_c))} F (${o.temperature_c.toFixed(2)} C)${extra.length ? "; " + extra.join("; ") : ""}.`);
      } else out.push(`    no recent observation.`);
      if (!m) continue;
      // Anchor to the latest hour with a 36h mean (the server runs about an hour behind the clock). With no
      // recent data (an outage), anchor the comparison to now: "this time of year in the years we hold".
      const tLast = m.lastValid();
      const recent = xs.indexOf(tLast) >= 0;
      const iAt = recent ? xs.indexOf(tLast) : xs.indexOf(d.now);
      const { shown, hidden } = visibleYears(yearLines(m, xs, d.now));
      if (recent) {
        const cur = m.at(tLast);
        const chg = d.temp.chg[s.depth]?.at(tLast) ?? NaN;
        out.push(`    36h mean as of ${fmtUtc(new Date(tLast * 1000).toISOString())}: ${f1(cur)} F (${f1(fToC(cur))} C); 7-day change: ${signed(chg)} F.`);
      } else {
        out.push(`    no data in the last 96 days (last 36h mean ${fmtUtc(new Date(tLast * 1000).toISOString())}); comparisons below are for this date and hour in earlier years.`);
      }
      const past = shown.filter((l) => l.offset > 0 && Number.isFinite(l.values[iAt])).map((l) => `${l.year} ${f1(l.values[iAt])} F`);
      if (past.length) out.push(`    36h mean at the same date and hour in earlier years: ${past.join("; ")}.`);
      if (hidden.length) out.push(`    years left out of the comparison because under ${COVERAGE_MIN * 100}% of the 110-day window has data: ${hidden.map((l) => l.year).join(", ")}.`);
    }
    if (d.temp.delta) {
      const sb = stratNow(d);
      out.push(`  Surface minus bottom, mean of the last 24 hours with data: ${signed(sb.deltaC, 2)} C, ${sb.status}.`);
    }
    const w = d.met?.last;
    if (w && w.wind_kt != null) {
      const dir = w.dir_deg != null ? `from ${compass(w.dir_deg)} (${Math.round(w.dir_deg)} degrees)` : "direction unknown";
      out.push(
        `  Weather at the ${d.kind === "buoy" ? "buoy" : "station"}, ${fmtUtc(w.time)} (${ago(w.time)}): wind ${f1(w.wind_kt)} kt ${dir}, gusts ${f1(w.gust_kt ?? NaN)} kt` +
          (WU === "kt" ? "; " : ` (wind ${windFmt(w.wind_kt)} ${WIND_UNITS[WU].label}, gusts ${windFmt(w.gust_kt)} ${WIND_UNITS[WU].label}); `) +
          `air ${f1(w.air_f ?? NaN)} F; pressure ${w.pressure_mb != null ? w.pressure_mb.toFixed(1) : "--"} mbar.`,
      );
    }
    if (wavesOf(st.id)) out.push(`  ${wavesText(st.id)}`);
    if (d.kind === "shore") {
      const e = nextTide(d);
      if (d.levelNow) out.push(`  Water level ${d.levelNow.ft.toFixed(2)} ft above MLLW at ${fmtUtc(d.levelNow.time)} (preliminary).`);
      if (e) out.push(`  Next predicted tide: ${tideText(e)} above MLLW (${fmtUtc(e.t)}).`);
    }
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

/** Plain text of a method entry for the prompt: citations become the references' short labels. */
function methodText(key: string): string {
  const m = METHODS[key];
  if (!m) return "";
  const plain = (t?: string) => (t ?? "").replace(/\[\[([a-z0-9_]+)\]\]/g, (_, k: string) => `(${REF_LABELS[k] ?? k})`).replace(/\{variable\}/g, isWater(VK) ? V().label.toLowerCase() : "the reading").replace(/\{station\}/g, "the station");
  return [`- ${m.title}${m.shows ? `: ${plain(m.shows)}` : ""}`, m.method ? `  Method: ${plain(m.method)}` : "", m.caveats ? `  Caveats: ${plain(m.caveats)}` : ""].filter(Boolean).join("\n");
}

/** The prompt for the collected items: the data of their stations (all stations when nothing is collected), the
 * methods of the collected plots, the readouts and the map as shown, and the visitor's question. */
function collectPrompt(meta: Meta, live: Live, stations: StationData[], ids: string[], question: string): string {
  const scoped = ids.length ? stations.filter((d) => ids.some((id) => id.startsWith(`${d.meta.id}-`))) : stations;
  let text = buildPrompt(meta, live, scoped.length ? scoped : stations);
  const extra: string[] = [];
  const keys = [...new Set(ids.map((id) => id.split("-").slice(1).join("-")).filter((k) => k in FIGS))];
  if (keys.length) extra.push(`Methods for the collected plots:\n${keys.map(methodText).join("\n")}`);
  const rows = ids.filter((id) => id.endsWith("-readouts")).map((id) => {
    const el = document.getElementById(id);
    const station = stations.find((d) => `${d.meta.id}-readouts` === id)?.meta.name ?? id;
    const lines = el ? [...el.querySelectorAll<HTMLElement>(".readout")].map((r) => `  ${r.innerText.replace(/\s*\n\s*/g, "; ")}`) : [];
    return `Readouts at ${station}, as shown (the latest readings${AT != null ? ", not the timeline cursor's time" : ""}; value; label; trend and %ile against the same dates in earlier years; depth and age):\n${lines.join("\n")}`;
  });
  if (rows.length) extra.push(rows.join("\n"));
  if (ids.includes("map")) {
    const key = document.querySelector<HTMLElement>(".field-panel")?.innerText.replace(/\s*\n\s*/g, " ") ?? "";
    const when = document.querySelector<HTMLElement>(".tl-label")?.textContent ?? "now";
    extra.push(`Map as shown: layer ${fieldPick === "none" ? "none (stations only)" : `${fieldPick} (${key})`}, time ${when}.${fieldPick !== "none" ? `\n${methodText(`map-${fieldPick}`)}` : ""}`);
  }
  if (extra.length) text = text.replace("\nQuestion:", `\n${extra.join("\n\n")}\n\nQuestion:`);
  return text.replace(/Question: [\s\S]*$/, `Question: ${question || "[Write your question here]"}`);
}

function wireCollect(meta: Meta, live: Live, stations: StationData[]): void {
  mountCollect({
    elementFor: (id) =>
      id === "map"
        ? document.querySelector<HTMLElement>(".map-col")
        : id.endsWith("-readouts")
          ? document.getElementById(id)
          : (document.getElementById(id)?.closest<HTMLElement>("figure") ?? null),
    prompt: (ids, question) => collectPrompt(meta, live, stations, ids, question),
    titleFor: (id, stored) => {
      if (id !== "map") return stored;
      const layer = fieldPick === "none" ? "stations" : (FIELD_CHOICES.find((c) => c.kind === fieldPick)?.label ?? fieldPick);
      const when = document.querySelector<HTMLElement>(".tl-label")?.textContent ?? "now";
      return `Map: ${layer} \u00b7 ${when}`;
    },
    linkFor: (id) => (id === "map" ? linkUrl() : id.endsWith("-readouts") ? linkUrl(id.replace(/-readouts$/, "")) : linkUrl(id)),
    header: () => `${meta.waterway.name} \u00b7 longhorizon.blue \u00b7 ${fmtEt(new Date().toISOString())} New York time`,
    credit: "Long Horizon Observatory \u00b7 longhorizon.blue \u00b7 CC BY-NC 4.0 \u00b7 data: LISICOS (UConn), NOAA, USGS, NASA; map \u00a9 OpenStreetMap contributors",
    mailTo: "long-island-sound@longhorizon.blue",
    pageName: meta.waterway.name,
  });
}


/* ---------- Main ---------- */

/** Units (kt, mph, m/s; waves in ft, or m with m/s): knots by default; the choice is remembered in this browser only. */
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
function gaugePins(): Pin[] {
  return RIVER_SECTIONS.filter((d) => d.kind === "river").map((d) => {
    const g = d.gauge!;
    if (AT != null) {
      const f = riverFlow(d.river!, g.id, AT);
      const label = Number.isFinite(f) ? `${cfs(f)} cfs, ${riverClass(d.river!, g.id, AT, f)}; observed ${atLabel(AT)}` : `no ${atFuture() ? "forecast" : "reading"} at ${atLabel(AT)}`;
      const last = d.river!.last[g.id];
      const base = last ? obsState({ time: last.time } as LastObs) : "offline";
      return { id: g.id, name: g.name, lat: g.lat, lon: g.lon, state: Number.isFinite(f) ? base : "offline", label };
    }
    const o = d.river!.last[g.id];
    const t = o ? Date.parse(o.time) / 1000 : NaN;
    const label = o?.flow_cfs != null ? `${cfs(o.flow_cfs)} cfs, ${riverClass(d.river!, g.id, t, o.flow_cfs)}; ${ago(o.time)}` : g.discontinued ? "gauge discontinued" : "no recent reading";
    return { id: g.id, name: g.name, lat: g.lat, lon: g.lon, state: o ? obsState({ time: o.time } as LastObs) : "offline", label };
  });
}

/** The map follows the view: basins and gauges in Rivers, the Sound otherwise; and the view's surface field. */
async function syncMap(): Promise<void> {
  if (EMBED) return; // an embed draws no map
  syncSchematic();
  try {
    (await import("./map")).setRiverMode(VK === "rivers", VK === "rivers" ? gaugePins() : []);
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

/** Scroll to a linked plot (or station) and outline it for a moment. */
function revealLinked(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  const target = el.closest("figure") ?? el;
  target.scrollIntoView({ block: "center" });
  target.classList.add("linked");
  window.setTimeout(() => target.classList.remove("linked"), 2600);
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
function wireRiverHover(): void {
  const box = $("status");
  let pending = 0;
  let current: string | null = null;
  const focus = (id: string | null) => {
    if (id === current) return;
    current = id;
    window.clearTimeout(pending);
    pending = window.setTimeout(async () => {
      try {
        (await import("./map")).focusBasin(id);
      } catch {
        /* map not loaded */
      }
    }, 120);
  };
  const row = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>("tr[data-gauge]")?.dataset.gauge ?? null;
  box.addEventListener("pointerover", (e) => VK === "rivers" && row(e) && focus(row(e)));
  box.addEventListener("focusin", (e) => VK === "rivers" && row(e) && focus(row(e)));
  box.addEventListener("pointerleave", () => VK === "rivers" && focus(null));
}

/** A phone drop-down: the button opens its panel under the bar; a choice, a tap elsewhere or Esc closes it.
 * Opening one closes any other. Returns the setter, for closing after a choice. */
const drops: ((open: boolean) => void)[] = [];
function dropDown(btn: HTMLElement, panel: HTMLElement): (open: boolean) => void {
  const setOpen = (open: boolean) => {
    if (open) drops.forEach((close) => close !== setOpen && close(false));
    panel.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    // A narrow panel opens under its own button, kept on the screen; a full-width one (the freshness line) as styled.
    if (open && panel.offsetWidth < window.innerWidth * 0.8) {
      const bar = btn.offsetParent as HTMLElement | null;
      const room = (bar?.clientWidth ?? window.innerWidth) - panel.offsetWidth - 8;
      panel.style.left = `${Math.max(8, Math.min(btn.offsetLeft, room))}px`;
      panel.style.right = "auto";
    }
  };
  drops.push(setOpen);
  btn.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (panel.classList.contains("open") && !btn.contains(t) && !panel.contains(t)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) {
      setOpen(false);
      btn.focus();
    }
  });
  return setOpen;
}

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
        await ensureVar(k, live, stations);
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

/** The Light/Dark toggle: light by default; the choice is remembered in this browser only. */
/** The phone's outage icon: opens the note in a dialog. */
function wireOutageIcon(): void {
  const dialog = $("outage-dialog") as HTMLDialogElement;
  // With a mouse the note shows on hover or focus (site.css); a tap on a touch screen opens it in the dialog.
  $("outage-icon").addEventListener("click", () => {
    if (!matchMedia("(hover: hover)").matches) dialog.showModal();
  });
  $("outage-dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
}

/** The boat class for the comfort index (the menu's Boat setting): paddle craft, small boat (5 to 8 m, the default),
 * large boat (8 to 15 m); kept in this browser. */
let BOAT: import("./fields").Boat = (() => {
  try {
    const b = localStorage.getItem("lhzn-blue-boat");
    // Earlier saved choices (paddle craft, small boat, large boat) map to the nearest class.
    const old: Record<string, import("./fields").Boat> = { paddle: "kayak", small: "console", large: "big" };
    return b === "kayak" || b === "skiff" || b === "console" || b === "big" ? b : old[b ?? ""] ?? "console";
  } catch {
    return "console";
  }
})();
/** The boat picker in the menu and in the comfort charts: one listener for every picker on the page. */
function wireBoat(): void {
  const slot = document.querySelector("[data-boat-slot]");
  if (slot) slot.insertAdjacentHTML("beforeend", boatPickerHtml(BOAT));
  // Up front, in the byline: the chosen boat's icon (its name and length as the tooltip); a click opens the picker.
  const mast = document.querySelector<HTMLElement>("[data-boat-mast]");
  const chip = () => `${BOATS[BOAT].name} \u00b7 ${Math.round(BOATS[BOAT].loa * 3.28084)} ft`;
  const spoken = () => `Boat for the comfort index: ${boatLabel(BOAT)}`;
  if (mast) {
    mast.innerHTML = `<button type="button" class="boat-now" aria-haspopup="true" aria-expanded="false" title="${chip()}" aria-label="${spoken()}">${boatIcon(BOAT, 12)}</button>` +
      `<span class="boat-pop" hidden>${boatPickerHtml(BOAT)}</span>`;
  }
  const now = mast?.querySelector<HTMLButtonElement>(".boat-now");
  const pop = mast?.querySelector<HTMLElement>(".boat-pop");
  const openPop = (open: boolean) => {
    if (!pop || !now) return;
    pop.hidden = !open;
    now.setAttribute("aria-expanded", String(open));
  };
  now?.addEventListener("click", () => openPop(!!pop?.hidden));
  document.addEventListener("click", (e) => {
    if (pop && !pop.hidden && !(e.target as Element).closest?.("[data-boat-mast]")) openPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop && !pop.hidden) {
      openPop(false);
      now?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    const b = (e.target as Element).closest?.("button[data-boat]") as HTMLButtonElement | null;
    if (!b) return;
    e.stopPropagation(); // the menu stays open
    BOAT = b.dataset.boat as typeof BOAT;
    try {
      localStorage.setItem("lhzn-blue-boat", BOAT);
    } catch {
      /* private mode: for this visit */
    }
    document.querySelectorAll<HTMLButtonElement>("button[data-boat]").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.boat === BOAT)));
    if (now) {
      now.innerHTML = boatIcon(BOAT, 12);
      now.title = chip();
      now.setAttribute("aria-label", spoken());
    }
    if (b.closest("[data-boat-mast]")) openPop(false);
    // The comfort charts, if open, redraw for the new boat.
    const chart = document.querySelector("#about-dialog-body .comfort-chart");
    if (chart) chart.outerHTML = comfortTableHtml(BOAT, WU === "ms");
    void syncField();
  });
}

/** "Use my location": off by default. Only when the reader turns it on does the browser ask for the location, once per
 * visit; the map then opens on their part of the Sound. The location is used in this browser only and never sent. */
function wireLocate(): void {
  const btn = document.querySelector<HTMLButtonElement>('[data-more="locate"]');
  if (!btn || !("geolocation" in navigator)) {
    btn?.remove();
    return;
  }
  let on = false;
  try {
    on = localStorage.getItem("lhzn-blue-locate") === "1";
  } catch {
    /* private mode: off */
  }
  const label = (note = "") => {
    btn.textContent = `Use my location: ${on ? "on" : "off"}${note}`;
    btn.setAttribute("aria-pressed", String(on));
  };
  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const near = await (await import("./map")).focusOn({ lon: pos.coords.longitude, lat: pos.coords.latitude });
        label(near ? "" : " (not near the Sound)");
      },
      () => label(" (not available)"),
      { maximumAge: 10 * 60_000, timeout: 10_000, enableHighAccuracy: false },
    );
  label();
  if (on) locate();
  btn.addEventListener("click", async () => {
    on = !on;
    try {
      if (on) localStorage.setItem("lhzn-blue-locate", "1");
      else localStorage.removeItem("lhzn-blue-locate");
    } catch {
      /* private mode: for this visit only */
    }
    label();
    if (on) locate();
    else void (await import("./map")).focusOn(null);
  });
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
interface UsgsTidal {
  generated_at: string;
  stations: Record<string, {
    name: string; short: string; usgs_id: string; lat: number; lon: number; side: string; caveat?: string;
    series: { t0: string | null; step: number; level_ft?: (number | null)[]; temperature_c?: (number | null)[];
      salinity?: (number | null)[]; oxygen_mg_l?: (number | null)[]; turbidity_fnu?: (number | null)[] };
    last: Record<string, { time: string; value: number }>;
    tides?: { pred: { t0: string; step: number; ft: (number | null)[] }; hilo: TideEvent[]; datums_ft: Record<string, number>; flood_ft: Record<string, number | null> };
  }>;
}

/** The USGS gauges with a level, as shore stations; their predictions join the tides (ours, fitted to each gauge's
 * own record and set on NOAA's footing; see the jobs' usgs_tidal). */
function usgsShoreStations(u: UsgsTidal): StationData[] {
  const toF = (c: number | null | undefined) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
  const out: StationData[] = [];
  for (const [id, g] of Object.entries(u.stations)) {
    if (!g.series.level_ft) continue; // water quality only (Old Lyme): not a tide station
    const st: ShoreMetaStation = {
      id, name: g.short, operator: "USGS", lat: g.lat, lon: g.lon, coops_id: "",
      info_url: `https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/`,
      note: g.caveat ?? null, record_start: g.series.t0,
    };
    const lv = g.last.level_ft, wt = g.last.temperature_c;
    const frame = {
      t0: g.series.t0, step: 3600, level_ft: g.series.level_ft, water_f: g.series.temperature_c?.map(toF),
      last_obs: lv ? { time: lv.time, level_ft: lv.value, water_f: wt ? toF(wt.value) : null } : null,
      tides: g.tides?.hilo ?? [], datum: "MLLW", coops_id: "",
    } as unknown as ShoreFrame;
    out.push(shoreStation(st, frame, undefined));
    if (g.tides) USGS_TIDES[id] = { pred: g.tides.pred, hilo: g.tides.hilo, datums_ft: g.tides.datums_ft, flood_ft: g.tides.flood_ft };
  }
  if (TIDES) TIDES = { ...TIDES, ...USGS_TIDES };
  DEPARTURE.clear();
  return out;
}

/* ---------- Coastal airports (NWS ASOS weather, through the Iowa Environmental Mesonet) ---------- */

interface AsosFrame { t0: string | null; step: number; air_f?: (number | null)[]; wind_kt?: (number | null)[]; gust_kt?: (number | null)[]; dir_deg?: (number | null)[]; pressure_mb?: (number | null)[]; last_obs: MetWindow["last_obs"] }
interface AsosFile { generated_at: string; source: string; stations: Record<string, AsosFrame> }

/** The airports as stations of their own kind: weather only (no water, no tides), shown in the Wind & waves view. */
function airportStations(a: AsosFile): StationData[] {
  const out: StationData[] = [];
  for (const st of asosRegistry.stations) {
    const f = a.stations[st.id];
    if (!f?.t0) continue;
    const meta = { id: st.id, name: `${st.name}, ${st.place}`, operator: st.operator, lat: st.lat, lon: st.lon, coops_id: "", info_url: st.info_url, note: st.note, record_start: f.t0 } as ShoreMetaStation;
    const frame = { ...f, tides: [], datum: "", coops_id: "" } as unknown as ShoreFrame;
    out.push({ ...shoreStation(meta, frame, undefined), kind: "airport", level: null, levelNow: null });
  }
  return out;
}

/** An airport's pin: its wind (measured, or HRRR ahead of now), in any view. */
function airportPin(d: StationData): Pin {
  const base = { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, kind: "shore" as const };
  const u = WIND_UNITS[WU].label;
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f) return { ...base, state: overallState(d), label: `Forecast: wind ${compass(f.dir)} ${windFmt(f.spd)} ${u}, gusts ${windFmt(f.gust)}<br>HRRR, ${f.lead} h ahead<br>${atLabel(AT)}` };
  }
  if (AT != null) {
    const wind = d.met?.wind?.at(AT) ?? NaN;
    const dir = d.met?.dir?.at(AT) ?? NaN;
    return Number.isFinite(wind)
      ? { ...base, state: overallState(d), label: `Airport wind ${Number.isFinite(dir) ? compass(dir) + " " : ""}${windFmt(wind)} ${u}<br>observed ${atLabel(AT)}` }
      : { ...base, state: "offline", label: `no reading at ${atLabel(AT)}` };
  }
  const w = d.met?.last;
  const label = w && w.wind_kt != null
    ? `Airport wind ${w.dir_deg != null ? compass(w.dir_deg) + " " : ""}${windFmt(w.wind_kt)} ${u}${w.gust_kt != null ? `, gusts ${windFmt(w.gust_kt)}` : ""}, ${ago(w.time)}${w.air_f != null ? `<br>air ${Math.round(w.air_f)}&deg;F` : ""}`
    : "no recent report";
  return { ...base, state: overallState(d), label };
}

/* ---------- USGS water quality at the shore (a separate source from the buoys) ---------- */
let USGS_WQ: UsgsTidal | null = null;
const USGS_VAR: Partial<Record<VarKey, { key: "temperature_c" | "salinity" | "oxygen_mg_l" | "turbidity_fnu"; unit: string; digits: number; f?: (v: number) => number }>> = {
  temp: { key: "temperature_c", unit: "&deg;F", digits: 1, f: (c) => (c * 9) / 5 + 32 },
  salinity: { key: "salinity", unit: "", digits: 1 },
  oxygen: { key: "oxygen_mg_l", unit: "", digits: 1 },
  turbidity: { key: "turbidity_fnu", unit: " FNU", digits: 1 },
};
// What each gauge's water is (so its numbers are read for what they are).
const USGS_SITE_NOTE: Record<string, string> = {
  WHOB: "West Harbor, Oyster Bay: a harbor off the western Sound",
  NORW: "the Norwalk River at the Maritime Aquarium: a river mouth, fresher and more turbid than the open Sound",
  FLAX: "Flax Pond: a tidal salt-marsh pond behind a narrow inlet, warmer and cooler than the Sound by turns",
  OLDL: "the Connecticut River at Old Lyme: the river's estuary, nearly fresh at most tides",
};

/** The USGS shore gauges' water quality for the view's variable, west to east: value, age, 7-day line. */
function usgsWqHtml(): string {
  const spec = USGS_VAR[VK];
  if (!USGS_WQ || !spec) return "";
  const rows = Object.entries(USGS_WQ.stations)
    .filter(([, g]) => g.series[spec.key]?.length)
    .sort(([, a], [, b]) => a.lon - b.lon)
    .map(([id, g]) => {
      const vals = g.series[spec.key]!.map((v) => (v == null ? NaN : spec.f ? spec.f(v) : v));
      const h = new Hourly(Date.parse(g.series.t0!) / 1000, Float64Array.from(vals));
      const last = g.last[spec.key];
      const site = `${USGS_SITE_NOTE[id] ?? g.name}. USGS ${g.usgs_id}, provisional data`;
      const name = `<th scope="row"><a href="https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/" title="${site}"><i class="dot shore ${last && hoursOld(last.time) < DELAYED_HOURS ? "live" : last && hoursOld(last.time) < OFFLINE_HOURS ? "delayed" : "offline"}"></i>${g.short}</a></th>`;
      const spark = sparklineOf(h, P.line, spec.unit.replace(/&deg;/, "°").trim() || unitName(VK), spec.digits);
      let cell: string;
      if (AT != null) {
        const v = h.at(hourOf(AT));
        cell = atCell(v, `${v.toFixed(spec.digits)}${spec.unit}`, `${g.short}: ${v.toFixed(spec.digits)}${spec.unit}`, spark);
      } else if (!last || hoursOld(last.time) >= OFFLINE_HOURS) {
        cell = `<td class="offline"><b>--</b><small>no recent reading</small></td>`;
      } else {
        const v = spec.f ? spec.f(last.value) : last.value;
        const low = VK === "oxygen" && v < DO_LEVELS.hypoxic;
        cell = `<td class="${hoursOld(last.time) < DELAYED_HOURS ? "live" : "delayed"}${low ? " low" : ""}" title="${g.short}: ${v.toFixed(spec.digits)}${spec.unit}, ${ago(last.time)}; ${site}">${spark}<b>${v.toFixed(spec.digits)}${spec.unit}</b><small>${low ? oxygenStatus(v) + " &middot; " : ""}${ago(last.time).replace(" ago", "")}</small></td>`;
      }
      return `<tr>${name}${cell}</tr>`;
    });
  if (!rows.length) return "";
  const what = VK === "turbidity" ? "turbidity (FNU, a different scale from the buoys' NTU)" : `${V().label.toLowerCase()} (${VK === "temp" ? "&deg;F" : unitName(VK)})`;
  return `<table class="status-grid usgs-wq"><caption>Shore gauges &middot; USGS, west to east: ${what}${AT != null ? ` at ${atLabel(AT)}` : ", latest"}</caption><tbody>${rows.join("")}</tbody></table>
    <p class="status-key">A separate source from the buoys: USGS water-quality sondes in harbors, a pond and river mouths, near the surface; provisional. Hover a name for what its water is.</p>`;
}

/** Shore stations from the registry, west to east (their record start years until the history arrives). */
const SHORE: ShoreMetaStation[] = shoreRegistry.stations
  .map((s) => ({ ...s, note: (s as { note?: string }).note ?? null, record_start: `${s.record_start_year}-01-01T00:00:00Z` }))
  .sort((a, b) => a.lon - b.lon);

async function main(): Promise<void> {
  P = PALETTES[currentTheme()];
  // Shore data loads alongside the buoys but never holds them up; its history (the larger file) last.
  const shoreLive = getJson<ShoreLive>(`${DATA}/shore.json`).catch(() => null);
  const shoreHist = getJson<ShoreHistory>(`${DATA}/shore-history.json`).catch(() => null);
  const usgsLive = getJson<UsgsTidal>(`${DATA}/usgs-tidal.json`).catch(() => null);
  const asosLive = getJson<AsosFile>(`${DATA}/asos.json`).catch(() => null);
  try {
    const { meta, live, stations } = await load();
    const byId = (id: string) => [...stations, ...RIVER_SECTIONS, ...(TURB_SECTION ? [TURB_SECTION] : [])].find((d) => d.meta.id === id)!;
    // A remembered salinity or oxygen choice loads its history first; if that fails, show temperature.
    if (VK !== "temp") await ensureVar(VK, live, stations).catch(() => (VK = "temp"));
    /** The stations on screen: the rivers section in the Rivers view, the buoys and shore stations otherwise. */
    const shown = () => (EMBED ? stations.filter((d) => d.meta.id === EMBED_STATION) : VK === "rivers" ? RIVER_SECTIONS : VK === "turbidity" ? (TURB_SECTION ? [TURB_SECTION] : []) : VK === "tides" ? stations.filter((d) => d.kind === "shore") : stations.filter((d) => d.kind !== "airport" || VK === "wind"));
    const drawAll = () => {
      for (const d of shown()) {
        readouts(d);
        (Object.keys(FIGS) as Kind[]).forEach((k) => drawInline(d, k));
      }
      if (zoom) drawZoom();
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
          ? `<h2 class="station-group">Shore stations, NOAA and USGS tide gauges</h2>${stations.filter((d) => d.kind === "shore").map(sectionHtml).join("")}`
          : VK === "rivers"
          ? `<h2 class="station-group">Rivers into the Sound, USGS stream gauges</h2>${RIVER_SECTIONS.map(sectionHtml).join("")}`
          : VK === "turbidity"
            ? `<h2 class="station-group">Turbidity, point observations</h2>${TURB_SECTION ? sectionHtml(TURB_SECTION) : ""}`
            : group("buoy", "Buoys, LISICOS") + group("shore", "Shore stations, NOAA and USGS tide gauges") +
              (VK === "wind" ? group("airport", "Coastal airports, NWS weather stations") : "");
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
    // Shore stations join once their live file arrives; the map waits for them so every pin is placed once.
    const sl = await shoreLive;
    if (sl) {
      stations.push(...SHORE.map((st) => shoreStation(st, sl.stations[st.id], undefined)));
      renderSections();
      statusGrid(stations);
      aboutShore(sl.qc);
    }
    // The USGS tidal gauges join the shore stations, all of them west to east after the buoys.
    const ul = await usgsLive;
    USGS_WQ = ul;
    if (ul) {
      const added = usgsShoreStations(ul);
      if (added.length) {
        const rest = stations.filter((d) => d.kind !== "shore");
        const shore = [...stations.filter((d) => d.kind === "shore"), ...added].sort((a, b) => a.meta.lon - b.meta.lon);
        stations.splice(0, stations.length, ...rest, ...shore);
        renderSections();
        statusGrid(stations);
      }
    }
    // The coastal airports (weather only) after the shore stations.
    const al = await asosLive;
    if (al) {
      stations.push(...airportStations(al));
      renderSections();
    }
    if (!EMBED) void overviewMap(stations); // an embed draws no map
    void shoreHist.then((sh) => {
      if (!sh || !sl) return;
      for (const st of SHORE) {
        const i = stations.findIndex((d) => d.meta.id === st.id);
        if (i >= 0) stations[i] = shoreStation(st, sl.stations[st.id], sh.series[st.id]);
      }
      keepPlace(renderSections);
    });
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
      if (opener?.dataset.station) openZoom(byId(opener.dataset.station), opener.dataset.fig as Kind, opener.dataset.full === "1");
    });
    wireZoom();
    wireAbout();
    window.setTimeout(revealLinked, 300); // after the sections draw
    updatedStrip(meta, live);
    about(meta);
    wireCollect(meta, live, stations);
    const redraw = () => {
      drawAll();
      statusGrid(stations);
    };
    fcstRedraw = () => {
      drawAll();
      void showAt(AT);
      statusGrid(stations);
    };
    tidesRedraw = () => {
      DEPARTURE.clear();
      drawAll();
      void showAt(AT);
      statusGrid(stations);
    };
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
    wireLocate();
    wireBoat();
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
