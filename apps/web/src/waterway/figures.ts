/** A waterway page's figures: what a figure is (its title, the views and stations that show it, its window, and a
 * builder for the chart), its legend, and the zoom view any figure opens into (wheel or pinch to zoom, drag to pan,
 * the full record a click away). The page keeps its registry of figures and hands the zoom view a host. */
import { highlight, renderLines, type ChartOptions } from "../chart";
import { COVERAGE_MIN, DAY, type Hourly, type YearLine } from "../series";
import type { StationData, VarKey } from "./station-data";

const $ = (id: string) => document.getElementById(id)!;

export interface Built {
  opts: ChartOptions;
  legend: [string, string, number][];
  note?: string;
}

export interface Fig {
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

export const recordStart = (d: StationData) => {
  const t = Math.min(...Object.values(d.hourly).filter((h): h is Hourly => !!h).map((h) => h.t0));
  return Number.isFinite(t) ? t : d.now - 2 * DAY;
};

/** Every chart of a view shares one time axis across stations (now), so an outage shows as an empty
 * stretch rather than a chart that quietly ends early. */
export const endOf = (d: StationData, _f: Fig) => d.now;

export function limits(d: StationData, f: Fig, full: boolean): { min: number; max: number; maxSpan: number } {
  const end = endOf(d, f);
  const min = Math.min(f.start?.(d) ?? recordStart(d), end - 2 * DAY);
  return full
    ? { min, max: end + 2 * DAY, maxSpan: Infinity }
    : { min: Math.min(min, f.window(d)[0]), max: Math.max(end + (f.seasonal ? 60 : 2) * DAY, f.window(d)[1]), maxSpan: f.maxSpan };
}

export const fullRange = (d: StationData, f: Fig): [number, number] => [f.start?.(d) ?? recordStart(d), endOf(d, f) + DAY];

export function legendHtml(b: Built): string {
  return (
    b.legend
      .map(([label, color, op]) => `<button type="button" class="lg" data-label="${label}"><i style="background:${color};opacity:${op}"></i>${label}</button>`)
      .join("") + (b.note ? `<span class="off">${b.note}</span>` : "")
  );
}

/** Hovering, focusing or tapping a legend entry highlights its line(s) in the plot. */
export function wireLegend(legend: HTMLElement, plot: HTMLElement): void {
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

/* ---------- Zoom view ---------- */

/** What the zoom view needs from the page: its figures, their names, the selected variable, the depth picked inline,
 * the depth tabs, and anything drawn on a plot after its lines (a forecast's run slider). */
export interface ZoomHost {
  fig(key: string): Fig;
  name(f: Fig): string;
  varLabel(): string;
  depth(d: StationData, key: string): string;
  depthTabs(d: StationData, key: string, active: string): string;
  afterDraw(plot: HTMLElement, d: StationData, key: string, x0: number, x1: number): void;
}
let H: ZoomHost;

interface ZoomState {
  d: StationData;
  key: string;
  depth: string;
  x0: number;
  x1: number;
  full: boolean; // the whole record as a timeline, instead of the default view
}

let zoom: ZoomState | null = null;
let zoomFrame = 0;

function drawZoom(): void {
  if (!zoom) return;
  const b = H.fig(zoom.key).build(zoom.d, zoom.depth, zoom.x0, zoom.x1, zoom.full);
  renderLines($("zoom-plot"), b.opts);
  $("zoom-legend").innerHTML = legendHtml(b);
  H.afterDraw($("zoom-plot"), zoom.d, zoom.key, zoom.x0, zoom.x1);
}

/** Switch between the default view and the full record, and label the toggle for the other one. */
function setFull(full: boolean): void {
  if (!zoom) return;
  const f = H.fig(zoom.key);
  zoom.full = full;
  const [a, b] = full ? fullRange(zoom.d, f) : f.window(zoom.d);
  zoom.x0 = a;
  zoom.x1 = b;
  const toggle = $("zoom-full");
  toggle.textContent = full ? (f.seasonal ? "Same dates by year" : "Recent") : "Full record";
  toggle.setAttribute("aria-pressed", String(full));
  const whole = f.seasonal ? "everything we hold, each year in its color; gaps are periods with no data" : "everything we hold; gaps are periods with no data";
  $("zoom-sub").textContent = full ? whole : `${f.varies ? `${H.varLabel().toLowerCase()}, ` : ""}${f.sub}`;
  requestZoomDraw();
}

function requestZoomDraw(): void {
  cancelAnimationFrame(zoomFrame);
  zoomFrame = requestAnimationFrame(drawZoom);
}

/** Clamp the range to the figure's limits, keeping the span. */
function setRange(x0: number, x1: number): void {
  if (!zoom) return;
  const lim = limits(zoom.d, H.fig(zoom.key), zoom.full);
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

export function openZoom(d: StationData, key: string, full = false): void {
  const f = H.fig(key);
  const [x0, x1] = f.window(d);
  zoom = { d, key, depth: H.depth(d, key), x0, x1, full: false };
  $("zoom-title").textContent = `${H.name(f)} · ${d.meta.name}`;
  $("zoom-tabs").innerHTML = f.depthTabs && d.depths.length > 1 ? H.depthTabs(d, "zoom", zoom.depth) : "";
  ($("zoom") as HTMLDialogElement).showModal();
  setFull(full); // draws after layout, so the axis labels fit the dialog's width
}

export function wireZoom(host: ZoomHost): void {
  H = host;
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
    const f = H.fig(zoom.key);
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

/** Redraw the zoom view if it is open (after data or units change). */
export function redrawZoom(): void {
  if (zoom) drawZoom();
}

/** Years drawn: this year whenever it has data, earlier years only with enough coverage. Years with no
 * data at all in the window (for example during an outage) are neither drawn nor listed. */
export function visibleYears(lines: YearLine[]): { shown: YearLine[]; hidden: YearLine[] } {
  const shown = lines.filter((l) => (l.offset === 0 ? l.coverage > 0 : l.coverage >= COVERAGE_MIN));
  const hidden = lines.filter((l) => l.offset > 0 && l.coverage > 0 && l.coverage < COVERAGE_MIN);
  return { shown, hidden };
}
