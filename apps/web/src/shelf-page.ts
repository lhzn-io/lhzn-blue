/**
 * "Ocean models compared" (/northeast-shelf/ocean-models/): two regional ocean models' currents side by side, each on its
 * own cells, from Cape Hatteras to Nova Scotia: NECOFS (FVCOM, an unstructured triangle mesh, UMass Dartmouth)
 * and DOPPIO (ROMS, a 7 km curvilinear grid, Rutgers for MARACOOS). Each panel is a small MapLibre map, as on the
 * wind models page: the cells as a translucent fill colored by speed, thin cell outlines, and a light arrow per cell
 * for the direction only (MapLibre's symbol collision thins them, the coarse lattice first). One slider steps both
 * through the same frames; pan or zoom one map and the other follows.
 *
 * Period: the latest daily run (2-hourly, 24 hours back to 72 ahead), or a span of archived UTC days (hourly), each
 * day its own files. A period is a list of sources (the run, or one per day) and the frames point into them. The
 * address bar holds the period, the hour and the map's box (?from=&to=&t=&bbox=), so a link reopens the same view.
 *
 * Level of detail: DOPPIO's whole grid (about 19,500 cells) is one file, drawn at every zoom. NECOFS's 265,000 cells
 * are cut into tiles; at a wide view, where they are smaller than a pixel, the page draws NECOFS averaged into
 * DOPPIO's cells (labeled so), and once zoomed in it fetches only the tiles in view, by HTTP range from one pack.
 *
 * Data: the tile store (jobs: shelf.py, tiles.py), served from its own host. latest.json names the current files and
 * indexes the NECOFS tiles; days.json lists the archived days, each with its own index.json. Each blob is gzip of
 * "LHZT", a uint32 header length, a JSON header, float32 node lon, lat pairs, the element node indices (uint16 or
 * uint32), a uint8 arrow level per element, then per step one int8 per element east and one north, in step_cms cm/s.
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
const MAX_DAYS = 7; // archived days shown at once
const DAY_MS = 86_400_000;
const theme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// ---------- Data ----------

type Id = "necofs" | "doppio";
/** Hours `from` to `to` (inclusive) of a model came from `url`: from a run (DOPPIO's best time series), or a file
 * written at `written` (NECOFS, on the server's clock); `product` and `title` name the source. */
interface Prov {
  from: string;
  to: string;
  url: string;
  product?: string;
  title?: string;
  run?: string;
  written?: string;
}
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
  depths?: Record<string, Partial<Model>>; // the same model at a fixed depth (m): its own files and counts
  ts?: { wide: string; pack?: string; tiles?: Record<string, [number, number, number]> }; // temperature and salinity
  prov?: Prov[]; // the source of each hour (jobs: shelf.py, doppio_prov and necofs_prov)
}
type Models = Partial<Record<Id, Model>>;
interface Latest {
  generated_at: string;
  base_zoom: number;
  models: Models;
}
interface DayIndex {
  day: string;
  complete: boolean;
  models: Models;
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
/** The files behind some of the frames: the latest run, or one archived day. */
interface Source {
  key: string;
  models: Models;
  wide: Record<string, Cells | null>; // "<model>@<depth>"
  loading: Record<number, Promise<void>>; // by depth
  vals: Record<string, Vals | null>; // temperature and salinity for the wide files, "<model>@<depth>"
  vloading: Record<number, Promise<void>>;
}
/** A value blob: scalar fields for the elements of the currents blob with the same key, in its order. */
interface Vals {
  m: number;
  steps: number;
  f: Record<string, { q: Uint8Array; offset: number; scale: number }>; // q: per step, m values; 255 is none
  s: Record<string, { q: Uint16Array; offset: number; scale: number }>; // static: one per element (the model's depth); 65535 is none
}
type Frame = { t: number; s: number }; // epoch seconds, and the source that holds it

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

function parseValues(raw: Uint8Array): Vals {
  if (String.fromCharCode(...raw.subarray(0, 4)) !== "LHZS") throw new Error("not a value blob");
  const n = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  type Meta = { name: string; offset: number; scale: number };
  const h = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + n))) as { elements: number; steps: number; fields: Meta[]; static?: Meta[] };
  let off = raw.byteOffset + 8 + n;
  const size = h.elements * h.steps;
  const f: Vals["f"] = {};
  for (const x of h.fields) {
    f[x.name] = { q: new Uint8Array(raw.buffer.slice(off, off + size)), offset: x.offset, scale: x.scale };
    off += size;
  }
  const s: Vals["s"] = {};
  for (const x of h.static ?? []) {
    // uint16, little-endian as written; a copy, aligned for the typed array (every browser in use is little-endian)
    s[x.name] = { q: new Uint16Array(raw.buffer.slice(off, off + 2 * h.elements)), offset: x.offset, scale: x.scale };
    off += 2 * h.elements;
  }
  return { m: h.elements, steps: h.steps, f, s };
}

