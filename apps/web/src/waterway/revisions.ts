/** Revisions, a mode of the next 48 hours plot for the reader who wants more: a small chart, in the plot's corner, of how
 * HRRR's wind for one hour changed from run to run. Its time axis is the time each run was issued (the forecast "as
 * of" then), so a line rising to the right is the model raising that hour's wind as the hour drew nearer; where the
 * hour has passed, the wind measured then is a gold dot. The hour is the one under the pointer, else the page's time.
 * Off until the reader turns it on ("Revisions", top right of the plot), remembered in this browser. */
import { renderLines, type Line } from "../chart";
import { HOUR } from "../series";
import { fmtRun, fmtWhen } from "./format";
import { WIND_UNITS, windFmt, windVal, WU } from "./units";
import { FCST, MS_KT, type FcRun } from "./forecast";
import { M } from "./models";
import type { StationData } from "./station-data";

const KEY = "lhzn-blue-revisions";
let on = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
let pageTime: number | null = null;
/** The next 48 hours plots with the mode mounted: what each needs to draw its inset. */
const MOUNTED = new Map<HTMLElement, { d: StationData; x0: number; x1: number; hover: number | null }>();

const hourOf = (t: number) => Math.round(t / HOUR) * HOUR;
const nowHour = () => Math.floor(Date.now() / 1000 / HOUR) * HOUR;

/** The runs issued before now (and before the hour), newest first, with each one's wind for the hour in knots. */
function revisionsFor(id: string, t: number): { issue: number; kt: number }[] {
  const now = Date.now() / 1000;
  const wind = (r: FcRun) => {
    const i = r.leads.indexOf(Math.round((t - r.issue) / HOUR));
    const u = r.u[i], v = r.v[i];
    return i < 0 || u == null || v == null ? NaN : Math.hypot(u, v) * MS_KT;
  };
  return (FCST?.runs[id] ?? [])
    .filter((r) => r.issue <= now && r.issue < t)
    .map((r) => ({ issue: r.issue, kt: wind(r) }))
    .filter((x) => Number.isFinite(x.kt));
}

/** The page's time (null: now), as the time bar moves: each inset not under the pointer follows it. */
export function setRevisionTime(t: number | null): void {
  pageTime = t;
  MOUNTED.forEach((_, plot) => draw(plot));
}

/** The mode on a next 48 hours plot (inline or expanded), drawn between x0 and x1: its switch and its inset. */
export function mountRevisions(d: StationData, plot: HTMLElement, x0: number, x1: number): void {
  for (const p of MOUNTED.keys()) if (!p.isConnected) MOUNTED.delete(p);
  const fresh = !MOUNTED.has(plot);
  MOUNTED.set(plot, { d, x0, x1, hover: MOUNTED.get(plot)?.hover ?? null });
  plot.querySelector(".rev-switch")?.remove();
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "rev-switch";
  sw.textContent = "Revisions";
  sw.title = "How the forecast for one hour changed from run to run";
  sw.setAttribute("aria-pressed", String(on));
  plot.append(sw);
  sw.addEventListener("click", (e) => {
    e.stopPropagation(); // not the plot's own click (expand, or a page's time)
    on = !on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* private mode: for this page only */
    }
    document.querySelectorAll(".rev-switch").forEach((b) => b.setAttribute("aria-pressed", String(on)));
    MOUNTED.forEach((_, p) => draw(p));
  });
  for (const type of ["pointerdown", "mousedown", "touchstart"]) sw.addEventListener(type, (e) => e.stopPropagation());
  if (fresh) {
    // The hour under the pointer (a mouse, or a finger dragging); back to the page's time when it leaves.
    plot.addEventListener("pointermove", (e) => {
      const m = MOUNTED.get(plot);
      const svg = plot.querySelector<SVGSVGElement>(":scope > svg");
      if (!m || !on || !svg || (e.target as Element).closest(".rev-pop, .rev-switch, .vintage")) return;
      const box = svg.getBoundingClientRect();
      m.hover = hourOf(m.x0 + ((e.clientX - box.left) / Math.max(1, box.width)) * (m.x1 - m.x0));
      draw(plot);
    });
    plot.addEventListener("pointerleave", () => {
      const m = MOUNTED.get(plot);
      if (m) m.hover = null;
      draw(plot);
    });
  }
  draw(plot);
}

