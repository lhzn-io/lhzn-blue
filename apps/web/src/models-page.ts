/**
 * "Wind models compared" (/long-island-sound/models/): 10 m wind over the Sound for the next 48 hours on four models'
 * own grids, finest to coarsest: HRRR (3 km), ICON (13 km triangles), ECMWF open data and GFS (0.25 degree). Each
 * panel is a small MapLibre map: the model's cells as a translucent fill under the basemap's labels, thin cell
 * outlines and an arrow per cell (thinned by MapLibre's symbol collision, the coarse lattice first). One slider (and
 * a play button) steps all four through the same 3-hourly frames; pan or zoom one map and the others follow.
 *
 * Data: v1/fields/model-grids.json, written by the jobs' model_grids module (a grid per model, frames of int8 u/v).
 */
import "./site.css";
import { mountAdvisories } from "./advisory";
import "./models-page.css";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson"; // types that come with maplibre-gl

const DATA = "/data/v1";
const $ = (id: string) => document.getElementById(id)!;
const MS_TO_KT = 1.943844;
const TZ = "America/New_York";
const STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};
type Theme = keyof typeof STYLES;
const VIEW: [number, number, number, number] = [-74.05, 40.75, -71.75, 41.45];
const ARROW = { light: "#1c2a48", dark: "#f4f1e8" };
const PLAY_MS = 900;

// ---------- Data ----------

interface Frame {
  valid_time: string;
  issue_time: string;
  lead_h: number;
  u: string;
  v: string;
}
type Grid = { type: "quads"; nx: number; ny: number; lon: number[]; lat: number[] } | { type: "tri"; n: number; tri: number[] };
interface Model {
  id: string;
  label: string;
  grid_label: string;
  spacing_km: number;
  attribution: string;
  grid: Grid;
  frames: Frame[];
}
interface ModelGrids {
  generated_at: string;
  encoding: { step: number };
  times: string[];
  models: Model[];
}

/** A model's cells once: polygon rings, centres and the arrow thinning level (0 places first). */
interface Mesh {
  rings: [number, number][][];
  centres: [number, number][];
  level: number[];
}
function mesh(g: Grid): Mesh {
  const rings: [number, number][][] = [];
  const centres: [number, number][] = [];
  const level: number[] = [];
  if (g.type === "quads") {
    const cw = g.nx + 1;
    const P = (r: number, q: number): [number, number] => [g.lon[r * cw + q], g.lat[r * cw + q]];
    const fine = g.nx > 40;
    for (let r = 0; r < g.ny; r++)
      for (let q = 0; q < g.nx; q++) {
        const ring = [P(r, q), P(r, q + 1), P(r + 1, q + 1), P(r + 1, q)];
        rings.push([...ring, ring[0]]);
        centres.push([ring.reduce((s, p) => s + p[0], 0) / 4, ring.reduce((s, p) => s + p[1], 0) / 4]);
        level.push(!fine ? 0 : r % 8 === 0 && q % 8 === 0 ? 0 : r % 4 === 0 && q % 4 === 0 ? 1 : r % 2 === 0 && q % 2 === 0 ? 2 : 3);
      }
  } else {
    for (let i = 0; i < g.n; i++) {
      const t = g.tri.slice(i * 6, i * 6 + 6);
      const ring: [number, number][] = [
        [t[0], t[1]],
        [t[2], t[3]],
        [t[4], t[5]],
      ];
      rings.push([...ring, ring[0]]);
      centres.push([(t[0] + t[2] + t[4]) / 3, (t[1] + t[3] + t[5]) / 3]);
      level.push(0);
    }
  }
  return { rings, centres, level };
}
function decode(s: string, step: number): Float32Array {
  const b = atob(s);
  const out = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = ((b.charCodeAt(i) << 24) >> 24) * step; // int8
  return out;
}

// ---------- Colour ----------

/** Wind colours in kt, as on the map's wind layer: one continuous scale from pale lavender to deep violet on the light
 * basemap, and the reverse on the dark one, so the strongest wind is always the most visible. */