async function loadWholeValues(path: string): Promise<Vals> {
  const r = await fetch(TILES + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return parseValues(await gunzip(await r.arrayBuffer()));
}

async function loadRange(pack: string, off: number, len: number): Promise<Uint8Array> {
  const r = await fetch(TILES + pack, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!r.ok) throw new Error(`tile: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  if (r.status === 200) buf = buf.slice(off, off + len); // a server that ignored the range sent the whole pack
  return gunzip(buf);
}

async function loadWhole(path: string): Promise<Cells> {
  const r = await fetch(TILES + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return parse(await gunzip(await r.arrayBuffer()));
}

async function loadTile(pack: string, off: number, len: number): Promise<Cells> {
  return parse(await loadRange(pack, off, len));
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(TILES + path, init);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const DEPTHS = [0, 10, 25, 50, 100, 200, 500]; // m below the surface; 0 is the top layer
let depth = 0;
type Field = "currents" | "temp" | "salt";
const FIELDS: Field[] = ["currents", "temp", "salt"];
let field: Field = "currents";
const FIELD_NAME: Record<Field, string> = { currents: "current", temp: "temperature", salt: "salinity" };
const wideKey = (id: Id) => `${id}@${depth}`;

/** A source's model at the chosen depth: the surface entry, or its depth entry over it (none if not made). */
function modelAt(src: Source | null, id: Id): Model | undefined {
  const m = src?.models[id];
  if (!m || depth === 0) return m;
  const e = m.depths?.[String(depth)];
  return e ? ({ ...m, ...e, ts: e.ts } as Model) : undefined; // never the surface's values at a depth
}

/** A source's values for its wide files at the chosen depth (temperature, salinity, each model's depth), fetched once. */
function ensureVals(src: Source): Promise<void> {
  const d = depth;
  src.vloading[d] ??= Promise.all(
    (["necofs", "doppio"] as Id[]).map(async (id) => {
      const w = modelAt(src, id)?.ts?.wide;
      const key = `${id}@${d}`;
      try {
        src.vals[key] = w ? await loadWholeValues(w) : null;
      } catch {
        src.vals[key] = null;
      }
    }),
  ).then(() => undefined);
  return src.vloading[d];
}

/** A source's two whole files at the chosen depth (DOPPIO's grid, NECOFS's averaged view), fetched once. */
function ensureWide(src: Source): Promise<void> {
  const d = depth;
  src.loading[d] ??= Promise.all(
    (["necofs", "doppio"] as Id[]).map(async (id) => {
      const m = modelAt(src, id);
      const key = `${id}@${d}`;
      try {
        src.wide[key] = m ? await loadWhole(m.wide) : null;
      } catch {
        src.wide[key] = null;
      }
    }),
  ).then(() => undefined);
  return src.loading[d];
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

/** Temperature and salinity on fixed scales: colors after cmocean's thermal and haline (Thyng et al. 2016). */
const SCALAR_RAMPS = {
  temp: { lo: 0, hi: 30, stops: ["#042333", "#2c3395", "#744992", "#b15f82", "#eb7655", "#fbb43d", "#e8fa5b"] },
  salt: { lo: 29, hi: 37, stops: ["#2a186c", "#14439c", "#206e8b", "#3c9387", "#5ab978", "#aad85c", "#fdef9a"] },
};
function scalarColor(f: "temp" | "salt", x: number): string {
  const r = SCALAR_RAMPS[f];
  const t = Math.max(0, Math.min(1, (x - r.lo) / (r.hi - r.lo))) * (r.stops.length - 1);
  const k = Math.min(r.stops.length - 2, Math.floor(t));
  return mix(r.stops[k], r.stops[k + 1], t - k);
}

// ---------- Formatting ----------

const fmtEastern = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric" });
const fmtEasternYear = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric" });
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const fmtUtcDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtEasternHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric" });
const fmtDayShort = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const fmtUtc = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")} UTC`;
const eastern = (d: Date) => (d.getUTCFullYear() === new Date().getUTCFullYear() ? fmtEastern : fmtEasternYear).format(d);
const nf = new Intl.NumberFormat("en-US");
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "Aug 11 to 13, 2022", "Nov 30 to Dec 2, 2026", "Aug 11, 2022". */
function dayRange(a: string, b: string): string {
  const [x, y] = [new Date(dayMs(a)), new Date(dayMs(b))];
  if (a === b) return fmtDay.format(x);
  if (x.getUTCFullYear() !== y.getUTCFullYear()) return `${fmtDay.format(x)} to ${fmtDay.format(y)}`;
  const end = x.getUTCMonth() === y.getUTCMonth() ? String(y.getUTCDate()) : fmtDayShort.format(y);
  return `${fmtDayShort.format(x)} to ${end}, ${y.getUTCFullYear()}`;
}

// ---------- State ----------

interface Panel {
  id: Id;
  label: string;
  unit: string; // what its cells are called in the caption
  iso: FeatureCollection | null; // the model's own depth contours
  box: HTMLElement;
  cap: HTMLElement;
  map: maplibregl.Map | null;
  popup: maplibregl.Popup | null; // the cell's values at the reader's point
}
type Period = { kind: "forecast" } | { kind: "days"; from: string; to: string };
/** What each map draws, the same on both: the currents (cells by speed, arrows), the cell outlines, the depth lines. */
type Layer = "color" | "arrows" | "grid" | "depth" | "names" | "mpa";
const LAYERS: Layer[] = ["color", "arrows", "grid", "depth", "names", "mpa"];
const DEFAULT_LAYERS: Layer[] = ["color", "arrows", "grid", "depth"]; // undersea names and protected areas are off until asked for
const LAYER_IDS: Record<Layer, string[]> = {
  color: ["cells"],
  arrows: ["arrows"],
  grid: ["cell-lines"],
  depth: ["isobaths", "isobaths-50", "isobath-labels"],
  names: ["names"],
  mpa: ["mpa-hit", "mpa-line", "mpa-label"],
};
/** The overlays' static files (scripts/fetch-marine-names.py), fetched the first time each is shown. */
type Overlay = "names" | "mpa";
const OVERLAY_URL: Record<Overlay, string> = { names: "/northeast-shelf/names.geojson", mpa: "/northeast-shelf/mpa.geojson" };
const overlay: Record<Overlay, FeatureCollection | null> = { names: null, mpa: null };
const overlayLoading = new Set<Overlay>();

const panels: Panel[] = [];
let period: Period = { kind: "forecast" };
let sources: Source[] = [];
let frames: Frame[] = [];
let frame = 0;
let latest: Latest | null = null;
let archived: Record<string, boolean> = {}; // day -> complete
let syncing = false;
let viewReady = false; // the opening view is set: moves from here on are the reader's
let shownBox: string | null = null; // the map's box for the address bar: the link's own until the reader moves
// The arrow level of a wide-view piece that draws none: the part of a DOPPIO cell left outside NECOFS's large triangles.
const NO_ARROW = 255;
// NECOFS's level of detail: "wide" (averaged into DOPPIO's cells) or "native" (its own cells, the tiles in view).
let lod: "wide" | "native" = "wide";
let tooMany = false; // zoomed in, but more NECOFS cells in view than the page draws at once
let inViewKeys: string[] = [];
let doppioInView = -1;
let shown = new Set<Layer>(DEFAULT_LAYERS);
const tileCache = new Map<string, Cells>(); // "<source>|<depth>|<tile>"
const valCache = new Map<string, Vals>(); // the same keys, for temperature and salinity
const pending = new Map<string, Promise<void>>();

const cur = (): Source | null => (frames.length && frame >= 0 ? sources[frames[frame].s] : null);
const tileKey = (src: Source, key: string) => `${src.key}|${depth}|${key}`;

/** The blobs a panel draws now, each with its temperature and salinity when they are loaded. */
function drawn(p: Panel): { c: Cells; v: Vals | null }[] {
  const src = cur();
  if (!src) return [];
  const wide = src.wide[wideKey(p.id)];
  const whole = wide ? [{ c: wide, v: src.vals[wideKey(p.id)] ?? null }] : [];
  if (p.id === "doppio" || lod === "wide") return whole;
  const loaded = inViewKeys
    .map((k) => ({ c: tileCache.get(tileKey(src, k)), v: valCache.get(tileKey(src, k)) ?? null }))
    .filter((x): x is { c: Cells; v: Vals | null } => !!x.c);
  return loaded.length ? loaded : whole;
}
const nativeNow = (p: Panel) => {
  const src = cur();
  return !!src && p.id === "necofs" && lod === "native" && inViewKeys.some((k) => tileCache.has(tileKey(src, k)));
};

/** The panel's step at the current frame, or -1 where its model has none. */
function stepOf(p: Panel): number {
  const m = modelAt(cur(), p.id);
  if (!m) return -1;
  const j = Math.round((frames[frame].t - Date.parse(m.t0) / 1000) / m.step);
  return j >= 0 && j < m.steps ? j : -1;
}

/** The panel's cells and arrows at the current frame (empty where its model does not reach). */
function features(p: Panel): { cells: FeatureCollection; arrows: FeatureCollection } {
  const j = stepOf(p);
  if (j < 0) return { cells: EMPTY, arrows: EMPTY };
  const cells: Feature[] = [];
  const arrows: Feature[] = [];
  for (const [b, { c, v: vals }] of drawn(p).entries()) {
    if (j >= c.steps) continue;
    const vf = field !== "currents" && vals && vals.m === c.m && j < vals.steps ? vals.f[field] : undefined;
    if (field !== "currents" && !vf) continue; // no values for this blob (yet): nothing drawn rather than currents
    const base = j * 2 * c.m;
    for (let i = 0; i < c.m; i++) {
      let x: number | null = null;
      if (vf) {
        const q = vf.q[j * c.m + i];
        if (q === 255) continue;
        x = vf.offset + q * vf.scale;
      }
      const u = c.q[base + i] * c.k;
      const v = c.q[base + c.m + i] * c.k;
      const ms = Math.hypot(u, v) / 100;
      const ring: [number, number][] = [];
      for (let t = 0; t < c.verts; t++) {
        const nd = c.elems[i * c.verts + t];
        ring.push([c.nodes[2 * nd], c.nodes[2 * nd + 1]]);
      }
      ring.push(ring[0]);
      const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
      const color = x === null ? speedColor(ms) : scalarColor(field as "temp" | "salt", x);
      // b and i find the cell's blob and element again for the readout (its centroid and the model's depth).
      cells.push({ type: "Feature", properties: { c: color, s: ms, d: dir, x, b, i }, geometry: { type: "Polygon", coordinates: [ring] } });
      if (ms >= 0.03 && c.levels[i] !== NO_ARROW)
        arrows.push({
          type: "Feature",
          properties: { dir, lvl: c.levels[i] },
          geometry: { type: "Point", coordinates: [c.cx[i], c.cy[i]] },
        });
    }
  }
  return { cells: { type: "FeatureCollection", features: cells }, arrows: { type: "FeatureCollection", features: arrows } };
}

// ---------- Address bar ----------

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "2022-08-12T14Z": an hour, UTC. */
const hourParam = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.toISOString().slice(0, 10)}T${pad2(d.getUTCHours())}Z`;
};
function readHour(s: string | null): number | null {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2})(?::00)?Z?$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${pad2(Number(m[2]))}:00:00Z`);
  return Number.isFinite(t) ? t / 1000 : null;
}
const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayMs(s));

