/**
 * "Northeast U.S. Shelf" (/northeast-shelf/): two regional ocean models' surface currents side by side, each on its
 * own cells, from Cape Hatteras to Nova Scotia: NECOFS (FVCOM, an unstructured triangle mesh, UMass Dartmouth)
 * and DOPPIO (ROMS, a 7 km curvilinear grid, Rutgers for MARACOOS). Each panel is a small MapLibre map, as on the
 * wind models page: the cells as a translucent fill colored by speed, thin cell outlines, and a light arrow per cell
 * for the direction only (MapLibre's symbol collision thins them, the coarse lattice first). One slider steps both
 * through the same 2-hourly frames; pan or zoom one map and the other follows.
 *
 * Level of detail: DOPPIO's whole grid (about 19,500 cells) is one file, drawn at every zoom. NECOFS's 265,000 cells
 * are cut into tiles; at a wide view, where they are smaller than a pixel, the page draws NECOFS averaged into
 * DOPPIO's cells (labeled so), and once zoomed in it fetches only the tiles in view, by HTTP range from one pack.
 *
 * Data: the tile store (jobs: shelf.py, tiles.py), served from its own host. latest.json names the current files and
 * indexes the NECOFS tiles; each blob is gzip of "LHZT", a uint32 header length, a JSON header, float32 node lon, lat
 * pairs, the element node indices (uint16 or uint32), a uint8 arrow level per element, then per step one int8 per
 * element east and one north, in step_cms cm/s.
 */
import "./site.css";
import "./away-links";
import "./models-page.css";
import "./shelf-page.css";
import { setPlayButton, timeTrack } from "@lhzn-io/timecharts/time-axis";
import { CURRENTS_RAMP, CURRENTS_RAMP_DARK } from "@lhzn-io/timecharts/currents-ramp";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";

const TILES = import.meta.env.DEV ? "/tiles/shelf/v1/" : "https://tiles.lhzn.blue/shelf/v1/";
const $ = (id: string) => document.getElementById(id)!;
const MS_TO_KT = 1.943844;
const TZ = "America/New_York";
const STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};
type Theme = keyof typeof STYLES;
const ARROW = { light: "#1c2a48", dark: "#f4f1e8" };
const PLAY_MS = 900;
const OPEN_BOUNDS: [number, number, number, number] = [-76.5, 35.0, -64.5, 45.3]; // Cape Hatteras to Nova Scotia
const NATIVE_MIN_ZOOM = 7; // below this, NECOFS's cells are a pixel or less: the averaged view
const MAX_NATIVE = window.matchMedia("(pointer: coarse)").matches ? 25_000 : 50_000; // NECOFS cells drawn at once
const CACHE_CELLS = 250_000; // NECOFS tile cells kept in memory, oldest dropped first
const FETCHES = 6;
const theme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// ---------- Data ----------

