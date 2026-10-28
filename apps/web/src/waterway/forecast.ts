/** NOAA HRRR at a waterway's stations: the forecast job's runs (the last 78 hours of cycles) and their verification
 * at the buoys, loaded when a reader first looks ahead or opens the weather; HRRR's last forecast before each hour,
 * the record's stand-in where a station is out; and the run slider that picks which run a plot emphasises. Values are
 * raw HRRR, never blended with observations: a time before now shows only what was measured. */
import { emphasise } from "../chart";
import { DAY, getJson, HOUR, Hourly } from "../series";
import { fmtRun, fmtWhenMin, hourOf } from "./format";
import { WIND_UNITS, windFmt, WU } from "./units";
import type { FcStats, FcValue, Met, StationData } from "./station-data";
import { DATA, FORECAST_PAGE, requestRedraw } from "./data";

export interface FcRun { issue: number; leads: number[]; u: (number | null)[]; v: (number | null)[]; gust: (number | null)[]; t2m: (number | null)[]; mslp: (number | null)[] }
export interface Verification { leads: number[]; by_lead: Record<string, { all: FcStats; buoys: Record<string, FcStats> }> }
export let FCST: { runs: Record<string, FcRun[]>; ver: Verification | null; generated: number } | null = null;
let fcstLoading: Promise<void> | null = null;
export const MS_KT = 1.943844;

export function loadForecast(): Promise<void> {
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
      requestRedraw();
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
        requestRedraw();
      })
      .catch(() => HRRR_HIST.set(name, null));
  }
  return undefined;
}

/** HRRR's last forecast before each hour, for a plot from x0 to x1: fetched only when the window has past hours
 * without a reading (the last 3 h are left out, as readings arrive late), from the recent file when the window lies
 * within it and the full one otherwise (a zoomed plot at full range). */
export function hrrrHist(id: string, x0: number, x1: number, observed: (t: number) => number): Met | null {
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
export const HRRR_HIST_LABEL = "HRRR, last forecast before each hour"; // drawn only where the station has no reading

/** The typical error (mean absolute, verified at the buoys) at a lead, between the verified leads. */
export function typicalError(id: string, lead: number, key: keyof FcStats): number {
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
export function forecastAt(id: string, t: number): FcValue | null {
  for (const r of FCST?.runs[id] ?? []) {
    const f = runValue(id, r, t);
    if (f) return f;
  }
  return null;
}

/** One run's forecast for a station and hour, or null where the run does not reach it. */
function runValue(id: string, r: FcRun, t: number): FcValue | null {
  const lead = Math.round((t - r.issue) / HOUR);
  if (lead < 1 || Math.abs(t - r.issue - lead * HOUR) > 60) return null;
  const i = r.leads.indexOf(lead);
  const u = r.u[i], v = r.v[i];
  if (i < 0 || u == null || v == null) return null;
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

/** HRRR's change at a station from this hour to `hours` ahead, both ends from one run (the newest that reaches
 * them), so it is the model's own change and not its offset from the readings. NaN where no run reaches both. */
export function forecastChange(id: string, hours: number, pick: (f: FcValue) => number): number {
  const t0 = hourOf(Date.now() / 1000);
  for (const r of FCST?.runs[id] ?? []) {
    const a = runValue(id, r, t0), b = runValue(id, r, t0 + hours * HOUR);
    const delta = a && b ? pick(b) - pick(a) : NaN;
    if (Number.isFinite(delta)) return delta;
  }
  return NaN;
}

/** The HRRR stand-in for a buoy at a time: only for buoys, and only where the newest run reaches the hour. */
export function standIn(d: StationData, t: number): FcValue | null {
  if (d.kind !== "buoy") return null;
  if (!FCST) void loadForecast();
  return forecastAt(d.meta.id, hourOf(t));
}

/** The range of the recent runs' forecasts for one station and hour: how far they disagree. */
export function runSpread(id: string, t: number): [number, number] | null {
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

/** The forecast's vintage over some hours at a station: the HRRR run behind each stretch, in order (the hourly runs
 * reach 18 h, the 00, 06, 12 and 18 UTC runs 48 h, so a 48 h forecast is usually two runs). "" before the runs load. */
export function hrrrAsOf(id: string, ts: number[]): string {
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

/** The verification tag: HRRR's typical miss at the buoys for this hour's lead at a station (the first in the table), linked to the page. */
export function verTag(t?: number, id?: string): string {
  const f = t != null && id ? forecastAt(id, hourOf(t)) : null;
  const n = FCST?.ver ? Object.values(FCST.ver.by_lead).reduce((a, b) => a + ((b.all as FcStats & { n?: number }).n ?? 0), 0) : 0;
  const what = f ? `typical miss &plusmn;${windFmt(f.err)} ${WIND_UNITS[WU].label} at ${f.lead} h ahead` : "verified at the buoys";
  return `<a class="ver-tag" href="${FORECAST_PAGE}" title="HRRR scored against the buoys${n ? ` over ${n.toLocaleString("en-US")} forecast hours` : ""}">${what}</a>`;
}

const VINTAGE = new Map<string, number>(); // station id -> the chosen run's issue time (epoch seconds)
const VINTAGE_LISTENERS = new WeakMap<HTMLElement, (e: Event) => void>();

const RECENT_RUNS = 24; // the last day's hourly runs; before them, only the 48 h runs (00, 06, 12 and 18 UTC)

/** The runs the plot draws for a station between x0 and x1, oldest first: the newest run (the dashed line), the
 * hourly runs before it for a day, and the 48 h runs before those (the page file keeps them for a week). A run is
 * drawn when any of its hours falls in the window. */
export function vintageRuns(id: string, x0 = -Infinity, x1 = Infinity): FcRun[] {
  const now = Date.now() / 1000;
  const last = (r: FcRun) => r.issue + r.leads[r.leads.length - 1] * HOUR;
  return (FCST?.runs[id] ?? [])
    .filter((r) => r.issue <= now)
    .filter((r, k) => (k <= RECENT_RUNS || r.leads[r.leads.length - 1] > 18) && last(r) >= x0 && r.issue < x1)
    .reverse();
}
/** A run's line label in the plot: the newest is the stitched forecast's line, the others "HRRR run <time>". */
export function vintageLabel(id: string, r: FcRun): string {
  const now = Date.now() / 1000;
  return r === (FCST?.runs[id] ?? []).find((q) => q.issue <= now) ? "Stitched forecast" : `HRRR run ${fmtRun.format(new Date(r.issue * 1000))}`;
}

export function mountVintage(d: StationData, plot: HTMLElement, x0?: number, x1?: number): void {
  mountRunSlider(plot, { store: d.meta.id, model: "HRRR", runs: vintageRuns(d.meta.id, x0, x1), lineLabel: (r) => vintageLabel(d.meta.id, r as FcRun) });
}

/** A version slider on a plot: picks one of a model's runs (oldest to newest), shows only "<model>, as of <run>", and
 * emphasises that run's line; hovering a run's line moves it. The choice is kept per plot (store key). */
export function mountRunSlider(plot: HTMLElement, o: { store: string; model: string; runs: { issue: number }[]; lineLabel: (r: { issue: number }) => string }): void {
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