interface Wanted {
  period: Period | null;
  t: number | null;
  bbox: [number, number, number, number] | null;
  layers: Set<Layer> | null;
  depth: number;
  field: Field;
}
function readUrl(): Wanted {
  const q = new URLSearchParams(location.search);
  const from = q.get("from");
  const to = q.get("to") ?? from;
  const t = readHour(q.get("t"));
  const b = q.get("bbox")?.split(",").map(Number);
  const bbox = b?.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3] ? (b as [number, number, number, number]) : null;
  const days = isDay(from) && isDay(to) && dayMs(to) >= dayMs(from);
  const ls = q.get("layers");
  const layers = ls === null ? null : new Set(ls.split(",").filter((x): x is Layer => (LAYERS as string[]).includes(x)));
  const dq = Number(q.get("depth"));
  const fq = q.get("field") as Field | null;
  return { period: days ? { kind: "days", from, to } : null, t, bbox, layers, depth: DEPTHS.includes(dq) ? dq : 0, field: fq && FIELDS.includes(fq) ? fq : "currents" };
}

let userTime = false; // the reader chose the hour: it goes to the address bar
function writeUrl(): void {
  const q = new URLSearchParams();
  if (period.kind === "days") {
    q.set("from", period.from);
    if (period.to !== period.from) q.set("to", period.to);
  }
  if (userTime && frames.length) q.set("t", hourParam(frames[frame].t));
  if (shownBox) q.set("bbox", shownBox);
  const asDefault = shown.size === DEFAULT_LAYERS.length && DEFAULT_LAYERS.every((l) => shown.has(l));
  if (!asDefault) q.set("layers", LAYERS.filter((l) => shown.has(l)).join(","));
  if (depth) q.set("depth", String(depth));
  if (field !== "currents") q.set("field", field);
  const s = q.toString().replace(/%2C/g, ",");
  const url = `${location.pathname}${s ? `?${s}` : ""}${location.hash}`;
  if (url !== location.pathname + location.search + location.hash) history.replaceState(null, "", url);
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
  map.addSource("names", { type: "geojson", data: overlay.names ?? EMPTY });
  map.addSource("mpa", { type: "geojson", data: overlay.mpa ?? EMPTY, tolerance: 0.5 });
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
  // Protected areas: a dashed outline over the cells and under the arrows, and an invisible fill for the readout.
  map.addLayer({ id: "mpa-hit", type: "fill", source: "mpa", paint: { "fill-color": ink, "fill-opacity": 0 } }, before);
  map.addLayer(
    { id: "mpa-line", type: "line", source: "mpa", paint: { "line-color": ink, "line-opacity": 0.7, "line-width": 1, "line-dasharray": [3, 2] } },
    before,
  );
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
  // Protected-area names: the large sites from the opening view, the rest as the map closes in.
  map.addLayer(
    {
      id: "mpa-label",
      type: "symbol",
      source: "mpa",
      filter: ["any", [">=", ["get", "km2"], 1000], ["all", [">=", ["get", "km2"], 50], [">=", ["zoom"], 8]], [">=", ["zoom"], 10]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10.5,
        "text-max-width": 9,
        "text-padding": 4,
        "symbol-sort-key": ["-", 0, ["get", "km2"]],
      },
      paint: { "text-color": ink, "text-opacity": 0.8, "text-halo-color": theme() === "light" ? "#ffffff" : "#1c2a48", "text-halo-width": 1.4 },
    },
    before,
  );
  // Undersea feature names, in italic as charts set them; on top, so they win their place over the depth labels.
  map.addLayer(
    {
      id: "names",
      type: "symbol",
      source: "names",
      filter: ["any", ["==", ["get", "rank"], 1], ["all", ["==", ["get", "rank"], 2], [">=", ["zoom"], 6.5]], [">=", ["zoom"], 8.5]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"],
        "text-size": ["match", ["get", "rank"], 1, 13, 2, 11.5, 10.5],
        "text-max-width": 8,
        "text-padding": 3,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: { "text-color": ink, "text-halo-color": theme() === "light" ? "#ffffff" : "#1c2a48", "text-halo-width": 1.4 },
    },
    before,
  );
  applyLayers(map);
}

/** An overlay's file, once: both maps get it as soon as it arrives. */
async function loadOverlay(o: Overlay): Promise<void> {
  if (overlay[o] || overlayLoading.has(o)) return;
  overlayLoading.add(o);
  try {
    const r = await fetch(OVERLAY_URL[o]);
    if (!r.ok) throw new Error(`${r.status}`);
    overlay[o] = (await r.json()) as FeatureCollection;
    for (const p of panels) (p.map?.getSource(o) as maplibregl.GeoJSONSource | undefined)?.setData(overlay[o]!);
  } catch (e) {
    console.warn(`overlay ${o}:`, e);
  } finally {
    overlayLoading.delete(o);
  }
}

function applyLayers(map: maplibregl.Map): void {
  for (const o of ["names", "mpa"] as const) if (shown.has(o)) void loadOverlay(o);
  for (const l of LAYERS)
    for (const id of LAYER_IDS[l]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", shown.has(l) ? "visible" : "none");
}

/** The field menu: currents, temperature or salinity, from the same depth and hour. */
function wireField(): void {
  const sel = $("field") as HTMLSelectElement;
  sel.value = field;
  sel.addEventListener("change", async () => {
    field = sel.value as Field;
    legend();
    writeUrl();
    if (!frames.length) return;
    const k = frame;
    frame = -1;
    inViewKeys = [];
    await setFrame(k);
  });
}

/** The depth menu: redraw both maps from that depth's files, at the same hour and view. */
function wireDepth(): void {
  const sel = $("depth") as HTMLSelectElement;
  sel.value = String(depth);
  sel.addEventListener("change", async () => {
    depth = Number(sel.value);
    legend();
    writeUrl();
    if (!frames.length) return;
    const k = frame;
    frame = -1; // no current source: setFrame refreshes the level of detail and the counts
    inViewKeys = [];
    await setFrame(k);
  });
}

function wireLayers(): void {
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#layers input[type=checkbox]")];
  const show = () => {
    for (const b of boxes) b.checked = shown.has(b.value as Layer);
    $("key").classList.toggle("sh-off", !shown.has("color")); // the key, faint while the colors are off
  };
  show();
  for (const b of boxes)
    b.addEventListener("change", () => {
      if (b.checked) shown.add(b.value as Layer);
      else shown.delete(b.value as Layer);
      show();
      for (const p of panels) if (p.map) applyLayers(p.map);
      if (valuesAt) showValues(valuesAt);
      writeUrl();
    });
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

function makeMap(p: Panel, bounds: [number, number, number, number]): void {
  const box = p.box;
  const map = new maplibregl.Map({
    container: box,
    style: STYLES[theme()],
    bounds,
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
  if (window.matchMedia("(hover: hover)").matches) {
    map.on("mousemove", (e) => showValues(e.lngLat));
    map.getCanvas().addEventListener("mouseleave", hideValues);
  } else map.on("click", (e) => showValues(e.lngLat));
  if (p.id === "necofs") {
    map.on("moveend", () => {
      void updateLod();
      countDoppio();
      if (!viewReady) return;
      const b = map.getBounds();
      shownBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(3)).join(",");
      writeUrl();
    });
    map.once("idle", () => {
      viewReady = true;
      countDoppio();
      void updateLod(); // a link may open zoomed in
    });
  }
  new ResizeObserver(() => map.resize()).observe(box);
}

// ---------- Level of detail ----------

// ---------- Values at a point ----------

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
let valuesAt: maplibregl.LngLat | null = null;

/** The cell under one point, on both maps: speed and the direction it flows toward, from the drawn cells. */
function showValues(at: maplibregl.LngLat): void {
  valuesAt = at;
  if (!shown.has("color")) return hideValues();
  const where = depth ? `at ${depth} m` : "surface";
  for (const p of panels) {
    const map = p.map;
    if (!map?.getLayer("cells")) continue;
    const f = map.queryRenderedFeatures(map.project(at), { layers: ["cells"] })[0];
    let body: string;
    if (f) {
      const ms = Number(f.properties.s);
      const d = Number(f.properties.d);
      const avg = p.id === "necofs" && !nativeNow(p) ? "; averaged to DOPPIO cell" : "";
      const x = f.properties.x === null || f.properties.x === undefined ? null : Number(f.properties.x);
      const flow = `${(ms * MS_TO_KT).toFixed(2)} kt (${ms.toFixed(2)} m/s) toward ${Math.round(d)}&deg; ${COMPASS[Math.round(d / 22.5) % 16]}`;
      const head = x === null ? "" : field === "temp" ? `<b>${x.toFixed(1)} &deg;C</b><br>` : `<b>salinity ${x.toFixed(2)}</b><br>`;
      body = x === null ? `<b>${flow.replace(" kt", " kt</b>")}<br>${where}${avg}` : `${head}${flow}, ${where}${avg}`;
      body += `<br>${cellPlace(p, Number(f.properties.b), Number(f.properties.i))}${provenance(p)}`;
    } else body = stepOf(p) < 0 ? "no data for this hour" : `no cell here ${where}`;
    body += overlayAt(map, at);
    p.popup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "pin-pop hover-pop sh-val", offset: 12, maxWidth: "none" });
    p.popup.setLngLat(at).setHTML(`<span class="sh-val-model">${p.label}</span> ${body}`).addTo(map);
  }
}

const fmtStamp = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const stamp = (ms: number) => `${fmtStamp.format(new Date(ms))} UTC`;

/** The model hour drawn (an instant of the output) and the run behind it with its lead, or when the file was written. */
function provenance(p: Panel): string {
  const m = modelAt(cur(), p.id);
  const j = stepOf(p);
  if (!m || j < 0) return "";
  const t = Date.parse(m.t0) + j * m.step * 1000;
  const seg = m.prov?.find((s) => Date.parse(s.from) <= t && t <= Date.parse(s.to));
  let src = "";
  if (seg?.run) {
    const lead = Math.round((t - Date.parse(seg.run)) / 3_600_000);
    src = ` &middot; run ${stamp(Date.parse(seg.run))}, ${lead >= 0 ? "+" : ""}${lead} h`;
  } else if (seg?.written) {
    src = ` &middot; file written ${esc(fmtStamp.format(new Date(`${seg.written}Z`)))} server time`;
  }
  return `<br><span class="sh-val-prov">${stamp(t)}, instant${src}</span>`;
}

const esc = (t: unknown) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const NAME_SOURCE: Record<string, string> = { ACUF: "US BGN ACUF", CGNDB: "Canadian Geographical Names Database", GEBCO: "GEBCO Gazetteer" };

/** Readout lines for the overlays under a point: a named feature's label, and the protected areas it lies in. */
function overlayAt(map: maplibregl.Map, at: maplibregl.LngLat): string {
  let out = "";
  const pt = map.project(at);
  if (shown.has("names") && map.getLayer("names")) {
    const n = map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: ["names"] })[0];
    if (n) out += `<br><i>${esc(n.properties.name)}</i>: ${esc(String(n.properties.kind).toLowerCase())}, name from ${esc(NAME_SOURCE[n.properties.src] ?? n.properties.src)}`;
  }
  if (shown.has("mpa") && map.getLayer("mpa-hit")) {
    const seen = new Set<string>();
    for (const a of map.queryRenderedFeatures(pt, { layers: ["mpa-hit"] })) {
      const name = String(a.properties.name);
      if (seen.has(name)) continue;
      seen.add(name);
      out += `<br>In ${esc(name)}${a.properties.agency ? ` (${esc(a.properties.agency)})` : ""}`;
    }
  }
  return out;
}

