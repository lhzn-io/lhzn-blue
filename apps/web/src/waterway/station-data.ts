/** The Sound's station model: what one buoy, shore station, airport or river section holds once loaded, the water
 * variables a reader picks between, and a station's state from the age of its readings. The engine's cells, pins and
 * (later) figures read this; the Sound's loaders fill it. */
import { Daily, Hourly, type LastObs, type MetaStation, type MetObs, type RiverHistory, type TideEvent } from "../series";
import { cToF, hoursOld } from "./format";

export const DEPTHS = ["SFC", "MID", "BTM"] as const;
export const DEPTH_LABEL: Record<string, string> = { SFC: "Surface", MID: "Mid", BTM: "Bottom" };
export const DELAYED_HOURS = 3; // older than this: delayed
export const OFFLINE_HOURS = 24; // older than this: offline

export type State = "live" | "delayed" | "offline";

/**
 * Water variables. The reader picks one for the whole page (status grid and the year, change, water
 * column and surface-minus-bottom charts); temperature is the default. Salinity and oxygen histories
 * load on first use, so the first view costs the same two requests as before.
 */
export type VarKey = "temp" | "salinity" | "oxygen" | "turbidity" | "wind" | "rivers" | "tides";
export interface WaterVar {
  label: string;
  unit: string; // appended to values on axes and in tooltips
  digits: number;
  file: string;
  obs: (o: LastObs) => number | null; // the latest raw reading, in this variable's units
}
export const WATER_VARS: Record<VarKey, WaterVar> = {
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
export const isWater = (k: VarKey) => k === "temp" || k === "salinity" || k === "oxygen";

/** Axis label for the variable: salinity has no unit (practical salinity scale), so it is named instead. */
export const unitName = (k: VarKey) => (k === "temp" ? "°F" : k === "salinity" ? "practical salinity" : "mg/L");

/** One variable's series for a station, per depth, with its derived views. */
export interface VarView {
  hourly: Record<string, Hourly | null>;
  m36: Record<string, Hourly | null>;
  chg: Record<string, Hourly | null>;
  delta: Hourly | null; // surface minus bottom, hourly
  delta36: Hourly | null;
}

export interface StationData {
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
export interface TurbData {
  buoys: { id: string; name: string }[];
  ntu: Record<string, Hourly | null>;
  suspect: Record<string, Hourly | null>;
  last: Record<string, { time: string; turb_ntu: number | null } | null>;
  share30: Record<string, number | null>;
  qc: string;
}

export type Gauge = RiverHistory["meta"]["gauges"][number];
export interface RiverData {
  gauges: Gauge[]; // largest gauged basin first
  flow: Record<string, Hourly | null>; // cfs, hourly, last 100 days
  daily: Record<string, Daily | null>; // cfs, daily means from 1990
  normals: RiverHistory["normals"];
  turb: Hourly | null; // Connecticut at Thompsonville, FNU
  last: Record<string, { time: string; flow_cfs: number | null; turb_fnu: number | null } | null>;
}

/** Hourly waves: heights in metres, periods in seconds. */
export interface Waves {
  hs: Hourly | null;
  hmax: Hourly | null;
  tp: Hourly | null;
}

export interface Met {
  wind: Hourly | null; // knots
  gust: Hourly | null; // knots, hourly peak
  dir: Hourly | null; // degrees the wind blows from
  air: Hourly | null; // F
  pressure: Hourly | null; // mbar
  last: MetObs | null;
}

/** A forecast's typical error at one lead (mean absolute error against the buoys: wind kt, air F, pressure mbar). */
export interface FcStats { mae: number | null; air_mae: number | null; pressure_mae: number | null }
/** The forecast at a station for one hour: its values, the run and lead behind them, and their typical error. */
export interface FcValue { spd: number; dir: number; gust: number; air: number; pres: number; lead: number; issue: number; err: number; airErr: number }

/* ---------- State ---------- */

export function obsState(o: LastObs | null): State {
  if (!o) return "offline";
  const h = hoursOld(o.time);
  return h > OFFLINE_HOURS ? "offline" : h > DELAYED_HOURS ? "delayed" : "live";
}

/** The whole buoy for the map and status dots: "partial" when its water sensors are offline but its
 * weather sensors still report (as at Central Sound). */
export function overallState(d: StationData): State | "partial" {
  const water = stationState(d);
  const weather = d.met?.last ? obsState({ time: d.met.last.time } as LastObs) : "offline";
  return water === "offline" && weather !== "offline" ? "partial" : water;
}

export function stationState(d: StationData): State {
  if (d.kind === "airport") return d.met?.last ? obsState({ time: d.met.last.time } as LastObs) : "offline";
  const states = d.depths.map((dep) => obsState(d.obs[dep]));
  return states.includes("live") ? "live" : states.includes("delayed") ? "delayed" : "offline";
}

/** A shore gauge with no water temperature sensor at all (Rye reports the level only): it has no series, where a
 * sensor that is out still has one with gaps. */
export const noWaterSensor = (d: StationData): boolean => d.kind === "shore" && !d.temp.hourly[d.depths[0]];

export const nextTide = (d: StationData): TideEvent | undefined => d.tides.find((e) => Date.parse(e.t) > Date.now());
