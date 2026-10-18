/**
 * Surface fields on the locator map: satellite rasters (sea surface temperature, chlorophyll-a, Kd490) and modelled
 * surface currents on the FVCOM mesh, with a panel for the colour bar, the source and age, and (for currents) a time
 * slider. The data come from /data/v1/fields/ (see the jobs' fields.py); this module only draws them.
 *
 * Rasters are drawn on a canvas at the product's own resolution and placed as an image over their grid cells, so a
 * pixel is never smoothed into its neighbours; older pixels (a cloudy spell) are drawn fainter. Currents are drawn on
 * the model's own triangles, shaded by speed, with arrows at element centres thinned by zoom level, so the field is
 * shown as the model holds it rather than regridded. HRRR wind is drawn the same way on HRRR's own 3 km cells, one
 * quadrilateral per cell, with land cells (HRRR's mask) fainter.
 */
import type maplibregl from "maplibre-gl";
import { alertsNow, zoneForecastUrl } from "./advisory";
import { BOATS, COMFORT_WORDS, type Boat } from "./comfort-thresholds";
import { mapReady, mapTheme, onStyle } from "./map";

export type FieldKind = "sst" | "chl" | "kd490" | "currents" | "wind" | "waves" | "wat";

export interface RasterField {
  kind: Exclude<FieldKind, "currents" | "wind" | "waves" | "wat">;
  units: string;
  scale: number;
  time: string;
  window_days: number;
  grid: { lon0: number; lat0: number; dlon: number; dlat: number; nx: number; ny: number };
  values: (number | null)[];
  age_days: (number | null)[];
  attribution: string;
  products: string[];
}

export interface CurrentsMesh {
  nodes: [number, number][];
  triangles: [number, number, number][];
  centres: [number, number][];
  arrow_level: number[];
  arrow_levels: number;
  source: string;
}

export interface CurrentsField {
  t0: string;
  step: number;
  steps: number;
  u: number[][];
  v: number[][];
  label: string;
  source: string;
  layer: string;
  generated_at: string;
}

/** HRRR 10 m wind on the model's own grid (see the jobs' hrrr_grid.py): each cell a quadrilateral, one frame per
 * valid hour with east and north components as base64 int8 in steps of encoding.step m/s. */
export interface WindField {
  generated_at: string;
  source: string;
  attribution: string;
  encoding: { step: number };
  mesh: {
    nx: number;
    ny: number;
    corner_lon: number[];
    corner_lat: number[];
    centre_lon: number[];
    centre_lat: number[];
    land: number[];
    arrow_level: number[];
  };
  frames: { valid_time: string; cycle: string; lead: number; u: string; v: string }[];
}

/** The last 90 days of a raster, one frame per UTC day (see the jobs' fields.py for the file layout). */
export interface RasterHistory {
  header: {
    kind: Exclude<FieldKind, "currents" | "wind" | "waves" | "wat">;
    units: string;
    grid: RasterField["grid"];
    days: string[];
    window_days: number;
    encoding: { low: number; high: number; log10: boolean; levels: number };
    age: { step_days: number } | null;
    generated_at: string;
    products: string[];
    attribution: string;
  };
  body: Uint8Array;
}

/** Wind against tide (see the jobs' wat.py): on the NWPS grid (regular lon-lat), the cells where the NECOFS current
 * opposes and steepens the NWPS waves. Each frame lists only those cells (indices into the grid) with level (1 to
 * 4), steepness ratio in tenths (255: blocking), current east and north in cm/s, wave height in cm, peak period in
 * tenths of a second and the direction the waves travel. */
export interface WatField {
  generated_at: string;
  source: string;
  attribution: string;
  grid: { lon0: number; lat0: number; dlon: number; dlat: number; nx: number; ny: number };
  cells: number[];
  arrow_level: number[];
  frames: { valid_time: string; cycle: string; lead: number; currents_run: string; i: number[]; lv: number[]; s: number[]; u: number[]; v: number[]; hs: number[]; tp: number[]; to: number[] }[];
}

export interface FieldData {
  wat?: WatField;
  /** Wind against tide drawn over the field (not with a wat field itself). */
  overlay?: WatField;
  raster?: RasterField;
  history?: RasterHistory;
  mesh?: CurrentsMesh;
  currents?: CurrentsField;
  wind?: WindField;
}

/** Unzip and parse a history file: "LHZF", a little-endian uint32 header length, the JSON header, the frames. */
export async function decodeHistory(buf: ArrayBuffer): Promise<RasterHistory> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  if (String.fromCharCode(...raw.subarray(0, 4)) !== "LHZF") throw new Error("not a history file");
  const n = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + n))) as RasterHistory["header"];
  return { header, body: raw.subarray(8 + n) };
}

/** The fields a point readout draws on: HRRR wind and NWPS waves (both on their model cells) and wind against tide. */
export interface PointSources {
  sst?: RasterField;
  zones?: { features: { properties: { id: string }; geometry: { type: string; coordinates: unknown } }[] };
  wind?: WindField;
  waves?: WindField;
  currents?: { mesh: CurrentsMesh; currents: CurrentsField };
  wat?: WatField;
}

/** Controls the page passes in: the layer picker and the full-width toggle. */
export interface FieldControls {
  choices: { kind: FieldKind | "none"; label: string; more?: boolean }[];
  chosen: FieldKind | "none";
  onPick: (kind: FieldKind | "none") => void;
  wide: boolean;
  onWide: (wide: boolean) => void;
  /** The models a click reads at its point whatever the layer (Wind & waves): loaded on the first click. */
  point?: () => Promise<PointSources>;
  /** The boat class the comfort index is for (the menu's Boat setting). */
  boat?: Boat;
  /** An overlay the view offers (wind against tide), whether it is on, and its switch. */
  overlay?: { label: string; on: boolean; onToggle: (on: boolean) => void };
  /** The reader's speed unit (from the page's Units switch), for the currents key and values. */
  speed: { label: string; perCms: number; digits: number };
}

/** cmocean-style ramps (perceptually ordered), low to high. */
const RAMPS: Record<string, string[]> = {
  thermal: ["#042333", "#2c3395", "#744992", "#b15f82", "#eb7655", "#fbb33f", "#e8fa5b"],
  algae: ["#d7f9d0", "#a3d3a0", "#6fae6a", "#3e8a3c", "#1c6427", "#0d3f17", "#062a10"],
  turbid: ["#e9f6ab", "#d3c671", "#bf9747", "#a1703b", "#795338", "#4d392d", "#221f1b"],
  speed: ["#fffdcd", "#e1cd73", "#aaac20", "#5f920c", "#187328", "#144b2a", "#172313"],
  wind: ["#f1edf8", "#b7a2dd", "#6a47a8", "#3f2477"], // the light-theme scale; see windStops()
};

/** Wind colours, m/s: one continuous scale, pale lavender to deep violet on the light basemap and the reverse on the
 * dark one, so the strongest wind is always the most visible (the same scale as the four-grids page, in kt). */
const KT = 0.514444;
const WIND_TOP = 35 * KT;
const windStops = (): [number, string][] =>
  (mapTheme() === "light"
    ? [[0, "#f1edf8"], [6, "#d9cdee"], [12, "#b7a2dd"], [18, "#9070c6"], [25, "#6a47a8"], [35, "#3f2477"]]
    : [[0, "#2b2440"], [6, "#3f3366"], [12, "#5d4a92"], [18, "#8167bd"], [25, "#a990dd"], [35, "#d6c7f5"]]
  ).map(([kt, c]) => [(kt as number) * KT, c as string]);

/** Wave colours, m: pale to deep blue-teal on the light basemap and the reverse on the dark one (as wind), a
 * different hue from wind's violet so the two layers are never confused. */
const WAVE_TOP = 2.5;
const waveStops = (): [number, string][] =>
  mapTheme() === "light"
    ? [[0, "#eef6f8"], [0.3, "#cfe6ee"], [0.6, "#9dcbdc"], [1.0, "#5ea6c4"], [1.5, "#2d7aa3"], [2.5, "#16466e"]]
    : [[0, "#16242c"], [0.3, "#1f3a48"], [0.6, "#2d5d73"], [1.0, "#4b8aa4"], [1.5, "#7fb8d8"], [2.5, "#cfe8f3"]];
const isWaves = () => active === "waves";
const vecStops = () => (isWaves() ? waveStops() : windStops());

interface Meta {
  title: string;
  short: string;
  ramp: string;
  log: boolean;
  range?: [number, number]; // fixed range; otherwise the 2nd to 98th percentile of the field
  unit: string;
  digits: number;
  note: string;
}

const META: Record<FieldKind, Meta> = {
  sst: { title: "Sea surface temperature", short: "SST", ramp: "thermal", log: false, unit: "°C", digits: 1, note: "Satellite analysis (gap-free), the skin of the water; buoy sensors sit about 1 m down." },
  chl: { title: "Chlorophyll-a", short: "Chlorophyll-a", ramp: "algae", log: true, range: [0.5, 30], unit: "mg/m³", digits: 1, note: "Satellite estimate of the surface; biased high in turbid water and near the shore (a band along the coast is left out)." },
  kd490: { title: "Water clarity (Kd490)", short: "Clarity, Kd490", ramp: "turbid", log: true, range: [0.1, 2], unit: "m⁻¹", digits: 2, note: "Light attenuation at 490 nm, a satellite proxy for murkiness, not a turbidity reading in NTU. Higher is murkier." },
  currents: { title: "Surface currents", short: "Currents", ramp: "speed", log: false, range: [0, 150], unit: "cm/s", digits: 0, note: "Model forecast (NECOFS FVCOM), top layer; arrows show where the water is going." },
  waves: { title: "Waves (NWS NWPS)", short: "Waves, NWPS", ramp: "wind", log: false, range: [0, WAVE_TOP], unit: "m", digits: 2, note: "Model forecast (NWS Nearshore Wave Prediction System, SWAN): significant wave height on the model's own 1.8 km cells; arrows show where the waves travel. These runs carry no currents, so steepening where wind opposes the tide is not in them." },
  wat: { title: "Wind against tide", short: "Wind against tide", ramp: "wind", log: false, unit: "", digits: 0, note: "A model-derived index, not an observation and not an NWS product: where the NECOFS current runs against the NWPS waves and steepens them (linear theory). Shoals, rips and overfalls finer than the 1.8 km cells are not in it." },
  wind: { title: "Wind (HRRR)", short: "Wind, HRRR", ramp: "wind", log: false, range: [0, WIND_TOP], unit: "m/s", digits: 1, note: "Model forecast (NOAA HRRR), 10 m above the surface, on the model's own 3 km cells; arrows show where the wind blows toward. Cells HRRR counts as land are fainter inland; on the shore (harbours, coves) they are drawn like water." },
};

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function colour(ramp: string[], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const a = hex(ramp[i]);
  const b = hex(ramp[i + 1]);
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];
}

function rangeOf(meta: Meta, values: number[]): [number, number] {
  if (meta.range) return meta.range;
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  return [v[Math.floor(0.02 * (v.length - 1))], v[Math.ceil(0.98 * (v.length - 1))]];
}

const position = (meta: Meta, [lo, hi]: [number, number], v: number) =>
  meta.log ? (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo || 1);

/* ---------- State ---------- */

let active: FieldKind | null = null;
let data: FieldData = {};
let range: [number, number] = [0, 1];
let frame = 0; // the currents frame on the map (-1: the timeline's time is outside the model run)
let windFrame = -1; // the wind frame on the map (-1: no HRRR hour at the timeline's time)
let watFrame = -1; // the wind-against-tide frame on the map (-1: none within the hour)
let overlay: WatField | null = null; // wind against tide over another field
let probeOv: number | null = null; // the overlay cell the popup reads, under the base value
/** The wind-against-tide field on the map: the layer itself, or the overlay. */
const watOf = (): WatField | null => data.wat ?? overlay;
let fieldT: number | null = null; // the page timeline's time (epoch seconds), or null for now
let controls: FieldControls | null = null;
let panel: HTMLElement | null = null;
let clickBound = false;
let shownRaster: RasterField | undefined; // the raster the page passed in (the newest), to tell a new layer from a refresh
let histIndex = -1; // the history frame on the map
const histRanges = new WeakMap<RasterHistory, [number, number]>();

/* ---------- History frames ---------- */

