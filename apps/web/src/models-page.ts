/**
 * "Wind models compared" (/long-island-sound/models/): 10 m wind over the Sound for the next 48 hours on five models'
 * own grids, finest to coarsest: HRDPS (2.5 km, rotated), HRRR (3 km), ICON (13 km triangles), ECMWF open data and
 * GFS (0.25 degree). The Waves view (?view=waves) shows significant wave height for the next 72 hours the same way on
 * two: NWPS (1.8 km cells) and NECOFS (its mesh nodes, each drawn as its median dual cell). Each
 * panel is a small MapLibre map: the model's cells as a translucent fill under the basemap's labels, thin cell
 * outlines and an arrow per cell (thinned by MapLibre's symbol collision, the coarse lattice first); in the Waves view,
 * lines along the wave crests in place of the arrows, traced through each model's own cells as on the Sound's map
 * (streamlets.ts, after Ware, Kelley and Pilar 2014). One slider (and
 * a play button) steps all five through the same 3-hourly frames; pan or zoom one map and the others follow.
 *
 * Data: v1/fields/model-grids.json, written by the jobs' model_grids module (a grid per model, frames of int8 u/v);
 * v1/fields/wave-grids.json for the waves (wave_grids module: frames of one byte per value for height, direction of
 * travel and period).
 */
import "./site.css";
import "./away-links";
import { mountAdvisories } from "./advisory";
import "./models-page.css";
import { setPlayButton, timeTrack } from "@lhzn-io/timecharts/time-axis";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson"; // types that come with maplibre-gl
import { dualCells, pointLevels } from "./dual-cells";
import { Streamlets, gridMesh, type FlowMesh } from "./streamlets";

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
const VIEW_MODE: "wind" | "waves" = new URLSearchParams(location.search).get("view") === "waves" ? "waves" : "wind";
const WAVES = VIEW_MODE === "waves";
/** Raw ("raw=1"): the crests and their glyphs read each cell's own value, with no interpolation between cells. */
let RAW = new URLSearchParams(location.search).get("raw") === "1";
/** Waves: the cells shaded by wave period (default), on the Sound map's green period scale, or by significant height
 * ("wshade=height"). NWPS gives the peak period and NECOFS the mean period. */
let SHADE: "height" | "period" = new URLSearchParams(location.search).get("wshade") === "height" ? "height" : "period";

// ---------- Data ----------

interface Frame {
  valid_time: string;
  issue_time: string | null; // NECOFS waves: no issue time or lead (its file does not give its run's start)
  lead_h: number | null;
  u?: string; // wind: int8 east and north
  v?: string;
  hs?: string; // waves: one byte each for height, direction of travel and period
  dir?: string;
  tp?: string;
}
type Grid =
  | { type: "quads"; nx: number; ny: number; lon: number[]; lat: number[]; land?: number[] }
  | { type: "tri"; n: number; tri: number[] }
  | { type: "nodes"; n: number; lon: number[]; lat: number[]; tri: number[] };
interface Model {
  id: string;
  label: string;
  grid_label: string;
  spacing_km: number | null;
  attribution: string;
  period?: string; // waves: "peak period" or "mean period (T0m1)"
  run?: string; // waves: the newest run (NWPS) or the last hour the forecast reaches (NECOFS)
  grid: Grid;
  frames: Frame[];
}
interface ModelGrids {
  generated_at: string;
  encoding: { step?: number; hs_step?: number; dir_step?: number; tp_step?: number; none?: number };
  times: string[];
  models: Model[] | Record<string, Model>;
}