interface Model {
  source: string;
  url: string | null;
  run: string;
  t0: string;
  step: number;
  steps: number;
  wide: string;
  pack?: string;
  cells: number;
  wide_cells?: number;
  tiles?: Record<string, [number, number, number]>; // offset, length, elements
}
interface Latest {
  generated_at: string;
  base_zoom: number;
  models: { necofs?: Model; doppio?: Model };
}
/** One blob's cells and forecast. */
interface Cells {
  m: number;
  verts: number;
  nodes: Float32Array; // lon, lat pairs
  elems: Uint16Array | Uint32Array;
  levels: Uint8Array;
  cx: Float32Array; // element centers
  cy: Float32Array;
  steps: number;
  k: number; // cm/s per unit
  q: Int8Array; // per step: m east, then m north
}

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parse(raw: Uint8Array): Cells {
  if (String.fromCharCode(...raw.subarray(0, 4)) !== "LHZT") throw new Error("not a tile");
  const n = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + n))) as { nodes: number; elements: number; verts: number; steps: number; step_cms: number; index: string };
  let off = raw.byteOffset + 8 + n;
  const take = (bytes: number) => {
    const b = raw.buffer.slice(off, off + bytes); // a copy, aligned for the typed arrays
    off += bytes;
    return b;
  };
  const nodes = new Float32Array(take(h.nodes * 8));
  const big = h.index === "u32";
  const elems = big ? new Uint32Array(take(h.elements * h.verts * 4)) : new Uint16Array(take(h.elements * h.verts * 2));
  const levels = new Uint8Array(take(h.elements));
  const q = new Int8Array(take(h.steps * 2 * h.elements));
  const cx = new Float32Array(h.elements);
  const cy = new Float32Array(h.elements);
  for (let i = 0; i < h.elements; i++) {
    // The mean of its distinct nodes: the wide view stores NECOFS's large triangles as four nodes, the last repeated.
    let x = 0;
    let y = 0;
    let k = 0;
    for (let j = 0; j < h.verts; j++) {
      const nd = elems[i * h.verts + j];
      if (j > 0 && nd === elems[i * h.verts + j - 1]) continue;
      x += nodes[2 * nd];
      y += nodes[2 * nd + 1];
      k++;
    }
    cx[i] = x / k;
    cy[i] = y / k;
  }
  return { m: h.elements, verts: h.verts, nodes, elems, levels, cx, cy, steps: h.steps, k: h.step_cms, q };
}