/** A cell's centroid and the model's own depth there (the bottom of its water column), for the readout. */
function cellPlace(p: Panel, b: number, i: number): string {
  const blob = drawn(p)[b];
  if (!blob || !(i < blob.c.m)) return "";
  const lat = blob.c.cy[i];
  const lon = blob.c.cx[i];
  const at = `${Math.abs(lat).toFixed(3)}&deg; ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(3)}&deg; ${lon >= 0 ? "E" : "W"}`;
  const H = blob.v && blob.v.m === blob.c.m ? blob.v.s?.h : undefined;
  const q = H ? H.q[i] : 65535;
  if (q === 65535) return at;
  const m = H!.offset + q * H!.scale;
  const avg = p.id === "necofs" && !nativeNow(p) ? ", averaged" : "";
  return `${at} &middot; model depth ${m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString("en-US")} m${avg}`;
}

function hideValues(): void {
  valuesAt = null;
  for (const p of panels) p.popup?.remove();
}

/** After a redraw: the values at the same point, once the new cells are on the map. */
function refreshValues(p: Panel): void {
  const at = valuesAt;
  if (at && p.map) p.map.once("idle", () => valuesAt === at && showValues(at));
}

function drawPanel(p: Panel): void {
  p.cap.innerHTML = caption(p);
  if (!p.map) return;
  const cells = p.map.getSource("cells") as maplibregl.GeoJSONSource | undefined;
  const arrows = p.map.getSource("arrows") as maplibregl.GeoJSONSource | undefined;
  if (!cells || !arrows) return; // style still loading: addLayers draws the current frame
  const d = features(p);
  cells.setData(d.cells);
  arrows.setData(d.arrows);
  refreshValues(p);
}