/** A model's cells once: polygon rings, centres, the arrow thinning level (0 places first) and cells left out (land). */
interface Mesh {
  rings: [number, number][][];
  centres: [number, number][];
  level: number[];
  skip?: Uint8Array;
}
function mesh(g: Grid): Mesh {
  const rings: [number, number][][] = [];
  const centres: [number, number][] = [];
  const level: number[] = [];
  if (g.type === "nodes") {
    // Each node's median dual cell, the area a node-centred wave model holds its value over.
    const cells = dualCells(g.lon, g.lat, g.tri);
    const skip = new Uint8Array(g.n);
    cells.forEach((ring, i) => {
      rings.push(ring);
      centres.push([g.lon[i], g.lat[i]]);
      if (!ring.length) skip[i] = 1;
    });
    return { rings, centres, level: pointLevels(g.lon, g.lat), skip };
  }
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
  const skip = g.type === "quads" && g.land ? Uint8Array.from(g.land) : undefined;
  return { rings, centres, level, skip };
}
/** One byte per value (waves): value = byte x step, NaN where the byte is `none`. */
function decodeBytes(s: string, step: number, none: number): Float32Array {
  const b = atob(s);
  const out = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const q = b.charCodeAt(i);
    out[i] = q === none ? NaN : q * step;
  }
  return out;
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

/** Wave height colours, m, as on the map's Waves layer: pale to deep blue-teal on the light basemap and the reverse on
 * the dark one, fixed at 0 to 2.5 m (higher is the last colour). */
const WAVE_STOPS: Record<"light" | "dark", [number, string][]> = {
  light: [[0, "#eef6f8"], [0.3, "#cfe6ee"], [0.6, "#9dcbdc"], [1.0, "#5ea6c4"], [1.5, "#2d7aa3"], [2.5, "#16466e"]],
  dark: [[0, "#16242c"], [0.3, "#1f3a48"], [0.6, "#2d5d73"], [1.0, "#4b8aa4"], [1.5, "#7fb8d8"], [2.5, "#cfe8f3"]],
};
/** Wave period, s: the Sound map's scale, pale to deep green on the light basemap and the reverse on the dark one. */
const PERIOD_STOPS: Record<Theme, [number, string][]> = {
  light: [[0, "#fbfbe6"], [3, "#e4e9b8"], [5, "#b9d48a"], [7, "#7fb664"], [10, "#3f8a4a"], [14, "#1c5233"]],
  dark: [[0, "#17261c"], [3, "#21422d"], [5, "#2f6440"], [7, "#4f8f5a"], [10, "#8fc27f"], [14, "#dfeec2"]],
};
function periodColour(t: number): string {
  const stops = PERIOD_STOPS[theme()];
  const k = Math.max(0, Math.min(14, t));
  for (let i = 1; i < stops.length; i++) {
    const [a, ca] = stops[i - 1];
    const [b, cb] = stops[i];
    if (k <= b) return mix(ca, cb, (k - a) / (b - a));
  }
  return stops[stops.length - 1][1];
}

const WAVE_TOP = 2.5;
function waveColour(m: number): string {
  const stops = WAVE_STOPS[theme() === "light" ? "light" : "dark"];
  const k = Math.max(0, Math.min(WAVE_TOP, m));
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
  flow: CrestMesh | null; // waves: the model's cells as triangles for the crest lines
  crest: Streamlets | null;
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
  if (WAVES) return waveFeatures(p, f);
  const u = decode(f.u!, MG.encoding.step!);
  const v = decode(f.v!, MG.encoding.step!);
  const cells: Feature[] = [];
  const arrows: Feature[] = [];
  p.mesh.rings.forEach((ring, i) => {
    const kt = Math.hypot(u[i], v[i]) * MS_TO_KT;
    const to = ((Math.atan2(u[i], v[i]) * 180) / Math.PI + 360) % 360;
    cells.push({ type: "Feature", properties: { c: windColour(kt), kt, dir: to }, geometry: { type: "Polygon", coordinates: [ring] } });
    if (kt >= 0.2)
      arrows.push({
        type: "Feature",
        properties: { kt, dir: ((Math.atan2(u[i], v[i]) * 180) / Math.PI + 360) % 360, lvl: p.mesh!.level[i] },
        geometry: { type: "Point", coordinates: p.mesh!.centres[i] },
      });
  });
  return { cells: { type: "FeatureCollection", features: cells }, arrows: { type: "FeatureCollection", features: arrows } };
}

