/** The NWS nearshore wave model (NWPS: SWAN, about 1.8 km) at a waterway's buoys: the newest run covering each hour,
 * shown under a wave sensor's fault (never in its place, and labelled as a model), ahead in the outlook, and on the
 * waves plot with its own run slider. */
import { getJson, HOUR } from "@lhzn-io/timecharts/series";
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
/** A wave model's runs at the buoys (waves-nwps.json, waves-necofs.json: the same shape), newest run first. */
export interface WaveModel { runs: NwpsRun[]; cells: Record<string, { lat: number; lon: number; km: number }> }
export let NWPS: WaveModel | null = null;
let nwpsLoading: Promise<void> | null = null;

function loadWaveModel(file: string, set: (m: WaveModel) => void): Promise<void> {
  return getJson<{ cells: WaveModel["cells"]; runs: Record<string, { steps: number[]; points: NwpsRun["points"] }> }>(`${DATA}/${file}`)
    .then((p) => {
      const runs = Object.entries(p.runs).map(([k, r]) => ({ issue: Date.parse(k.replace(/Z$/, ":00Z")) / 1000, steps: r.steps, points: r.points }));
      runs.sort((a, b) => b.issue - a.issue);
      set({ runs, cells: p.cells });
      requestRedraw();
    })
    .catch(() => undefined);
}

export function loadNwps(): Promise<void> {
  nwpsLoading ??= loadWaveModel("waves-nwps.json", (m) => (NWPS = m));
  return nwpsLoading;
}

/** A model's newest run's waves at a buoy for an hour (epoch seconds), or null where no run covers it. */
function waveAt(m: WaveModel | null, id: string, t: number): NwpsValue | null {
  for (const r of m?.runs ?? []) {
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

/** A model's waves on a time grid (for the wave plot): the newest run covering each hour, linear between hours. */
function waveSeries(m: WaveModel | null, id: string, xs: number[], key: "hs" | "tp" = "hs"): number[] {
  return xs.map((t) => {
    const h = Math.floor(t / HOUR) * HOUR;
    const a = waveAt(m, id, h), b = waveAt(m, id, h + HOUR);
    if (!a) return NaN;
    return b && Number.isFinite(b[key]) ? a[key] + ((b[key] - a[key]) * (t - h)) / HOUR : a[key];
  });
}

/** The newest NWPS run's waves at a buoy for an hour (epoch seconds), or null where no run covers it. */
export function nwpsAt(id: string, t: number): NwpsValue | null {
  return waveAt(NWPS, id, t);
}

/** NWPS waves on a time grid (for the wave plot): the newest run covering each hour, linear between hours. */
export function nwpsSeries(id: string, xs: number[]): number[] {
  return waveSeries(NWPS, id, xs);
}

/** NECOFS waves at the buoys (UMass Dartmouth SMAST, the node nearest each buoy): a second model line on the waves
 * plot, the newest run stitched as NWPS's, its period the mean period (T0m1), not a peak period. */
export let NECOFS_WAVES: WaveModel | null = null;
let necofsLoading: Promise<void> | null = null;
export function loadNecofsWaves(): Promise<void> {
  necofsLoading ??= loadWaveModel("waves-necofs.json", (m) => (NECOFS_WAVES = m));
  return necofsLoading;
}
export function necofsWavesSeries(id: string, xs: number[], key: "hs" | "tp" = "hs"): number[] {
  return waveSeries(NECOFS_WAVES, id, xs, key);
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
/** NECOFS's runs at a buoy between x0 and x1, oldest first (the newest is the stitched line). */
export function necofsWavesRuns(id: string, x0 = -Infinity, x1 = Infinity): NwpsRun[] {
  return (NECOFS_WAVES?.runs ?? [])
    .filter((r) => r.points[id] && r.issue < x1 && r.issue + r.steps[r.steps.length - 1] * HOUR >= x0)
    .reverse();
}
/** A NECOFS run's line label: the newest is the stitched model line, the others "NECOFS run <time>". */
export function necofsWavesLabel(r: NwpsRun): string {
  return r === NECOFS_WAVES?.runs[0] ? "NECOFS wave model" : `NECOFS run ${fmtRun.format(new Date(r.issue * 1000))}`;
}
/** For Revisions: each run issued before now and before the hour, newest first, with its height there (m). */
export function waveRevisions(model: "nwps" | "necofs", id: string, t: number): { issue: number; hs: number }[] {
  const now = Date.now() / 1000;
  return ((model === "nwps" ? NWPS : NECOFS_WAVES)?.runs ?? [])
    .filter((r) => r.issue <= now && r.issue < t)
    .map((r) => ({ issue: r.issue, hs: nwpsRunAt(r, id, t) }))
    .filter((x) => Number.isFinite(x.hs));
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
/** The waves plot's run slider, part of Revisions: it picks an NWPS run and emphasizes it with the newest NECOFS run
 * issued by then. */
export function mountNwpsVintage(d: StationData, plot: HTMLElement, x0?: number, x1?: number): void {
  const id = d.meta.id;
  mountRunSlider(plot, {
    store: `${id}:nwps`,
    model: "NWPS",
    runs: nwpsRuns(id, x0, x1),
    lineLabel: (r) => {
      const n = NECOFS_WAVES?.runs.find((q) => q.issue <= r.issue && q.points[id]);
      return [nwpsLabel(r as NwpsRun), ...(n ? [necofsWavesLabel(n)] : [])];
    },
  });
}
