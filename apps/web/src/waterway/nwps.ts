/** The NWS nearshore wave model (NWPS: SWAN, about 1.8 km) at a waterway's buoys: the newest run covering each hour,
 * shown under a wave sensor's fault (never in its place, and labelled as a model), ahead in the outlook, and on the
 * waves plot with its own run slider. */
import { getJson, HOUR } from "../series";
import { fmtRun } from "./format";
import type { StationData } from "./station-data";
import { DATA, requestRedraw } from "./data";
import { mountRunSlider } from "./forecast";

/** The newest NWS wave model run: "as of the Fri 8 PM run". */
export function nwpsAsOf(): string {
  const r = NWPS?.runs[0];
  return r ? `as of the ${fmtRun.format(new Date(r.issue * 1000))} run` : "";
}

export interface NwpsRun { issue: number; steps: number[]; points: Record<string, Record<string, (number | null)[]>> }
export interface NwpsValue { hs: number; tp: number; dir: number; lead: number; issue: number }
export let NWPS: { runs: NwpsRun[]; cells: Record<string, { lat: number; lon: number; km: number }> } | null = null;
let nwpsLoading: Promise<void> | null = null;

export function loadNwps(): Promise<void> {
  nwpsLoading ??= getJson<{ cells: Record<string, { lat: number; lon: number; km: number }>; runs: Record<string, { steps: number[]; points: NwpsRun["points"] }> }>(`${DATA}/waves-nwps.json`)
    .then((p) => {
      const runs = Object.entries(p.runs).map(([k, r]) => ({ issue: Date.parse(k.replace(/Z$/, ":00Z")) / 1000, steps: r.steps, points: r.points }));
      runs.sort((a, b) => b.issue - a.issue);
      NWPS = { runs, cells: p.cells };
      requestRedraw();
    })
    .catch(() => undefined);
  return nwpsLoading;
}

/** The newest NWPS run's waves at a buoy for an hour (epoch seconds), or null where no run covers it. */
export function nwpsAt(id: string, t: number): NwpsValue | null {
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
export function nwpsSeries(id: string, xs: number[]): number[] {
  return xs.map((t) => {
    const h = Math.floor(t / HOUR) * HOUR;
    const a = nwpsAt(id, h), b = nwpsAt(id, h + HOUR);
    if (!a) return NaN;
    return b ? a.hs + ((b.hs - a.hs) * (t - h)) / HOUR : a.hs;
  });
}

/** The NWPS runs the Waves plot draws for a buoy between x0 and x1, oldest first (the newest is the stitched line). */
export function nwpsRuns(id: string, x0 = -Infinity, x1 = Infinity): NwpsRun[] {
  return (NWPS?.runs ?? [])
    .filter((r) => r.points[id] && r.issue < x1 && r.issue + r.steps[r.steps.length - 1] * HOUR >= x0)
    .reverse();
}
/** An NWPS run's line label: the newest is the stitched model line, the others "NWPS run <time>". */
export function nwpsLabel(r: NwpsRun): string {
  return r === NWPS?.runs[0] ? "NWS wave model (NWPS)" : `NWPS run ${fmtRun.format(new Date(r.issue * 1000))}`;
}
/** One NWPS run's significant height at a buoy for a time, linear between its hours. */
export function nwpsRunAt(r: NwpsRun, id: string, t: number): number {
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
export function mountNwpsVintage(d: StationData, plot: HTMLElement, x0?: number, x1?: number): void {
  mountRunSlider(plot, { store: `${d.meta.id}:nwps`, model: "NWPS", runs: nwpsRuns(d.meta.id, x0, x1), lineLabel: (r) => nwpsLabel(r as NwpsRun) });
}