/** Waves: each cell coloured by its height, an arrow where the waves travel; land and empty cells left out. */
function waveFeatures(p: Panel, f: Frame): { cells: FeatureCollection; arrows: FeatureCollection } {
  const e = MG!.encoding;
  const none = e.none ?? 255;
  const hs = decodeBytes(f.hs!, e.hs_step!, none);
  const dir = decodeBytes(f.dir!, e.dir_step!, none);
  const tp = decodeBytes(f.tp!, e.tp_step!, none);
  const m = p.mesh!;
  const cells: Feature[] = [];
  const arrows: Feature[] = [];
  m.rings.forEach((ring, i) => {
    if (m.skip?.[i] || !Number.isFinite(hs[i]) || ring.length < 4) return;
    const c = SHADE === "height" ? waveColour(hs[i]) : Number.isFinite(tp[i]) ? periodColour(tp[i]) : "rgba(0,0,0,0)";
    cells.push({ type: "Feature", properties: { c, hs: hs[i], tp: tp[i], dir: dir[i] }, geometry: { type: "Polygon", coordinates: [ring] } });
    if (hs[i] >= 0.05 && Number.isFinite(dir[i]))
      arrows.push({ type: "Feature", properties: { kt: Math.min(25, hs[i] * 10), dir: dir[i], lvl: m.level[i] }, geometry: { type: "Point", coordinates: m.centres[i] } });
  });
  return { cells: { type: "FeatureCollection", features: cells }, arrows: { type: "FeatureCollection", features: arrows } };
}

/** Waves: the model's cells as triangles for the crest lines, and how each triangle reads its values: NWPS cells (land
 * left out) each as two triangles; NECOFS's own triangles, each the mean of its three nodes. */
interface CrestMesh {
  mesh: FlowMesh;
  cell: Int32Array | null; // grid: the cell under each triangle
  tri: ArrayLike<number> | null; // nodes: three node indices per triangle
}
function crestMesh(g: Grid): CrestMesh | null {
  if (g.type === "quads") {
    const { mesh, cell } = gridMesh(g.nx, g.ny, g.lon, g.lat, g.land);
    return { mesh, cell, tri: null };
  }
  if (g.type === "nodes") {
    const nodes: [number, number][] = g.lon.map((x, i) => [x, g.lat[i]]);
    const triangles: [number, number, number][] = [];
    for (let k = 0; k + 2 < g.tri.length; k += 3) triangles.push([g.tri[k], g.tri[k + 1], g.tri[k + 2]]);
    return { mesh: { nodes, triangles }, cell: null, tri: g.tri };
  }
  return null;
}

/** The crest field at the current frame, per triangle: significant height along the direction the waves travel. */
function crestField(p: Panel): { u: Float32Array; v: Float32Array } | null {
  const f = MG && p.flow ? p.frames.get(MG.times[frame]) : undefined;
  if (!f || !p.flow || !MG || !f.hs || !f.dir) return null;
  const e = MG.encoding;
  const none = e.none ?? 255;
  const hs = decodeBytes(f.hs, e.hs_step!, none);
  const dir = decodeBytes(f.dir, e.dir_step!, none);
  const cu = new Float32Array(hs.length);
  const cv = new Float32Array(hs.length);
  for (let i = 0; i < hs.length; i++) {
    if (!Number.isFinite(hs[i]) || !Number.isFinite(dir[i])) continue;
    const r = (dir[i] * Math.PI) / 180;
    cu[i] = hs[i] * Math.sin(r);
    cv[i] = hs[i] * Math.cos(r);
  }
  const { cell, tri, mesh } = p.flow;
  if (cell) return { u: Float32Array.from(cell, (c) => cu[c]), v: Float32Array.from(cell, (c) => cv[c]) };
  const t = mesh.triangles.length;
  const u = new Float32Array(t);
  const v = new Float32Array(t);
  for (let k = 0; k < t; k++) {
    const a = tri![3 * k], b = tri![3 * k + 1], c = tri![3 * k + 2];
    u[k] = (cu[a] + cu[b] + cu[c]) / 3;
    v[k] = (cv[a] + cv[b] + cv[c]) / 3;
  }
  return { u, v };
}

function setCrests(p: Panel): void {
  if (!p.crest) return;
  const c = crestField(p);
  p.crest.setField(c?.u ?? null, c?.v ?? null);
}

/** An arrow pointing north in the theme's color: a fine shaft and an open chevron head, drawn at ARROW_RATIO times
 * its 32 px size. A plain image, not an SDF icon: a pen under a pixel wide breaks up at an SDF's edge threshold. */
