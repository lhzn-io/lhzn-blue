import type { ChartOptions } from "@lhzn-io/timecharts/chart";

/** Speed units for wind and currents, and the wave height and temperature that go with them: data arrive in knots (wind), cm/s
 * (currents) and metres (waves); the reader picks how they are shown, one choice across the site (remembered in this
 * browser only). Read `WU` live; change it with `setUnit`. */

export const WIND_UNITS = {
  kt: { factor: 1, label: "kt", name: "knots", digits: 0 },
  mph: { factor: 1.150779, label: "mph", name: "miles per hour", digits: 0 },
  ms: { factor: 0.514444, label: "m/s", name: "metres per second", digits: 1 },
} as const;
export type WindUnit = keyof typeof WIND_UNITS;

export let WU: WindUnit = "kt";
try {
  const saved = localStorage.getItem("lhzn-blue-wind-unit");
  if (saved && saved in WIND_UNITS) WU = saved as WindUnit;
} catch {
  /* private mode: knots */
}

/** The reader's choice (knots for anything unknown), remembered where the browser allows. */
export function setUnit(u: string | undefined): void {
  WU = u && u in WIND_UNITS ? (u as WindUnit) : "kt";
  try {
    localStorage.setItem("lhzn-blue-wind-unit", WU);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

export const windVal = (kt: number) => kt * WIND_UNITS[WU].factor;
export const windFmt = (kt: number | null | undefined) =>
  kt == null || !Number.isFinite(kt) ? "--" : windVal(kt).toFixed(WIND_UNITS[WU].digits);
/** The current speed unit for currents (stored in cm/s): 1 cm/s is 0.0194384 kt. */
export const currentSpeed = () => ({ label: WIND_UNITS[WU].label, perCms: 0.0194384 * WIND_UNITS[WU].factor, digits: 1 });
export const waveUnit = () => (WU === "ms" ? { label: "m", factor: 1, digits: 2 } : { label: "ft", factor: 3.28084, digits: 1 });
export const waveFmt = (m: number | null | undefined) => (m == null || !Number.isFinite(m) ? "--" : (m * waveUnit().factor).toFixed(waveUnit().digits));

/* Temperature follows the same choice: °C with m/s (as waves go to metres), °F with knots or mph. Readings are stored in
 * °F (buoys, shore stations, airports, HRRR at the stations) or °C (satellite, USGS sondes) and shown through these. */
export const metricTemp = () => WU === "ms";
export const tempUnit = () => (metricTemp() ? "°C" : "°F");
export const tempHtml = () => (metricTemp() ? "&deg;C" : "&deg;F");
/** "C" or "F", for plain-text hover titles ("Air 41.2 F"). */
export const tempLetter = () => (metricTemp() ? "C" : "F");
export const tempOfF = (f: number) => (metricTemp() ? ((f - 32) * 5) / 9 : f);
export const tempOfC = (c: number) => (metricTemp() ? c : (c * 9) / 5 + 32);
/** A difference in °F (a change, a spread, a typical miss) in the reader's unit. */
export const tempDeltaOfF = (d: number) => (metricTemp() ? (d * 5) / 9 : d);
export const tempNum = (f: number | null | undefined, digits = 1) => (f == null || !Number.isFinite(f) ? "--" : tempOfF(f).toFixed(digits));

/** A plot drawn in °F, in the reader's unit: with °C chosen, its values, shading, bands and axis limits converted
 * (as differences when `delta`, e.g. a 7-day change) and its labels' unit with them. Any other plot as it is. */
export function tempOpts<T extends ChartOptions>(o: T, delta = false): T {
  if (!metricTemp() || o.unit.trim() !== "°F") return o;
  const v = delta ? (x: number) => (x * 5) / 9 : (x: number) => ((x - 32) * 5) / 9;
  const c = (s: string) => s.replace(/°F/g, "°C").replace(/&deg;F/g, "&deg;C");
  return {
    ...o,
    unit: c(o.unit),
    lines: o.lines.map((l) => ({ ...l, ys: l.ys.map(v), fmt: l.fmt && ((x: number) => c(l.fmt!(x))) })),
    areas: o.areas?.map((a) => ({ ...a, lo: a.lo.map(v), hi: a.hi.map(v) })),
    bands: o.bands?.map((b) => ({ ...b, y0: v(b.y0), y1: v(b.y1) })),
    floor: o.floor == null ? o.floor : v(o.floor),
    ceil: o.ceil == null ? o.ceil : v(o.ceil),
    minPad: o.minPad == null ? o.minPad : (o.minPad * 5) / 9,
  };
}