const LAVENDER: Record<"light" | "dark", [number, string][]> = {
  light: [[0, "#f1edf8"], [6, "#d9cdee"], [12, "#b7a2dd"], [18, "#9070c6"], [25, "#6a47a8"], [35, "#3f2477"]],
  dark: [[0, "#2b2440"], [6, "#3f3366"], [12, "#5d4a92"], [18, "#8167bd"], [25, "#a990dd"], [35, "#d6c7f5"]],
};
const TOP = 35;
function hexRgb(h: string): number[] {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
function mix(a: string, b: string, t: number): string {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  const k = Math.max(0, Math.min(1, t));
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}
function windColour(kt: number): string {
  const stops = LAVENDER[theme() === "light" ? "light" : "dark"];
  const k = Math.max(0, Math.min(TOP, kt));
  for (let i = 1; i < stops.length; i++) {
    const [a, ca] = stops[i - 1];
    const [b, cb] = stops[i];
    if (k <= b) return mix(ca, cb, (k - a) / (b - a));
  }
  return stops[stops.length - 1][1];
}

// ---------- Formatting ----------

const fmtEastern = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric" });
const fmtWeekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const hourUtc = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")} UTC`;

// ---------- Maps ----------

interface Panel {
  model: Model | null;
  mesh: Mesh | null;
  frames: Map<string, Frame>;
  box: HTMLElement;
  cap: HTMLElement;
  map: maplibregl.Map | null;
}
const panels: Panel[] = [];
let MG: ModelGrids | null = null;
let frame = 0;
let syncing = false;
const theme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** The panel's cells and arrows at the current frame (empty if no run of the model reaches it). */
function features(p: Panel): { cells: FeatureCollection; arrows: FeatureCollection } {
  const f = MG && p.mesh ? p.frames.get(MG.times[frame]) : undefined;
  if (!f || !p.mesh || !MG) return { cells: EMPTY, arrows: EMPTY };
  const u = decode(f.u, MG.encoding.step);
  const v = decode(f.v, MG.encoding.step);
  const cells: Feature[] = [];
  const arrows: Feature[] = [];
  p.mesh.rings.forEach((ring, i) => {
    const kt = Math.hypot(u[i], v[i]) * MS_TO_KT;
    cells.push({ type: "Feature", properties: { c: windColour(kt) }, geometry: { type: "Polygon", coordinates: [ring] } });
    if (kt >= 0.2)
      arrows.push({
        type: "Feature",
        properties: { kt, dir: ((Math.atan2(u[i], v[i]) * 180) / Math.PI + 360) % 360, lvl: p.mesh!.level[i] },
        geometry: { type: "Point", coordinates: p.mesh!.centres[i] },
      });
  });
  return { cells: { type: "FeatureCollection", features: cells }, arrows: { type: "FeatureCollection", features: arrows } };
}

/** An arrow pointing north, as an alpha mask for an SDF icon (coloured by the layer). */
function arrowImage(): ImageData {
  const n = 32;
  const cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const g = cv.getContext("2d")!;
  g.strokeStyle = "#000";
  g.fillStyle = "#000";
  g.lineWidth = 3;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(16, 28);
  g.lineTo(16, 9);
  g.stroke();
  g.beginPath();
  g.moveTo(16, 3);
  g.lineTo(23, 13);
  g.lineTo(9, 13);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, n, n);
}

