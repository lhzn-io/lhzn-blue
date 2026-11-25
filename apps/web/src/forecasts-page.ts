/**
 * "About the forecasts" (/long-island-sound/forecasts/): the models behind the site's forecasts, what each gives, how
 * finely each sees the water and how each has scored. The table and prose are in the page; this script draws:
 *
 * - Their grids: one small panel per model over the same patch of the eastern Sound (BOX, around The Race), finest
 *   first, each model's cell edges over NECOFS's mesh shaded as water (a common reference for the shore). Plain
 *   canvas, no basemap: the cells are the subject. Data: v1/fields/currents-mesh.json (NECOFS), nwps-waves.json (its
 *   mesh only) and model-grids.json (the five wind models), the files the Sound's map and "Wind models compared" read.
 * - How they score: the wind models' mean absolute speed error by lead, 1 to 48 hours, one sparkline each on one shared
 *   scale, from the verification files behind "Forecast verification".
 */
import "./site.css";
import "./away-links";
import { mountAdvisories } from "./advisory";
import "./models-page.css"; // the masthead and lede shared with "Wind models compared"
import "./forecasts-page.css";
import { dualCells } from "./dual-cells";

const DATA = "/data/v1";
const $ = (id: string) => document.getElementById(id)!;

// ---------- Data ----------

/** The patch every panel shows: the eastern Sound from New London to The Race (west, south, east, north). */
const BOX: [number, number, number, number] = [-72.45, 41.12, -71.85, 41.36];
const COS = Math.cos(((BOX[1] + BOX[3]) / 2) * (Math.PI / 180)); // equirectangular about the patch's middle
const KM_PER_DEG = 111.32;
const PLACES: [string, number, number][] = [
  ["New London", -72.095, 41.355],
  ["The Race", -72.06, 41.235],
];

interface CurrentsMesh {
  nodes: [number, number][];
  triangles: [number, number, number][];
}
interface NwpsMesh {
  nx: number;
  ny: number;
  corner_lon: number[];
  corner_lat: number[];
  land: number[];
}
type Grid = { type: "quads"; nx: number; ny: number; lon: number[]; lat: number[] } | { type: "tri"; n: number; tri: number[] };
interface GridModel {
  id: string;
  label: string;
  grid_label: string;
  spacing_km: number;
  grid: Grid;
}
interface Stats {
  n: number;
  bias: number;
  mae: number;
}
interface Verification {
  first_valid: string;
  through: string;
  leads: number[];
  by_lead: Record<string, { all: Stats } | undefined>;
}