const ARROW_RATIO = 2;
function arrowImage(color: string): ImageData {
  const n = 32 * ARROW_RATIO;
  const cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const g = cv.getContext("2d")!;
  g.scale(ARROW_RATIO, ARROW_RATIO);
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(16, 28);
  g.lineTo(16, 4.5);
  g.moveTo(10, 11.5);
  g.lineTo(16, 4.5);
  g.lineTo(22, 11.5);
  g.stroke();
  return g.getImageData(0, 0, n, n);
}

function addLayers(p: Panel): void {
  const map = p.map!;
  const data = features(p);
  const fine = (p.model?.grid.type === "quads" && p.model.grid.nx > 40) || p.model?.grid.type === "nodes";
  const icon = `mg-arrow-${theme()}`;
  if (!map.hasImage(icon)) map.addImage(icon, arrowImage(ARROW[theme()]), { pixelRatio: ARROW_RATIO });
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
        // HRRR's and HRDPS's cells are a few pixels wide at the opening view: their outlines appear only as the map
        // zooms in.
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
        "icon-image": icon,
        "icon-rotate": ["get", "dir"],
        "icon-rotation-alignment": "map",
        "icon-size": ["interpolate", ["linear"], ["get", "kt"], 0, 0.45, 25, 0.75],
        "icon-allow-overlap": false,
        "icon-padding": 1,
        "symbol-sort-key": ["get", "lvl"],
      },
      paint: { "icon-opacity": 0.8 },
    },
    before,
  );
  if (WAVES && p.flow) {
    // Crests in place of the arrows, in the theme's ink (rebuilt after a theme switch, which reloads the style).
    p.crest?.destroy();
    const light = theme() === "light";
    p.crest = new Streamlets(map, p.flow.mesh, { mode: "crest", floor: 0.05, glyph: 3.28084 });
    p.crest.setStyle(light ? "#1c2a48" : "#f4f1e8", light ? "#fbf8f1" : "#10182a", 0.5);
    p.crest.setRaw(RAW);
    setCrests(p);
    map.setLayoutProperty("arrows", "visibility", "none");
  }
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
  map.on("mousemove", (e) => readout(e.lngLat));
  map.on("click", (e) => readout(e.lngLat));
  map.getCanvasContainer().addEventListener("mouseleave", () => readout(null));
  new ResizeObserver(() => map.resize()).observe(box);
}

// ---------- Frames ----------

function caption(p: Panel, label: string, gridLabel: string): string {
  const f = MG && p.model ? p.frames.get(MG.times[frame]) : undefined;
  const ends = (iso: string) => `${fmtWeekday.format(new Date(iso))} ${hourUtc(new Date(iso))}`;
  const sub = !p.model
    ? "not available"
    : f && f.issue_time
      ? `issued ${fmtWeekday.format(new Date(f.issue_time.replace(/T(\d\d)Z$/, "T$1:00Z")))} ${hourUtc(new Date(f.issue_time.replace(/T(\d\d)Z$/, "T$1:00Z")))}, ${f.lead_h} h ahead`
      : f && p.model.run
        ? `forecast to ${ends(p.model.run)}`
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
    setCrests(p);
  }
}

let timer = 0;
function setPlaying(on: boolean): void {
  window.clearInterval(timer);
  setPlayButton($("play"), on);
  if (on && MG) timer = window.setInterval(() => setFrame((frame + 1) % MG!.times.length), PLAY_MS);
}

// ---------- Page ----------

const GLYPH_KEY =
  `<span class="glyph-key" title="Crest marks: significant height, a bar per foot and a triangle per 5 feet">` +
  `<svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true"><path d="M1 9h10M6 9V4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>1 ft ` +
  `<svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true"><path d="M1 9h10" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 9L6 2.5 8.5 9z" fill="currentColor"/></svg>5 ft</span>`;

let rawButton: HTMLSpanElement | null = null; // the raw switch, kept across legend redraws

