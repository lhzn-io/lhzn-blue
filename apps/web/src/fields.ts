/**
 * Surface fields on the locator map: satellite rasters (sea surface temperature, chlorophyll-a, Kd490) and modelled
 * surface currents on the FVCOM mesh, with a panel for the colour bar, the source and age, and (for currents) a time
 * slider. The data come from /data/v1/fields/ (see the jobs' fields.py); this module only draws them.
 *
 * Rasters are drawn on a canvas at the product's own resolution and placed as an image over their grid cells, so a
 * pixel is never smoothed into its neighbours; older pixels (a cloudy spell) are drawn fainter. Currents are drawn on
 * the model's own triangles, shaded by speed, with arrows at element centres thinned by zoom level, so the field is
 * shown as the model holds it rather than regridded.
 */
import type maplibregl from "maplibre-gl";
import { mapReady, mapTheme, onStyle } from "./map";

export type FieldKind = "sst" | "chl" | "kd490" | "currents";

export interface RasterField {
  kind: Exclude<FieldKind, "currents">;
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

export interface FieldData {
  raster?: RasterField;
  mesh?: CurrentsMesh;
  currents?: CurrentsField;
}

/** Controls the page passes in: the layer picker and the full-width toggle. */
export interface FieldControls {
  choices: { kind: FieldKind | "none"; label: string }[];
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
};

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
let frame = 0;
let fieldT: number | null = null; // the page timeline's time (epoch seconds), or null for now
let controls: FieldControls | null = null;
let panel: HTMLElement | null = null;
let clickBound = false;
let infoOpen: boolean | null = null; // the key's note: closed in the small map unless opened

const LAYER_IDS = ["field-raster", "cur-fill", "cur-arrows"];
const SOURCE_IDS = ["field-raster", "cur-mesh", "cur-points"];

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
  range = rangeOf(meta, values);
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
      paint: { "fill-color": ["interpolate", ["linear"], ["coalesce", ["feature-state", "s"], 0], ...stops] as maplibregl.ExpressionSpecification, "fill-opacity": 0.6, "fill-antialias": false },
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

/** Shade each triangle by speed at the current frame, and move the arrows. */
function paintFrame(map: maplibregl.Map): void {
  const { mesh: m, currents: c } = data;
  if (!m || !c || !map.getSource("cur-mesh")) return;
  const u = c.u[frame];
  const v = c.v[frame];
  for (let i = 0; i < u.length; i++) map.setFeatureState({ source: "cur-mesh", id: i }, { s: Math.hypot(u[i], v[i]) });
  (map.getSource("cur-points") as maplibregl.GeoJSONSource).setData(pointsGeoJSON(m, c, frame));
  if (popup && probe != null) popup.setHTML(currentText(c, probe));
}

const fmtProbe = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });

/** A current's value at one element for the frame shown, in the reader's unit, with its time. */
function currentText(c: CurrentsField, id: number): string {
  const u = c.u[frame][id];
  const v = c.v[frame][id];
  const deg = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const sp = controls?.speed ?? { label: "cm/s", perCms: 1, digits: 0 };
  const t = fmtProbe.format(new Date(Date.parse(c.t0) + frame * c.step * 1000));
  return `${(Math.hypot(u, v) * sp.perCms).toFixed(sp.digits + 1)} ${sp.label} toward ${Math.round(deg)}&deg;<br><small>${t}, model</small>`;
}

/** The frame nearest the timeline's time (now by default). */
function frameAt(c: CurrentsField): number {
  const k = Math.round(((fieldT ?? Date.now() / 1000) - Date.parse(c.t0) / 1000) / c.step);
  return Math.min(c.steps - 1, Math.max(0, k));
}

/** Follow the page timeline: the currents move to its time; satellite fields are daily and keep their dates. */
export async function setFieldTime(t: number | null): Promise<void> {
  fieldT = t;
  const c = data.currents;
  if (!c) return;
  const k = frameAt(c);
  if (k === frame) return;
  frame = k;
  paintFrame(await mapReady());
}