function remember(key: string, c: Cells): void {
  tileCache.set(key, c);
  let total = 0;
  for (const v of tileCache.values()) total += v.m;
  const src = cur();
  const keep = new Set(src ? inViewKeys.map((k) => tileKey(src, k)) : []);
  for (const [k, v] of tileCache) {
    if (total <= CACHE_CELLS) break;
    if (keep.has(k)) continue;
    tileCache.delete(k);
    total -= v.m;
  }
}

/** DOPPIO's cells whose centers are in view, for its caption. */
function countDoppio(): void {
  const p = panels.find((x) => x.id === "doppio");
  const c = cur()?.wide[wideKey("doppio")];
  if (!p?.map || !c) return;
  const b = p.map.getBounds();
  const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  let k = 0;
  for (let i = 0; i < c.m; i++) if (c.cx[i] >= w && c.cx[i] <= e && c.cy[i] >= s && c.cy[i] <= n) k++;
  if (k !== doppioInView) {
    doppioInView = k;
    p.cap.innerHTML = caption(p);
  }
}

let lodRun = 0;
/** After a move or a change of source: pick NECOFS's level of detail and fetch the tiles in view it lacks. */
async function updateLod(): Promise<void> {
  const p = panels.find((x) => x.id === "necofs");
  const src = cur();
  const index = modelAt(src, "necofs")?.tiles;
  const pack = modelAt(src, "necofs")?.pack;
  if (!p?.map || !src || !index || !pack) return;
  const run = ++lodRun;
  const { keys, count } = p.map.getZoom() >= NATIVE_MIN_ZOOM ? inView(p.map, index) : { keys: [], count: 0 };
  tooMany = keys.length > 0 && count > MAX_NATIVE;
  const next = keys.length && !tooMany ? "native" : "wide";
  lod = next;
  inViewKeys = lod === "native" ? keys : [];
  drawPanel(p); // cheap next to a move, and a change of source always needs it
  if (lod !== "native") return;
  const missing = keys.filter((k) => !tileCache.has(tileKey(src, k)));
  if (!missing.length) return loadValueTiles(p, src, keys, run);
  let i = 0;
  const worker = async () => {
    while (i < missing.length && run === lodRun) {
      const key = missing[i++];
      const ck = tileKey(src, key);
      const [off, len] = index[key];
      let job = pending.get(ck);
      if (!job) {
        job = loadTile(pack, off, len).then((c) => remember(ck, c)).finally(() => pending.delete(ck));
        pending.set(ck, job);
      }
      try {
        await job;
      } catch {
        /* a tile that fails stays averaged; the next move tries again */
      }
    }
  };
  await Promise.all(Array.from({ length: FETCHES }, worker));
  if (run === lodRun && cur() === src) drawPanel(p);
  await loadValueTiles(p, src, keys, run);
}