function addLayers(p: Panel): void {
  const map = p.map!;
  const data = features(p);
  const fine = p.model?.grid.type === "quads" && p.model.grid.nx > 40;
  if (!map.hasImage("mg-arrow")) map.addImage("mg-arrow", arrowImage(), { sdf: true });
  map.addSource("cells", { type: "geojson", data: data.cells });
  map.addSource("arrows", { type: "geojson", data: data.arrows });
  // Over the basemap's land, water and roads but under its labels, so place names stay readable and arrows give way
  // to them: before the first label layer that follows the last drawn (non-label) layer.
  const layers = map.getStyle().layers;
  let last = -1;
  layers.forEach((l, i) => {
    if (l.type !== "symbol") last = i;
  });
  const before = layers.slice(last + 1).find((l) => l.type === "symbol")?.id;
  map.addLayer(
    { id: "cells", type: "fill", source: "cells", paint: { "fill-color": ["get", "c"], "fill-opacity": theme() === "light" ? 0.55 : 0.45, "fill-antialias": false } },
    before,
  );
  map.addLayer(
    {
      id: "cell-lines",
      type: "line",
      source: "cells",
      paint: {
        "line-color": theme() === "light" ? "#1c2a48" : "#ffffff",
        // HRRR's 3 km cells are a few pixels wide at the opening view: their outlines appear only as the map zooms in.
        "line-opacity": fine ? ["interpolate", ["linear"], ["zoom"], 8, 0, 10, 0.22] : 0.25,
        "line-width": 0.5,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "arrows",
      type: "symbol",
      source: "arrows",
      layout: {
        "icon-image": "mg-arrow",
        "icon-rotate": ["get", "dir"],
        "icon-rotation-alignment": "map",
        "icon-size": ["interpolate", ["linear"], ["get", "kt"], 0, 0.4, 25, 0.75],
        "icon-allow-overlap": false,
        "icon-padding": 1,
        "symbol-sort-key": ["get", "lvl"],
      },
      paint: { "icon-color": ARROW[theme()], "icon-opacity": 0.9 },
    },
    before,
  );
}

function webglOk(): boolean {
  try {
    const cv = document.createElement("canvas");
    return !!(cv.getContext("webgl2") || cv.getContext("webgl"));
  } catch {
    return false;
  }
}

function sync(from: maplibregl.Map): void {
  if (syncing) return;
  syncing = true;
  try {
    const view = { center: from.getCenter(), zoom: from.getZoom() };
    for (const p of panels) if (p.map && p.map !== from) p.map.jumpTo(view);
  } finally {
    syncing = false;
  }
}

function makeMap(p: Panel): void {
  const box = p.box;
  const map = new maplibregl.Map({
    container: box,
    style: STYLES[theme()],
    bounds: VIEW,
    fitBoundsOptions: { padding: 4 },
    attributionControl: { compact: true },
    // As on the Sound's main map: on a touch screen one finger scrolls the page and two move the map.
    cooperativeGestures: !window.matchMedia("(pointer: fine)").matches,
    dragRotate: false,
    pitchWithRotate: false,
  });
  p.map = map;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const collapse = () => box.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  map.once("load", collapse);
  map.once("idle", collapse);
  // A new style (theme switch) drops custom layers: add them back at the current frame.
  if (p.mesh) map.on("style.load", () => addLayers(p));
  map.on("move", () => sync(map));
  new ResizeObserver(() => map.resize()).observe(box);
}

// ---------- Frames ----------

function caption(p: Panel, label: string, gridLabel: string): string {
  const f = MG && p.model ? p.frames.get(MG.times[frame]) : undefined;
  const sub = !p.model
    ? "not available"
    : f
      ? `issued ${fmtWeekday.format(new Date(f.issue_time))} ${hourUtc(new Date(f.issue_time))}, ${f.lead_h} h ahead`
      : "no run reaches this hour";
  return `<span class="cap-label">${label}</span><span class="cap-sub">${gridLabel}, ${sub}</span>`;
}

function setFrame(i: number): void {
  if (!MG) return;
  frame = Math.max(0, Math.min(MG.times.length - 1, i));
  ($("slider") as HTMLInputElement).value = String(frame);
  const t = new Date(MG.times[frame]);
  $("tlabel").innerHTML = `<b>${fmtDay.format(t)}, ${hourUtc(t)}</b> (${fmtEastern.format(t)} Eastern)`;
  for (const p of panels) {
    p.cap.innerHTML = caption(p, p.model?.label ?? p.box.dataset.label!, p.model?.grid_label ?? "");
    if (!p.map || !p.mesh) continue;
    const cells = p.map.getSource("cells") as maplibregl.GeoJSONSource | undefined;
    const arrows = p.map.getSource("arrows") as maplibregl.GeoJSONSource | undefined;
    if (!cells || !arrows) continue; // style still loading: addLayers draws the current frame
    const d = features(p);
    cells.setData(d.cells);
    arrows.setData(d.arrows);
  }
}

let timer = 0;
function setPlaying(on: boolean): void {
  const btn = $("play");
  window.clearInterval(timer);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Pause" : "Play");
  btn.innerHTML = on
    ? `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>`;
  if (on && MG) timer = window.setInterval(() => setFrame((frame + 1) % MG!.times.length), PLAY_MS);
}

// ---------- Page ----------

function legend(): void {
  const steps = [0, 5, 10, 15, 20, 25, 30, 35];
  $("key").innerHTML =
    `<span>wind at 10 m, kt:</span>` + steps.map((v) => `<span><i class="sq" style="background:${windColour(v)}"></i>${v === 35 ? "35+" : v}</span>`).join("");
}

function wireTheme(redraw: () => void): void {
  const btn = $("theme-toggle");
  const MOON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const SUN = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const light = () => document.documentElement.dataset.theme === "light";
  const label = () => {
    btn.innerHTML = light() ? MOON : SUN;
    btn.title = light() ? "Dark theme" : "Light theme";
    btn.setAttribute("aria-pressed", String(light()));
    btn.setAttribute("aria-label", light() ? "Switch to the dark theme" : "Switch to the light theme");
  };
  label();
  btn.addEventListener("click", () => {
    const next = light() ? "dark" : "light";
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("lhzn-blue-theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    label();
    redraw();
  });
}

const PANELS: [string, string, string][] = [
  ["hrrr", "HRRR", "3 km"],
  ["icon", "ICON", "13 km (triangles)"],
  ["ecmwf", "ECMWF", "0.25° (open data)"],
  ["gfs", "GFS", "0.25° (27 km)"],
];

async function main(): Promise<void> {
  wireTheme(() => {
    for (const p of panels) p.map?.setStyle(STYLES[theme()]);
  });
  legend();
  try {
    const r = await fetch(`${DATA}/fields/model-grids.json`, { cache: "no-cache" });
    if (r.ok) MG = (await r.json()) as ModelGrids;
  } catch {
    MG = null;
  }
  if (MG && (!Array.isArray(MG.times) || !MG.times.length)) MG = null; // an older layout
  const byId = new Map((MG?.models ?? []).map((m) => [m.id, m]));
  if (!MG) {
    const e = $("load-error");
    e.hidden = false;
    e.textContent = "Model grids load with the next forecast update.";
    $("controls").hidden = true;
  } else {
    $("lede").textContent =
      PANELS.map(([id]) => byId.get(id))
        .filter((m): m is Model => !!m)
        .map((m) => `${m.label} ${m.spacing_km} km`)
        .join(" · ") + ": each on its own grid, the next 48 hours over Long Island Sound.";
    const slider = $("slider") as HTMLInputElement;
    slider.max = String(MG.times.length - 1);
    slider.addEventListener("input", () => {
      setPlaying(false);
      setFrame(Number(slider.value));
    });
    $("play").addEventListener("click", () => setPlaying($("play").getAttribute("aria-pressed") !== "true"));
    setPlaying(false);
  }

  const gl = webglOk();
  const host = $("panels");
  for (const [id, label, gridLabel] of PANELS) {
    const m = byId.get(id) ?? null;
    const f = document.createElement("figure");
    f.className = "mg-panel";
    const cap = document.createElement("figcaption");
    const box = document.createElement("div");
    box.className = "mg-map";
    box.dataset.model = id;
    box.dataset.label = label;
    f.append(cap, box);
    host.append(f);
    const p: Panel = { model: m, mesh: m ? mesh(m.grid) : null, frames: new Map((m?.frames ?? []).map((x) => [x.valid_time, x])), box, cap, map: null };
    panels.push(p);
    cap.innerHTML = `<span class="cap-label">${label}</span><span class="cap-sub">${gridLabel}</span>`;
    if (!gl) {
      box.innerHTML = `<p class="mg-fallback">This map needs WebGL, which this browser has turned off.</p>`;
      continue;
    }
    makeMap(p);
  }
  setFrame(0);

  // Test hooks for the page's own browser checks, in development only.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __mgMaps: maplibregl.Map[]; __mgFrame: () => number; __mgCaptions: () => string[] };
    w.__mgMaps = panels.map((p) => p.map).filter((m): m is maplibregl.Map => !!m);
    w.__mgFrame = () => frame;
    w.__mgCaptions = () => panels.map((p) => p.cap.textContent ?? "");
  }
}

void main();

// The NWS advisories in force on the Sound, in the masthead (links to the Wind view).
const mastEl = document.querySelector(".mast");
if (mastEl) void mountAdvisories(mastEl);