async function getJson<T>(rel: string): Promise<T | null> {
  try {
    const r = await fetch(`${DATA}/${rel}.json`, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** A model's cells as polygons (lon, lat rings, not closed). */
type Ring = [number, number][];
function quadRings(nx: number, ny: number, lon: number[], lat: number[], keep: (r: number, q: number) => boolean = () => true): Ring[] {
  const cw = nx + 1;
  const P = (r: number, q: number): [number, number] => [lon[r * cw + q], lat[r * cw + q]];
  const out: Ring[] = [];
  for (let r = 0; r < ny; r++) for (let q = 0; q < nx; q++) if (keep(r, q)) out.push([P(r, q), P(r, q + 1), P(r + 1, q + 1), P(r + 1, q)]);
  return out;
}
function gridRings(g: Grid): Ring[] {
  if (g.type === "quads") return quadRings(g.nx, g.ny, g.lon, g.lat);
  const out: Ring[] = [];
  for (let i = 0; i < g.n; i++) {
    const t = g.tri.slice(i * 6, i * 6 + 6);
    out.push([
      [t[0], t[1]],
      [t[2], t[3]],
      [t[4], t[5]],
    ]);
  }
  return out;
}
const meshRings = (m: CurrentsMesh): Ring[] => m.triangles.map((t) => t.map((i) => m.nodes[i]) as Ring);
const centre = (r: Ring): [number, number] => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
const inBox = ([x, y]: [number, number]) => x >= BOX[0] && x <= BOX[2] && y >= BOX[1] && y <= BOX[3];
const touches = (r: Ring) => {
  const xs = r.map((p) => p[0]);
  const ys = r.map((p) => p[1]);
  return Math.max(...xs) >= BOX[0] && Math.min(...xs) <= BOX[2] && Math.max(...ys) >= BOX[1] && Math.min(...ys) <= BOX[3];
};

// ---------- Their grids ----------

interface PanelSpec {
  id: string;
  label: string;
  gives: string;
  spacing: string;
  rings: Ring[] | null; // null: the file did not load
}
let WATER: Ring[] = []; // NECOFS's triangles in the patch, the shaded water in every panel
let ISOBATHS: [[number, number], [number, number]][] = []; // depth contour segments (lon, lat), every level together

/** The depths the isobaths follow, in meters: every 10 m to 30, then 50 and 80 (the Race's deepest water). */
const ISOBATH_M = [10, 20, 30, 50, 80];
/** The 3D view's frame (lis_pane.py): east and north meters from the Groton current meter, equirectangular. */
const ORIGIN = [-72.0923, 41.3918];
const EARTH_M = 6371000;

/** Isobaths from NECOFS's still-water depth at its nodes (the 3D view's whole-Sound subset, v1/lis-pane/sound/):
 * marching triangles, linear within each triangle, kept to the triangles that reach the patch. */
async function isobaths(): Promise<void> {
  try {
    const [nb, tb] = await Promise.all(
      ["nodes.f32", "tri.u16"].map((f) => fetch(`${DATA}/lis-pane/sound/${f}`, { cache: "no-cache" }).then((r) => (r.ok ? r.arrayBuffer() : null))),
    );
    if (!nb || !tb) return;
    const nodes = new Float32Array(nb); // east m, north m, depth m (positive down)
    const tri = new Uint16Array(tb);
    const k = (180 / Math.PI) / EARTH_M;
    const lon = (e: number) => ORIGIN[0] + (e * k) / Math.cos((ORIGIN[1] * Math.PI) / 180);
    const lat = (n: number) => ORIGIN[1] + n * k;
    const P = (i: number): [number, number, number] => [lon(nodes[3 * i]), lat(nodes[3 * i + 1]), nodes[3 * i + 2]];
    const out: [[number, number], [number, number]][] = [];
    for (let t = 0; t + 2 < tri.length; t += 3) {
      const v = [P(tri[t]), P(tri[t + 1]), P(tri[t + 2])];
      if (!touches(v.map(([x, y]) => [x, y]) as Ring)) continue;
      for (const L of ISOBATH_M) {
        const cut: [number, number][] = [];
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
          const [ha, hb] = [v[a][2] - L, v[b][2] - L];
          if (ha * hb < 0) {
            const f = ha / (ha - hb);
            cut.push([v[a][0] + f * (v[b][0] - v[a][0]), v[a][1] + f * (v[b][1] - v[a][1])]);
          }
        }
        if (cut.length === 2) out.push([cut[0], cut[1]]);
      }
    }
    ISOBATHS = out;
    redraw();
  } catch {
    /* the panels stand without them */
  }
}
const panels: { spec: PanelSpec; canvas: HTMLCanvasElement }[] = [];

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw(spec: PanelSpec, canvas: HTMLCanvasElement): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const sx = w / (BOX[2] - BOX[0]);
  const sy = h / (BOX[3] - BOX[1]);
  const X = (lon: number) => (lon - BOX[0]) * sx;
  const Y = (lat: number) => (BOX[3] - lat) * sy;
  const path = (r: Ring) => {
    g.moveTo(X(r[0][0]), Y(r[0][1]));
    for (let i = 1; i < r.length; i++) g.lineTo(X(r[i][0]), Y(r[i][1]));
    g.closePath();
  };
  // Water: NECOFS's triangles filled as one path, so no edge of theirs shows (only the NECOFS panel draws them).
  g.beginPath();
  for (const r of WATER) path(r);
  g.fillStyle = css("--fp-water");
  g.fill();
  // Isobaths, very faint: where the water deepens, under every grid alike.
  if (ISOBATHS.length) {
    g.beginPath();
    for (const [a, b] of ISOBATHS) {
      g.moveTo(X(a[0]), Y(a[1]));
      g.lineTo(X(b[0]), Y(b[1]));
    }
    g.strokeStyle = css("--fp-isobath");
    g.lineWidth = 0.7;
    g.stroke();
  }
  // The model's cell edges.
  if (spec.rings) {
    g.beginPath();
    for (const r of spec.rings) path(r);
    g.strokeStyle = css("--fp-edge");
    g.lineWidth = spec.rings.length > 2000 ? 0.35 : spec.rings.length > 200 ? 0.5 : 0.85;
    g.stroke();
  }
  // Place names, small and quiet.
  g.font = `400 9.5px ${css("--mono") || "monospace"}`;
  g.fillStyle = css("--dim");
  g.textBaseline = "middle";
  for (const [name, lon, lat] of PLACES) {
    const x = X(lon);
    const y = Y(lat);
    g.beginPath();
    g.arc(x, y, 1.6, 0, 2 * Math.PI);
    g.fill();
    g.fillText(name, x + 5, y);
  }
  // A 5 km bar in the lower left.
  const bar = (5 / (KM_PER_DEG * COS)) * sx;
  g.strokeStyle = css("--dim");
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(8, h - 10);
  g.lineTo(8 + bar, h - 10);
  g.moveTo(8, h - 13);
  g.lineTo(8, h - 7);
  g.moveTo(8 + bar, h - 13);
  g.lineTo(8 + bar, h - 7);
  g.stroke();
  g.fillText("5 km", 12 + bar, h - 10);
}

function addPanel(spec: PanelSpec, host: HTMLElement): void {
  const f = document.createElement("figure");
  f.className = "fp-panel";
  const cap = document.createElement("figcaption");
  const n = spec.rings ? spec.rings.filter((r) => inBox(centre(r))).length : 0;
  cap.innerHTML =
    `<span class="fp-cap-label">${spec.label}</span> <span class="fp-cap-sub">${spec.spacing}</span>` +
    `<span class="fp-cap-n">${spec.rings ? `${n.toLocaleString("en-US")} ${n === 1 ? "cell" : "cells"}` : "not loaded"}</span>`;
  const canvas = document.createElement("canvas");
  canvas.className = "fp-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", spec.rings ? `${spec.label}: ${n} cells in the patch around The Race, ${spec.spacing}` : `${spec.label}: grid not loaded`);
  const strip = document.createElement("div");
  strip.className = "fp-strip";
  strip.dataset.id = spec.id;
  f.append(cap, canvas, strip);
  host.append(f);
  panels.push({ spec, canvas });
}

