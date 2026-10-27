/** The tide at a waterway's shore stations: NOAA's predictions (hourly levels and the highs and lows), datums and NWS
 * flood levels, the moon's phases, and what the weather adds to the tide (observed minus predicted, hourly). */
import { getJson, HOUR, Hourly } from "../series";
import type { StationData } from "./station-data";
import { DATA } from "./data";

export interface TideStation {
  pred?: { t0: string; step: number; ft: (number | null)[] };
  hilo?: { t: string; ft: number; type: "H" | "L" }[];
  datums_ft?: Record<string, number>;
  flood_ft?: Record<string, number | null>;
}
export let TIDES: Record<string, TideStation> | null = null;
const FITTED: Record<string, TideStation> = {}; // a page's own fitted predictions (at gauges NOAA does not predict), merged in
export let MOON: { t: string; phase: string }[] = [];
let tidesLoading: Promise<void> | null = null;
let redraw: () => void = () => undefined;
export const DEPARTURE = new Map<string, Hourly | null>();

export function loadTides(): Promise<void> {
  tidesLoading ??= getJson<{ stations: Record<string, TideStation>; moon?: { t: string; phase: string }[] }>(`${DATA}/shore-tides.json`)
    .then((j) => {
      TIDES = { ...j.stations, ...FITTED };
      MOON = j.moon ?? [];
      DEPARTURE.clear();
      redraw();
    })
    .catch(() => undefined);
  return tidesLoading;
}

/** NOAA's predicted level at the middle of the hour starting at t (4-point interpolation), the time an observed
 * hourly mean stands for. Measured against Kings Point's record, this alignment leaves the least twice-daily ripple
 * in the departure (about 0.3 ft, the predictions' own timing error there). */
export function predictedHour(id: string, t: number): number {
  const p = TIDES?.[id]?.pred;
  if (!p) return NaN;
  const i = Math.round((t - Date.parse(p.t0) / 1000) / p.step);
  const [a, b, c, e] = [p.ft[i - 1], p.ft[i], p.ft[i + 1], p.ft[i + 2]];
  if (b == null || c == null) return NaN;
  return a == null || e == null ? (b + c) / 2 : (-a + 9 * b + 9 * c - e) / 16;
}

/** Observed minus predicted, hourly, feet: what the weather adds to the tide. */
export function departure(d: StationData): Hourly | null {
  if (!TIDES || !d.level) return null;
  if (!DEPARTURE.has(d.meta.id)) {
    const lv = d.level;
    const v = new Float64Array(lv.v.length);
    lv.v.forEach((x, i) => (v[i] = x - predictedHour(d.meta.id, lv.t0 + i * HOUR)));
    DEPARTURE.set(d.meta.id, v.some(Number.isFinite) ? new Hourly(lv.t0, v) : null);
  }
  return DEPARTURE.get(d.meta.id) ?? null;
}

/** What the page redraws once the predictions arrive. */
export function onTides(fn: () => void): void {
  redraw = fn;
}

/** A page's own fitted predictions for a gauge (NOAA predicts only its own stations), merged with NOAA's. */
export function addFittedTides(id: string, t: TideStation): void {
  FITTED[id] = t;
  if (TIDES) TIDES = { ...TIDES, ...FITTED };
  DEPARTURE.clear();
}