const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The history frame for the timeline's time: the newest day not after its New York date, the date the time bar
 * shows (now: the newest frame). */
function historyIndex(h: RasterHistory): number {
  const days = h.header.days;
  if (fieldT == null) return days.length - 1;
  const day = nyDay.format(new Date(fieldT * 1000));
  let k = days.length - 1;
  while (k > 0 && days[k] > day) k--;
  return k;
}

function dequantise(h: RasterHistory, q: number): number {
  const { low, high, log10 } = h.header.encoding;
  if (q === 0) return NaN;
  const a = log10 ? Math.log10(low) : low;
  const b = log10 ? Math.log10(high) : high;
  const x = a + ((q - 1) / 254) * (b - a);
  return log10 ? 10 ** x : x;
}

/** One history frame as a raster the drawing code already knows. */
function historyRaster(h: RasterHistory, k: number): RasterField {
  const { grid, age, days, window_days } = h.header;
  const px = grid.nx * grid.ny;
  const per = px * (age ? 2 : 1);
  const v = h.body.subarray(k * per, k * per + px);
  const a = age ? h.body.subarray(k * per + px, (k + 1) * per) : null;
  const last = k === days.length - 1 && h.header.generated_at.slice(0, 10) === days[k];
  return {
    kind: h.header.kind,
    units: h.header.units,
    scale: 1,
    time: last ? h.header.generated_at : `${days[k]}T23:59:59Z`,
    window_days,
    grid,
    values: Array.from(v, (q) => (q === 0 ? null : dequantise(h, q))),
    age_days: a ? Array.from(a, (q) => (q === 255 ? null : q * age!.step_days)) : new Array(px).fill(null),
    attribution: h.header.attribution,
    products: h.header.products,
  };
}

/** One colour scale for every frame, so the movie does not flicker: the field's fixed range, or for SST the 2nd to
 * 98th percentile over all 90 days. */
function historyRange(h: RasterHistory): [number, number] {
  const meta = META[h.header.kind];
  if (meta.range) return meta.range;
  let r = histRanges.get(h);
  if (!r) {
    const { grid, age } = h.header;
    const px = grid.nx * grid.ny;
    const vals = new Array(256).fill(0);
    for (let k = 0; k < h.header.days.length; k++) {
      const off = k * px * (age ? 2 : 1);
      for (let i = 0; i < px; i++) vals[h.body[off + i]]++;
    }
    vals[0] = 0;
    const total = vals.reduce((s, c) => s + c, 0);
    const at = (p: number) => {
      let acc = 0;
      for (let q = 1; q < 256; q++) if ((acc += vals[q]) >= p * total) return dequantise(h, q);
      return dequantise(h, 255);
    };
    r = total ? [at(0.02), at(0.98)] : [0, 1];
    histRanges.set(h, r);
  }
  return r;
}

const LAYER_IDS = ["field-raster", "cur-fill", "cur-arrows", "wind-fill", "wind-arrows", "wat-fill", "wat-arrows"];
const SOURCE_IDS = ["field-raster", "cur-mesh", "cur-points", "wind-cells", "wind-points", "wat-cells", "wat-points"];

function clear(map: maplibregl.Map): void {
  for (const id of LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of SOURCE_IDS) if (map.getSource(id)) map.removeSource(id);
}

/** The first symbol layer of the basemap: fields draw beneath place names. */
const beneathLabels = (map: maplibregl.Map) => map.getStyle().layers?.find((l) => l.type === "symbol")?.id;

/* ---------- Rasters ---------- */

function rasterImage(f: RasterField, meta: Meta): string {
  const { nx, ny } = f.grid;
  const values = f.values.map((v) => (v == null ? NaN : v * f.scale));
  range = data.history ? historyRange(data.history) : rangeOf(meta, values);
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(nx, ny);
  const ramp = RAMPS[meta.ramp];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = values[j * nx + i];
      if (!Number.isFinite(v)) continue;
      const [r, g, b] = colour(ramp, position(meta, range, v));
      // Rows run from the south in the data and from the top on the canvas. Older pixels are fainter.
      const o = ((ny - 1 - j) * nx + i) * 4;
      const age = f.age_days[j * nx + i] ?? 0;
      const fade = Math.max(0.35, 1 - age / Math.max(1, f.window_days));
      img.data.set([r, g, b, Math.round(235 * fade)], o);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function addRaster(map: maplibregl.Map, f: RasterField): void {
  const meta = META[f.kind];
  const { lon0, lat0, dlon, dlat, nx, ny } = f.grid;
  const w = lon0 - dlon / 2;
  const e = lon0 + (nx - 0.5) * dlon;
  const s = lat0 - dlat / 2;
  const n = lat0 + (ny - 0.5) * dlat;
  map.addSource("field-raster", { type: "image", url: rasterImage(f, meta), coordinates: [[w, n], [e, n], [e, s], [w, s]] });
  map.addLayer(
    { id: "field-raster", type: "raster", source: "field-raster", paint: { "raster-opacity": 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 } },
    beneathLabels(map),
  );
}

/** Move the raster to another history frame: the image, the key, and an open value. */
async function showHistoryFrame(k: number): Promise<void> {
  const h = data.history;
  if (!h || k === histIndex) return;
  histIndex = k;
  data.raster = historyRaster(h, k);
  const box = document.getElementById("map");
  if (box) renderPanel(box);
  const map = await mapReady();
  const src = map.getSource("field-raster") as maplibregl.ImageSource | undefined;
  if (src) {
    const { lon0, lat0, dlon, dlat, nx, ny } = data.raster.grid;
    const w = lon0 - dlon / 2;
    const e = lon0 + (nx - 0.5) * dlon;
    const s = lat0 - dlat / 2;
    const n = lat0 + (ny - 0.5) * dlat;
    src.updateImage({ url: rasterImage(data.raster, META[data.raster.kind]), coordinates: [[w, n], [e, n], [e, s], [w, s]] });
  }
  if (popup && probeAt) popup.setHTML(rasterText(data.raster, probeAt.lng, probeAt.lat) ?? "no value on this day");
}

const fmtFrameDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

/** A raster's value at a point, with its age, and the day for a history frame. */
function rasterText(f: RasterField, lng: number, lat: number): string | null {
  const at = rasterValueAt(f, lng, lat);
  if (!at) return null;
  const meta = META[f.kind];
  const age = Number.isFinite(at.age) ? `, ${at.age.toFixed(1)}d old` : "";
  const day = data.history ? `<br><small>${fmtFrameDay.format(new Date(f.time))}</small>` : "";
  return `${at.v.toFixed(meta.digits)} ${meta.unit}${age}${day}`;
}

function rasterValueAt(f: RasterField, lng: number, lat: number): { v: number; age: number } | null {
  const i = Math.round((lng - f.grid.lon0) / f.grid.dlon);
  const j = Math.round((lat - f.grid.lat0) / f.grid.dlat);
  if (i < 0 || j < 0 || i >= f.grid.nx || j >= f.grid.ny) return null;
  const raw = f.values[j * f.grid.nx + i];
  return raw == null ? null : { v: raw * f.scale, age: f.age_days[j * f.grid.nx + i] ?? NaN };
}

/* ---------- Currents ---------- */

function arrowImage(map: maplibregl.Map): void {
  if (map.hasImage("cur-arrow")) return;
  const size = 32;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.beginPath();
  // An arrow pointing up (north); the layer rotates it to the flow's heading.
  g.moveTo(16, 2);
  g.lineTo(25, 16);
  g.lineTo(19, 15);
  g.lineTo(19, 30);
  g.lineTo(13, 30);
  g.lineTo(13, 15);
  g.lineTo(7, 16);
  g.closePath();
  g.fill();
  map.addImage("cur-arrow", g.getImageData(0, 0, size, size), { sdf: true });
}

const meshGeoJSON = (m: CurrentsMesh) => ({
  type: "FeatureCollection" as const,
  features: m.triangles.map((t, i) => ({
    type: "Feature" as const,
    id: i,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [[m.nodes[t[0]], m.nodes[t[1]], m.nodes[t[2]], m.nodes[t[0]]]] },
  })),
});

function pointsGeoJSON(m: CurrentsMesh, c: CurrentsField, k: number) {
  if (k < 0) return { type: "FeatureCollection" as const, features: [] };
  const u = c.u[k];
  const v = c.v[k];
  return {
    type: "FeatureCollection" as const,
    features: m.centres.map((p, i) => ({
      type: "Feature" as const,
      properties: { level: m.arrow_level[i], s: Math.hypot(u[i], v[i]), d: (Math.atan2(u[i], v[i]) * 180) / Math.PI },
      geometry: { type: "Point" as const, coordinates: p },
    })),
  };
}

function addCurrents(map: maplibregl.Map, m: CurrentsMesh, c: CurrentsField): void {
  const meta = META.currents;
  range = meta.range!;
  arrowImage(map);
  map.addSource("cur-mesh", { type: "geojson", data: meshGeoJSON(m) });
  map.addSource("cur-points", { type: "geojson", data: pointsGeoJSON(m, c, frame) });
  const ramp = RAMPS[meta.ramp];
  const stops = ramp.flatMap((col, i) => [range[0] + ((range[1] - range[0]) * i) / (ramp.length - 1), col]);
  map.addLayer(
    {
      id: "cur-fill",
      type: "fill",
      source: "cur-mesh",
      paint: {
        "fill-color": ["interpolate", ["linear"], ["coalesce", ["feature-state", "s"], 0], ...stops] as maplibregl.ExpressionSpecification,
        "fill-opacity": ["case", ["==", ["feature-state", "s"], null], 0, 0.6] as maplibregl.ExpressionSpecification,
        "fill-antialias": false,
      },
    },
    beneathLabels(map),
  );
  // Arrows: level 0 shows at the widest zoom; each zoom step lets the next level in, so spacing stays even.
  const shown = (level: number): maplibregl.ExpressionSpecification => ["case", ["<=", ["get", "level"], level], 0.9, 0];
  map.addLayer({
    id: "cur-arrows",
    type: "symbol",
    source: "cur-points",
    layout: {
      "icon-image": "cur-arrow",
      "icon-rotate": ["get", "d"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["get", "s"], 0, 0.28, 40, 0.42, 120, 0.7],
    },
    paint: {
      "icon-color": mapTheme() === "light" ? "#1c2a48" : "#f4f1e8",
      "icon-opacity": ["step", ["zoom"], shown(0), 8.6, shown(1), 9.4, shown(2), 10.2, shown(3), 11, shown(4), 11.8, shown(5), 12.6, shown(6)] as maplibregl.ExpressionSpecification,
    },
  });
  paintFrame(map);
}

/** Shade each triangle by speed at the current frame (none outside the model run), and move the arrows. */
function paintFrame(map: maplibregl.Map): void {
  const { mesh: m, currents: c } = data;
  if (!m || !c || !map.getSource("cur-mesh")) return;
  if (frame < 0) {
    for (let i = 0; i < m.triangles.length; i++) map.setFeatureState({ source: "cur-mesh", id: i }, { s: null });
  } else {
    const u = c.u[frame];
    const v = c.v[frame];
    for (let i = 0; i < u.length; i++) map.setFeatureState({ source: "cur-mesh", id: i }, { s: Math.hypot(u[i], v[i]) });
  }
  (map.getSource("cur-points") as maplibregl.GeoJSONSource).setData(pointsGeoJSON(m, c, frame));
  refreshPopup();
}

const fmtProbe = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });

/** A current's value at one element for the frame shown, in the reader's unit, with its time. */
function currentText(c: CurrentsField, id: number): string {
  if (frame < 0) return "no model hour at this time";
  const u = c.u[frame][id];
  const v = c.v[frame][id];
  const deg = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const sp = controls?.speed ?? { label: "cm/s", perCms: 1, digits: 0 };
  const t = fmtProbe.format(new Date(Date.parse(c.t0) + frame * c.step * 1000));
  return `${(Math.hypot(u, v) * sp.perCms).toFixed(sp.digits + 1)} ${sp.label} toward ${Math.round(deg)}&deg;<br><small>${t}, model</small>`;
}

/* ---------- Wind (HRRR) ---------- */

const windDecoded = new WeakMap<WindField["frames"][number], { u: Float32Array; v: Float32Array }>();