function draw(plot: HTMLElement): void {
  const m = MOUNTED.get(plot);
  let pop = plot.querySelector<HTMLElement>(":scope > .rev-pop");
  const t = m?.hover ?? (pageTime != null ? hourOf(pageTime) : null);
  if (!m || !on || t == null || t < m.x0 || t > m.x1) {
    pop?.remove();
    return;
  }
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "rev-pop";
    pop.innerHTML = `<p class="rev-h"></p><div class="rev-plot"><svg role="img" aria-label="The forecast for this hour, run by run"></svg><div class="plot-labels" aria-hidden="true"></div></div>`;
    for (const type of ["pointerdown", "mousedown", "touchstart", "click", "wheel"]) pop.addEventListener(type, (e) => e.stopPropagation());
    plot.append(pop);
  }
  const u = WIND_UNITS[WU];
  const runs = revisionsFor(m.d.meta.id, t);
  const measured = t <= nowHour() ? (m.d.met?.wind?.at(t) ?? NaN) : NaN;
  const head = pop.querySelector<HTMLElement>(".rev-h")!;
  const when = fmtWhen.format(new Date(t * 1000));
  if (!runs.length) {
    head.textContent = `${when}: no HRRR run reaches this hour`;
    pop.querySelector<HTMLElement>(".rev-plot")!.hidden = true;
    return;
  }
  pop.querySelector<HTMLElement>(".rev-plot")!.hidden = false;
  // Its runs, from the first that reached the hour (48 hours before) to the newest, or to the hour itself once it has
  // passed; the 6-hourly long runs first, then a run an hour from 18 hours out, joined straight.
  const x0 = t - 48 * HOUR;
  const x1 = Math.min(t, nowHour());
  const xs: number[] = [];
  for (let x = x0; x <= x1; x += HOUR) xs.push(x);
  const at = new Map(runs.map((r) => [r.issue, windVal(r.kt)]));
  const dots = xs.map((x) => at.get(x) ?? NaN);
  const joined = [...dots];
  let a = -1;
  dots.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    for (let j = a + 1; a >= 0 && j < i; j++) joined[j] = dots[a] + ((v - dots[a]) * (j - a)) / (i - a);
    a = i;
  });
  const P = M.palette();
  const fmtU = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
  const lines: Line[] = [
    { ys: joined, color: P.line, width: 1.6, label: "Forecast", tip: false },
    { ys: dots, color: P.line, width: 3.5, dots: true, label: "Forecast, by the run then", fmt: fmtU },
    ...(Number.isFinite(measured) ? [{ ys: xs.map((x) => (x === t ? windVal(measured) : NaN)), color: P.now, width: 7, dots: true, label: "Measured", fmt: fmtU }] : []),
  ];
  renderLines(pop.querySelector<HTMLElement>(".rev-plot")!, { xs, lines, unit: ` ${u.label}`, zero: true, hoverDigits: u.digits, minPad: 1 });
  // The newest run's value, its change since the run 6 hours before it, and what was measured.
  const [latest] = runs;
  const before = runs.find((r) => r.issue <= latest.issue - 6 * HOUR);
  const delta = before ? windVal(latest.kt) - windVal(before.kt) : NaN;
  const change = !Number.isFinite(delta) ? "" : Math.abs(delta) < 0.5 * 10 ** -u.digits ? ", unchanged over 6 h of runs" : `, ${delta > 0 ? "up" : "down"} ${windFmt(Math.abs(latest.kt - before!.kt))} over 6 h of runs`;
  head.innerHTML = `<b>${when}</b> ${windFmt(latest.kt)} ${u.label} as of ${fmtRun.format(new Date(latest.issue * 1000))}${change}` +
    (Number.isFinite(measured) ? `; measured <span class="rev-m">${windFmt(measured)}</span>` : "");
}