/** The values for the NECOFS tiles in view: the field shown, or, for currents, the model's depth in the readouts. */
async function loadValueTiles(p: Panel, src: Source, keys: string[], run: number): Promise<void> {
  const ts = modelAt(src, "necofs")?.ts;
  if (!ts?.pack || !ts.tiles) return;
  const missing = keys.filter((k) => ts.tiles![k] && !valCache.has(tileKey(src, k)));
  let i = 0;
  const worker = async () => {
    while (i < missing.length && run === lodRun) {
      const key = missing[i++];
      const [off, len] = ts.tiles![key];
      try {
        valCache.set(tileKey(src, key), parseValues(await loadRange(ts.pack!, off, len)));
      } catch {
        /* drawn without colors there; the next move tries again */
      }
    }
  };
  await Promise.all(Array.from({ length: FETCHES }, worker));
  if (run === lodRun && cur() === src) drawPanel(p);
}

// ---------- Frames ----------

/** One phrase per panel, the same shape for both: its cells and how many are in view, or why there are none. */
function caption(p: Panel): string {
  const src = cur();
  const m = modelAt(src, p.id);
  let sub: string;
  if (!src) sub = "no data";
  else if (!m) sub = depth ? `no data at ${depth} m for this ${period.kind === "days" ? "day" : "run"}` : "no data for this period";
  else if (field !== "currents" && !m.ts) sub = `no ${FIELD_NAME[field]} for this ${period.kind === "days" ? "day" : "run"}${depth ? ` at ${depth} m` : ""}`;
  else if (stepOf(p) < 0) {
    const end = Date.parse(m.t0) / 1000 + (m.steps - 1) * m.step;
    sub = period.kind === "forecast" && frames[frame].t > end ? `forecast ends ${eastern(new Date(end * 1000))}` : "no data for this hour";
  } else if (p.id === "doppio") sub = `${p.unit}, ${nf.format(doppioInView >= 0 ? doppioInView : m.cells)} in view`;
  else if (nativeNow(p)) {
    const n = inViewKeys.reduce((s, k) => s + (tileCache.get(tileKey(src, k))?.m ?? 0), 0);
    const loading = inViewKeys.some((k) => !tileCache.has(tileKey(src, k)));
    sub = `${p.unit}, ${nf.format(n)} in view${loading ? "; loading" : ""}`;
  } else if (lod === "native") sub = "averaged to DOPPIO cells; loading triangles";
  else sub = `averaged to DOPPIO cells; zoom in${tooMany ? " further" : ""} for triangles`;
  return `<span class="cap-label">${p.label}</span><span class="cap-sub">${sub}</span>`;
}