function legend(): void {
  if (WAVES) {
    const pick = (k: "height" | "period") =>
      `<button type="button" data-wshade="${k}" aria-pressed="${SHADE === k}" title="Shade the cells by ${k === "height" ? "significant wave height" : "wave period (NWPS peak, NECOFS mean)"}">${k}</button>`;
    const steps = SHADE === "height" ? [0, 0.3, 0.6, 1, 1.5, 2, 2.5] : [0, 3, 5, 7, 10, 14];
    const swatch = (v: number) => (SHADE === "height" ? waveColour(v) : periodColour(v));
    const top = SHADE === "height" ? 2.5 : 14;
    $("key").innerHTML =
      `<span class="field-range" role="group" aria-label="Shading">${pick("height")}${pick("period")}</span>` +
      `<span>${SHADE === "height" ? "height, m:" : "period, s:"}</span>` +
      steps.map((v) => `<span><i class="sq" style="background:${swatch(v)}"></i>${v === top ? `${v}+` : v}</span>`).join("") +
      GLYPH_KEY;
    for (const b of $("key").querySelectorAll<HTMLButtonElement>("[data-wshade]"))
      b.addEventListener("click", () => {
        const k = b.dataset.wshade === "period" ? "period" : "height";
        if (k === SHADE) return;
        SHADE = k;
        const u = new URL(location.href);
        if (SHADE === "height") u.searchParams.set("wshade", "height");
        else u.searchParams.delete("wshade");
        history.replaceState(null, "", u);
        legend();
        setFrame(frame);
      });
    if (rawButton) $("key").append(rawButton);
    return;
  }
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

const PANELS: [string, string, string][] = WAVES
  ? [
      ["nwps", "NWPS", "1.8 km cells"],
      ["necofs", "NECOFS", "mesh nodes, 0.2 to 1.5 km"],
    ]
  : [
      ["hrdps", "HRDPS", "2.5 km"],
      ["hrrr", "HRRR", "3 km"],
      ["icon", "ICON", "13 km (triangles)"],
      ["ecmwf", "ECMWF", "0.25° (open data)"],
      ["gfs", "GFS", "0.25° (27 km)"],
    ];

// ---------- Readout ----------

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Every panel's value at one place (the maps follow each other, so a point projects into each). */
function readout(at: maplibregl.LngLat | null): void {
  const el = $("readout");
  if (!at) {
    el.textContent = WAVES ? "Point at the water for both models' values there." : "Point at the map for each model's wind there.";
    return;
  }
  const parts: string[] = [];
  for (const p of panels) {
    if (!p.map || !p.model || !p.map.getLayer("cells")) continue;
    const hit = p.map.queryRenderedFeatures(p.map.project(at), { layers: ["cells"] })[0];
    const q = hit?.properties as { hs?: number; tp?: number; dir?: number; kt?: number } | undefined;
    if (!q) {
      parts.push(`<b>${p.model.label}</b> none`);
      continue;
    }
    if (WAVES) {
      const period = Number.isFinite(q.tp) ? `, ${Number(q.tp).toFixed(1)} s ${p.model.period?.startsWith("mean") ? "mean" : "peak"}` : "";
      const toward = Number.isFinite(q.dir) && Number(q.hs) >= 0.05 ? `, toward ${compass(Number(q.dir))}` : "";
      parts.push(`<b>${p.model.label}</b> ${Number(q.hs).toFixed(2)} m (${(Number(q.hs) * 3.28084).toFixed(1)} ft)${period}${toward}`);
    } else {
      parts.push(`<b>${p.model.label}</b> ${Number(q.kt).toFixed(0)} kt toward ${compass(Number(q.dir))}`);
    }
  }
  const lat = `${Math.abs(at.lat).toFixed(3)}° ${at.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(at.lng).toFixed(3)}° ${at.lng >= 0 ? "E" : "W"}`;
  el.innerHTML = `${lat} ${lon}: ${parts.join(" · ")}`;
}

/** The page's words for the view: title, switch, lede until the data loads, the note under the maps and the credits. */
function viewText(): void {
  const title = WAVES ? "Wave models compared" : "Wind models compared";
  $("title").textContent = title;
  document.title = `${title}, Long Island Sound (alpha) | longhorizon.blue`;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".mg-views a"))
    if (a.dataset.view === VIEW_MODE) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  for (const el of document.querySelectorAll<HTMLElement>("[data-only]")) el.hidden = el.dataset.only !== VIEW_MODE;
  if (WAVES) {
    $("lede").textContent = "NWPS 1.8 km · NECOFS mesh nodes: each on its own grid, the next 72 hours over Long Island Sound.";
    $("foot").textContent =
      "Crests traced through each model's cells; NECOFS nodes drawn over their dual cells. Period: NWPS peak, NECOFS mean. NWPS runs without currents.";
  }
  readout(null);
}