async function loadWhole(path: string): Promise<Cells> {
  const r = await fetch(TILES + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return parse(await gunzip(await r.arrayBuffer()));
}

async function loadTile(pack: string, off: number, len: number): Promise<Cells> {
  const r = await fetch(TILES + pack, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!r.ok) throw new Error(`tile: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  if (r.status === 200) buf = buf.slice(off, off + len); // a server that ignored the range sent the whole pack
  return parse(await gunzip(buf));
}

// ---------- Tiles in view ----------

function tileBounds(key: string): [number, number, number, number] {
  const [z, x, y] = key.split("/").map(Number);
  const n = 2 ** z;
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

const tileBox = new Map<string, [number, number, number, number]>();
/** The tiles touching the view, and about how many of their elements are in it (each tile's count times the share of
 * its box in view): a tile mostly outside the view counts for little. */
function inView(map: maplibregl.Map, index: Record<string, [number, number, number]>): { keys: string[]; count: number } {
  const b = map.getBounds();
  const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const keys: string[] = [];
  let count = 0;
  for (const key of Object.keys(index)) {
    let t = tileBox.get(key);
    if (!t) tileBox.set(key, (t = tileBounds(key)));
    const dx = Math.min(t[2], e) - Math.max(t[0], w);
    const dy = Math.min(t[3], n) - Math.max(t[1], s);
    if (dx <= 0 || dy <= 0) continue;
    keys.push(key);
    count += (index[key][2] * dx * dy) / ((t[2] - t[0]) * (t[3] - t[1]));
  }
  return { keys, count };
}

// ---------- Color ----------

function hexRgb(h: string): number[] {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
function mix(a: string, b: string, t: number): string {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  const k = Math.max(0, Math.min(1, t));
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}
/** The site's currents speed ramp (m/s, log speed), the dark-basemap twin on the dark theme. */
function speedColor(ms: number): string {
  const ramp = theme() === "light" ? CURRENTS_RAMP : CURRENTS_RAMP_DARK;
  if (!(ms > ramp[0][0])) return ramp[0][1];
  for (let i = 1; i < ramp.length; i++) {
    const [a, ca] = ramp[i - 1];
    const [b, cb] = ramp[i];
    if (ms <= b) return mix(ca, cb, Math.log(ms / a) / Math.log(b / a));
  }
  return ramp[ramp.length - 1][1];
}

// ---------- Formatting ----------

const fmtEastern = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric" });
const fmtUtc = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")} UTC`;
const nf = new Intl.NumberFormat("en-US");

// ---------- State ----------

interface Panel {
  id: "necofs" | "doppio";
  label: string;
  grid: string;
  model: Model | null;
  wide: Cells | null;
  iso: FeatureCollection | null; // the model's own depth contours
  box: HTMLElement;
  cap: HTMLElement;
  map: maplibregl.Map | null;
}
const panels: Panel[] = [];
let times: number[] = []; // epoch seconds of the frames (both models share the window's 2-hourly steps)
let frame = 0;
let syncing = false;
// NECOFS's level of detail: "wide" (averaged into DOPPIO's cells) or "native" (its own cells, the tiles in view).
let lod: "wide" | "native" = "wide";
let tooMany = false; // zoomed in, but more NECOFS cells in view than the page draws at once
let inViewKeys: string[] = [];
const tileCache = new Map<string, Cells>();
const pending = new Map<string, Promise<void>>();

/** The blobs a panel draws now. */
function drawn(p: Panel): Cells[] {
  if (p.id === "doppio" || lod === "wide") return p.wide ? [p.wide] : [];
  const loaded = inViewKeys.map((k) => tileCache.get(k)).filter((c): c is Cells => !!c);
  return loaded.length ? loaded : p.wide ? [p.wide] : [];
}
const nativeNow = (p: Panel) => p.id === "necofs" && lod === "native" && inViewKeys.some((k) => tileCache.has(k));

/** The panel's cells and arrows at the current frame (empty where its forecast does not reach). */
function features(p: Panel): { cells: FeatureCollection; arrows: FeatureCollection } {
  if (!p.model) return { cells: EMPTY, arrows: EMPTY };
  const j = Math.round((times[frame] - Date.parse(p.model.t0) / 1000) / p.model.step);
  if (j < 0 || j >= p.model.steps) return { cells: EMPTY, arrows: EMPTY };
  const cells: Feature[] = [];
  const arrows: Feature[] = [];
  for (const c of drawn(p)) {
    if (j >= c.steps) continue;
    const base = j * 2 * c.m;
    for (let i = 0; i < c.m; i++) {
      const u = c.q[base + i] * c.k;
      const v = c.q[base + c.m + i] * c.k;
      const ms = Math.hypot(u, v) / 100;
      const ring: [number, number][] = [];
      for (let t = 0; t < c.verts; t++) {
        const nd = c.elems[i * c.verts + t];
        ring.push([c.nodes[2 * nd], c.nodes[2 * nd + 1]]);
      }
      ring.push(ring[0]);
      cells.push({ type: "Feature", properties: { c: speedColor(ms) }, geometry: { type: "Polygon", coordinates: [ring] } });
      if (ms >= 0.03)
        arrows.push({
          type: "Feature",
          properties: { dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, lvl: c.levels[i] },
          geometry: { type: "Point", coordinates: [c.cx[i], c.cy[i]] },
        });
    }
  }
  return { cells: { type: "FeatureCollection", features: cells }, arrows: { type: "FeatureCollection", features: arrows } };
}

// ---------- Maps ----------

/** An arrow pointing north, as an alpha mask for an SDF icon (colored by the layer). */
function arrowImage(): ImageData {
  const n = 32;
  const cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const g = cv.getContext("2d")!;
  g.strokeStyle = "#000";
  g.fillStyle = "#000";
  g.lineWidth = 2.5;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(16, 28);
  g.lineTo(16, 9);
  g.stroke();
  g.beginPath();
  g.moveTo(16, 3);
  g.lineTo(22, 12);
  g.lineTo(10, 12);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, n, n);
}

function addLayers(p: Panel): void {
  const map = p.map!;
  const data = features(p);
  if (!map.hasImage("sh-arrow")) map.addImage("sh-arrow", arrowImage(), { sdf: true });
  // No simplification: at a wide zoom it drops NECOFS's smallest triangles (canyon heads) and leaves holes.
  map.addSource("cells", { type: "geojson", data: data.cells, tolerance: 0 });
  map.addSource("arrows", { type: "geojson", data: data.arrows });
  map.addSource("isobaths", { type: "geojson", data: p.iso ?? EMPTY });
  // Over the basemap's land, water and roads but under its labels.
  const layers = map.getStyle().layers;
  let last = -1;
  layers.forEach((l, i) => {
    if (l.type !== "symbol") last = i;
  });
  const before = layers.slice(last + 1).find((l) => l.type === "symbol")?.id;
  const ink = theme() === "light" ? "#1c2a48" : "#ffffff";
  map.addLayer({ id: "cells", type: "fill", source: "cells", paint: { "fill-color": ["get", "c"], "fill-opacity": 0.8, "fill-antialias": false } }, before);
  map.addLayer(
    {
      id: "cell-lines",
      type: "line",
      source: "cells",
      // Outlines come in as the map zooms: at the opening view the cells are a few pixels wide.
      paint: { "line-color": ink, "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0, 8, p.id === "necofs" ? 0.08 : 0.15, 10, 0.2], "line-width": 0.5 },
    },
    before,
  );
  // The model's own depth contours, over its cells and under the arrows; 50 m only once the coast is resolved.
  const iso = { "line-color": ink, "line-opacity": 0.45, "line-width": 0.7 };
  map.addLayer({ id: "isobaths", type: "line", source: "isobaths", filter: [">=", ["get", "d"], 100], paint: iso }, before);
  map.addLayer({ id: "isobaths-50", type: "line", source: "isobaths", minzoom: 7, filter: ["==", ["get", "d"], 50], paint: iso }, before);
  map.addLayer(
    {
      id: "arrows",
      type: "symbol",
      source: "arrows",
      layout: {
        "icon-image": "sh-arrow",
        "icon-rotate": ["get", "dir"],
        "icon-rotation-alignment": "map",
        "icon-size": 0.5, // one length for every arrow: the color gives the speed, the arrow only the direction
        "icon-allow-overlap": false,
        "icon-padding": 1,
        "symbol-sort-key": ["get", "lvl"],
      },
      paint: { "icon-color": ARROW[theme()], "icon-opacity": 0.55 },
    },
    before,
  );
  // Above the arrows: symbols on top are placed first, so a label wins its place and the arrows under it give way.
  map.addLayer(
    {
      id: "isobath-labels",
      type: "symbol",
      source: "isobaths",
      minzoom: 6,
      filter: ["any", [">=", ["get", "d"], 100], [">=", ["zoom"], 7]],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 400,
        "text-field": ["concat", ["to-string", ["get", "d"]], " m"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-max-angle": 30,
      },
      paint: { "text-color": ink, "text-opacity": 0.7, "text-halo-color": theme() === "light" ? "#ffffff" : "#1c2a48", "text-halo-width": 1.2 },
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
    bounds: OPEN_BOUNDS,
    fitBoundsOptions: { padding: 4 },
    attributionControl: { compact: true },
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
  map.on("style.load", () => addLayers(p)); // a theme switch drops custom layers: add them back at the current frame
  map.on("move", () => sync(map));
  if (p.id === "necofs") map.on("moveend", () => void updateLod());
  new ResizeObserver(() => map.resize()).observe(box);
}

// ---------- Level of detail ----------

function drawPanel(p: Panel): void {
  p.cap.innerHTML = caption(p);
  if (!p.map) return;
  const cells = p.map.getSource("cells") as maplibregl.GeoJSONSource | undefined;
  const arrows = p.map.getSource("arrows") as maplibregl.GeoJSONSource | undefined;
  if (!cells || !arrows) return; // style still loading: addLayers draws the current frame
  const d = features(p);
  cells.setData(d.cells);
  arrows.setData(d.arrows);
}

function remember(key: string, c: Cells): void {
  tileCache.set(key, c);
  let total = 0;
  for (const v of tileCache.values()) total += v.m;
  for (const [k, v] of tileCache) {
    if (total <= CACHE_CELLS) break;
    if (inViewKeys.includes(k)) continue;
    tileCache.delete(k);
    total -= v.m;
  }
}

let lodRun = 0;
/** After a move: pick NECOFS's level of detail and fetch the tiles in view it lacks (a few at a time). */
async function updateLod(): Promise<void> {
  const p = panels.find((x) => x.id === "necofs");
  const index = p?.model?.tiles;
  const pack = p?.model?.pack;
  if (!p?.map || !index || !pack) return;
  const run = ++lodRun;
  const { keys, count } = p.map.getZoom() >= NATIVE_MIN_ZOOM ? inView(p.map, index) : { keys: [], count: 0 };
  const wasTooMany = tooMany;
  tooMany = keys.length > 0 && count > MAX_NATIVE;
  const next = keys.length && !tooMany ? "native" : "wide";
  const changed = next !== lod || tooMany !== wasTooMany || keys.join() !== inViewKeys.join();
  lod = next;
  inViewKeys = lod === "native" ? keys : [];
  if (changed) drawPanel(p);
  if (lod !== "native") return;
  const missing = keys.filter((k) => !tileCache.has(k));
  let i = 0;
  const worker = async () => {
    while (i < missing.length && run === lodRun) {
      const key = missing[i++];
      const [off, len] = index[key];
      let job = pending.get(key);
      if (!job) {
        job = loadTile(pack, off, len).then((c) => remember(key, c)).finally(() => pending.delete(key));
        pending.set(key, job);
      }
      try {
        await job;
      } catch {
        /* a tile that fails stays averaged; the next move tries again */
      }
    }
  };
  await Promise.all(Array.from({ length: FETCHES }, worker));
  if (run === lodRun) drawPanel(p);
}

// ---------- Frames ----------

function caption(p: Panel): string {
  let sub = "not available";
  if (p.model) {
    const end = Date.parse(p.model.t0) / 1000 + (p.model.steps - 1) * p.model.step;
    if (times[frame] > end) sub = `its forecast ends ${fmtEastern.format(new Date(end * 1000))} Eastern`;
    else if (p.id === "doppio") sub = `${p.grid}, ${nf.format(p.model.cells)} cells`;
    else if (nativeNow(p)) {
      const n = inViewKeys.reduce((s, k) => s + (tileCache.get(k)?.m ?? 0), 0);
      const loading = inViewKeys.some((k) => !tileCache.has(k));
      sub = `${p.grid}, ${nf.format(n)} elements in view${loading ? "; loading" : ""}`;
    } else if (lod === "native") sub = "at DOPPIO resolution; loading native mesh";
    else sub = tooMany ? "at DOPPIO resolution; zoom in further for native mesh" : "at DOPPIO resolution; zoom in for native mesh";
  }
  return `<span class="cap-label">${p.label}</span><span class="cap-sub">${sub}</span>`;
}

function setFrame(i: number): void {
  if (!times.length) return;
  frame = Math.max(0, Math.min(times.length - 1, i));
  ($("slider") as HTMLInputElement).value = String(frame);
  const t = new Date(times[frame] * 1000);
  const ahead = Math.round((times[frame] - Date.now() / 1000) / 3600);
  $("tlabel").innerHTML = `<b>${fmtEastern.format(t)} Eastern</b> (${fmtUtc(t)}, ${ahead === 0 ? "now" : `${ahead > 0 ? "+" : ""}${ahead} h`})`;
  for (const p of panels) drawPanel(p);
}

let timer = 0;
function setPlaying(on: boolean): void {
  window.clearInterval(timer);
  setPlayButton($("play"), on);
  if (on && times.length) timer = window.setInterval(() => setFrame((frame + 1) % times.length), PLAY_MS);
}

// ---------- Page ----------

function legend(): void {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3]; // kt
  $("key").innerHTML =
    `<span>surface current, kt:</span>` + steps.map((v) => `<span><i class="sq" style="background:${speedColor(v / MS_TO_KT)}"></i>${v}</span>`).join("");
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
      /* private mode */
    }
    label();
    legend();
    redraw();
  });
}

const PANELS: [Panel["id"], string, string][] = [
  ["necofs", "NECOFS", "native mesh"],
  ["doppio", "DOPPIO", "native 7 km grid"],
];

function failed(): void {
  const e = $("load-error");
  e.hidden = false;
  e.textContent = "The models load with the next daily update.";
  $("controls").hidden = true;
}

async function main(): Promise<void> {
  wireTheme(() => {
    for (const p of panels) p.map?.setStyle(STYLES[theme()]);
  });
  const about = $("about-dialog") as HTMLDialogElement;
  $("sh-info").addEventListener("click", () => about.showModal());
  $("about-close").addEventListener("click", () => about.close());
  about.addEventListener("click", (e) => e.target === about && about.close()); // a click on the backdrop
  legend();

  let latest: Latest | null = null;
  try {
    const r = await fetch(TILES + "latest.json", { cache: "no-cache" });
    if (r.ok) latest = (await r.json()) as Latest;
  } catch {
    /* shown below */
  }
  const isos = await Promise.all(
    PANELS.map(async ([id]) => {
      try {
        const r = await fetch(`${TILES}isobaths-${id}.json`);
        return r.ok ? ((await r.json()) as FeatureCollection) : null;
      } catch {
        return null; // the currents still draw without the contours
      }
    }),
  );
  const wides = await Promise.all(
    PANELS.map(async ([id]) => {
      const m = latest?.models[id];
      try {
        return m ? await loadWhole(m.wide) : null;
      } catch {
        return null;
      }
    }),
  );
  // The frames: the longer forecast's 2-hourly steps (both start at the window's first hour).
  const models = PANELS.map(([id], i) => (wides[i] ? latest?.models[id] ?? null : null));
  const longest = models.filter((m): m is Model => !!m).sort((a, b) => b.steps - a.steps)[0];
  if (longest) times = Array.from({ length: longest.steps }, (_, k) => Date.parse(longest.t0) / 1000 + k * longest.step);
  if (!times.length) failed();
  else {
    const slider = $("slider") as HTMLInputElement;
    slider.max = String(times.length - 1);
    timeTrack(slider, (v) => times[Math.round(v)]);
    slider.addEventListener("input", () => {
      setPlaying(false);
      setFrame(Number(slider.value));
    });
    $("play").addEventListener("click", () => setPlaying($("play").getAttribute("aria-pressed") !== "true"));
    setPlaying(false);
  }

  const gl = webglOk();
  const host = $("panels");
  PANELS.forEach(([id, label, grid], i) => {
    const f = document.createElement("figure");
    f.className = "mg-panel";
    const cap = document.createElement("figcaption");
    const box = document.createElement("div");
    box.className = "mg-map sh-map";
    box.dataset.model = id;
    f.append(cap, box);
    host.append(f);
    const p: Panel = { id, label, grid, model: models[i], wide: wides[i], iso: isos[i], box, cap, map: null };
    panels.push(p);
    cap.innerHTML = caption(p);
    if (!gl) {
      box.innerHTML = `<p class="mg-fallback">This map needs WebGL, which this browser has turned off.</p>`;
      return;
    }
    makeMap(p);
  });
  // Open on the frame nearest now.
  const now = Date.now() / 1000;
  setFrame(times.reduce((best, t, k) => (Math.abs(t - now) < Math.abs(times[best] - now) ? k : best), 0));

  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__shMaps = panels.map((p) => p.map).filter((m): m is maplibregl.Map => !!m);
    w.__shFrame = () => frame;
    w.__shCaptions = () => panels.map((p) => p.cap.textContent ?? "");
    w.__shCounts = () => panels.map((p) => features(p).cells.features.length);
    w.__shLod = () => ({ lod, tooMany, inView: inViewKeys.length, cached: tileCache.size });
  }
}

void main();