/* ---------- Panel ---------- */

const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });


function scaleHtml(meta: Meta): string {
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


function renderPanel(container: HTMLElement): void {
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
    // The dates of the data, not of the job: from the oldest pixel in a composite to the newest.
    const ages = r ? r.age_days.filter((a): a is number => a != null) : [];
    const newest = ages.length ? Math.min(...ages) : 0;
    const oldest = ages.length ? Math.max(...ages) : 0;
    const day = (age: number) => new Date(Date.parse(r!.time) - age * 86400e3);
    const when = r ? daySpan(day(r.window_days > 2 ? oldest : newest), day(newest)) : c ? "model" : "";
    const span = r && r.window_days > 2 && oldest - newest >= 1 ? ` Each pixel is the latest clear view in the last ${Math.round(oldest) + 1} days; older pixels are fainter.` : "";
    const run = c ? ` Run of ${fmtDay.format(new Date(c.generated_at))}, covering 24h back to 72h ahead; the time bar below moves it.` : "";
    const credit = r ? r.attribution : c ? c.source : "";
    const open = infoOpen ?? controls.wide;
    body = `<div class="field-key"><span class="field-name" title="${meta.title}">${meta.short}</span><span class="field-when">${when}</span>
      <button type="button" class="field-info" aria-expanded="${open}" aria-label="About this layer" title="About this layer">i</button></div>
      ${scaleHtml(meta)}
      <p class="field-note"${open ? "" : " hidden"}><b>${meta.title}.</b> ${meta.note}${span}${run} <span class="field-credit">${credit}</span></p>`;
  }
  panel.innerHTML = body;
  container.appendChild(panel);
  const info = panel.querySelector<HTMLButtonElement>(".field-info")!;
  info.addEventListener("click", () => {
    infoOpen = info.getAttribute("aria-expanded") !== "true";
    info.setAttribute("aria-expanded", String(infoOpen));
    panel!.querySelector<HTMLElement>(".field-note")!.hidden = !infoOpen;
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
  drawer.innerHTML = `<p class="layers-title">Layer</p>${controls.choices
    .map((c) => `<button type="button" class="layers-choice" data-kind="${c.kind}" aria-pressed="${c.kind === controls!.chosen}">${c.label}</button>`)
    .join("")}`;
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
}

/** Show a field (or none) with its data, and the panel with the page's controls. */
export async function showField(kind: FieldKind | null, payload: FieldData, ctl: FieldControls): Promise<void> {
  const sameLayer = kind === active && payload.raster === data.raster && payload.currents === data.currents;
  if (!sameLayer) closeValue(); // a value from another layer
  active = kind;
  data = kind ? payload : {};
  controls = ctl;
  if (data.currents) frame = frameAt(data.currents);
  if (sameLayer && popup && probe != null && data.currents) popup.setHTML(currentText(data.currents, probe)); // e.g. the unit changed
  if (data.raster) range = rangeOf(META[data.raster.kind], data.raster.values.map((v) => (v == null ? NaN : v * data.raster!.scale)));
  else if (data.currents) range = META.currents.range!;
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
        const at = rasterValueAt(r, e.lngLat.lng, e.lngLat.lat);
        if (!at) return;
        const meta = META[r.kind];
        void showValue(map, e.lngLat, `${at.v.toFixed(meta.digits)} ${meta.unit}${Number.isFinite(at.age) ? `, ${at.age.toFixed(1)}d old` : ""}`);
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

async function showValue(map: maplibregl.Map, at: maplibregl.LngLat, text: string, element: number | null = null): Promise<void> {
  const ml = (await import("maplibre-gl")).default;
  closeValue();
  probe = element;
  const p = new ml.Popup({ closeButton: false, className: "pin-pop" }).setLngLat(at).setHTML(text).addTo(map);
  p.on("close", () => {
    if (popup === p) {
      popup = null;
      probe = null;
    }
  });
  popup = p;
}

function closeValue(): void {
  popup?.remove();
  popup = null;
  probe = null;
}
