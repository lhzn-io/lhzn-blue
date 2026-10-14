/** Long Island Sound page: overview (map and status grid), readouts and views per station, a zoom view,
 * and the bring-your-own-AI prompt. */
import "./site.css";

import promptTemplate from "../../../configs/prompts/visitor_prompt.txt?raw";
import registry from "../../../stations/stations.json";
import shoreRegistry from "../../../stations/shore.json";
import { highlight, renderLines, YELLOW, type ChartOptions, type Line } from "./chart";
import { wireHints } from "./hints";
import { BUOY_SENSORS, METHODS, methodHtml, REF_LABELS } from "./methods";
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
  oxygen: [string, string, string]; // dissolved oxygen shading: anoxic, hypoxic, below the growth criterion
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
    oxygen: ["rgba(240,177,53,0.26)", "rgba(240,177,53,0.14)", "rgba(240,177,53,0.05)"],
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
    oxygen: ["rgba(163,90,0,0.22)", "rgba(163,90,0,0.12)", "rgba(163,90,0,0.045)"],
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
type VarKey = "temp" | "salinity" | "oxygen" | "turbidity" | "wind" | "rivers";
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
};
const isWater = (k: VarKey) => k === "temp" || k === "salinity" || k === "oxygen";
let VK: VarKey = "temp";
/** What a link asked for: ?view=oxygen&layer=sst&t=-30d#WLIS-col (see linkUrl). */
const LINK = new URLSearchParams(location.search);
try {
  const saved = LINK.get("view") ?? localStorage.getItem("lhzn-blue-water-var");
  if (saved && saved in WATER_VARS) VK = saved as VarKey;
} catch {
  /* private mode: temperature */
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
  kind: "buoy" | "shore" | "rivers" | "river" | "turbidity"; // rivers: the all-rivers summary; river: one gauge
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

/** Stratification is a temperature measure, whichever variable is shown. */
function stratNow(d: StationData): { deltaC: number; status: string } {
  const delta = d.temp.delta;
  const end = delta ? delta.lastValid() : NaN;
  const deltaC = delta && Number.isFinite(end) ? (delta.mean(end - 23 * HOUR, end) * 5) / 9 : NaN;
  return { deltaC, status: stratStatus(deltaC) };
}

/* ---------- Figures: one builder per view, used inline and in the zoom view ---------- */

type Kind = "yoy" | "chg" | "col" | "sb" | "wind" | "air" | "tide" | "waves" | "pressure" | "flow" | "share" | "rturb" | "ryoy" | "rpct" | "bturb";

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
  if (d.kind === "shore" && VK !== "temp") return `${d.meta.name} measures water temperature only; ${V().label.toLowerCase()} comes from the buoys.`;
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
  tide: {
    title: "Water level",
    sub: "observed hourly and predicted highs and lows, feet above mean lower low water",
    varies: false,
    in: (k) => k !== "rivers",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.level,
    window: (d) => [d.now - 7 * DAY, d.now + 2 * DAY],
    maxSpan: 100 * DAY,
    start: (d) => d.level?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const step = xs.length > 1 ? xs[1] - xs[0] : HOUR;
      // Each predicted high and low on the grid point nearest its minute.
      const events = xs.map(() => NaN);
      const kinds = xs.map(() => "");
      for (const e of d.tides) {
        const i = Math.round((Date.parse(e.t) / 1000 - xs[0]) / step);
        if (i >= 0 && i < xs.length) {
          events[i] = e.ft;
          kinds[i] = e.type === "H" ? "high" : "low";
        }
      }
      const ft = (v: number) => `${v.toFixed(2)} ft`;
      const lines: Line[] = [
        { ys: xs.map((t) => d.level?.at(t) ?? NaN), color: P.depth.SFC, width: 1.6, label: "Observed", fmt: ft },
        { ys: events, color: P.contrast, opacity: 0.8, label: "Predicted high or low", dots: true, fmt: (v) => `${ft(v)}` },
      ];
      return {
        opts: { xs, lines, unit: " ft", marker: { x: d.now, label: "now" }, empty: "No water level in this window." },
        legend: [["Observed", P.depth.SFC, 1], ["Predicted high or low", P.contrast, 0.8]],
        note: d.tides.length ? `predictions held from ${fmtDate.format(new Date(d.tides[0].t))}; observations are preliminary until NOAA verifies them` : undefined,
      };
    },
  },
  waves: {
    title: "Waves",
    sub: "significant wave height hourly, with each hour's highest wave",
    varies: false,
    in: (k) => k === "wind",
    depthTabs: false,
    seasonal: false,
    available: (d) => d.kind === "buoy" && !!wavesOf(d.meta.id)?.sensor,
    window: LEFT,
    maxSpan: 2 * 366 * DAY,
    start: (d) => d.waves?.hs?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const w = d.waves;
      const u = waveUnit();
      const val = (m: number) => m * u.factor;
      const fmt = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
      const lines: Line[] = w
        ? [
            { ys: xs.map((t) => val(w.hmax?.at(t) ?? NaN)), color: P.contrast, width: 0.7, opacity: 0.35, label: "Highest wave", fmt },
            { ys: xs.map((t) => val(w.hs?.at(t) ?? NaN)), color: P.depth.BTM, width: 1.6, label: "Significant height", fmt },
            { ys: xs.map((t) => w.tp?.at(t) ?? NaN), color: P.contrast, label: "Dominant period", hidden: true, fmt: (v) => `${v.toFixed(1)} s` },
          ]
        : [];
      return {
        opts: { xs, lines, unit: ` ${u.label}`, zero: true, hoverDigits: u.digits, empty: `No wave readings in this window. ${wavesText(d.meta.id)} Full record shows what we hold.` },
        legend: [["Significant height", P.depth.BTM, 1], ["Highest wave", P.contrast, 0.35]],
        note: "significant height: the mean of the highest third of waves, close to what an observer reports",
      };
    },
  },
  pressure: {
    title: "Pressure",
    sub: "hourly, at the station",
    varies: false,
    in: (k) => k === "wind",
    depthTabs: false,
    seasonal: false,
    available: (d) => !!d.met?.pressure && Number.isFinite(d.met.pressure.lastValid()),
    window: RIGHT,
    maxSpan: 100 * DAY,
    start: (d) => d.met?.pressure?.t0 ?? d.now,
    build: (d, _depth, x0, x1) => {
      const xs = grid(x0, x1);
      const lines: Line[] = [{ ys: xs.map((t) => d.met?.pressure?.at(t) ?? NaN), color: P.air, width: 1.5, label: "Pressure" }];
      return { opts: { xs, lines, unit: " mb", hoverDigits: 1, empty: "No pressure readings in this window." }, legend: [["Pressure", P.air, 1]] };
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
      const colors = [P.depth.SFC, P.depth.MID, P.depth.BTM, P.wind, P.air, P.delayed, P.contrast];
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
      const lines: Line[] = [{ ys: xs.map((t) => d.river?.turb?.at(t) ?? NaN), color: P.air, width: 1.5, label }];
      return {
        opts: { xs, lines, unit: " FNU", hoverDigits: 1, zero: true, empty: "No turbidity readings in this window." },
        legend: [[label, P.air, 1]],
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
      const colors = [P.depth.SFC, P.depth.MID, P.depth.BTM, P.wind, P.air];
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
const ORDER: Kind[] = ["yoy", "chg", "col", "sb", "wind", "air", "tide", "waves", "pressure", "share", "bturb", "flow", "rpct", "ryoy", "rturb"];

/** A figure's name with the variable it shows, for the zoom title and screen readers. */
const figName = (f: Fig) => (f.varies && VK !== "temp" ? `${V().label}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}` : f.title);

/** Whether a station shows a figure: shore stations measure temperature only, so under salinity or oxygen
 * their variable charts are left out rather than drawn empty. */
const shows = (d: StationData, k: Kind) =>
  FIGS[k].in(VK) && FIGS[k].available(d) && !(FIGS[k].varies && d.kind === "shore" && VK !== "temp");

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
  return `${fmtAtWhen.format(new Date(ms))} (${ms < Date.now() ? `${span(ms, Date.now())} ago` : `in ${span(Date.now(), ms)}`})`;
}
/** A table cell at the cursor's time: the observed value where the record covers it, "--" otherwise. */
function atCell(v: number, shown: string, title: string, spark = "", extra = ""): string {
  if (!Number.isFinite(v)) return `<td class="offline"><b>--</b><small>${atFuture() ? "no forecast" : "no reading"}</small></td>`;
  return `<td class="asof" title="${title}, observed ${atLabel(AT!)}">${spark}<b>${shown}</b><small>${extra || "observed"}</small></td>`;
}

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

function cellHtml(d: StationData, depth: string): string {
  if (d.kind === "shore" && VK !== "temp") return `<td class="na" title="Not measured at this station">&middot;</td>`;
  if (!d.depths.includes(depth)) return `<td class="na" title="No ${DEPTH_LABEL[depth].toLowerCase()} sensor published">&middot;</td>`;
  if (AT != null) {
    const h = d.hourly[depth];
    const v = h ? h.at(AT) : NaN;
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
  return `<td class="${state}${low ? " low" : ""}" title="${DEPTH_LABEL[depth]}: ${value.toFixed(V().digits)} ${unitName(VK)}${status}, ${ago(o.time)}">${sparkline(d, depth, state === "live" ? P.now : P.delayed)}<b>${shown}</b><small>${low ? oxygenStatus(value) + " &middot; " : ""}${ago(o.time).replace(" ago", "")}</small></td>`;
}

/** Latest buoy wind: mean and gust in the chosen unit, a downwind arrow with the compass point it comes
 * from, and air temperature, with a 7-day wind sparkline. */
function windCell(d: StationData): string {
  if (AT != null) {
    const m = d.met;
    if (!m?.wind) return `<td class="na">&middot;</td>`;
    const v = m.wind.at(AT);
    const dir = m.dir?.at(AT) ?? NaN;
    const gust = m.gust?.at(AT) ?? NaN;
    const u = WIND_UNITS[WU].label;
    const from = Number.isFinite(dir) ? compass(dir) : "";
    return atCell(v, `${Number.isFinite(dir) ? windArrow(dir) : ""}${from} ${windFmt(v)}<small class="g">${u}</small>`, `Wind ${windFmt(v)} ${u} from ${from || "--"}, gusts ${windFmt(gust)} ${u}`, sparklineOf(m.wind, P.wind, "kt"), `gusts ${windFmt(gust)}`);
  }
  const o = d.met?.last;
  if (!o || o.wind_kt == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent wind</small></td>`;
  const u = WIND_UNITS[WU].label;
  const dir = o.dir_deg != null ? compass(o.dir_deg) : "";
  const title = `Wind ${windFmt(o.wind_kt)} ${u}, gusts ${windFmt(o.gust_kt)} ${u}, from ${dir || "--"}; air ${f1(o.air_f ?? NaN)} F; ${ago(o.time)}`;
  const spark = d.met?.wind ? sparklineOf(d.met.wind, P.wind, "kt") : "";
  return `<td class="${state} wind" title="${title}">${spark}<b>${o.dir_deg != null ? windArrow(o.dir_deg) : ""}${dir} ${windFmt(o.wind_kt)}<small class="g">${u}</small></b><small>gusts ${windFmt(o.gust_kt)} &middot; ${ago(o.time).replace(" ago", "")}</small></td>`;
}

/** Waves: the latest significant height and period where published, the outage with its last reading where
 * not, and "no sensor" where the buoy has none. */
function wavesCell(d: StationData): string {
  const w = wavesOf(d.meta.id);
  if (!w) return `<td class="na">&middot;</td>`;
  const panel = panelsOf(d.meta.id).waves;
  if (!w.sensor) return `<td class="na" title="${wavesText(d.meta.id)}"><small>no sensor</small></td>`;
  if (AT != null) {
    const v = d.waves?.hs?.at(AT) ?? NaN;
    return atCell(v, `${waveFmt(v)}<small class="g"> ${waveUnit().label}</small>`, `Significant wave height ${waveFmt(v)} ${waveUnit().label}`);
  }
  const last = lastWave(d.meta.id);
  const state = last ? obsState({ time: last.time } as LastObs) : "offline";
  if (WAVE_LIVE[d.meta.id]?.published && last && state !== "offline") {
    const spark = d.waves?.hs ? sparklineOf(d.waves.hs, P.depth.BTM, "m significant height", 2) : "";
    return `<td class="${state}" title="Significant wave height ${waveFmt(last.hs_m)} ${waveUnit().label}, highest ${waveFmt(last.hmax_m)}, period ${last.tp_s ?? "--"} s; ${ago(last.time)}">${spark}<b>${waveFmt(last.hs_m)}<small class="g"> ${waveUnit().label}</small></b><small>${last.tp_s != null ? last.tp_s.toFixed(0) + " s &middot; " : ""}${ago(last.time).replace(" ago", "")}</small></td>`;
  }
  const inner = `<b>--</b><small>${wavesText(d.meta.id, true)}</small>`;
  return `<td class="offline waves" title="${wavesText(d.meta.id)}">${panel ? `<a href="${panel}">${inner}</a>` : inner}</td>`;
}

/** Air temperature at the station, and pressure with its change over the last 3 hours (the forecaster's tendency). */
function airCell(d: StationData): string {
  if (AT != null) {
    if (!d.met?.air) return `<td class="na">&middot;</td>`;
    const v = d.met.air.at(AT);
    return atCell(v, `${Math.round(v)}&deg;`, `Air ${f1(v)} F`);
  }
  const o = d.met?.last;
  if (!o || o.air_f == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b></td>`;
  return `<td class="${state}" title="Air ${f1(o.air_f)} F, ${ago(o.time)}"><b>${Math.round(o.air_f)}&deg;</b><small>${ago(o.time).replace(" ago", "")}</small></td>`;
}

function pressureCell(d: StationData): string {
  const o = d.met?.last;
  const p = d.met?.pressure;
  if (AT != null) {
    if (!p) return `<td class="na">&middot;</td>`;
    const v = p.at(AT);
    const tend = p.at(AT) - p.at(AT - 3 * HOUR);
    return atCell(v, `${v.toFixed(0)}<small class="g"> mb</small>`, `Pressure ${v.toFixed(1)} mbar`, "", Number.isFinite(tend) ? `${signed(tend)} in 3h` : "");
  }
  if (!o || o.pressure_mb == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b></td>`;
  const end = p ? p.lastValid() : NaN;
  const trend = p && Number.isFinite(end) ? p.at(end) - p.at(end - 3 * HOUR) : NaN;
  const tend = Number.isFinite(trend) ? `${signed(trend)} in 3h` : "";
  return `<td class="${state}" title="Pressure ${o.pressure_mb.toFixed(1)} mbar${tend ? `, ${tend}` : ""}; ${ago(o.time)}"><b>${o.pressure_mb.toFixed(0)}<small class="g"> mb</small></b><small>${tend || ago(o.time).replace(" ago", "")}</small></td>`;
}

/** Shore station cells: the latest water level with a 7-day line (the tides), and the next predicted tide. */
function levelCell(d: StationData): string {
  if (AT != null) {
    if (!d.level) return `<td class="na">&middot;</td>`;
    const v = d.level.at(AT);
    return atCell(v, `${feet(v)}<small class="g"> ft</small>`, `Water level ${feet(v)} ft above MLLW (preliminary)`, sparklineOf(d.level, P.depth.SFC, "ft above MLLW"));
  }
  const lv = d.levelNow;
  if (!lv) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: lv.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent level</small></td>`;
  const spark = d.level ? sparklineOf(d.level, P.depth.SFC, "ft above MLLW") : "";
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
        : `<td class="offline"><b>--</b><small>${AT != null ? (atFuture() ? "no forecast" : "no reading") : "no current reading"}</small></td>`;
    return `<tr><th scope="row"><a href="#TURB"><i class="dot ${state}"></i>${b.name}</a></th>${value}
      <td><b>${state === "offline" ? "--" : fouled ? "likely fouled" : "clean"}</b><small>by the check, ${AT != null ? "that day" : "today"}</small></td>
      <td><b>${share != null ? Math.round(share * 100) + "%" : "--"}</b><small>of hours flagged</small></td></tr>`;
  });
  const r = d.river;
  const connAt = AT != null ? r?.turb?.at(AT) ?? NaN : NaN;
  const conn = AT == null ? r?.last.CONN : Number.isFinite(connAt) ? { time: new Date(AT * 1000).toISOString(), turb_fnu: connAt, flow_cfs: null } : null;
  const river = conn?.turb_fnu != null
    ? `<tr class="total"><th scope="row">Connecticut River</th><td title="USGS, Thompsonville, ${ago(conn.time)}"><b>${conn.turb_fnu.toFixed(1)}<small class="g"> FNU</small></b><small>${AT != null ? "observed" : ago(conn.time).replace(" ago", "")}</small></td><td colspan="2"><small>the river input at Thompsonville; a serviced USGS sensor</small></td></tr>`
    : "";
  return `<table class="status-grid" id="status-panel">
    <caption>${AT != null ? `Turbidity at ${atLabel(AT)}` : "Latest turbidity"}, buoys west to east, then the river input</caption>
    <thead><tr><th></th><th scope="col">Turbidity</th><th scope="col">Sensor check</th><th scope="col">Last 30 days</th></tr></thead>
    <tbody>${rows.join("")}${river}</tbody>
  </table>
  <p class="status-key">Point observations at 1 m. The check flags a day as likely sensor fouling when its quietest readings sit above 5 NTU; flagged readings are kept and drawn faintly. See the note below the table.</p>`;
}

function statusGrid(stations: StationData[]): void {
  if (VK === "turbidity") {
    $("status").innerHTML = turbTable();
    return;
  }
  if (VK === "rivers") {
    $("status").innerHTML = riverTable();
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
        ? `${open("buoy")}<caption>${AT != null ? `At ${atLabel(AT)}` : "Latest readings"}, west to east: ${what}</caption>${head(DEPTHS.map((d) => DEPTH_LABEL[d]))}
      <tbody>${buoys.map((d) => `<tr>${name(d)}${DEPTHS.map((dep) => cellHtml(d, dep)).join("")}</tr>`).join("")}</tbody></table>`
        : `${open("buoy")}<caption>${AT != null ? `At ${atLabel(AT)}` : "Latest readings"}, west to east: ${wind}, ${air} and waves (${waveUnit().label})</caption>${head(["Wind", "Air", "Pressure", "Waves"])}
      <tbody>${buoys.map((d) => `<tr>${name(d)}${windCell(d)}${airCell(d)}${pressureCell(d)}${wavesCell(d)}</tr>`).join("")}</tbody></table>`
      : isWater(VK)
        ? `${open("shore")}<caption>${AT != null ? `At ${atLabel(AT)}` : "Latest readings"}, west to east: ${VK === "temp" ? "water temperature (&deg;F)" : `water temperature only (no ${V().label.toLowerCase()} sensors)`} and water level</caption>${head(["Water", "Level", "Next tide"])}
      <tbody>${shore.map((d) => `<tr>${name(d)}${cellHtml(d, "SFC")}${levelCell(d)}${tideCell(d)}</tr>`).join("")}</tbody></table>`
        : `${open("shore")}<caption>${AT != null ? `At ${atLabel(AT)}` : "Latest readings"}, west to east: ${wind}, ${air} and the next tide</caption>${head(["Wind", "Air", "Pressure", "Next tide"])}
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
    <p class="status-key">${key} &middot; lines: last 7 days, each stretched to its own range</p>`;
}

/** Tab clicks and arrow keys on the overview table (wired once; the table itself is redrawn often). */
function wireStatusTabs(stations: StationData[]): void {
  const box = $("status");
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
  box.addEventListener("keydown", (e) => {
    if (!(e.target as HTMLElement).closest(".stab") || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    pick(SG === "buoy" ? "shore" : "buoy");
  });
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
    syncUrl(true);
    chart.markAsOf(t);
    void showAt(t);
    import("./fields").then((f) => f.setFieldTime(t)).catch(() => undefined);
  });
  applyPendingOffset("hours"); // after the listener, so a linked time reaches the charts, the table and the pins
}

/** A station's map pin: its latest readings, or its observations at the timeline cursor's time. */
function stationPin(d: StationData): Pin {
  const dep = d.depths.includes("SFC") ? "SFC" : d.depths[0];
  const kind = d.kind === "shore" ? ("shore" as const) : ("buoy" as const);
  const base = { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, kind };
  if (AT != null) {
    const water = d.temp.hourly[dep]?.at(AT) ?? NaN;
    const wind = d.met?.wind?.at(AT) ?? NaN;
    const dir = d.met?.dir?.at(AT) ?? NaN;
    const parts = [
      Number.isFinite(water) ? `${d.kind === "shore" ? "Water" : DEPTH_LABEL[dep]} ${f1(water)}&deg;F` : "",
      Number.isFinite(wind) ? `wind ${Number.isFinite(dir) ? compass(dir) + " " : ""}${windFmt(wind)} ${WIND_UNITS[WU].label}` : "",
    ].filter(Boolean);
    const label = parts.length ? `${parts.join("<br>")}<br>observed ${atLabel(AT)}` : `no ${atFuture() ? "forecast" : "reading"} at ${atLabel(AT)}`;
    return { ...base, state: parts.length ? "asof" : "offline", label };
  }
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
  const label = waves ? `${reading}<br>Waves: ${waves}` : reading.replace(/^Surface /, d.kind === "shore" ? "Water " : "Surface ");
  const tide = d.kind === "shore" && nextTide(d) ? `<br>Next ${tideText(nextTide(d)!)}` : "";
  return { ...base, state, label: label + tide };
}

/** The overview table and the map pins at the cursor's time (or the latest readings at now). */
async function showAt(t: number | null): Promise<void> {
  AT = t;
  if (STATIONS.length) statusGrid(STATIONS);
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
        <span class="fig-actions"><button class="collect-btn" type="button" data-collect="${id}-${key}" data-title="${figName(f)}: ${st.name}" data-kind="plot" aria-pressed="false">+</button><button class="fig-info" type="button" data-about="${key}" aria-label="About this plot: ${figName(f)}" title="About this plot">i</button><button class="expand" type="button" data-station="${id}" data-fig="${key}" data-full="1" aria-label="Full record: ${figName(f)}, ${st.name}">Full record</button><button class="expand" type="button" data-station="${id}" data-fig="${key}" aria-label="Expand: ${figName(f)}, ${st.name}">Expand</button></span></figcaption>
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
      <p class="station-links"><span>${d.kind === "turbidity" ? "Buoys:" : d.kind === "rivers" || d.kind === "river" ? "At USGS:" : d.kind === "shore" ? "At NOAA:" : "At LISICOS:"}</span>${[
        ...(d.kind === "rivers" ? (d.river?.gauges ?? []).map((g) => `<a href="#${g.id}">${g.river}</a>`) : []),
        ...(d.kind === "turbidity" ? (d.turb?.buoys ?? []).map((b) => `<a href="${(registry.stations as { id: string; info_url?: string }[]).find((s) => s.id === b.id)?.info_url ?? "#"}">${b.name}</a>`) : []),
        st.info_url ? `<a href="${st.info_url}">${d.kind === "river" ? "Gauge page" : d.kind === "shore" ? "Station page" : "About this buoy"}</a>` : "",
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
  return readoutHtml(fmt(v), label, about, `${o.depth_m ?? "--"} m &middot; ${extra ? extra(o, v) + " &middot; " : ""}${ago(o.time)}`, state, context);
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
    out.push(readoutHtml(`${windFmt(o.wind_kt)}<small>${u}</small>`, "Wind", "wind", `${dir}${dir ? " &middot; " : ""}gusts ${windFmt(o.gust_kt)} ${u} &middot; ${ago(o.time)}`, state,
      [contextLine(d.met?.wind, "wind", (v) => `${windFmt(v)} ${u}`), veerText(d.met?.dir, d.met?.wind), percentileText(seasonalPercentile(d.metLong?.wind ?? d.met?.wind, SEASONS.wind), "last 3 days")]
        .filter(Boolean)
        .join(" &middot; ")));
  } else out.push(readoutHtml("--", "Wind", "wind", "no recent reading", "offline"));
  if (d.kind === "buoy" && wavesOf(d.meta.id)?.sensor) {
    const w = lastWave(d.meta.id);
    const live = WAVE_LIVE[d.meta.id]?.published && w && obsState({ time: w.time } as LastObs) !== "offline";
    out.push(
      live
        ? readoutHtml(`${waveFmt(w!.hs_m)}<small>${waveUnit().label}</small>`, "Waves", "waves", `${w!.tp_s != null ? `${w!.tp_s.toFixed(0)} s period &middot; ` : ""}${ago(w!.time)}`, "",
            contextLine(d.waves?.hs, "waves", (v) => `${waveFmt(v)} ${waveUnit().label}`, { key: "waves", what: "last 3 days" }))
        : readoutHtml("--", "Waves", "waves", wavesText(d.meta.id, true), "offline"),
    );
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

/** The readouts at the top of a buoy or shore station section follow the view, mirroring the plots below them.
 * Mid-depth stays out: the water-column plot carries it. */
function stationReadouts(d: StationData): string[] {
  const depths = d.depths.filter((dep) => dep !== "MID");
  if (d.kind === "shore") {
    if (VK === "wind") return [...weatherReadouts(d), levelReadout(d)];
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

function drawInline(d: StationData, key: Kind): void {
  if (!shows(d, key)) return;
  const [x0, x1] = FIGS[key].window(d);
  const b = FIGS[key].build(d, activeDepth(d, key), x0, x1, false);
  renderLines($(`${d.meta.id}-${key}`), b.opts);
  $(`${d.meta.id}-${key}-legend`).innerHTML = legendHtml(b);
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
  const draw = () => {
    // How stale the buoys were when the data was fetched, as a delta, rather than a second timestamp.
    const fetched = Date.parse(live.generated_at);
    const parts = [
      `<b>Updated</b>${fmtEt(live.generated_at)} <span class="ago">(${span(fetched, Date.now())} ago)</span>`,
      latest ? `buoys ${span(Date.parse(latest), fetched)} behind` : "no recent buoy reading",
    ];
    if (failing.length) parts.push(`<span class="warn">fetch failed: ${failing.join(", ")}</span>`);
    $("updated").innerHTML = parts.join(`<span class="sep">&middot;</span>`);
    // The bar: a dot and the age; the buoys' lag only past its usual hour or two; the exact times in the hint.
    const fresh = $("fresh");
    const age = Date.now() - fetched;
    const lag = latest ? fetched - Date.parse(latest) : Infinity;
    const lagging = lag > 2 * 3600_000;
    const state = age > 24 * 3600_000 ? "offline" : failing.length || lagging || age > 3 * 3600_000 ? "delayed" : "live";
    const note = failing.length ? "fetch failed" : !latest ? "no recent buoy reading" : lagging ? `buoys ${span(Date.parse(latest), fetched)} behind` : "";
    fresh.innerHTML = `<i class="dot ${state}"></i>${span(fetched, Date.now())}<span class="fresh-long">&nbsp;ago</span>${note ? `<span class="lag">${note}</span>` : ""}`;
    fresh.title =
      `Fetched ${fmtEt(live.generated_at)}` + (latest ? ` · latest buoy reading ${fmtEt(latest)}` : "") + ` · history rebuilt ${fmtEt(meta.generated_at)} (New York time)`;
    fresh.setAttribute("aria-label", `Data fetched ${span(fetched, Date.now())} ago${note ? `, ${note}` : ""}`);
    $("updated").title =
      `Fetched ${fmtEt(live.generated_at)}` +
      (latest ? `; latest buoy reading ${fmtEt(latest)}` : "") +
      `; history rebuilt ${fmtEt(meta.generated_at)} (New York time)` +
      (failing.length ? `; the last fetch failed for ${failing.join(", ")}, so those show the last good values` : "") +
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
    else window.setTimeout(() => (($("about-drawer") as HTMLDetailsElement).open = true)); // after this click settles
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
    d.kind === "shore" && VK !== "temp" ? `Water temperature only; ${V().label.toLowerCase()} comes from the buoys.` : "",
  ].filter(Boolean);
}

/** A buoy, shore station or the turbidity section's About: what it is, its record and every note, as labelled rows. */
function stationAboutHtml(d: StationData): string {
  const st = d.meta;
  const row = (label: string, html: string) => `<dt>${label}</dt><dd>${html}</dd>`;
  const links = [
    st.info_url ? `<a href="${st.info_url}">${d.kind === "shore" ? "station page" : "about this buoy"}</a>` : "",
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
  if (d.kind === "shore" && VK !== "temp") rows += row("Measures", `Water temperature only; ${V().label.toLowerCase()} on this page comes from the buoys.`);
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
    `Each plot's (i), and each readout's label, explains what it shows, how it is computed, the sensors and the sources, ` +
    `with references. The papers and monitoring programs behind the page are on the <a href="/references/">references</a> page. ` +
    `Times are stored in UTC and labelled in New York time; all data are provisional and may be revised.`;
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

function promptData(stations: StationData[]): string {
  const out: string[] = [];
  for (const d of stations) {
    const st = d.meta;
    const xs = grid(d.now - 96 * DAY, d.now + 14 * DAY, Infinity);
    out.push(`Station ${st.id}, ${st.name} (${st.operator}), ${st.lat.toFixed(2)} N, ${Math.abs(st.lon).toFixed(2)} W.${st.note ? " " + st.note : ""}${!d.live && st.outage_note ? " " + st.outage_note : ""}`);
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
        `  Weather at the ${d.kind === "shore" ? "station" : "buoy"}, ${fmtUtc(w.time)} (${ago(w.time)}): wind ${f1(w.wind_kt)} kt ${dir}, gusts ${f1(w.gust_kt ?? NaN)} kt` +
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
  return [`- ${m.title}: ${plain(m.shows)}`, m.method ? `  Method: ${plain(m.method)}` : "", m.caveats ? `  Caveats: ${plain(m.caveats)}` : ""].filter(Boolean).join("\n");
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
    return `Readouts at ${station}, as shown (value; label; trend and %ile against the same dates in earlier years; depth and age):\n${lines.join("\n")}`;
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
      return { id: g.id, name: g.name, lat: g.lat, lon: g.lon, state: Number.isFinite(f) ? "asof" : "offline", label };
    }
    const o = d.river!.last[g.id];
    const t = o ? Date.parse(o.time) / 1000 : NaN;
    const label = o?.flow_cfs != null ? `${cfs(o.flow_cfs)} cfs, ${riverClass(d.river!, g.id, t, o.flow_cfs)}; ${ago(o.time)}` : g.discontinued ? "gauge discontinued" : "no recent reading";
    return { id: g.id, name: g.name, lat: g.lat, lon: g.lon, state: o ? obsState({ time: o.time } as LastObs) : "offline", label };
  });
}

/** The map follows the view: basins and gauges in Rivers, the Sound otherwise; and the view's surface field. */
async function syncMap(): Promise<void> {
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
  { kind: "sst", label: "Sea surface temperature" },
  { kind: "chl", label: "Chlorophyll-a" },
  { kind: "kd490", label: "Water clarity (Kd490)" },
  { kind: "currents", label: "Surface currents (model)" },
];
let fieldPick: FieldKind | "none" = (["sst", "chl", "kd490", "currents"] as const).find((k) => k === LINK.get("layer")) ?? "none"; // none until picked (or linked); kept across views
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
const FRAME_SPAN: Record<FieldKind | "none", [number, number]> = { none: [0, 0], currents: [0, 2], sst: [24, 0], chl: [7 * 24, 0], kd490: [7 * 24, 0] };
const fieldCache = new Map<FieldKind, Promise<FieldData>>();

function fieldData(kind: FieldKind): Promise<FieldData> {
  if (!fieldCache.has(kind)) {
    const load: Promise<FieldData> =
      kind === "currents"
        ? Promise.all([getJson<FieldData["mesh"]>(`${DATA}/fields/currents-mesh.json`), getJson<FieldData["currents"]>(`${DATA}/fields/currents.json`)]).then(([mesh, currents]) => ({ mesh, currents }))
        : getJson<FieldData["raster"]>(`${DATA}/fields/${kind}.json`).then((raster) => ({ raster }));
    fieldCache.set(kind, load.catch((err) => {
      fieldCache.delete(kind); // try again next time
      throw err;
    }));
  }
  return fieldCache.get(kind)!;
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
  applyWide();
  const kind = fieldPick;
  let payload: FieldData = {};
  if (kind !== "none") {
    try {
      payload = await fieldData(kind);
    } catch (err) {
      console.error(err);
    }
  }
  const shown = kind !== "none" && (payload.raster || payload.currents) ? kind : null;
  // The time bar: days for a satellite layer once its history is in, hours otherwise.
  const tl = await import("./timeline");
  if (shown !== "sst" && shown !== "chl" && shown !== "kd490") tl.setScale("hours");
  // The span each frame covers, shaded on the time bar: a 2h model step, a day of SST, a 7-day composite.
  tl.setFrame(...FRAME_SPAN[shown ?? "none"]);
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
    choices: FIELD_CHOICES,
    chosen: fieldPick,
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

/** Shore stations from the registry, west to east (their record start years until the history arrives). */
const SHORE: ShoreMetaStation[] = shoreRegistry.stations
  .map((s) => ({ ...s, note: (s as { note?: string }).note ?? null, record_start: `${s.record_start_year}-01-01T00:00:00Z` }))
  .sort((a, b) => a.lon - b.lon);

async function main(): Promise<void> {
  P = PALETTES[currentTheme()];
  // Shore data loads alongside the buoys but never holds them up; its history (the larger file) last.
  const shoreLive = getJson<ShoreLive>(`${DATA}/shore.json`).catch(() => null);
  const shoreHist = getJson<ShoreHistory>(`${DATA}/shore-history.json`).catch(() => null);
  try {
    const { meta, live, stations } = await load();
    const byId = (id: string) => [...stations, ...RIVER_SECTIONS, ...(TURB_SECTION ? [TURB_SECTION] : [])].find((d) => d.meta.id === id)!;
    // A remembered salinity or oxygen choice loads its history first; if that fails, show temperature.
    if (VK !== "temp") await ensureVar(VK, live, stations).catch(() => (VK = "temp"));
    /** The stations on screen: the rivers section in the Rivers view, the buoys and shore stations otherwise. */
    const shown = () => (VK === "rivers" ? RIVER_SECTIONS : VK === "turbidity" ? (TURB_SECTION ? [TURB_SECTION] : []) : stations);
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
      $("stations").innerHTML =
        VK === "rivers"
          ? `<h2 class="station-group">Rivers into the Sound, USGS stream gauges</h2>${RIVER_SECTIONS.map(sectionHtml).join("")}`
          : VK === "turbidity"
            ? `<h2 class="station-group">Turbidity, point observations</h2>${TURB_SECTION ? sectionHtml(TURB_SECTION) : ""}`
            : group("buoy", "Buoys, LISICOS") + group("shore", "Shore stations, NOAA tide gauges");
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
    void overviewMap(stations);
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
    wireTheme(redraw);
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
