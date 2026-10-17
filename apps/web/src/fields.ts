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
import { mapReady, mapTheme, onStyle } from "./map";

export type FieldKind = "sst" | "chl" | "kd490" | "currents" | "wind" | "waves";

export interface RasterField {
  kind: Exclude<FieldKind, "currents" | "wind" | "waves">;
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
    kind: Exclude<FieldKind, "currents" | "wind" | "waves">;
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

export interface FieldData {
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

/** Controls the page passes in: the layer picker and the full-width toggle. */
export interface FieldControls {
  choices: { kind: FieldKind | "none"; label: string; more?: boolean }[];
  chosen: FieldKind | "none";
  onPick: (kind: FieldKind | "none") => void;
  wide: boolean;
  onWide: (wide: boolean) => void;
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
  wind: { title: "Wind (HRRR)", short: "Wind, HRRR", ramp: "wind", log: false, range: [0, WIND_TOP], unit: "m/s", digits: 1, note: "Model forecast (NOAA HRRR), 10 m above the surface, on the model's own 3 km cells; arrows show where the wind blows toward. Cells HRRR counts as land are fainter." },
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

const LAYER_IDS = ["field-raster", "cur-fill", "cur-arrows", "wind-fill", "wind-arrows"];
const SOURCE_IDS = ["field-raster", "cur-mesh", "cur-points", "wind-cells", "wind-points"];

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
  if (popup && probe != null) popup.setHTML(currentText(c, probe));
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

/** Each HRRR cell as its own quadrilateral, from the corners the job published. */
function windCellsGeoJSON(w: WindField) {
  const { nx, ny, corner_lon: x, corner_lat: y, land } = w.mesh;
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
  const uv = k >= 0 ? windUV(w, k) : null;
  return {
    type: "FeatureCollection" as const,
    features: uv
      ? m.centre_lon.map((lon, i) => ({
          type: "Feature" as const,
          properties: { level: m.arrow_level[i], land: m.land[i], s: Math.hypot(uv.u[i], uv.v[i]), d: (Math.atan2(uv.u[i], uv.v[i]) * 180) / Math.PI },
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
  if (popup && probe != null) popup.setHTML(windText(w, probe));
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

/** The frame nearest the timeline's time (now by default), or -1 when the time is outside the model run. */
function frameAt(c: CurrentsField): number {
  const k = Math.round(((fieldT ?? Date.now() / 1000) - Date.parse(c.t0) / 1000) / c.step);
  return k >= 0 && k < c.steps ? k : -1;
}

/** Follow the page timeline: the currents move to its time; satellite fields are daily and keep their dates. */
export async function setFieldTime(t: number | null): Promise<void> {
  fieldT = t;
  if (data.history) return showHistoryFrame(historyIndex(data.history));
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


function scaleHtml(meta: Meta): string {
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
    // The dates of the data, not of the job: from the oldest pixel in a composite to the newest.
    const ages = r ? r.age_days.filter((a): a is number => a != null) : [];
    const newest = ages.length ? Math.min(...ages) : 0;
    const oldest = ages.length ? Math.max(...ages) : 0;
    const day = (age: number) => new Date(Date.parse(r!.time) - age * 86400e3);
    const wf = w && windFrame >= 0 ? w.frames[windFrame] : null;
    const when = r
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
    const run = c
      ? ` Run of ${fmtDay.format(new Date(c.generated_at))}, covering 24h back to 72h ahead; the time bar below moves it.`
      : w
        ? isWaves()
          ? " Each hour from the newest NWPS run that covers it (00 and 12 UTC), 24h back to 72h ahead; the time bar below moves it."
          : " Each hour from the newest HRRR run that covers it, 24h back to 48h ahead; the time bar below moves it."
        : "";
    const credit = r ? r.attribution : c ? c.source : w ? w.attribution : "";
    body = `<div class="field-key"><span class="field-name" title="${meta.title}">${meta.short}</span><span class="field-when">${when}</span>
      <button type="button" class="field-info" aria-haspopup="dialog" aria-label="About this layer" title="About this layer">i</button></div>
      ${scaleHtml(meta)}
      <p class="field-note" hidden><b>${meta.title}.</b> ${meta.note}${span}${run} <span class="field-credit">${credit}</span></p>`;
  }
  panel.innerHTML = body;
  container.prepend(panel);
  const info = panel.querySelector<HTMLButtonElement>(".field-info")!;
  info.addEventListener("click", () => {
    if (!active) return;
    // The page shows the layer's explanation in its About dialog (lis.ts listens).
    document.dispatchEvent(new CustomEvent("lhzn-about", { detail: { key: `map-${active}` } }));
  });
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
  drawer.innerHTML = `<p class="layers-title">Layer</p>${main.map(btn).join("")}` +
    (more.length ? `<details class="layers-more"${open ? " open" : ""}><summary>More layers</summary>${more.map(btn).join("")}</details>` : "");
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
    controls.onPick(b.dataset.kind as FieldKind | "none");
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
  if (data.raster) addRaster(map, data.raster);
  else if (data.mesh && data.currents) addCurrents(map, data.mesh, data.currents);
  else if (data.wind) addWind(map, data.wind);
}

/** Show a field (or none) with its data, and the panel with the page's controls. */
export async function showField(kind: FieldKind | null, payload: FieldData, ctl: FieldControls): Promise<void> {
  const sameLayer = kind === active && payload.raster === shownRaster && payload.currents === data.currents && payload.wind === data.wind;
  if (!sameLayer) closeValue(); // a value from another layer
  active = kind;
  data = kind ? { ...payload } : {};
  shownRaster = payload.raster;
  controls = ctl;
  histIndex = -1;
  if (data.history) {
    histIndex = historyIndex(data.history);
    data.raster = historyRaster(data.history, histIndex);
  }
  if (data.currents) frame = frameAt(data.currents);
  if (data.wind) windFrame = windFrameAt(data.wind);
  if (sameLayer && popup && probe != null && data.currents) popup.setHTML(currentText(data.currents, probe)); // e.g. the unit changed
  if (sameLayer && popup && probe != null && data.wind) popup.setHTML(windText(data.wind, probe));
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
    map.on("click", (e) => {
      const r = data.raster;
      if (!active) return;
      if (r) {
        const text = rasterText(r, e.lngLat.lng, e.lngLat.lat);
        if (text) void showValue(map, e.lngLat, text, null, { lng: e.lngLat.lng, lat: e.lngLat.lat });
        return;
      }
      const w = data.wind;
      if (w) {
        const cell = map.queryRenderedFeatures(e.point, { layers: ["wind-fill"] })[0];
        if (cell && typeof cell.id === "number") void showValue(map, e.lngLat, windText(w, cell.id), cell.id);
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ["cur-fill"] })[0];
      const c = data.currents;
      if (hit && c && typeof hit.id === "number") void showValue(map, e.lngLat, currentText(c, hit.id), hit.id);
    });
  }
  draw(map);
}

let popup: maplibregl.Popup | null = null;
let probe: number | null = null; // the current element the popup reads, so it can follow the timeline
let probeAt: { lng: number; lat: number } | null = null; // the raster point it reads, for history frames

async function showValue(map: maplibregl.Map, at: maplibregl.LngLat, text: string, element: number | null = null, point: { lng: number; lat: number } | null = null): Promise<void> {
  const ml = (await import("maplibre-gl")).default;
  closeValue();
  probe = element;
  probeAt = point;
  const p = new ml.Popup({ closeButton: false, className: "pin-pop" }).setLngLat(at).setHTML(text).addTo(map);
  p.on("close", () => {
    if (popup === p) {
      popup = null;
      probe = null;
      probeAt = null;
    }
  });
  popup = p;
}

function closeValue(): void {
  popup?.remove();
  popup = null;
  probe = null;
  probeAt = null;
}