/** A frame's east and north components in m/s (decoded once). */
function windUV(w: WindField, k: number): { u: Float32Array; v: Float32Array } {
  const f = w.frames[k];
  let uv = windDecoded.get(f);
  if (!uv) {
    const dec = (s: string) => {
      const b = atob(s);
      const out = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) out[i] = ((b.charCodeAt(i) << 24) >> 24) * w.encoding.step; // int8
      return out;
    };
    uv = { u: dec(f.u), v: dec(f.v) };
    windDecoded.set(f, uv);
  }
  return uv;
}

/** The frame for the timeline's time: the nearest valid hour, or -1 when HRRR has none within the hour. */
function windFrameAt(w: WindField): number {
  const t = fieldT ?? Date.now() / 1000;
  let best = -1;
  let gap = Infinity;
  w.frames.forEach((f, k) => {
    const d = Math.abs(Date.parse(f.valid_time) / 1000 - t);
    if (d < gap) [best, gap] = [k, d];
  });
  return gap <= 3600 ? best : -1;
}

/** Cells the model counts as land but that touch a water cell (any of the 8 around): harbours, coves and the shore,
 * where HRRR's 3 km cells straddle the coastline. They are drawn like water cells; only inland cells are faint. */
const shoreCells = new WeakMap<WindField["mesh"], Uint8Array>();
function shoreOf(m: WindField["mesh"]): Uint8Array {
  let s = shoreCells.get(m);
  if (s) return s;
  s = new Uint8Array(m.land.length);
  for (let j = 0; j < m.ny; j++) {
    for (let i = 0; i < m.nx; i++) {
      const id = j * m.nx + i;
      if (!m.land[id]) continue;
      for (let dj = -1; dj <= 1 && !s[id]; dj++) {
        for (let di = -1; di <= 1; di++) {
          const jj = j + dj;
          const ii = i + di;
          if (jj >= 0 && jj < m.ny && ii >= 0 && ii < m.nx && !m.land[jj * m.nx + ii]) {
            s[id] = 1;
            break;
          }
        }
      }
    }
  }
  shoreCells.set(m, s);
  return s;
}