function redraw(): void {
  for (const p of panels) draw(p.spec, p.canvas);
}

/** The Northeast Shelf's tile store: its latest DOPPIO run carries the whole grid's water cells. */
const TILES = import.meta.env.DEV ? "/tiles/shelf/v1/" : "https://tiles.lhzn.blue/shelf/v1/";

/** DOPPIO's water cells, from the head of the shelf's latest DOPPIO file (shelf.py, tiles.encode: gzip of "LHZT", a
 * uint32 header length, a JSON header, the nodes as float32 lon, lat, then the cells' corner indices, then the values).
 * Only the geometry is needed: the first HEAD_BYTES of the gzip (the store serves byte ranges) hold it, decompressed as a
 * stream that stops once the geometry has arrived; the whole file is the fallback. */
const HEAD_BYTES = 512 * 1024;
let DOPPIO_AHEAD = 0; // hours ahead of its run that the latest DOPPIO file reaches, once read
async function doppioRings(): Promise<Ring[] | null> {
  try {
    const latest = await fetch(`${TILES}latest.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null));
    const m = latest?.models?.doppio;
    const wide: string | undefined = m?.wide;
    if (!wide) return null;
    const run = /^(\d{4})(\d{2})(\d{2})T(\d{2})Z$/.exec(String(m.run ?? ""));
    if (run && m.t0 && m.steps && m.step) {
      const runMs = Date.UTC(+run[1], +run[2] - 1, +run[3], +run[4]);
      DOPPIO_AHEAD = Math.round((Date.parse(m.t0) + m.steps * m.step * 1000 - runMs) / 3.6e6);
    }
    return (await doppioHead(TILES + wide, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } })) ?? (await doppioHead(TILES + wide, {}));
  } catch {
    return null;
  }
}
async function doppioHead(url: string, init: RequestInit): Promise<Ring[] | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok || !r.body) return null;
    const reader = r.body.pipeThrough(new DecompressionStream("gzip")).getReader();
    let buf = new Uint8Array(0);
    let need = Infinity;
    let head: { nodes: number; elements: number; verts: number; index: string } | null = null;
    const idxBytes = () => (head!.index === "u32" ? 4 : 2);
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      if (!head && buf.length >= 8) {
        const n = new DataView(buf.buffer).getUint32(4, true);
        if (buf.length >= 8 + n) {
          head = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + n)));
          need = 8 + n + head!.nodes * 8 + head!.elements * head!.verts * idxBytes();
        }
      }
      if (buf.length >= need || done) break;
    }
    void reader.cancel().catch(() => {});
    if (!head || buf.length < need || new TextDecoder().decode(buf.subarray(0, 4)) !== "LHZT") return null;
    const at = need - head.nodes * 8 - head.elements * head.verts * idxBytes();
    const ab = buf.slice(at, need).buffer;
    const nodes = new Float32Array(ab, 0, head.nodes * 2);
    const count = head.elements * head.verts;
    const idx = head.index === "u32" ? new Uint32Array(ab, head.nodes * 8, count) : new Uint16Array(ab, head.nodes * 8, count);
    const out: Ring[] = [];
    for (let e = 0; e < head.elements; e++) {
      const ring: Ring = [];
      for (let k = 0; k < head.verts; k++) {
        const i = idx[e * head.verts + k];
        ring.push([nodes[2 * i], nodes[2 * i + 1]]);
      }
      if (touches(ring)) out.push(ring);
    }
    return out;
  } catch {
    return null;
  }
}

async function grids(): Promise<void> {
  const [cm, nw, mg, dp, wg] = await Promise.all([
    getJson<CurrentsMesh>("fields/currents-mesh"),
    getJson<{ mesh: NwpsMesh }>("fields/nwps-waves"),
    getJson<{ models: GridModel[] }>("fields/model-grids"),
    doppioRings(),
    getJson<{ models: Record<string, { grid: { type: string; lon: number[]; lat: number[]; tri: number[] } }> }>("fields/wave-grids"),
  ]);
  const necofs = cm ? meshRings(cm).filter(touches) : null;
  WATER = necofs ?? [];
  let nwps: Ring[] | null = null;
  if (nw?.mesh) {
    const m = nw.mesh;
    nwps = quadRings(m.nx, m.ny, m.corner_lon, m.corner_lat, (r, q) => !m.land[r * m.nx + q]).filter(touches);
  }
  // NECOFS's waves sit on its mesh nodes: each drawn as its median dual cell.
  const ng = wg?.models?.necofs?.grid;
  const necofsWaves = ng && ng.type === "nodes" ? dualCells(ng.lon, ng.lat, ng.tri).filter((r) => r.length > 3 && touches(r)) : null;
  const wind = new Map((mg?.models ?? []).map((m) => [m.id, m]));
  const windSpec = (id: string, label: string, spacing: string): PanelSpec => {
    const m = wind.get(id);
    return { id, label, gives: "wind", spacing, rings: m ? gridRings(m.grid).filter(touches) : null };
  };
  // By what each forecasts, finest cells first in each group.
  const groups: [string, PanelSpec[]][] = [
    ["Wind", [windSpec("hrdps", "HRDPS", "2.5 km"), windSpec("hrrr", "HRRR", "3 km"), windSpec("icon", "ICON", "13 km triangles"), windSpec("ecmwf", "ECMWF", "0.25°"), windSpec("gfs", "GFS", "0.25°")]],
    [
      "Waves",
      [
        { id: "nwps", label: "NWPS", gives: "waves", spacing: "1.8 km, water cells", rings: nwps },
        { id: "necofs-waves", label: "NECOFS", gives: "waves", spacing: "dual cells, 0.2 to 1.5 km", rings: necofsWaves },
      ],
    ],
    [
      "Currents",
      [
        { id: "necofs", label: "NECOFS", gives: "currents", spacing: "triangles, 0.2 to 1.5 km", rings: necofs },
        { id: "doppio", label: "DOPPIO", gives: "currents", spacing: "7 km, water cells", rings: dp },
      ],
    ],
  ];
  for (const [name, specs] of groups) {
    const h = document.createElement("h3");
    h.className = "fp-sub";
    h.textContent = name;
    const grid = document.createElement("div");
    grid.className = "fp-grid";
    $("grids-panels").append(h, grid);
    for (const spec of specs) addPanel(spec, grid);
  }
  void isobaths();
  if (!cm || !nw || !mg || !dp || !wg) {
    const e = $("grids-error");
    e.hidden = false;
    e.textContent = "Some model grids did not load; they show with the next forecast update.";
  }
  redraw();
  let pending = 0;
  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(pending);
    pending = window.requestAnimationFrame(redraw);
  });
}

// ---------- Time under each grid ----------

/** Under each map, on one linear lead axis from now to GFS's 7 days: a bar for how far ahead the site shows the model,
 * a tick for each of its time steps (dense ticks: a fine step), and for the wind models, above the bar, the mean absolute
 * error of wind speed against the buoys by lead, one scale (0 to YMAX kt) in every panel. The wind records span
 * different periods (HRDPS's only weeks), so their lines are comparable in kind, not yet hour for hour. */
interface Strip {
  horizon: number; // hours ahead the site shows
  step: number; // hours between the steps the site uses
  ver?: string; // a verification file (the wind models)
  note?: string; // otherwise: how it is or will be scored
}
const STRIP: Record<string, Strip> = {
  necofs: { horizon: 72, step: 2, note: "to be scored against the current meter and HF radar" },
  nwps: { horizon: 72, step: 1, note: "to be scored against the buoys' wave heights" },
  "necofs-waves": { horizon: 72, step: 3, note: "compared, not yet scored" },
  hrdps: { horizon: 48, step: 1, ver: "forecast-verification-hrdps" },
  hrrr: { horizon: 48, step: 1, ver: "forecast-verification" },
  doppio: { horizon: 72, step: 2, note: "not scored" },
  icon: { horizon: 48, step: 3, note: "compared, not scored" },
  ecmwf: { horizon: 48, step: 3, note: "compared, not scored" },
  gfs: { horizon: 168, step: 3, ver: "forecast-verification-gfs" },
};
const MAX_LEAD = 168;
const fmtMonth = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const MINUS = "−";
const signed = (v: number) => (Math.abs(v) < 0.05 ? "0.0" : (v > 0 ? "+" : MINUS) + Math.abs(v).toFixed(1));
const ahead = (h: number) => (h % 24 === 0 && h > 48 ? `${h / 24} days` : `${h} h`);
const every = (h: number) => (h === 1 ? "hourly" : `every ${h} h`);

async function strips(): Promise<void> {
  const ids = Object.keys(STRIP);
  const vs = await Promise.all(ids.map((id) => (STRIP[id].ver ? getJson<Verification>(STRIP[id].ver!) : Promise.resolve(null))));
  const curves = new Map(
    ids.map((id, i) => {
      const v = vs[i];
      const pts = v ? v.leads.filter((L) => L <= MAX_LEAD).map((L) => [L, v.by_lead[String(L)]?.all] as const).filter((p): p is readonly [number, Stats] => !!p[1] && p[1].n > 0) : [];
      return [id, { v, pts }] as const;
    }),
  );
  const yMax = Math.ceil(Math.max(1, ...[...curves.values()].flatMap((c) => c.pts.map(([, s]) => s.mae))));
  // The strip's frame (viewBox units; it scales with the panel): the error plot on top, the bar, then the lead labels.
  const W = 360;
  const H = 52;
  const [x0, x1] = [4, W - 4];
  const [pTop, pBot] = [6, 30]; // the error plot: yMax at pTop, 0 at pBot
  const barY = 35;
  const X = (L: number) => x0 + ((x1 - x0) * L) / MAX_LEAD;
  const Y = (e: number) => pBot - ((pBot - pTop) * e) / yMax;
  const DAYS = [0, 24, 48, 72, 168];
  for (const el of document.querySelectorAll<HTMLElement>(".fp-strip")) {
    const id = el.dataset.id ?? "";
    const s = STRIP[id];
    if (!s) continue;
    const horizon = id === "doppio" && DOPPIO_AHEAD ? DOPPIO_AHEAD : s.horizon;
    const c = curves.get(id);
    let svg = `<line class="fp-base" x1="${x0}" x2="${x1}" y1="${barY}" y2="${barY}"/>`;
    svg += `<line class="fp-horizon" x1="${X(0)}" x2="${X(horizon)}" y1="${barY}" y2="${barY}"/>`;
    for (let L = s.step; L <= horizon; L += s.step) svg += `<line class="fp-step" x1="${X(L).toFixed(1)}" x2="${X(L).toFixed(1)}" y1="${barY - 5}" y2="${barY - 2.5}"/>`;
    svg += DAYS.map((L) => `<text x="${X(L)}" y="${H - 3}" text-anchor="${L === 0 ? "start" : L === MAX_LEAD ? "end" : "middle"}">${L === 0 ? "now" : `${L / 24} d`}</text>`).join("");
    // Unscored: the strip says so; the line under it adds only against what it will be scored.
    let meta = `${every(s.step)} to ${ahead(horizon)}${s.note?.startsWith("to be") ? `; ${s.note}` : ""}`;
    // The error plot's frame in every strip, so a missing line reads as missing, not as a shorter strip.
    svg += `<line class="fp-zero" x1="${x0}" x2="${x1}" y1="${pBot}" y2="${pBot}"/>`;
    if (!s.ver) svg += `<text class="fp-none" x="${(x0 + x1) / 2}" y="${(pTop + pBot) / 2 + 3}" text-anchor="middle">${s.note?.startsWith("to be") ? "not yet scored" : s.note}</text>`;
    if (s.ver) {
      if (c && c.v && c.pts.length) {
        const at = c.pts.find(([L]) => L === 24) ?? c.pts[c.pts.length - 1];
        const line = c.pts.map(([L, st], k) => `${k ? "L" : "M"}${X(L).toFixed(1)},${Y(st.mae).toFixed(1)}`).join("");
        svg +=
          `<text class="fp-y" x="${x0}" y="${pTop + 3}">${yMax} kt</text>` +
          `<text class="fp-y" x="${x0}" y="${pBot - 2}">0</text>` +
          `<path class="fp-line" d="${line}"/><circle class="fp-dot" cx="${X(at[0])}" cy="${Y(at[1].mae)}" r="2.2"/>` +
          `<text class="fp-val" x="${X(at[0]) + 5}" y="${Y(at[1].mae) - 4}">${at[1].mae.toFixed(1)}</text>`;
        meta =
          `${every(s.step)} to ${ahead(horizon)}; speed error ${at[1].mae.toFixed(1)} kt at ${at[0]} h, bias ${signed(at[1].bias)}, ` +
          `since ${fmtMonth.format(new Date(c.v.first_valid))}`;
      } else meta = `${every(s.step)} to ${ahead(horizon)}; scores load with the next update`;
    }
    el.innerHTML = `<svg class="fp-strip-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${svg}</svg><p class="fp-meta">${meta}</p>`;
  }
}

// ---------- Page ----------

function wireTheme(): void {
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

/** Each table cell's column name, for the phone layout's labels (the table's own head is hidden there). */
function labelTable(): void {
  const heads = [...document.querySelectorAll<HTMLElement>(".fp-table thead th")].map((h) => h.textContent ?? "");
  for (const tr of document.querySelectorAll(".fp-table tbody tr"))
    [...tr.children].forEach((cell, i) => {
      if (cell.tagName === "TD") cell.setAttribute("data-label", heads[i] ?? "");
    });
}

/** The headings' (i): each shows or hides the note it controls. */
function wireNotes(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".fp-i")) {
    const note = document.getElementById(b.getAttribute("aria-controls") ?? "");
    if (!note) continue;
    b.addEventListener("click", () => {
      note.hidden = !note.hidden;
      b.setAttribute("aria-expanded", String(!note.hidden));
    });
  }
}

wireTheme();
wireNotes();
labelTable();
void grids().then(strips);

// The NWS advisories in force on the Sound, in the masthead (links to the Wind view).
const mastEl = document.querySelector(".mast");
if (mastEl) void mountAdvisories(mastEl);