/** The forecast in Eastern time with the hours from now; archived days, which are UTC days, in UTC first. */
function timeLabel(): void {
  const t = new Date(frames[frame].t * 1000);
  if (period.kind === "days") {
    $("tlabel").innerHTML = `<b>${fmtUtcDay.format(t)}, ${fmtUtc(t)}</b> (${fmtEasternHour.format(t)} Eastern)`;
    return;
  }
  const ahead = Math.round((frames[frame].t - Date.now() / 1000) / 3600);
  $("tlabel").innerHTML = `<b>${eastern(t)} Eastern</b> (${fmtUtc(t)}, ${ahead === 0 ? "now" : `${ahead > 0 ? "+" : ""}${ahead} h`})`;
}

let frameRun = 0;
async function setFrame(i: number): Promise<void> {
  if (!frames.length) return;
  const before = cur();
  frame = Math.max(0, Math.min(frames.length - 1, i));
  ($("slider") as HTMLInputElement).value = String(frame);
  ($("step-back") as HTMLButtonElement).disabled = frame === 0;
  ($("step-fwd") as HTMLButtonElement).disabled = frame === frames.length - 1;
  timeLabel();
  const src = cur()!;
  const run = ++frameRun;
  await ensureWide(src);
  // Values hold the field drawn, so wait for them; for currents they hold only the readouts' depth, so not.
  if (field !== "currents") await ensureVals(src);
  else void ensureVals(src).then(() => valuesAt && showValues(valuesAt));
  if (run !== frameRun) return; // a later step won
  if (src !== before) {
    countDoppio();
    void updateLod();
    // The next day's files while this one shows, so playing across midnight does not stall.
    const next = sources[sources.indexOf(src) + 1];
    if (next) void ensureWide(next).then(() => ensureVals(next));
  }
  for (const p of panels) drawPanel(p);
}

let timer = 0;
function setPlaying(on: boolean): void {
  window.clearInterval(timer);
  setPlayButton($("play"), on);
  if (on && frames.length) {
    userTime = true;
    timer = window.setInterval(() => void setFrame((frame + 1) % frames.length), PLAY_MS);
  } else writeUrl();
}

function step(by: number): void {
  setPlaying(false);
  userTime = true;
  void setFrame(frame + by).then(writeUrl);
}

// ---------- Periods ----------

/** The frames and sources of a period; none when nothing is available for it. */
async function loadPeriod(p: Period): Promise<{ sources: Source[]; frames: Frame[] }> {
  const out: { sources: Source[]; frames: Frame[] } = { sources: [], frames: [] };
  if (p.kind === "forecast") {
    const ms = Object.values(latest?.models ?? {}).filter((m): m is Model => !!m);
    const longest = ms.sort((a, b) => b.steps - a.steps)[0];
    if (!latest || !longest) return out;
    out.sources.push({ key: longest.run, models: latest.models, wide: {}, loading: {}, vals: {}, vloading: {} });
    const t0 = Date.parse(longest.t0) / 1000;
    for (let k = 0; k < longest.steps; k++) out.frames.push({ t: t0 + k * longest.step, s: 0 });
    return out;
  }
  const days: string[] = [];
  for (let t = dayMs(p.from); t <= dayMs(p.to) && days.length < MAX_DAYS; t += DAY_MS) if (dayOf(t) in archived) days.push(dayOf(t));
  const idx = await Promise.all(days.map((d) => getJson<DayIndex>(`days/${d}/index.json`)));
  idx.forEach((e, i) => {
    if (!e || !Object.keys(e.models).length) return;
    const s = out.sources.length;
    out.sources.push({ key: `days/${days[i]}`, models: e.models, wide: {}, loading: {}, vals: {}, vloading: {} });
    const t0 = dayMs(days[i]) / 1000;
    for (let h = 0; h < 24; h++) out.frames.push({ t: t0 + h * 3600, s });
  });
  return out;
}

/** Switch to a period, opening on the hour `t` if it holds it (else the hour nearest now, or its first). */
async function showPeriod(p: Period, t: number | null = null): Promise<boolean> {
  const got = await loadPeriod(p);
  if (!got.frames.length) return false;
  window.clearInterval(timer);
  setPlayButton($("play"), false);
  period = p.kind === "days" ? { kind: "days", from: dayOf(got.frames[0].t * 1000), to: dayOf(got.frames[got.frames.length - 1].t * 1000) } : p;
  sources = got.sources;
  frames = got.frames;
  frame = -1; // no current source: setFrame refreshes the level of detail and the counts
  inViewKeys = [];
  const slider = $("slider") as HTMLInputElement;
  slider.max = String(frames.length - 1);
  const target = t ?? (p.kind === "forecast" ? Date.now() / 1000 : frames[0].t);
  const k = frames.reduce((best, f, i) => (Math.abs(f.t - target) < Math.abs(frames[best].t - target) ? i : best), 0);
  periodLabel();
  await setFrame(k);
  writeUrl();
  return true;
}