/** Each HRRR cell as its own quadrilateral, from the corners the job published. */
function windCellsGeoJSON(w: WindField) {
  const { nx, ny, corner_lon: x, corner_lat: y, land: isLand } = w.mesh;
  const shore = shoreOf(w.mesh);
  const land = isLand.map((v, i) => (v && !shore[i] ? 1 : 0)); // inland only: shore cells draw as water
  const c = (j: number, i: number) => [x[j * (nx + 1) + i], y[j * (nx + 1) + i]];
  const features = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const id = j * nx + i;
      features.push({
        type: "Feature" as const,
        id,
        properties: { land: land[id] },
        geometry: { type: "Polygon" as const, coordinates: [[c(j, i), c(j, i + 1), c(j + 1, i + 1), c(j + 1, i), c(j, i)]] },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function windPointsGeoJSON(w: WindField, k: number) {
  const m = w.mesh;
  const shore = shoreOf(m);
  const uv = k >= 0 ? windUV(w, k) : null;
  return {
    type: "FeatureCollection" as const,
    features: uv
      ? m.centre_lon.map((lon, i) => ({
          type: "Feature" as const,
          properties: { level: m.arrow_level[i], land: m.land[i] && !shore[i] ? 1 : 0, s: Math.hypot(uv.u[i], uv.v[i]), d: (Math.atan2(uv.u[i], uv.v[i]) * 180) / Math.PI },
          geometry: { type: "Point" as const, coordinates: [lon, m.centre_lat[i]] },
        }))
      : [],
  };
}

/** The wind colour expression on a speed in m/s. */
function windColour(s: maplibregl.ExpressionSpecification): maplibregl.ExpressionSpecification {
  return ["interpolate", ["linear"], s, ...vecStops().flat()] as maplibregl.ExpressionSpecification;
}

function addWind(map: maplibregl.Map, w: WindField): void {
  range = META[isWaves() ? "waves" : "wind"].range!;
  arrowImage(map);
  map.addSource("wind-cells", { type: "geojson", data: windCellsGeoJSON(w) });
  map.addSource("wind-points", { type: "geojson", data: windPointsGeoJSON(w, windFrame) });
  const land = (water: number, onLand: number): maplibregl.ExpressionSpecification => ["case", ["==", ["get", "land"], 1], onLand, water];
  map.addLayer(
    {
      id: "wind-fill",
      type: "fill",
      source: "wind-cells",
      paint: {
        "fill-color": windColour(["coalesce", ["feature-state", "s"], 0]),
        "fill-opacity": ["case", ["==", ["feature-state", "s"], null], 0, ["==", ["get", "land"], 1], isWaves() ? 0 : 0.28, 0.72] as maplibregl.ExpressionSpecification,
        "fill-antialias": false,
      },
    },
    beneathLabels(map),
  );
  const shown = (level: number): maplibregl.ExpressionSpecification => ["case", ["<=", ["get", "level"], level], land(0.9, 0.3), 0];
  map.addLayer({
    id: "wind-arrows",
    type: "symbol",
    source: "wind-points",
    layout: {
      "icon-image": "cur-arrow",
      "icon-rotate": ["get", "d"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-size": (isWaves() ? ["interpolate", ["linear"], ["get", "s"], 0, 0.3, 1, 0.5, 2.5, 0.72] : ["interpolate", ["linear"], ["get", "s"], 0, 0.3, 5, 0.46, 15, 0.72]) as maplibregl.ExpressionSpecification,
    },
    paint: {
      // One colour per theme, never switching by speed.
      "icon-color": mapTheme() === "light" ? "#1c2a48" : "#f4f1e8",
      "icon-opacity": ["step", ["zoom"], shown(0), 8.6, shown(1), 9.4, shown(2), 10.2, shown(3), 11, shown(6)] as maplibregl.ExpressionSpecification,
    },
  });
  paintWind(map);
}

/** Shade each cell by speed at the frame shown (none outside HRRR's hours), and move the arrows. */
function paintWind(map: maplibregl.Map): void {
  const w = data.wind;
  if (!w || !map.getSource("wind-cells")) return;
  const n = w.mesh.nx * w.mesh.ny;
  if (windFrame < 0) {
    for (let i = 0; i < n; i++) map.setFeatureState({ source: "wind-cells", id: i }, { s: null });
  } else {
    const { u, v } = windUV(w, windFrame);
    for (let i = 0; i < n; i++) map.setFeatureState({ source: "wind-cells", id: i }, { s: Math.hypot(u[i], v[i]) });
  }
  (map.getSource("wind-points") as maplibregl.GeoJSONSource).setData(windPointsGeoJSON(w, windFrame));
  refreshPopup();
}

/** The reader's unit for wind, from the page's speed setting (given per cm/s for currents). */
function windUnit(): { label: string; perMs: number; digits: number } {
  const sp = controls?.speed;
  if (!sp) return { label: "kt", perMs: 1 / 0.514444, digits: 0 };
  return { label: sp.label, perMs: sp.perCms * 100, digits: sp.label === "m/s" ? 1 : 0 };
}

const compass16 = (deg: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16];

/** One cell's wind for the frame shown: speed in the reader's unit and the direction it blows from. */
function windText(w: WindField, id: number): string {
  if (isWaves()) return waveText(w, id);
  if (windFrame < 0) return "no HRRR hour at this time";
  const f = w.frames[windFrame];
  const { u, v } = windUV(w, windFrame);
  const from = ((Math.atan2(-u[id], -v[id]) * 180) / Math.PI + 360) % 360;
  const un = windUnit();
  const land = w.mesh.land[id] ? ", land cell" : "";
  return `${(Math.hypot(u[id], v[id]) * un.perMs).toFixed(un.digits)} ${un.label} from ${compass16(from)} (${Math.round(from)}&deg;)<br><small>${fmtProbe.format(new Date(f.valid_time))}, HRRR ${f.cycle.slice(11, 13)}Z run, ${f.lead} h ahead${land}</small>`;
}

/** One cell's waves for the frame shown: significant height (ft and m) and the direction they come from. */
function waveText(w: WindField, id: number): string {
  if (windFrame < 0) return "no NWPS hour at this time";
  if (w.mesh.land[id]) return "land in the wave model";
  const f = w.frames[windFrame];
  const { u, v } = windUV(w, windFrame);
  const h = Math.hypot(u[id], v[id]);
  const from = ((Math.atan2(-u[id], -v[id]) * 180) / Math.PI + 360) % 360;
  return `${(h * 3.28084).toFixed(1)} ft (${h.toFixed(2)} m) from ${compass16(from)}<br><small>${fmtProbe.format(new Date(f.valid_time))}, NWPS ${f.cycle.slice(11, 13)}Z run, ${f.lead} h ahead, model</small>`;
}

/* ---------- Wind against tide ---------- */

const WAT_LABELS = ["", "Current steepening the waves", "Steep, short seas likely", "Breaking seas likely", "Waves blocked by the current"];
const WAT_SHORT = ["", "steepening", "steep", "breaking", "blocked"];
/** Tide-rip hatching per level, after the chart symbol for rips and overfalls: rows of wavy lines in the map's ink,
 * drawn with a fine pen. The patterns are fixed (they never rescale with the hours shown), and the step to the
 * densest, heavier pen is kept for blocking, so the heaviest marks appear only on outlier days. [row spacing px, pen
 * width px] in CSS pixels. */
const RIP: [number, number][] = [[0, 0], [10, 0.5], [7, 0.5], [5, 0.55], [3, 0.8]];
const ripInk = () => (mapTheme() === "light" ? "#1c2a48" : "#f4f1e8");

/** One level's tile: 16 px wide (two wavelengths), one row of the wave, drawn at twice the resolution so a 0.5 px
 * pen is one device pixel. */
function ripTile(level: number, ink: string, ratio = 2): ImageData {
  const [gap, pen] = RIP[level];
  const w = 16 * ratio;
  const h = gap * ratio;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.strokeStyle = ink;
  g.lineWidth = pen * ratio;
  g.lineCap = "round";
  const amp = Math.min(1.2, gap / 4) * ratio;
  g.beginPath();
  for (let x = -1; x <= w + 1; x += 1) {
    const y = h / 2 - amp * Math.sin((x / w) * 4 * Math.PI);
    if (x === -1) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  return g.getImageData(0, 0, w, h);
}

/** The level patterns and a fine-pen arrow, as map images named for the theme (a theme switch adds its own set). */
function ripImages(map: maplibregl.Map): string {
  const theme = mapTheme();
  const ink = ripInk();
  for (let l = 1; l <= 4; l++) {
    const name = `rip-${theme}-${l}`;
    if (!map.hasImage(name)) map.addImage(name, ripTile(l, ink), { pixelRatio: 2 });
  }
  const arrow = `rip-arrow-${theme}-3`; // -3: one heavier pen, no halo
  if (!map.hasImage(arrow)) {
    const r = 2;
    const c = document.createElement("canvas");
    c.width = c.height = 20 * r;
    const g = c.getContext("2d")!;
    g.lineCap = "round";
    g.lineJoin = "round";
    const arrowPath = () => {
      g.beginPath();
      g.moveTo(10 * r, 17.5 * r); // shaft, pointing up (north); the layer rotates it
      g.lineTo(10 * r, 3 * r);
      g.moveTo(6 * r, 7.5 * r); // open head
      g.lineTo(10 * r, 3 * r);
      g.lineTo(14 * r, 7.5 * r);
    };
    // One pen in the map's ink, about 3.5 times the hatching's, so the arrows read apart from the rows.
    g.strokeStyle = ink;
    g.lineWidth = 1.8 * r;
    arrowPath();
    g.stroke();
    map.addImage(arrow, g.getImageData(0, 0, c.width, c.height), { pixelRatio: r });
  }
  return theme;
}

/** A level's pattern as an inline SVG swatch for the key (the same rows and pen as on the map). */
function ripSwatch(level: number): string {
  const [gap, pen] = RIP[level];
  const amp = Math.min(1.2, gap / 4);
  const rows = [];
  for (let y = gap / 2; y < 12; y += gap) {
    let d = "";
    for (let x = 0; x <= 24; x += 1) d += `${x ? "L" : "M"}${x} ${(y - amp * Math.sin((x / 16) * 4 * Math.PI)).toFixed(2)}`;
    rows.push(`<path d="${d}" fill="none" stroke="${ripInk()}" stroke-width="${pen}" stroke-linecap="round"/>`);
  }
  return `<svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true">${rows.join("")}</svg>`;
}

function watFrameAt(w: WatField): number {
  const t = fieldT ?? Date.now() / 1000;
  let best = -1;
  let gap = Infinity;
  w.frames.forEach((f, k) => {
    const d = Math.abs(Date.parse(f.valid_time) / 1000 - t);
    if (d < gap) [best, gap] = [k, d];
  });
  return gap <= 3600 ? best : -1;
}

/** The frame's active cells, each its own square with its level and cell index. */
function watCellsGeoJSON(w: WatField, k: number) {
  if (k < 0) return { type: "FeatureCollection" as const, features: [] };
  const f = w.frames[k];
  const { lon0, lat0, dlon, dlat, nx } = w.grid;
  return {
    type: "FeatureCollection" as const,
    features: f.i.map((c, j) => {
      const x = lon0 + dlon * (c % nx);
      const y = lat0 + dlat * Math.floor(c / nx);
      const [x0, x1, y0, y1] = [x - dlon / 2, x + dlon / 2, y - dlat / 2, y + dlat / 2];
      return { type: "Feature" as const, properties: { cell: c, lv: f.lv[j] }, geometry: { type: "Polygon" as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } };
    }),
  };
}

const watArrowLevel = new WeakMap<WatField, Map<number, number>>();

/** Arrows for the current at the active cells, pointing where the water goes. */
function watPointsGeoJSON(w: WatField, k: number) {
  if (k < 0) return { type: "FeatureCollection" as const, features: [] };
  let levels = watArrowLevel.get(w);
  if (!levels) {
    levels = new Map(w.cells.map((c, j) => [c, w.arrow_level[j]]));
    watArrowLevel.set(w, levels);
  }
  const f = w.frames[k];
  const { lon0, lat0, dlon, dlat, nx } = w.grid;
  return {
    type: "FeatureCollection" as const,
    features: f.i.map((c, j) => ({
      type: "Feature" as const,
      properties: { level: levels!.get(c) ?? 6, lv: f.lv[j], s: Math.hypot(f.u[j], f.v[j]), d: (Math.atan2(f.u[j], f.v[j]) * 180) / Math.PI },
      geometry: { type: "Point" as const, coordinates: [lon0 + dlon * (c % nx), lat0 + dlat * Math.floor(c / nx)] },
    })),
  };
}

function addWat(map: maplibregl.Map, w: WatField, arrows = true): void {
  const theme = ripImages(map);
  map.addSource("wat-cells", { type: "geojson", data: watCellsGeoJSON(w, watFrame) });
  map.addSource("wat-points", { type: "geojson", data: watPointsGeoJSON(w, watFrame) });
  map.addLayer(
    {
      id: "wat-fill",
      type: "fill",
      source: "wat-cells",
      paint: {
        "fill-pattern": ["match", ["get", "lv"], 1, `rip-${theme}-1`, 2, `rip-${theme}-2`, 3, `rip-${theme}-3`, `rip-${theme}-4`] as maplibregl.ExpressionSpecification,
        "fill-antialias": false,
      },
    },
    beneathLabels(map),
  );
  const shown = (level: number): maplibregl.ExpressionSpecification => ["case", ["<=", ["get", "level"], level], 0.95, 0];
  // Over a field with its own arrows (wind, waves, currents) the current's arrows are left out: one set per map.
  if (arrows) map.addLayer({
    id: "wat-arrows",
    type: "symbol",
    source: "wat-points",
    layout: {
      "icon-image": `rip-arrow-${theme}-3`,
      "icon-rotate": ["get", "d"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["get", "s"], 30, 0.55, 80, 0.75, 150, 1],
    },
    paint: {
      "icon-opacity": ["step", ["zoom"], shown(0), 8.6, shown(1), 9.4, shown(2), 10.2, shown(3), 11, shown(6)] as maplibregl.ExpressionSpecification,
    },
  });
  paintWat(map);
}

/** Draw the frame shown (nothing outside the model hours): its cells' hatching and the arrows. */
function paintWat(map: maplibregl.Map): void {
  const w = watOf();
  if (!w || !map.getSource("wat-cells")) return;
  (map.getSource("wat-cells") as maplibregl.GeoJSONSource).setData(watCellsGeoJSON(w, watFrame));
  (map.getSource("wat-points") as maplibregl.GeoJSONSource).setData(watPointsGeoJSON(w, watFrame));
  refreshPopup();
}

/** The open popup's text for the frame shown: the base layer's value, and the overlay's cell below it. */
function refreshPopup(): void {
  if (!popup) return;
  if (probePoint) {
    popup.setHTML(pointText(probePoint.lng, probePoint.lat));
    return;
  }
  let base: string | null = null;
  if (probe != null) {
    if (data.wat) base = watText(data.wat, probe);
    else if (data.wind) base = windText(data.wind, probe);
    else if (data.currents) base = currentText(data.currents, probe);
  }
  if (base != null) popup.setHTML(withOverlay(base));
}

/** A value's text with the overlay's cell under it (when the overlay is on and the click hit one of its cells). */
function withOverlay(text: string): string {
  if (!overlay || data.wat || probeOv == null) return text;
  return `${text}<hr class="pop-rule">${watText(overlay, probeOv)}`;
}

/** One cell for the frame shown: the level, the current against the waves, and how much steeper they get. */
function watText(w: WatField, cell: number): string {
  if (watFrame < 0) return "no model hour at this time";
  const f = w.frames[watFrame];
  const when = `<small>${fmtProbe.format(new Date(f.valid_time))}, NWPS ${f.cycle.slice(11, 13)}Z run with NECOFS currents; a model-derived index</small>`;
  const j = f.i.indexOf(cell);
  if (j < 0) return `No meaningful wave-current interaction here<br>${when}`;
  const un = windUnit();
  const spd = (Math.hypot(f.u[j], f.v[j]) / 100) * un.perMs;
  const toward = ((Math.atan2(f.u[j], f.v[j]) * 180) / Math.PI + 360) % 360;
  const from = (f.to[j] + 180) % 360;
  const s = f.s[j];
  const effect = s >= 255 ? "the current is strong enough to stop these waves, which break at its edge" : `waves up to ${(s / 10).toFixed(1)} times steeper than in slack water`;
  return `<b>${WAT_LABELS[f.lv[j]]}</b><br>Current ${spd.toFixed(un.digits)} ${un.label} toward ${compass16(toward)} against ${((f.hs[j] / 100) * 3.28084).toFixed(1)} ft, ${(f.tp[j] / 10).toFixed(1)} s waves from ${compass16(from)}: ${effect}<br>${when}`;
}


/* ---------- Small-craft comfort index ---------- */

export type { Boat } from "./comfort-thresholds";
const stepLevel = (v: number, steps: number[]) => (v >= steps[2] ? 3 : v >= steps[1] ? 2 : v >= steps[0] ? 1 : 0);

/** The NWS zone (id) containing a point, from the zone outlines. */
function zoneAt(zones: PointSources["zones"], lng: number, lat: number): string | null {
  const inRing = (ring: number[][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const f of zones?.features ?? []) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates as number[][][]] : (f.geometry.coordinates as number[][][][]);
    if (polys.some((poly) => inRing(poly[0]) && !poly.slice(1).some(inRing))) return f.properties.id;
  }
  return null;
}

/** The strongest NWS advisory or warning in force for a zone at a time: 0 none, 1 small craft, 2 gale or worse. */
function advisoryAt(zone: string | null, t: number): { rank: number; name: string } {
  let best = { rank: 0, name: "" };
  if (!zone) return best;
  for (const a of alertsNow()?.alerts ?? []) {
    const span = a.by_zone?.[zone];
    if (!span) continue;
    const from = Date.parse(span.from ?? span.issued ?? "") / 1000;
    const until = Date.parse(span.until ?? a.ends ?? "") / 1000;
    if (!(t >= (Number.isFinite(from) ? from : -Infinity) && t < (Number.isFinite(until) ? until : Infinity))) continue;
    const rank = a.kind === "SC.Y" ? 1 : 2;
    if (rank > best.rank) best = { rank, name: a.event.toLowerCase() };
  }
  return best;
}

/** The comfort level at a point and time for a boat class, with the factors that set it. */
function comfortAt(src: PointSources, lng: number, lat: number, t: number, boat: Boat): { level: number; why: string[]; partial: boolean; zone: string | null; advisory: string } | null {
  const b = BOATS[boat];
  const un = windUnit();
  const metric = un.label === "m/s";
  const f: { level: number; text: string }[] = [];
  let partial = false;
  let hs = NaN;
  if (src.wind) {
    const id = nearestCell(src.wind.mesh, lng, lat, 3);
    const kt = id >= 0 ? valueAt(cellSeries(src.wind, id), t) * 1.943844 : NaN;
    if (Number.isFinite(kt)) f.push({ level: stepLevel(kt, b.wind), text: `wind ${(kt / 1.943844 * un.perMs).toFixed(un.digits)} ${un.label}` });
    else partial = true;
  }
  if (src.waves) {
    const id = nearestCell(src.waves.mesh, lng, lat, 2);
    hs = id >= 0 && !src.waves.mesh.land[id] ? valueAt(cellSeries(src.waves, id), t) : NaN;
    if (Number.isFinite(hs)) f.push({ level: stepLevel(hs, b.hs), text: `waves ${metric ? `${hs.toFixed(1)} m` : `${(hs * 3.28084).toFixed(1)} ft`}` });
  }
  if (b.current && src.currents) {
    const { mesh: m, currents: c } = src.currents;
    const cos = Math.cos((lat * Math.PI) / 180);
    let e = -1;
    let d2 = Infinity;
    m.centres.forEach(([x, y], i) => {
      const d = ((x - lng) * cos) ** 2 + (y - lat) ** 2;
      if (d < d2) [e, d2] = [i, d];
    });
    if (e >= 0 && Math.sqrt(d2) * 111.2 <= 2) {
      const s0 = Date.parse(c.t0) / 1000;
      const kt = valueAt(c.u.map((uk, j) => [s0 + j * c.step, Math.hypot(uk[e], c.v[j][e]) / 100] as [number, number]), t) * 1.943844;
      if (Number.isFinite(kt)) f.push({ level: stepLevel(kt, b.current), text: `current ${(kt / 1.943844 * un.perMs).toFixed(un.digits + 1)} ${un.label}` });
    }
  }
  if (src.wat) {
    const g = src.wat.grid;
    const i = Math.round((lng - g.lon0) / g.dlon);
    const j = Math.round((lat - g.lat0) / g.dlat);
    let wl = 0;
    let best = Infinity;
    for (const fr of src.wat.frames) {
      const d = Math.abs(Date.parse(fr.valid_time) / 1000 - t);
      if (d < best && d <= 3600) {
        best = d;
        const k = fr.i.indexOf(j * g.nx + i);
        wl = k >= 0 ? fr.lv[k] : 0;
      }
    }
    if (wl > 0) f.push({ level: b.wat[wl], text: WAT_LABELS[wl].toLowerCase() });
    // Breaking waves near 30% of the boat's length can capsize it beam-on (model tests after the 1979 Fastnet race).
    if (wl >= 3 && Number.isFinite(hs) && 1.8 * hs >= 0.3 * b.loa) f.push({ level: 3, text: "breaking waves near 30% of the boat's length" });
  }
  if (!f.length) return null;
  let level = Math.max(...f.map((x) => x.level));
  if (f.filter((x) => x.level >= 2).length >= 3) level = 3; // three factors at Uncomfortable compound
  const zone = zoneAt(src.zones, lng, lat);
  const adv = advisoryAt(zone, t);
  if (adv.rank === 2) {
    level = 3;
    f.push({ level: 3, text: adv.name });
  } else if (adv.rank === 1) {
    level = Math.max(level, b.sca);
    f.push({ level: b.sca, text: "small craft advisory" });
  }
  // Cold water: under 15 C raises the level by one where anything else is already Moderate or worse (always for paddle craft).
  const sst = src.sst ? rasterValueAt(src.sst, lng, lat)?.v ?? NaN : NaN;
  if (Number.isFinite(sst) && sst < 15 && (level >= 1 || boat === "kayak") && level < 3) {
    level += 1;
    f.push({ level, text: `water ${metric ? `${sst.toFixed(0)} C` : `${((sst * 9) / 5 + 32).toFixed(0)} F`}` });
  }
  const why = f.filter((x) => x.level >= level).map((x) => x.text);
  return { level, why: why.length ? why : f.filter((x) => x.level === Math.max(...f.map((y) => y.level))).map((x) => x.text), partial, zone, advisory: adv.rank === 2 ? adv.name : adv.rank === 1 ? "small craft advisory" : "" };
}

/** Four small squares, filled to the level: a word-sized gauge in the ink. */
function comfortGauge(level: number): string {
  return `<svg class="pop-gauge" viewBox="0 0 30 8" width="30" height="8" aria-hidden="true">${[0, 1, 2, 3]
    .map((k) => `<rect x="${k * 7.5 + 0.5}" y="0.5" width="6" height="7" class="${k <= level ? "on" : "off"}"/>`)
    .join("")}</svg>`;
}

function comfortLine(src: PointSources, lng: number, lat: number): string | null {
  const boat = controls?.boat ?? "console";
  const t = fieldT ?? Date.now() / 1000;
  const c = comfortAt(src, lng, lat, t, boat);
  if (!c) return null;
  return `<span class="pop-l1"><b>${BOATS[boat].name}: ${COMFORT_WORDS[c.level]}</b> ${comfortGauge(c.level)} <button type="button" class="pop-about" data-about="comfort" aria-label="About the comfort index">i</button></span>` +
    `<br><small>${c.level ? `limited by ${c.why.map((w) => (w === c.advisory && c.zone ? `<a href="${zoneForecastUrl(c.zone)}" target="_blank" rel="noopener" title="NWS marine forecast for ${c.zone}">${w}</a>` : w)).join("; ")}` : "within comfortable limits"}${c.partial ? "; beyond the wind forecast" : ""}</small>`;
}

/* ---------- Point readout (Wind & waves): every model at the clicked point ---------- */

let pointSrc: PointSources | null = null; // loaded on the first click
let probeRing: [number, number][] | null = null; // the clicked cell's outline (lon, lat corners) while its readout is open

/** The clicked model cell as a ring: the wave model's cell, or HRRR's where the waves have none (land, the edge). */
function cellRing(src: PointSources, lng: number, lat: number): [number, number][] | null {
  for (const [w, km] of [[src.waves, 2], [src.wind, 3]] as const) {
    if (!w) continue;
    const id = nearestCell(w.mesh, lng, lat, km);
    if (id < 0 || (w === src.waves && w.mesh.land[id])) continue;
    const { nx, corner_lon: x, corner_lat: y } = w.mesh;
    const j = Math.floor(id / nx);
    const i = id % nx;
    const c = (jj: number, ii: number): [number, number] => [x[jj * (nx + 1) + ii], y[jj * (nx + 1) + ii]];
    return [c(j, i), c(j, i + 1), c(j + 1, i + 1), c(j + 1, i), c(j, i)];
  }
  return null;
}

/** Draw (or clear) the clicked cell's outline, above the fields and below the labels. */
function drawProbeCell(map: maplibregl.Map): void {
  if (map.getLayer("probe-cell")) map.removeLayer("probe-cell");
  if (map.getSource("probe-cell")) map.removeSource("probe-cell");
  if (!probeRing) return;
  map.addSource("probe-cell", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: probeRing } } });
  map.addLayer({ id: "probe-cell", type: "line", source: "probe-cell", paint: { "line-color": mapTheme() === "light" ? "#1c2a48" : "#f4f1e8", "line-width": 2 } }, beneathLabels(map));
}
let probePoint: { lng: number; lat: number } | null = null; // the point the popup reads

/** The model cell whose centre is nearest a point, or -1 beyond maxKm (outside the model's grid). */
function nearestCell(m: WindField["mesh"], lng: number, lat: number, maxKm: number): number {
  const c = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let d2 = Infinity;
  for (let i = 0; i < m.centre_lon.length; i++) {
    const dx = (m.centre_lon[i] - lng) * c;
    const dy = m.centre_lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < d2) [best, d2] = [i, d];
  }
  return Math.sqrt(d2) * 111.2 <= maxKm ? best : -1;
}