async function main(): Promise<void> {
  wireTheme(() => {
    for (const p of panels) p.map?.setStyle(STYLES[theme()]);
    legend(); // the swatches follow the theme
  });
  viewText();
  legend();
  try {
    const r = await fetch(`${DATA}/fields/${WAVES ? "wave-grids" : "model-grids"}.json`, { cache: "no-cache" });
    if (r.ok) MG = (await r.json()) as ModelGrids;
  } catch {
    MG = null;
  }
  if (MG && (!Array.isArray(MG.times) || !MG.times.length)) MG = null; // an older layout
  const list = MG ? (Array.isArray(MG.models) ? MG.models : Object.values(MG.models)) : [];
  const byId = new Map(list.map((m) => [m.id, m]));
  if (!MG) {
    const e = $("load-error");
    e.hidden = false;
    e.textContent = WAVES ? "Wave grids load with the next forecast update." : "Model grids load with the next forecast update.";
    $("controls").hidden = true;
  } else {
    if (!WAVES)
      $("lede").textContent =
        PANELS.map(([id]) => byId.get(id))
          .filter((m): m is Model => !!m)
          .map((m) => `${m.label} ${m.spacing_km} km`)
          .join(" · ") + ": each on its own grid, the next 48 hours over Long Island Sound.";
    const slider = $("slider") as HTMLInputElement;
    const times = MG.times;
    slider.max = String(times.length - 1);
    timeTrack(slider, (v) => Date.parse(times[Math.round(v)]) / 1000);
    slider.addEventListener("input", () => {
      setPlaying(false);
      setFrame(Number(slider.value));
    });
    $("play").addEventListener("click", () => setPlaying($("play").getAttribute("aria-pressed") !== "true"));
    if (WAVES) {
      // The no-smoothing switch (off by default), carried in the link as "raw=1".
      const raw = document.createElement("button");
      raw.type = "button";
      raw.id = "raw";
      raw.textContent = "raw";
      raw.title = "No smoothing or interpolation: the crests and glyphs read each model cell's own value";
      raw.setAttribute("aria-pressed", String(RAW));
      raw.addEventListener("click", () => {
        RAW = !RAW;
        raw.setAttribute("aria-pressed", String(RAW));
        for (const p of panels) p.crest?.setRaw(RAW);
        const u = new URL(location.href);
        if (RAW) u.searchParams.set("raw", "1");
        else u.searchParams.delete("raw");
        history.replaceState(null, "", u);
      });
      rawButton = document.createElement("span");
      rawButton.className = "field-range";
      rawButton.append(raw);
      $("key").append(rawButton);
    }
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
    const p: Panel = { model: m, mesh: m ? mesh(m.grid) : null, frames: new Map((m?.frames ?? []).map((x) => [x.valid_time, x])), box, cap, map: null, flow: WAVES && m ? crestMesh(m.grid) : null, crest: null };
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
    const w = window as unknown as {
      __mgMaps: maplibregl.Map[];
      __mgFrame: () => number;
      __mgCaptions: () => string[];
      __mgReadout: (lng: number, lat: number) => string;
    };
    w.__mgMaps = panels.map((p) => p.map).filter((m): m is maplibregl.Map => !!m);
    w.__mgFrame = () => frame;
    w.__mgCaptions = () => panels.map((p) => p.cap.textContent ?? "");
    w.__mgReadout = (lng, lat) => {
      readout(new maplibregl.LngLat(lng, lat));
      return $("readout").textContent ?? "";
    };
  }
}

void main();

// The NWS advisories in force on the Sound, in the masthead (links to the Wind view).
const mastEl = document.querySelector(".mast");
if (mastEl) void mountAdvisories(mastEl);