/** Archived days as runs of consecutive dates: [first, last]. */
function runs(): [string, string][] {
  const out: [string, string][] = [];
  for (const d of Object.keys(archived).sort()) {
    const last = out[out.length - 1];
    if (last && dayMs(d) - dayMs(last[1]) === DAY_MS) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

function periodLabel(): void {
  $("period-now").textContent = period.kind === "forecast" ? "Latest forecast" : dayRange(period.from, period.to);
  if (period.kind === "days") {
    ($("p-from") as HTMLInputElement).value = period.from;
    const n = Math.round((dayMs(period.to) - dayMs(period.from)) / DAY_MS) + 1;
    const len = $("p-len") as HTMLSelectElement;
    if ([...len.options].some((o) => o.value === String(n))) len.value = String(n);
  }
}

function wirePeriod(): void {
  const box = $("period") as HTMLDetailsElement;
  const from = $("p-from") as HTMLInputElement;
  const len = $("p-len") as HTMLSelectElement;
  const note = $("p-note");
  const spans = runs();
  const held = `Archived: ${spans.map(([a, b]) => dayRange(a, b)).join("; ")}.`;
  if (spans.length) {
    from.min = spans[0][0];
    from.max = spans[spans.length - 1][1];
    if (!from.value) from.value = from.max;
    note.textContent = held;
  } else {
    from.disabled = len.disabled = ($("p-show") as HTMLButtonElement).disabled = true;
    note.textContent = "No days archived yet.";
  }
  $("p-latest").addEventListener("click", async () => {
    box.open = false;
    userTime = false;
    await showPeriod({ kind: "forecast" });
  });
  $("p-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isDay(from.value)) return;
    const to = dayOf(dayMs(from.value) + (Number(len.value) - 1) * DAY_MS);
    userTime = false;
    if (await showPeriod({ kind: "days", from: from.value, to })) {
      box.open = false;
      note.textContent = held;
    } else note.textContent = `Nothing archived for ${dayRange(from.value, to)}. ${held}`;
  });
  document.addEventListener("click", (e) => {
    if (box.open && !box.contains(e.target as Node)) box.open = false;
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") box.open = false;
  });
}

// ---------- Page ----------

function legend(): void {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3]; // kt
  if (field !== "currents") {
    const r = SCALAR_RAMPS[field];
    const steps = field === "temp" ? [0, 5, 10, 15, 20, 25, 30] : [29, 31, 33, 35, 37];
    $("key").innerHTML =
      `<span>${depth ? `${FIELD_NAME[field]} at ${depth} m` : `surface ${FIELD_NAME[field]}`}${field === "temp" ? ", &deg;C" : ""}:</span>` +
      steps.map((v) => `<span><i class="sq" style="background:${scalarColor(field as "temp" | "salt", v)}"></i>${v === r.hi ? `${v}+` : v}</span>`).join("");
    return;
  }
  $("key").innerHTML =
    `<span>${depth ? `current at ${depth} m` : "surface current"}, kt:</span>` + steps.map((v) => `<span><i class="sq" style="background:${speedColor(v / MS_TO_KT)}"></i>${v}</span>`).join("");
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

const PANELS: [Id, string, string][] = [
  ["necofs", "NECOFS", "triangles"],
  ["doppio", "DOPPIO", "7 km cells"],
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

  const want = readUrl();
  shownBox = want.bbox?.join(",") ?? null;
  if (want.layers) shown = want.layers;
  wireLayers();
  depth = want.depth;
  wireDepth();
  field = want.field;
  wireField();
  legend(); // the key names the depth
  const [l, d, ...isos] = await Promise.all([
    getJson<Latest>("latest.json", { cache: "no-cache" }),
    getJson<{ days: Record<string, boolean> }>("days.json", { cache: "no-cache" }),
    ...PANELS.map(([id]) => getJson<FeatureCollection>(`isobaths-${id}.json`)), // the currents still draw without them
  ]);
  latest = l as Latest | null;
  archived = (d as { days: Record<string, boolean> } | null)?.days ?? {};

  const slider = $("slider") as HTMLInputElement;
  timeTrack(slider, (v) => frames[Math.round(v)]?.t ?? NaN);
  slider.addEventListener("input", () => {
    window.clearInterval(timer);
    setPlayButton($("play"), false);
    userTime = true;
    void setFrame(Number(slider.value));
  });
  slider.addEventListener("change", writeUrl);
  $("play").addEventListener("click", () => setPlaying($("play").getAttribute("aria-pressed") !== "true"));
  $("step-back").addEventListener("click", () => step(-1));
  $("step-fwd").addEventListener("click", () => step(1));
  setPlayButton($("play"), false);
  wirePeriod();

  const host = $("panels");
  PANELS.forEach(([id, label, unit], i) => {
    const f = document.createElement("figure");
    f.className = "mg-panel";
    const cap = document.createElement("figcaption");
    const box = document.createElement("div");
    box.className = "mg-map sh-map";
    box.dataset.model = id;
    f.append(cap, box);
    host.append(f);
    panels.push({ id, label, unit, iso: (isos[i] as FeatureCollection | null) ?? null, box, cap, map: null, popup: null });
  });

  // The period the address asks for: its days; or, for an hour alone, the forecast if it holds it, else its day.
  userTime = want.t !== null;
  let ok = false;
  if (want.period) ok = await showPeriod(want.period, want.t);
  else if (want.t !== null) {
    const held = latest && (await loadPeriod({ kind: "forecast" })).frames.some((f) => f.t === want.t);
    const day = dayOf(want.t * 1000);
    ok = held ? await showPeriod({ kind: "forecast" }, want.t) : day in archived && (await showPeriod({ kind: "days", from: day, to: day }, want.t));
  }
  if (!ok && (want.period || want.t !== null)) {
    // A link to days the archive does not hold: say so, and show the latest forecast.
    const asked = want.period?.kind === "days" ? dayRange(want.period.from, want.period.to) : dayRange(dayOf(want.t! * 1000), dayOf(want.t! * 1000));
    const e = $("load-error");
    e.hidden = false;
    e.textContent = `Nothing archived for ${asked}; showing the latest forecast.`;
  }
  if (!ok) ok = await showPeriod({ kind: "forecast" });
  if (!ok) failed();

  const gl = webglOk();
  for (const p of panels) {
    p.cap.innerHTML = caption(p);
    if (!gl) p.box.innerHTML = `<p class="mg-fallback">This map needs WebGL, which this browser has turned off.</p>`;
    else makeMap(p, want.bbox ?? OPEN_BOUNDS);
  }

  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__shMaps = panels.map((p) => p.map).filter((m): m is maplibregl.Map => !!m);
    w.__shFrame = () => frame;
    w.__shCaptions = () => panels.map((p) => p.cap.textContent ?? "");
    w.__shCounts = () => panels.map((p) => features(p).cells.features.length);
    w.__shLod = () => ({ lod, tooMany, inView: inViewKeys.length, cached: tileCache.size });
    w.__shPeriod = () => ({ period, frames: frames.length, sources: sources.map((s) => s.key) });
  }
}

void main();