/* Trend arrows and sparklines for the point readout. */
const SPARK_BACK = 6 * 3600; // the sparkline: 6 h before the time bar's hour to 42 h after
const SPARK_AHEAD = 42 * 3600;

const fmtMidnight = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const fmtDayShort = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });

/** Local midnights (America/New_York) between two times, epoch seconds. */
function midnights(t0: number, t1: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) if (Number(fmtMidnight.format(new Date(t * 1000))) % 24 === 0) out.push(t);
  return out;
}

/** The highest value ahead of the cursor within the sparkline's window, with its time. */
function peakAhead(pts: [number, number][], cursor: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const [t, v] of pts) if (t >= cursor && t <= cursor + SPARK_AHEAD && Number.isFinite(v) && (!best || v > best[1])) best = [t, v];
  return best;
}

/** A word-sized sparkline on a fixed 0..top scale from 6 h before the time bar's hour to 42 h after: faint ticks at
 * local midnights, the hour marked, a dot at the peak ahead. */
function sparkSvg(pts: [number, number][], top: number, cursor: number, colour: string): string {
  const W = 54;
  const H = 14;
  const t0 = cursor - SPARK_BACK;
  const t1 = cursor + SPARK_AHEAD;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - 1 - (Math.max(0, Math.min(top, v)) / top) * (H - 2);
  let d = "";
  let pen = false;
  for (const [t, v] of pts) {
    if (t < t0 - 3 * 3600 || t > t1 + 3 * 3600 || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  const ticks = midnights(t0, t1).map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${H - 4}" y2="${H}" class="pop-spark-tick"/>`).join("");
  const pk = peakAhead(pts, cursor);
  const dot = pk ? `<circle cx="${x(pk[0]).toFixed(1)}" cy="${y(pk[1]).toFixed(1)}" r="1.4" fill="${colour}"/>` : "";
  const cx = x(cursor).toFixed(1);
  return `<svg class="pop-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="6 hours back to 42 hours ahead"><title>6 h back to 42 h ahead; ticks at midnight; dot at the peak</title>` +
    `<line x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}" class="pop-spark-base"/>${ticks}` +
    `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1" stroke-linejoin="round"/>${dot}<line x1="${cx}" x2="${cx}" y1="0" y2="${H}" class="pop-spark-cur"/></svg>`;
}

/** A value of (time, value) points at t, linear between them; NaN outside. */
function valueAt(pts: [number, number][], t: number): number {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ta, a] = pts[i];
    const [tb, b] = pts[i + 1];
    if (t >= ta && t <= tb) return a + ((b - a) * (t - ta)) / (tb - ta || 1);
  }
  return NaN;
}

/** A model cell's speed (m/s for wind, m for waves) at every frame of a wind-shaped field, in time order. */
function cellSeries(w: WindField, id: number): [number, number][] {
  return w.frames
    .map((f, k) => {
      const { u, v } = windUV(w, k);
      return [Date.parse(f.valid_time) / 1000, Math.hypot(u[id], v[id])] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);
}

const sparkColours = () => (mapTheme() === "light" ? { wind: "#3f2477", waves: "#2d7aa3", current: "#5f920c" } : { wind: "#b7a2dd", waves: "#7fb8d8", current: "#c2c43a" });

function windLine(w: WindField, lng: number, lat: number): string | null {
  const id = nearestCell(w.mesh, lng, lat, 3);
  if (id < 0) return null;
  const k = windFrameAt(w);
  if (k < 0) return "<b>Wind</b> no HRRR hour at this time";
  const { u, v } = windUV(w, k);
  const from = ((Math.atan2(-u[id], -v[id]) * 180) / Math.PI + 360) % 360;
  const un = windUnit();
  const t = fieldT ?? Date.now() / 1000;
  const pts = cellSeries(w, id);
  const dKt = (valueAt(pts, t + 3 * 3600) - valueAt(pts, t)) * 1.943844;
  const word = !Number.isFinite(dKt) || Math.abs(dKt) < 2 ? "steady" : dKt > 0 ? "rising" : "easing";
  const pk = peakAhead(pts, t);
  const peak = pk ? `; peak ${(pk[1] * un.perMs).toFixed(un.digits)} ${un.label} ${fmtProbe.format(new Date(pk[0] * 1000))}` : "";
  return `<span class="pop-l1"><b>Wind</b> ${(Math.hypot(u[id], v[id]) * un.perMs).toFixed(un.digits)} ${un.label} from ${compass16(from)}${sparkSvg(pts, 35 * 0.514444, t, sparkColours().wind)}</span>` +
    `<br><small>${word}${peak}${w.mesh.land[id] ? ", land cell" : ""}</small>`;
}

function waveLine(w: WindField, lng: number, lat: number): string | null {
  const id = nearestCell(w.mesh, lng, lat, 2);
  if (id < 0 || w.mesh.land[id]) return null;
  const k = windFrameAt(w);
  if (k < 0) return "<b>Waves</b> no NWPS hour at this time";
  const { u, v } = windUV(w, k);
  const h = Math.hypot(u[id], v[id]);
  const from = ((Math.atan2(-u[id], -v[id]) * 180) / Math.PI + 360) % 360;
  const t = fieldT ?? Date.now() / 1000;
  const pts = cellSeries(w, id);
  const d = valueAt(pts, t + 3 * 3600) - valueAt(pts, t);
  const word = !Number.isFinite(d) || Math.abs(d) < 0.1 ? "steady" : d > 0 ? "building" : "easing";
  const metric = windUnit().label === "m/s";
  const ht = (m: number) => (metric ? `${m.toFixed(2)} m` : `${(m * 3.28084).toFixed(1)} ft`);
  const pk = peakAhead(pts, t);
  const peak = pk ? `; peak ${ht(pk[1])} ${fmtProbe.format(new Date(pk[0] * 1000))}` : "";
  return `<span class="pop-l1"><b>Waves</b> ${ht(h)} from ${compass16(from)}${sparkSvg(pts, 2.5, t, sparkColours().waves)}</span>` +
    `<br><small>${word}${peak}</small>`;
}

const fmtClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/** The current's tidal phase at an element for frame k: building or easing, and when it next turns (the along-axis
 * component crossing zero, between the 2 h steps), on the axis of the element's strongest current in the run. */
function localPhase(c: CurrentsField, id: number, k: number): string {
  let best = 0;
  let ax = 0;
  let ay = 1;
  for (let j = 0; j < c.steps; j++) {
    const s = Math.hypot(c.u[j][id], c.v[j][id]);
    if (s > best) [best, ax, ay] = [s, c.u[j][id] / s, c.v[j][id] / s];
  }
  if (best < 10) return "weak tidal current"; // under 10 cm/s (0.2 kt) at its strongest
  const along = (j: number) => c.u[j][id] * ax + c.v[j][id] * ay;
  const t = (j: number) => Date.parse(c.t0) / 1000 + j * c.step;
  let slack: number | null = null;
  for (let j = k; j < c.steps - 1; j++) {
    const a = along(j);
    const b = along(j + 1);
    if (a * b < 0) {
      slack = t(j) + (a / (a - b)) * c.step;
      break;
    }
  }
  const trend = k + 1 < c.steps && Math.abs(along(k + 1)) > Math.abs(along(k)) ? "building" : "easing";
  if (slack == null) return trend;
  const rounded = Math.round(slack / 600) * 600; // to 10 minutes: the steps are 2 h apart
  return `${trend}, turns about ${fmtClock.format(new Date(rounded * 1000))}`;
}

/** The NECOFS surface current at the element nearest the point (within 2 km), for the timeline's time. */
function currentLine(src: { mesh: CurrentsMesh; currents: CurrentsField }, lng: number, lat: number): string | null {
  const { mesh: m, currents: c } = src;
  const cos = Math.cos((lat * Math.PI) / 180);
  let id = -1;
  let d2 = Infinity;
  m.centres.forEach(([x, y], i) => {
    const d = ((x - lng) * cos) ** 2 + (y - lat) ** 2;
    if (d < d2) [id, d2] = [i, d];
  });
  if (id < 0 || Math.sqrt(d2) * 111.2 > 2) return null;
  const k = frameAt(c);
  if (k < 0) return "<b>Current</b> no model hour at this time";
  const u = c.u[k][id];
  const v = c.v[k][id];
  const un = windUnit();
  const toward = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const t = fieldT ?? Date.now() / 1000;
  const t0 = Date.parse(c.t0) / 1000;
  const pts: [number, number][] = c.u.map((uk, j) => [t0 + j * c.step, Math.hypot(uk[id], c.v[j][id]) / 100]);
  return `<span class="pop-l1"><b>Current</b> ${((Math.hypot(u, v) / 100) * un.perMs).toFixed(un.digits + 1)} ${un.label} toward ${compass16(toward)}${sparkSvg(pts, 1.5, t, sparkColours().current)}</span>` +
    `<br><small>${localPhase(c, id, k)}</small>`;
}

/** Two half-length arrows on a north-up ring, each running in from the bearing it comes from and ending at the centre:
 * opposed, their heads meet head-on; aligned, they stack, coming in from the same side; across, they form a V. The
 * waves are a wavy line in the waves layer's blue-teal, the current a straight line in the currents layer's
 * yellow-green, so the line style tells them apart without colour. */
function vectorsSvg(waveTo: number, currentTo: number): string {
  const R = 20;
  let wave = `M0 ${R}`;
  for (let y = R; y >= 0.5; y -= 0.5) wave += `L${(1.3 * Math.sin((y / 4.5) * Math.PI)).toFixed(2)} ${y}`;
  const head = "M-3.2 4.8L0 0.4L3.2 4.8";
  const light = mapTheme() === "light";
  const arrow = (d: string, deg: number, colour: string) =>
    `<g transform="rotate(${Math.round(deg)})" stroke="${colour}"><path d="${d}${head}" fill="none"/></g>`;
  return `<svg class="pop-vec" viewBox="-24 -29 48 53" width="48" height="53" role="img" aria-label="Waves toward ${compass16(waveTo)}, current toward ${compass16(currentTo)}">` +
    `<circle r="22" fill="none" class="pop-vec-ring"/><circle r="1" class="pop-vec-c"/><text x="0" y="-26" class="pop-vec-n">N</text>` +
    `<g stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">` +
    `${arrow(`M0 ${R}L0 0.4`, currentTo, light ? "#5f920c" : "#c2c43a")}${arrow(wave, waveTo, light ? "#2d7aa3" : "#7fb8d8")}</g></svg>`;
}

/** The waves' and the current's headings at a point (degrees toward), from the waves layer and the currents field,
 * for the compass where the wind-against-tide file has no cell. */
function headingsAt(src: PointSources, lng: number, lat: number): { waveTo: number; currentTo: number; along: number } | null {
  const w = src.waves;
  const c = src.currents;
  if (!w || !c) return null;
  const id = nearestCell(w.mesh, lng, lat, 2);
  const k = windFrameAt(w);
  const kc = frameAt(c.currents);
  if (id < 0 || k < 0 || kc < 0 || w.mesh.land[id]) return null;
  const { u, v } = windUV(w, k);
  const cos = Math.cos((lat * Math.PI) / 180);
  let e = -1;
  let d2 = Infinity;
  c.mesh.centres.forEach(([x, y], i) => {
    const d = ((x - lng) * cos) ** 2 + (y - lat) ** 2;
    if (d < d2) [e, d2] = [i, d];
  });
  if (e < 0 || Math.sqrt(d2) * 111.2 > 2) return null;
  const deg = (a: number, b: number) => ((Math.atan2(a, b) * 180) / Math.PI + 360) % 360;
  const waveTo = deg(u[id], v[id]);
  const cu = c.currents.u[kc][e];
  const cv = c.currents.v[kc][e];
  const rad = (waveTo * Math.PI) / 180;
  // along: cm/s of the current in the waves' direction (negative: opposing them).
  return { waveTo, currentTo: deg(cu, cv), along: cu * Math.sin(rad) + cv * Math.cos(rad) };
}

/** Wind against tide at the point: the cell's level whenever it has one, factored into its parts; "none" only while
 * the overlay is on. */
function watLine(w: WatField, lng: number, lat: number, on: boolean, heads: { waveTo: number; currentTo: number; along: number } | null = null): string | null {
  const { lon0, lat0, dlon, dlat, nx, ny } = w.grid;
  const i = Math.round((lng - lon0) / dlon);
  const j = Math.round((lat - lat0) / dlat);
  if (i < 0 || i >= nx || j < 0 || j >= ny) return null;
  const k = watFrameAt(w);
  if (k < 0) return on ? "No wave-current model hour at this time" : null;
  const cell = j * nx + i;
  const f = w.frames[k];
  if (!f.i.includes(cell)) {
    if (!on) return null;
    const fig = heads ? vectorsSvg(heads.waveTo, heads.currentTo) : "";
    const un = windUnit();
    const part = heads ? `${((Math.abs(heads.along) / 100) * un.perMs).toFixed(un.digits + 1)} ${un.label} ${heads.along < 0 ? "opposing" : "following"}` : "";
    const what = heads ? `Waves from ${compass16((heads.waveTo + 180) % 360)}, current toward ${compass16(heads.currentTo)}, ${part}.` : "";
    return `No wave-current steepening<br><small>${fig}${what}</small><hr class="pop-rule"><small class="pop-src">${fmtProbe.format(new Date(f.valid_time))}, NWPS + NECOFS (model)</small>`;
  }
  const j2 = f.i.indexOf(cell);
  const un = windUnit();
  const kt = (cms: number) => `${((cms / 100) * un.perMs).toFixed(un.digits + 1)} ${un.label}`; // currents: a decimal finer than wind
  const cu = f.u[j2];
  const cv = f.v[j2];
  const to = (f.to[j2] * Math.PI) / 180;
  const against = -(cu * Math.sin(to) + cv * Math.cos(to)); // cm/s of the current running against the waves
  const tp = f.tp[j2] / 10;
  const r = -(against / 100) / ((9.81 * tp) / (2 * Math.PI));
  // Linear theory for waves entering the current from slack water: the period holds, the crests close up (wavelength
  // ratio c^2) and rise (height ratio 1 / sqrt(c (c + 2r))), so the waves steepen.
  const cr = r > -0.25 ? (1 + Math.sqrt(1 + 4 * r)) / 2 : NaN;
  const closer = Math.round((1 - cr ** 2) * 100);
  const higher = Math.round((1 / Math.sqrt(cr * (cr + 2 * r)) - 1) * 100);
  const sr = f.s[j2];
  const effect = sr >= 255 ? "Waves blocked: they break at the current's edge" : `Crests ${closer}% closer, ${higher}% higher, up to ${(sr / 10).toFixed(1)}&times; steeper`;
  return `<b>${WAT_LABELS[f.lv[j2]]}</b>` +
    `<br><small>${vectorsSvg(f.to[j2], ((Math.atan2(cu, cv) * 180) / Math.PI + 360) % 360)}${((f.hs[j2] / 100) * 3.28084).toFixed(1)} ft ${tp.toFixed(1)} s waves from ${compass16((f.to[j2] + 180) % 360)}, ${kt(against)} opposing. ` +
    `${effect} (r ${r.toFixed(2)}).</small>` +
    `<hr class="pop-rule"><small class="pop-src">${fmtProbe.format(new Date(f.valid_time))}, NWPS ${f.cycle.slice(11, 13)}Z + NECOFS (model)</small>`;
}

/** The readout at a point: wind, waves, the current (when its layer shows), and wind against tide. */
function pointText(lng: number, lat: number): string {
  const src = pointSrc ?? {};
  const lines = [
    comfortLine(src, lng, lat),
    src.wind ? windLine(src.wind, lng, lat) : null,
    src.waves ? waveLine(src.waves, lng, lat) : null,
    src.currents ? currentLine(src.currents, lng, lat) : null,
    src.wat ? watLine(src.wat, lng, lat, !!overlay || !!data.wat, headingsAt(src, lng, lat)) : null,
  ].filter((l): l is string => !!l);
  if (!lines.length) return "No model cell here";
  return lines.join('<hr class="pop-rule">') + '<hr class="pop-rule"><button type="button" class="pop-detail">Cell detail</button>';
}


/* ---------- Cell detail: one cell's models on one time axis ---------- */

const CELL_BACK = 24 * 3600;
const CELL_AHEAD = 72 * 3600;
let cellAt: { lng: number; lat: number } | null = null;
let cellCursor: number | null = null; // the view's own cursor (epoch seconds); set by dragging, the time bar's hour on opening
let cellDialog: HTMLDialogElement | null = null;

/** A plot row: the series on a fixed 0..top scale across the view's window, midnight ticks, the cursor, the value at
 * the cursor written at the right (Tufte's direct label). */
function cellRow(label: string, unit: string, pts: [number, number][], top: number, scale: number, digits: number, colour: string, t0: number, t1: number, cursor: number): string {
  const W = 600;
  const H = 54;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - 2 - (Math.max(0, Math.min(top, v)) / top) * (H - 6);
  let d = "";
  let pen = false;
  for (const [t, v] of pts) {
    if (t < t0 || t > t1 || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(2)}`;
    pen = true;
  }
  const ticks = midnights(t0, t1).map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="0" y2="${H}" class="cell-tick"/>`).join("");
  const now = valueAt(pts, cursor);
  const read = Number.isFinite(now) ? `${(now * scale).toFixed(digits)} ${unit}` : "--";
  return `<div class="cell-row"><span class="cell-label">${label}<small>0 to ${(top * scale).toFixed(0)} ${unit}</small></span>` +
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cell-plot">${ticks}<line x1="0" x2="${W}" y1="${H - 2}" y2="${H - 2}" class="cell-base"/>` +
    `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
    `<line x1="${x(cursor).toFixed(1)}" x2="${x(cursor).toFixed(1)}" y1="0" y2="${H}" class="cell-cursor"/></svg><span class="cell-read">${read}</span></div>`;
}

/** Draw the open cell view for the time bar's hour. */
function renderCell(): void {
  if (!cellDialog || !cellAt || !cellDialog.open) return;
  const src = pointSrc ?? {};
  const { lng, lat } = cellAt;
  const now = Math.round(Date.now() / 3.6e6) * 3600;
  const t0 = now - CELL_BACK;
  const t1 = now + CELL_AHEAD;
  const cursor = cellCursor ?? fieldT ?? Date.now() / 1000;
  const un = windUnit();
  const c = sparkColours();
  const metric = un.label === "m/s";
  const rows: string[] = [];
  const notes: string[] = [];
  if (src.wind) {
    const id = nearestCell(src.wind.mesh, lng, lat, 3);
    if (id >= 0) {
      rows.push(cellRow("Wind", un.label, cellSeries(src.wind, id), 35 * 0.514444, un.perMs, un.digits, c.wind, t0, t1, cursor));
      const k = windFrameAt(src.wind);
      if (k >= 0) notes.push(`wind HRRR ${src.wind.frames[k].cycle.slice(11, 13)}Z run, ${src.wind.frames[k].lead} h ahead`);
    }
  }
  if (src.waves) {
    const id = nearestCell(src.waves.mesh, lng, lat, 2);
    if (id >= 0 && !src.waves.mesh.land[id]) {
      rows.push(cellRow("Waves", metric ? "m" : "ft", cellSeries(src.waves, id), 2.5, metric ? 1 : 3.28084, metric ? 2 : 1, c.waves, t0, t1, cursor));
      const k = windFrameAt(src.waves);
      if (k >= 0) notes.push(`waves NWPS ${src.waves.frames[k].cycle.slice(11, 13)}Z run`);
    }
  }
  if (src.currents) {
    const { mesh: m, currents: cur } = src.currents;
    const cos = Math.cos((lat * Math.PI) / 180);
    let e = -1;
    let d2 = Infinity;
    m.centres.forEach(([x0, y0], i) => {
      const dd = ((x0 - lng) * cos) ** 2 + (y0 - lat) ** 2;
      if (dd < d2) [e, d2] = [i, dd];
    });
    if (e >= 0 && Math.sqrt(d2) * 111.2 <= 2) {
      const s0 = Date.parse(cur.t0) / 1000;
      const pts: [number, number][] = cur.u.map((uk, j) => [s0 + j * cur.step, Math.hypot(uk[e], cur.v[j][e]) / 100]);
      rows.push(cellRow("Current", un.label, pts, 1.5, un.perMs, un.digits + 1, c.current, t0, t1, cursor));
      notes.push(`current NECOFS run of ${fmtDay.format(new Date(cur.generated_at))}`);
    }
  }
  if (src.wat) {
    const g = src.wat.grid;
    const i = Math.round((lng - g.lon0) / g.dlon);
    const j = Math.round((lat - g.lat0) / g.dlat);
    if (i >= 0 && i < g.nx && j >= 0 && j < g.ny) {
      const cellIx = j * g.nx + i;
      const W = 600;
      const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
      let blocks = "";
      for (const f of src.wat.frames) {
        const t = Date.parse(f.valid_time) / 1000;
        const k = f.i.indexOf(cellIx);
        if (k < 0 || t < t0 || t > t1) continue;
        blocks += `<rect x="${x(t - 3600).toFixed(1)}" width="${(x(t + 3600) - x(t - 3600)).toFixed(1)}" y="0" height="14" class="cell-lv cell-lv${f.lv[k]}"><title>${WAT_LABELS[f.lv[k]]}, ${fmtProbe.format(new Date(t * 1000))}</title></rect>`;
      }
      const wf = src.wat.frames[watFrameAt(src.wat)];
      const k = wf ? wf.i.indexOf(cellIx) : -1;
      const now = k >= 0 ? WAT_LABELS[wf!.lv[k]].toLowerCase() : "none";
      rows.push(`<div class="cell-row"><span class="cell-label">Wave-current<small>darker: steeper</small></span><svg viewBox="0 0 ${W} 14" preserveAspectRatio="none" class="cell-plot cell-band">` +
        `${midnights(t0, t1).map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="0" y2="14" class="cell-tick"/>`).join("")}${blocks}` +
        `<line x1="${x(cursor).toFixed(1)}" x2="${x(cursor).toFixed(1)}" y1="0" y2="14" class="cell-cursor"/></svg><span class="cell-read">${now}</span></div>`);
    }
  }
  {
    const boat = controls?.boat ?? "console";
    const W = 600;
    const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
    let blocks = "";
    for (let t = t0; t <= t1; t += 3600) {
      const cf = comfortAt(src, lng, lat, t, boat);
      if (!cf || cf.partial) continue;
      blocks += `<rect x="${x(t - 1800).toFixed(1)}" width="${(x(t + 1800) - x(t - 1800)).toFixed(1)}" y="0" height="14" class="cell-cf cell-cf${cf.level}"><title>${COMFORT_WORDS[cf.level]}, ${fmtProbe.format(new Date(t * 1000))}${cf.level ? `: ${cf.why.join("; ")}` : ""}</title></rect>`;
    }
    const now = comfortAt(src, lng, lat, cursor, boat);
    rows.unshift(`<div class="cell-row"><span class="cell-label">Comfort<small>${BOATS[boat].name.toLowerCase()}</small></span><svg viewBox="0 0 ${W} 14" preserveAspectRatio="none" class="cell-plot cell-band">` +
      `${midnights(t0, t1).map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="0" y2="14" class="cell-tick"/>`).join("")}${blocks}` +
      `<line x1="${x(cursor).toFixed(1)}" x2="${x(cursor).toFixed(1)}" y1="0" y2="14" class="cell-cursor"/></svg><span class="cell-read">${now ? COMFORT_WORDS[now.level].toLowerCase() : "--"}</span></div>`);
  }
  const days = midnights(t0, t1).map((t) => `<span style="left:${((((t - t0) / (t1 - t0)) * 100) + 0.5).toFixed(2)}%">${fmtDayShort.format(new Date((t + 6 * 3600) * 1000))}</span>`).join("");
  const nowMark = `<span class="cell-now" style="left:${(((now - t0) / (t1 - t0)) * 100).toFixed(2)}%">now</span>`;
  cellDialog.querySelector(".cell-body")!.innerHTML =
    `<p class="cell-head"><b>${lat.toFixed(3)} N, ${Math.abs(lng).toFixed(3)} W</b> <span>${fmtProbe.format(new Date(cursor * 1000))}; drag across the plots to read another hour</span></p>` +
    rows.join("") +
    `<div class="cell-row cell-axis-row"><span></span><div class="cell-axis">${days}${nowMark}</div><span></span></div>` +
    `<p class="cell-note">${notes.join("; ")}. Models, not measurements; fixed scales as on the map. 24 h back to 72 h ahead (HRRR wind to 48 h).</p>`;
}

function openCell(at: { lng: number; lat: number }): void {
  if (!cellDialog) {
    cellDialog = document.createElement("dialog");
    cellDialog.className = "cell-dialog";
    cellDialog.setAttribute("aria-label", "Cell detail");
    cellDialog.innerHTML = `<div class="cell-body"></div><button type="button" class="cell-close">Close</button>`;
    document.body.append(cellDialog);
    cellDialog.querySelector(".cell-close")!.addEventListener("click", () => cellDialog!.close());
    cellDialog.addEventListener("click", (e) => {
      if (e.target === cellDialog) cellDialog!.close();
    });
    cellDialog.addEventListener("close", () => (cellAt = null));
    // Dragging across the plots moves the view's own cursor (to the hour); the page behind stays as it is.
    let dragging = false;
    const scrub = (e: PointerEvent) => {
      const plot = cellDialog!.querySelector(".cell-plot");
      if (!plot) return;
      const r = plot.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const now = Math.round(Date.now() / 3.6e6) * 3600;
      const t = Math.round((now - CELL_BACK + f * (CELL_BACK + CELL_AHEAD)) / 3600) * 3600;
      if (t === cellCursor) return;
      cellCursor = t;
      renderCell();
    };
    cellDialog.addEventListener("pointerdown", (e) => {
      if (!(e.target as Element).closest?.(".cell-plot")) return;
      dragging = true;
      scrub(e);
    });
    cellDialog.addEventListener("pointermove", (e) => {
      if (dragging) scrub(e);
    });
    window.addEventListener("pointerup", () => (dragging = false));
  }
  cellAt = at;
  cellCursor = null; // opens at the time bar's hour
  cellDialog.showModal();
  renderCell();
}

/** The readout's (i) buttons open their About entry (lis.ts listens). */
document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest?.(".pop-about") as HTMLElement | null;
  if (b?.dataset.about) document.dispatchEvent(new CustomEvent("lhzn-about", { detail: { key: b.dataset.about } }));
});

/** Escape closes the map's readout (the cell view, a dialog, closes itself first). */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popup && !document.querySelector("dialog[open]")) closeValue();
});

/** The popup's "Cell detail" link (the popup's HTML is rewritten as the time moves, so one listener on the page). */
document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest?.(".pop-detail");
  if (b && probePoint) openCell({ ...probePoint });
});

/** The frame nearest the timeline's time (now by default), or -1 when the time is outside the model run. */
function frameAt(c: CurrentsField): number {
  const k = Math.round(((fieldT ?? Date.now() / 1000) - Date.parse(c.t0) / 1000) / c.step);
  return k >= 0 && k < c.steps ? k : -1;
}

/** Follow the page timeline: the currents move to its time; satellite fields are daily and keep their dates. */
export async function setFieldTime(t: number | null): Promise<void> {
  fieldT = t;
  if (probePoint) refreshPopup();
  if (cellAt && cellCursor == null) renderCell();
  if (data.history) return showHistoryFrame(historyIndex(data.history));
  if (overlay && !data.wat) {
    const k = watFrameAt(overlay);
    if (k !== watFrame) {
      watFrame = k;
      const box = document.getElementById("map");
      if (box) renderPanel(box);
      paintWat(await mapReady());
    }
  }
  if (data.wat) {
    const k = watFrameAt(data.wat);
    if (k === watFrame) return;
    watFrame = k;
    const box = document.getElementById("map");
    if (box) renderPanel(box);
    return paintWat(await mapReady());
  }
  if (data.wind) {
    const k = windFrameAt(data.wind);
    if (k === windFrame) return;
    windFrame = k;
    const box = document.getElementById("map");
    if (box) renderPanel(box); // the key shows the hour and run
    return paintWind(await mapReady());
  }
  const c = data.currents;
  if (!c) return;
  const k = frameAt(c);
  if (k === frame) return;
  const edge = (k < 0) !== (frame < 0);
  frame = k;
  if (edge) {
    const box = document.getElementById("map");
    if (box) renderPanel(box); // the key says when there is no model hour
  }
  paintFrame(await mapReady());
}

/* ---------- Panel ---------- */

const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });


function scaleHtml(meta: Meta, ripKey = false): string {
  if (ripKey || active === "wat") {
    return `<div class="field-scale wat-scale">${[1, 2, 3, 4].map((l) => `<span>${ripSwatch(l)}${WAT_SHORT[l]}</span>`).join("")}</div>`;
  }
  if (isWaves()) {
    const at = (m: number) => `${((m / WAVE_TOP) * 100).toFixed(1)}%`;
    const stops = waveStops().map(([m, c]) => `${c} ${at(m)}`);
    return `<div class="field-scale"><span>0</span><i class="field-bar" style="background:linear-gradient(90deg,${stops.join(",")})"></i><span>${(WAVE_TOP * 3.28084).toFixed(0)} ft (${WAVE_TOP} m)</span></div>`;
  }
  if (active === "wind") {
    const un = windUnit();
    const at = (s: number) => `${((s / WIND_TOP) * 100).toFixed(1)}%`;
    const stops = windStops().map(([s, c]) => `${c} ${at(s)}`);
    const v = (s: number) => (s * un.perMs).toFixed(0);
    return `<div class="field-scale"><span>0</span><i class="field-bar" style="background:linear-gradient(90deg,${stops.join(",")})"></i><span>${v(WIND_TOP)} ${un.label}</span></div>`;
  }
  const ramp = RAMPS[meta.ramp];
  // Currents are stored in cm/s and shown in the reader's unit.
  const sp = active === "currents" && controls ? controls.speed : null;
  const fmt = (v: number) => (v === 0 ? "0" : sp ? (v * sp.perCms).toFixed(sp.digits) : meta.log && v < 1 ? v.toFixed(2) : v.toFixed(meta.digits));
  return `<div class="field-scale"><span>${fmt(range[0])}</span><i class="field-bar" style="background:linear-gradient(90deg,${ramp.join(",")})"></i><span>${fmt(range[1])} ${sp ? sp.label : meta.unit}</span></div>`;
}

/** "Oct 7", or a span for a composite: "Oct 1-7", "Sep 30-Oct 7". */
function daySpan(from: Date, to: Date): string {
  const a = fmtDay.format(from);
  const b = fmtDay.format(to);
  if (a === b) return b;
  const [ma] = a.split(" ");
  const [mb, db] = b.split(" ");
  return ma === mb ? `${a}\u2013${db}` : `${a}\u2013${mb} ${db}`;
}


function renderPanel(fallback: HTMLElement): void {
  // Below the map when the page has the slot (the key never covers the field), on the map otherwise.
  const container = document.getElementById("map-foot") ?? fallback;
  panel?.remove();
  if (!controls) return;
  syncControls();
  const meta = active ? META[active] : null;
  if (!meta || !active) {
    panel = null; // no field, no panel: the map stays clear
    return;
  }
  panel = document.createElement("div");
  panel.className = "field-panel";
  let body = "";
  {
    const r = data.raster;
    const c = data.currents;
    const w = data.wind;
    const wt = data.wat;
    const tf = wt && watFrame >= 0 ? wt.frames[watFrame] : null;
    // The dates of the data, not of the job: from the oldest pixel in a composite to the newest.
    const ages = r ? r.age_days.filter((a): a is number => a != null) : [];
    const newest = ages.length ? Math.min(...ages) : 0;
    const oldest = ages.length ? Math.max(...ages) : 0;
    const day = (age: number) => new Date(Date.parse(r!.time) - age * 86400e3);
    const wf = w && windFrame >= 0 ? w.frames[windFrame] : null;
    const when = wt
      ? tf
        ? `${fmtProbe.format(new Date(tf.valid_time))}, NWPS ${tf.cycle.slice(11, 13)}Z run`
        : "no model hour"
      : r
      ? daySpan(day(r.window_days > 2 ? oldest : newest), day(newest))
      : c
        ? frame >= 0
          ? "model"
          : "no model hour"
        : w
          ? wf
            ? `${fmtProbe.format(new Date(wf.valid_time))}, ${wf.cycle.slice(11, 13)}Z run`
            : isWaves() ? "no NWPS hour" : "no HRRR hour"
          : "";
    const span = r && r.window_days > 2 && oldest - newest >= 1 ? ` Each pixel is the latest clear view in the last ${Math.round(oldest) + 1} days; older pixels are fainter.` : "";
    const run = wt
      ? " Every 2 hours from 24h back to 72h ahead: the newest NWPS run for each hour with the day's NECOFS currents; the time bar below moves it."
      : c
      ? ` Run of ${fmtDay.format(new Date(c.generated_at))}, covering 24h back to 72h ahead; the time bar below moves it.`
      : w
        ? isWaves()
          ? " Each hour from the newest NWPS run that covers it (00 and 12 UTC), 24h back to 72h ahead; the time bar below moves it."
          : " Each hour from the newest HRRR run that covers it, 24h back to 48h ahead; the time bar below moves it."
        : "";
    const credit = wt ? wt.attribution : r ? r.attribution : c ? c.source : w ? w.attribution : "";
    body = `<div class="field-key"><span class="field-name" title="${meta.title}">${meta.short}</span><span class="field-when">${when}</span>
      <button type="button" class="field-info" aria-haspopup="dialog" aria-label="About this layer" title="About this layer">i</button></div>
      ${scaleHtml(meta)}
      <p class="field-note" hidden><b>${meta.title}.</b> ${meta.note}${span}${run} <span class="field-credit">${credit}</span></p>`;
    if (overlay && !wt) {
      const of = watFrame >= 0 ? overlay.frames[watFrame] : null;
      body += `<div class="field-key field-overlay"><span class="field-name" title="${META.wat.title}">+ ${META.wat.short}</span><span class="field-when">${of ? `NWPS ${of.cycle.slice(11, 13)}Z run` : "no model hour"}</span>
        <button type="button" class="field-info" data-about="map-wat" aria-haspopup="dialog" aria-label="About wind against tide" title="About wind against tide">i</button>${scaleHtml(META.wat, true)}</div>`;
    }
  }
  panel.innerHTML = body;
  container.prepend(panel);
  panel.querySelectorAll<HTMLButtonElement>(".field-info").forEach((info) =>
    info.addEventListener("click", () => {
      if (!active) return;
      // The page shows the layer's explanation in its About dialog (lis.ts listens).
      document.dispatchEvent(new CustomEvent("lhzn-about", { detail: { key: info.dataset.about ?? `map-${active}` } }));
    }),
  );
}

/* ---------- Map controls: expand and layers ---------- */

const ICON_EXPAND = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
const ICON_SHRINK = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8 3v5H3M17 8h-5V3M12 17v-5h5M3 12h5v5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
const ICON_LAYERS = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 3l7 4-7 4-7-4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10.5l7 4 7-4M3 14l7 4 7-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

let expandButton: HTMLButtonElement | null = null;
let layersButton: HTMLButtonElement | null = null;
let drawer: HTMLElement | null = null;

/** Keep the controls' state in step with the page's (the wide state and the chosen layer). */
function syncControls(): void {
  if (expandButton && controls) {
    expandButton.innerHTML = controls.wide ? ICON_SHRINK : ICON_EXPAND;
    const label = controls.wide ? "Smaller map" : "Larger map";
    expandButton.title = label;
    expandButton.setAttribute("aria-label", label);
    expandButton.setAttribute("aria-pressed", String(controls.wide));
  }
  if (drawer && controls) renderDrawer();
}

function renderDrawer(): void {
  if (!drawer || !controls) return;
  const btn = (c: FieldControls["choices"][number]) =>
    `<button type="button" class="layers-choice" data-kind="${c.kind}" aria-pressed="${c.kind === controls!.chosen}">${c.label}</button>`;
  const main = controls.choices.filter((c) => !c.more);
  const more = controls.choices.filter((c) => c.more);
  const open = more.some((c) => c.kind === controls!.chosen);
  const ov = controls.overlay;
  drawer.innerHTML = `<p class="layers-title">Layer</p>${main.map(btn).join("")}` +
    (more.length ? `<details class="layers-more"${open ? " open" : ""}><summary>More layers</summary>${more.map(btn).join("")}</details>` : "") +
    (ov ? `<p class="layers-title">Overlay</p><button type="button" class="layers-choice layers-overlay" aria-pressed="${ov.on}">${ov.label}</button>` : "");
}

function closeDrawer(): void {
  drawer?.remove();
  drawer = null;
  layersButton?.setAttribute("aria-expanded", "false");
}

function openDrawer(container: HTMLElement): void {
  drawer = document.createElement("div");
  drawer.className = "layers-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Map layer");
  renderDrawer();
  drawer.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".layers-choice");
    if (!b || !controls) return;
    closeDrawer();
    if (b.classList.contains("layers-overlay")) controls.overlay?.onToggle(!controls.overlay.on);
    else controls.onPick(b.dataset.kind as FieldKind | "none");
  });
  container.appendChild(drawer);
  layersButton?.setAttribute("aria-expanded", "true");
  drawer.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
}

function addControls(map: maplibregl.Map): void {
  const group = document.createElement("div");
  group.className = "maplibregl-ctrl maplibregl-ctrl-group field-ctrls";
  expandButton = document.createElement("button");
  expandButton.type = "button";
  expandButton.addEventListener("click", () => controls?.onWide(!controls.wide));
  layersButton = document.createElement("button");
  layersButton.type = "button";
  layersButton.innerHTML = ICON_LAYERS;
  layersButton.title = "Map layer";
  layersButton.setAttribute("aria-label", "Map layer");
  layersButton.setAttribute("aria-haspopup", "dialog");
  layersButton.setAttribute("aria-expanded", "false");
  layersButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (drawer) closeDrawer();
    else openDrawer(map.getContainer());
  });
  group.append(expandButton, layersButton);
  map.addControl({ onAdd: () => group, onRemove: () => group.remove() }, "top-right");
  document.addEventListener("click", (e) => {
    if (drawer && !drawer.contains(e.target as Node)) closeDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer) {
      closeDrawer();
      layersButton?.focus();
    }
  });
  syncControls();
}

/* ---------- Public ---------- */

function draw(map: maplibregl.Map): void {
  clear(map);
  if (!active) return;
  if (data.wat) addWat(map, data.wat);
  else if (data.raster) addRaster(map, data.raster);
  else if (data.mesh && data.currents) addCurrents(map, data.mesh, data.currents);
  else if (data.wind) addWind(map, data.wind);
  if (overlay && !data.wat) addWat(map, overlay, !(data.wind || data.currents));
  drawProbeCell(map); // after a theme switch, the outline comes back on top
}

/** Show a field (or none) with its data, and the panel with the page's controls. */
export async function showField(kind: FieldKind | null, payload: FieldData, ctl: FieldControls): Promise<void> {
  const sameLayer = kind === active && payload.raster === shownRaster && payload.currents === data.currents && payload.wind === data.wind && payload.wat === data.wat && (payload.overlay ?? null) === overlay;
  if (!sameLayer) closeValue(); // a value from another layer
  active = kind;
  data = kind ? { ...payload } : {};
  overlay = kind && kind !== "wat" ? (payload.overlay ?? null) : null;
  delete data.overlay;
  shownRaster = payload.raster;
  controls = ctl;
  histIndex = -1;
  if (data.history) {
    histIndex = historyIndex(data.history);
    data.raster = historyRaster(data.history, histIndex);
  }
  if (data.currents) frame = frameAt(data.currents);
  if (data.wind) windFrame = windFrameAt(data.wind);
  const wat = watOf();
  watFrame = wat ? watFrameAt(wat) : -1;
  if (sameLayer) refreshPopup(); // e.g. the unit changed
  if (data.history) range = historyRange(data.history);
  else if (data.raster) range = rangeOf(META[data.raster.kind], data.raster.values.map((v) => (v == null ? NaN : v * data.raster!.scale)));
  else if (data.currents) range = META.currents.range!;
  else if (data.wind) range = META[isWaves() ? "waves" : "wind"].range!;
  // The panel first, so the picker, colour bar and source show while the map is still loading its tiles.
  const box = document.getElementById("map");
  if (box) renderPanel(box);
  const map = await mapReady();
  if (!clickBound) {
    clickBound = true;
    addControls(map);
    onStyle((m) => draw(m)); // a theme switch drops the layers; draw them again
    map.on("click", async (e) => {
      const r = data.raster;
      if (controls?.point) {
        const load = controls.point;
        pointSrc ??= await load().catch(() => ({}));
        const at = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        // 304 px: the widest value line (Current, with its arrow and sparkline) across units and values, in the popup's fonts.
        const ring = pointSrc ? cellRing(pointSrc, at.lng, at.lat) : null;
        await showValue(map, e.lngLat, pointText(at.lng, at.lat), null, null, null, "304px", true, ring);
        probePoint = at;
        probeRing = ring;
        drawProbeCell(map);
        return;
      }
      if (!active) return;
      if (r) {
        const text = rasterText(r, e.lngLat.lng, e.lngLat.lat);
        if (text) void showValue(map, e.lngLat, text, null, { lng: e.lngLat.lng, lat: e.lngLat.lat });
        return;
      }
      const wt = data.wat;
      if (wt) {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["wat-fill"] })[0];
        const cell = hit ? Number(hit.properties?.cell) : NaN;
        if (Number.isFinite(cell)) void showValue(map, e.lngLat, watText(wt, cell), cell);
        return;
      }
      const ovHit = overlay && map.getLayer("wat-fill") ? map.queryRenderedFeatures(e.point, { layers: ["wat-fill"] })[0] : undefined;
      const ovCell = ovHit ? Number(ovHit.properties?.cell) : NaN;
      const w = data.wind;
      if (w) {
        const cell = map.queryRenderedFeatures(e.point, { layers: ["wind-fill"] })[0];
        if (cell && typeof cell.id === "number") void showValue(map, e.lngLat, windText(w, cell.id), cell.id, null, Number.isFinite(ovCell) ? ovCell : null);
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ["cur-fill"] })[0];
      const c = data.currents;
      if (hit && c && typeof hit.id === "number") void showValue(map, e.lngLat, currentText(c, hit.id), hit.id, null, Number.isFinite(ovCell) ? ovCell : null);
    });
  }
  draw(map);
}

let popup: maplibregl.Popup | null = null;
let probe: number | null = null; // the current element the popup reads, so it can follow the timeline
let probeAt: { lng: number; lat: number } | null = null; // the raster point it reads, for history frames

async function showValue(map: maplibregl.Map, at: maplibregl.LngLat, text: string, element: number | null = null, point: { lng: number; lat: number } | null = null, ovCell: number | null = null, maxWidth = "240px", closable = false, beside: [number, number][] | null = null): Promise<void> {
  const ml = (await import("maplibre-gl")).default;
  closeValue();
  probe = element;
  probeAt = point;
  probeOv = ovCell;
  // Beside a cell: anchored on the side with more room, just past the cell's edge, so the cell stays in view.
  let place: { anchor?: maplibregl.PositionAnchor; offset?: [number, number] } = {};
  if (beside) {
    const c = map.project(at);
    const xs = beside.map((q) => map.project(q).x);
    const right = map.getContainer().clientWidth - c.x > c.x;
    place = right ? { anchor: "left", offset: [Math.max(...xs) - c.x + 10, 0] } : { anchor: "right", offset: [Math.min(...xs) - c.x - 10, 0] };
  }
  const p = new ml.Popup({ closeButton: closable, className: "pin-pop", maxWidth, focusAfterOpen: false, ...place }).setLngLat(at).setHTML(withOverlay(text)).addTo(map);
  p.on("close", () => {
    if (popup === p) {
      popup = null;
      probe = null;
      probeAt = null;
      probePoint = null;
      clearProbeCell();
    }
  });
  popup = p;
}

function closeValue(): void {
  popup?.remove();
  popup = null;
  probe = null;
  probeAt = null;
  probeOv = null;
  probePoint = null;
  clearProbeCell();
}

function clearProbeCell(): void {
  if (!probeRing) return;
  probeRing = null;
  void mapReady().then(drawProbeCell);
}
