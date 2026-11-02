/** A virtual buoy: any point on a waterway (/long-island-sound/at/41.050,-72.900/), shown as a station page from the
 * models the map already holds, read at that point in the browser: HRRR wind and gusts on its 3 km cell (and the
 * nearest GFS point past 48 h), NWPS waves on its 1.8 km cell, the NECOFS surface current on its triangle, and the
 * satellite water temperature on its pixel. Nothing is measured there; HRRR's and GFS's typical miss is borrowed from
 * the nearest buoy they are scored at (or the scored buoys together, where none is near), and named as such. */
import type { CurrentsField, CurrentsMesh, RasterHistory, WindField } from "../fields";
import type { Line } from "../chart";
import { DAY, getJson, grid, HOUR } from "../series";
import { compass } from "../wind-dir";
import { DATA, FORECAST_PAGE, requestRedraw } from "./data";
import type { Fig } from "./figures";
import { FCST, GFS, loadForecast, MS_KT, VER_AS, type FcRun } from "./forecast";
import { M } from "./models";
import type { StationData } from "./station-data";
import { currentSpeed, waveUnit, WIND_UNITS, windFmt, WU } from "./units";

export const VIRTUAL_ID = "AT";
const SCORED_KM = 25; // the nearest scored buoy's miss within this distance; the scored buoys together beyond
const GFS_KM = 20; // the nearest GFS point within this distance; no GFS beyond (it is published at the stations only)
const SHORE_KM = 2; // a point this close to an HRRR land cell reads a wind slowed by the land

type Place = { id: string; name: string; lat: number; lon: number };
let places: () => Place[] = () => [];
let stationUrl: (id: string) => string = () => "/";

/** Where the page's stations are, and their pages' addresses (for the nearest-station links). */
export function configureVirtual(o: { places: () => Place[]; stationUrl: (id: string) => string }): void {
  places = o.places;
  stationUrl = o.stationUrl;
}

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180), a.lat - b.lat) * 111.2;
const fmtKm = (d: number) => `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;

/** The point an address names (`<base>at/<lat>,<lon>/`), rounded to 3 decimals (about 110 m), or null; a point outside
 * the box is null too. */
export function virtualFromPath(path: string, base: string, box: [[number, number], [number, number]]): { lat: number; lon: number } | null {
  if (!path.startsWith(`${base}at/`)) return null;
  const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)\/?$/.exec(decodeURIComponent(path.slice(base.length + 3)));
  if (!m) return null;
  const lat = Math.round(Number(m[1]) * 1000) / 1000;
  const lon = Math.round(Number(m[2]) * 1000) / 1000;
  const [[w, s], [e, n]] = box;
  return lon >= w && lon <= e && lat >= s && lat <= n ? { lat, lon } : null;
}
/** The address of a point on a waterway's page (base: "/long-island-sound/"). */
export const virtualPath = (base: string, lat: number, lon: number) => `${base}at/${lat.toFixed(3)},${lon.toFixed(3)}/`;
export const pointName = (lat: number, lon: number) => `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? "E" : "W"}`;

/** The virtual station: no series, no readings; the figures below read the models at its point. */
export function makeVirtual(lat: number, lon: number): StationData {
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const empty = { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null };
  P = { lat, lon };
  return {
    kind: "virtual",
    meta: { id: VIRTUAL_ID, name: pointName(lat, lon), operator: "", lat, lon, note: null, info_url: null, series: [] },
    depths: [],
    ...empty,
    temp: { ...empty },
    views: {},
    obs: {},
    live: true,
    now,
    anchor: now,
    met: null,
    level: null,
    tides: [],
    levelNow: null,
    waves: null,
  };
}
let P: { lat: number; lon: number } | null = null;

/* ---------- The models at the point ---------- */

const b64int8 = (s: string, i: number) => (s.charCodeAt(i) << 24) >> 24; // one cell of an atob'd int8 string

/** The nearest cell centre within maxKm (water cells only, when asked), with its distance; -1 beyond. */
function nearest(m: { centre_lon: number[]; centre_lat: number[]; land: number[] }, maxKm: number, water: boolean): { i: number; km: number } {
  let best = -1;
  let d = Infinity;
  for (let i = 0; i < m.centre_lon.length; i++) {
    if (water && m.land[i]) continue;
    const k = km(P!, { lat: m.centre_lat[i], lon: m.centre_lon[i] });
    if (k < d) [best, d] = [i, k];
  }
  return d <= maxKm ? { i: best, km: d } : { i: -1, km: d };
}

interface Wind { cell: number; land: boolean; shoreKm: number; cycles: number }
interface Waves { cell: number; km: number; at: { t: number; hs: number; tp: number; to: number }[] }
interface Current { element: number; at: { t: number; u: number; v: number }[]; slack: number[] }
interface Sst { at: [number, number][]; newest: string }
export const VB: { wind?: Wind | null; waves?: Waves | null; current?: Current | null; sst?: Sst | null; scored?: { id: string; name: string; km: number } | null; gfs?: { id: string; name: string; km: number } | null } = {};
const loading = new Set<string>();
const once = (key: string, run: () => Promise<void>) => {
  if (loading.has(key)) return;
  loading.add(key);
  run()
    .catch((err) => console.warn(`virtual buoy: ${key}`, err))
    .finally(requestRedraw);
};

/** HRRR at the point: the nearest water cell within 3 km (the nearest cell of any kind where none is, as the map's
 * readout), one run per HRRR cycle in the grid file (each hour from the newest cycle that reaches it), in FCST under
 * the virtual id so the next-48-hours plot draws it as a station's; the nearest GFS point within GFS_KM likewise;
 * the nearest scored buoy within SCORED_KM lends its typical miss. */
export function loadVirtualWind(): void {
  once("wind", async () => {
    const [w] = await Promise.all([getJson<WindField>(`${DATA}/fields/hrrr-wind.json`), loadForecast()]);
    let c = nearest(w.mesh, 3, true);
    if (c.i < 0) c = nearest(w.mesh, 3, false);
    if (c.i < 0) {
      VB.wind = null;
      return;
    }
    let shoreKm = Infinity;
    w.mesh.land.forEach((l, i) => l && (shoreKm = Math.min(shoreKm, km(P!, { lat: w.mesh.centre_lat[i], lon: w.mesh.centre_lon[i] }))));
    const step = w.encoding.step;
    const gstep = (w.encoding as { gust_step?: number }).gust_step ?? step;
    const runs = new Map<string, FcRun>();
    for (const f of w.frames) {
      const issue = Date.parse(f.cycle.replace(/Z$/, ":00Z")) / 1000;
      const r = runs.get(f.cycle) ?? { issue, leads: [], u: [], v: [], gust: [], t2m: [], mslp: [] };
      runs.set(f.cycle, r);
      const g = (f as { gust?: string }).gust;
      r.leads.push(f.lead);
      r.u.push(b64int8(atob(f.u), c.i) * step);
      r.v.push(b64int8(atob(f.v), c.i) * step);
      r.gust.push(g ? b64int8(atob(g), c.i) * gstep : null);
      r.t2m.push(null);
      r.mslp.push(null);
    }
    if (FCST) FCST.runs[VIRTUAL_ID] = [...runs.values()].sort((a, b) => b.issue - a.issue);
    VB.wind = { cell: c.i, land: !!w.mesh.land[c.i], shoreKm, cycles: runs.size };
    // The miss: the nearest buoy HRRR is scored at, if near enough; otherwise the scored buoys together (no alias).
    const pl = places();
    const scored = Object.keys(FCST?.ver?.by_lead[FCST.ver.leads[0]]?.buoys ?? {})
      .map((id) => pl.find((p) => p.id === id))
      .filter((p): p is Place => !!p)
      .map((p) => ({ id: p.id, name: p.name, km: km(P!, p) }))
      .sort((a, b) => a.km - b.km);
    VB.scored = scored[0] ?? null;
    if (VB.scored && VB.scored.km <= SCORED_KM) VER_AS[VIRTUAL_ID] = VB.scored.id;
    const gfs = Object.keys(GFS?.runs ?? {})
      .filter((id) => id !== VIRTUAL_ID)
      .map((id) => pl.find((p) => p.id === id))
      .filter((p): p is Place => !!p)
      .map((p) => ({ id: p.id, name: p.name, km: km(P!, p) }))
      .sort((a, b) => a.km - b.km)[0];
    VB.gfs = gfs ?? null;
    if (GFS && gfs && gfs.km <= GFS_KM) GFS.runs[VIRTUAL_ID] = GFS.runs[gfs.id];
  });
}

/** NWPS at the point: the nearest water cell within 2 km, every frame (24 h back to 72 h ahead). */
export function loadVirtualWaves(): void {
  once("waves", async () => {
    type NwpsField = Omit<WindField, "encoding" | "frames"> & { encoding: { step: number; tp_step?: number }; frames: (WindField["frames"][number] & { tp?: string })[] };
    const w = await getJson<NwpsField>(`${DATA}/fields/nwps-waves.json`);
    const c = nearest(w.mesh, 2, true);
    if (c.i < 0) {
      VB.waves = null;
      return;
    }
    const at = (w.frames as NwpsField["frames"]).map((f) => {
      const u = b64int8(atob(f.u), c.i) * w.encoding.step;
      const v = b64int8(atob(f.v), c.i) * w.encoding.step;
      const tp = f.tp && w.encoding.tp_step ? b64int8(atob(f.tp), c.i) * w.encoding.tp_step : NaN;
      return { t: Date.parse(f.valid_time.replace(/Z$/, ":00Z")) / 1000, hs: Math.hypot(u, v), tp, to: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 };
    }).sort((a, b) => a.t - b.t);
    VB.waves = { cell: c.i, km: c.km, at };
  });
}

/** Whether a point is inside a triangle (lon, lat taken as plane coordinates: the triangles are under 2 km). */
function inside(p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean {
  const s = (q: [number, number], r: [number, number]) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** NECOFS at the point: the surface current on the triangle holding it, every 2 h step, and the slack times ahead
 * (where the component along the element's strongest current changes sign). */
export function loadVirtualCurrent(): void {
  once("current", async () => {
    const [mesh, c] = await Promise.all([
      getJson<CurrentsMesh>(`${DATA}/fields/currents-mesh.json`),
      import("../fields").then((f) => f.loadCurrents(`${DATA}/fields/`)) as Promise<CurrentsField>,
    ]);
    const p: [number, number] = [P!.lon, P!.lat];
    const e = mesh.triangles.findIndex(([a, b, d]) => inside(p, mesh.nodes[a], mesh.nodes[b], mesh.nodes[d]));
    if (e < 0) {
      VB.current = null;
      return;
    }
    const t0 = Date.parse(c.t0) / 1000;
    const at = Array.from({ length: c.steps }, (_, j) => ({ t: t0 + j * c.step, u: c.u[j][e], v: c.v[j][e] }));
    let best = 0, ax = 0, ay = 1;
    for (const s of at) {
      const sp = Math.hypot(s.u, s.v);
      if (sp > best) [best, ax, ay] = [sp, s.u / sp, s.v / sp];
    }
    const slack: number[] = [];
    if (best >= 10) {
      // under 10 cm/s (0.2 kt) at its strongest the current has no tide worth timing
      for (let j = 0; j + 1 < at.length; j++) {
        const a = at[j].u * ax + at[j].v * ay, b = at[j + 1].u * ax + at[j + 1].v * ay;
        if (a * b < 0) slack.push(at[j].t + (c.step * Math.abs(a)) / (Math.abs(a) + Math.abs(b)));
      }
    }
    VB.current = { element: e, at, slack };
  });
}

/** The satellite analysis at the point: its pixel in each of the last 90 days. */
export function loadVirtualSst(): void {
  once("sst", async () => {
    const res = await fetch(`${DATA}/fields/sst-90d.bin`);
    if (!res.ok) throw new Error(`sst-90d: HTTP ${res.status}`);
    const h: RasterHistory = await (await import("../fields")).decodeHistory(await res.arrayBuffer());
    const { grid: g, days, encoding: enc, age } = h.header;
    const i = Math.round((P!.lon - g.lon0) / g.dlon);
    const j = Math.round((P!.lat - g.lat0) / g.dlat);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) {
      VB.sst = null;
      return;
    }
    const px = g.nx * g.ny;
    const per = px * (age ? 2 : 1);
    const lo = enc.log10 ? Math.log10(enc.low) : enc.low;
    const hi = enc.log10 ? Math.log10(enc.high) : enc.high;
    const at: [number, number][] = [];
    days.forEach((day, k) => {
      const q = h.body[k * per + j * g.nx + i];
      if (q === 0) return;
      const x = lo + ((q - 1) / 254) * (hi - lo);
      at.push([Date.parse(`${day}T12:00:00Z`) / 1000, enc.log10 ? 10 ** x : x]);
    });
    VB.sst = at.length ? { at, newest: days[days.length - 1] } : null;
  });
}

/** Everything at once (the readouts read all four). */
export function loadVirtual(): void {
  loadVirtualWind();
  loadVirtualWaves();
  loadVirtualCurrent();
  loadVirtualSst();
}

/* ---------- Readouts and words ---------- */

const linear = <T extends { t: number }>(at: T[], t: number, pick: (x: T) => number): number => {
  for (let k = 0; k + 1 < at.length; k++) {
    if (t >= at[k].t && t <= at[k + 1].t) {
      const f = (t - at[k].t) / (at[k + 1].t - at[k].t || 1);
      return pick(at[k]) + (pick(at[k + 1]) - pick(at[k])) * f;
    }
  }
  return NaN;
};
const cToF = (c: number) => (c * 9) / 5 + 32;
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const fmtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

const readout = (num: string, unit: string, lab: string, sub: string) =>
  `<div class="readout"><div class="num">${num}<small>${unit}</small></div><span class="lab">${lab}</span><span class="sub">${sub}</span></div>`;

/** The readouts at an hour: the models' values, each named as a model. */
export function virtualReadouts(t: number): string {
  loadVirtual();
  const h = Math.round(t / HOUR) * HOUR;
  const out: string[] = [];
  const runs = FCST?.runs[VIRTUAL_ID] ?? [];
  const r = runs.find((q) => q.leads.includes(Math.round((h - q.issue) / HOUR)));
  if (r) {
    const k = r.leads.indexOf(Math.round((h - r.issue) / HOUR));
    const u = r.u[k] ?? NaN, v = r.v[k] ?? NaN, g = r.gust[k] ?? NaN;
    const from = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
    out.push(readout(windFmt(Math.hypot(u, v) * MS_KT), WIND_UNITS[WU].label, `Wind from ${compass(from)}`, `HRRR${Number.isFinite(g) ? `, gusts ${windFmt(g * MS_KT)}` : ""}`));
  } else out.push(readout("--", WIND_UNITS[WU].label, "Wind", VB.wind === null ? "no HRRR cell" : "loading"));
  const wv = VB.waves;
  const hs = wv ? linear(wv.at, h, (x) => x.hs) : NaN;
  const tp = wv ? linear(wv.at, h, (x) => x.tp) : NaN;
  const to = wv?.at.find((x) => Math.abs(x.t - h) < HOUR)?.to;
  out.push(readout(Number.isFinite(hs) ? (hs * waveUnit().factor).toFixed(waveUnit().digits) : "--", waveUnit().label, to != null ? `Waves from ${compass((to + 180) % 360)}` : "Waves", wv === null ? "no NWPS cell" : `NWPS${Number.isFinite(tp) ? `, ${tp.toFixed(1)} s` : ""}`));
  const cu = VB.current;
  const cs = currentSpeed();
  const cuU = cu ? linear(cu.at, h, (x) => x.u) : NaN;
  const cuV = cu ? linear(cu.at, h, (x) => x.v) : NaN;
  const slack = cu?.slack.find((s) => s > t); // after the readout's own time, not its rounded hour (up to 30 min earlier)
  out.push(readout(Number.isFinite(cuU) ? (Math.hypot(cuU, cuV) * cs.perCms).toFixed(cs.digits) : "--", cs.label, Number.isFinite(cuU) ? `Current toward ${compass(((Math.atan2(cuU, cuV) * 180) / Math.PI + 360) % 360)}` : "Current", cu === null ? "outside the NECOFS mesh" : `NECOFS${slack ? `, slack ${fmtWhen.format(new Date(slack * 1000))}` : ""}`));
  const s = VB.sst?.at[VB.sst.at.length - 1];
  out.push(readout(s ? cToF(s[1]).toFixed(1) : "--", "°F", "Water temperature", VB.sst === null ? "no satellite pixel" : s ? `satellite, ${fmtDay.format(new Date(s[0] * 1000))}` : "satellite"));
  return out.join("");
}

/** The heading's lines: what the page is, and the stations nearest the point. */
export function virtualIntro(d: StationData): { sid: string; links: string; note: string } {
  const near = places()
    .map((p) => ({ ...p, km: km(d.meta, p) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  const land = VB.wind?.land && VB.waves === null && VB.current === null;
  const shore = land ? " On land: HRRR wind only." : VB.wind && VB.wind.shoreKm <= SHORE_KM ? " Near shore: the wind's real miss is larger." : "";
  return {
    sid: "Virtual buoy",
    links: `<span>Nearest:</span>${near.map((p) => `<a href="${stationUrl(p.id)}">${p.name} (${fmtKm(p.km)})</a>`).join("")}`,
    note: `Models only; nothing is measured here.${shore}`,
  };
}

/** The status column on a virtual buoy's page: where each value at this point comes from, and how far away. */
export function virtualSources(): string {
  const s = VB.scored;
  const g = VB.gfs;
  const row = (k: string, v: string) => `<div class="ol-row vb-row"><span class="ol-k">${k}</span><span class="ol-v">${v}</span></div>`;
  const wait = "loading";
  return `<section class="outlook vb-sources" aria-label="Where this point's values come from">
    <p class="ol-title">At this point</p>
    ${row("Wind", VB.wind === undefined ? wait : VB.wind ? `HRRR, 3 km ${VB.wind.land ? "land " : ""}cell` : "no HRRR cell")}
    ${row("Miss", s === undefined ? wait : s && s.km <= SCORED_KM ? `${s.name}, ${fmtKm(s.km)}` : "the 4 scored buoys")}
    ${row("Past 48 h", g === undefined ? wait : g && g.km <= GFS_KM ? `GFS at ${g.name}, ${fmtKm(g.km)}` : `no GFS within ${GFS_KM} km`)}
    ${row("Waves", VB.waves === undefined ? wait : VB.waves ? "NWPS, 1.8 km cell" : "no NWPS cell")}
    ${row("Current", VB.current === undefined ? wait : VB.current ? "NECOFS triangle" : "outside NECOFS")}
    ${row("Water", VB.sst === undefined ? wait : VB.sst ? "MUR satellite, 1 km" : "no satellite pixel")}
    <p class="status-key">Click the map to read another point.</p>
  </section>`;
}

/** The miss's line in the next-48-hours plot: whose it is, and how far away. */
export function virtualMiss(): { label: string; note: string } {
  const s = VB.scored;
  const near = s && s.km <= SCORED_KM;
  const g = VB.gfs;
  const gNote = !g ? "" : g.km <= GFS_KM ? ` &middot; past 48 h: GFS at ${g.name}` : ` &middot; no GFS within ${GFS_KM} km`;
  return {
    label: near ? `Typical miss at ${s.name}` : "Typical miss, 4 scored buoys",
    note:
      `NOAA HRRR, raw, 3 km cell &middot; <a class="ver-tag" href="${FORECAST_PAGE}">typical miss</a> ` +
      `${near ? `from ${s.name}, ${fmtKm(s.km)} away` : "from the 4 scored buoys"}; not scored here${gNote}`,
  };
}

/* ---------- Figures ---------- */

const ahead = (back: number, fwd: number) => (): [number, number] => {
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  return [now - back, now + fwd];
};
const isVirtual = (d: StationData) => d.kind === "virtual";

export const VWAVES: Fig = {
  title: "Waves, next 72 hours",
  sub: "NWPS model",
  varies: false,
  in: (k) => k === "wind",
  depthTabs: false,
  seasonal: false,
  available: isVirtual,
  window: ahead(DAY, 3 * DAY),
  maxSpan: 4 * DAY,
  build: (_d, _depth, x0, x1) => {
    loadVirtualWaves();
    const xs = grid(x0, x1, 400).map((t) => Math.round(t / HOUR) * HOUR);
    const u = waveUnit();
    const at = VB.waves?.at ?? [];
    const fmt = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
    const lines: Line[] = [
      { ys: xs.map((t) => linear(at, t, (x) => x.hs) * u.factor), color: M.palette().line, width: 2, dash: "6 3", label: "NWS wave model (NWPS)", fmt },
      { ys: xs.map((t) => linear(at, t, (x) => x.tp)), color: M.palette().contrast, label: "Peak period", hidden: true, fmt: (v) => `${v.toFixed(1)} s` },
      { ys: xs.map((t) => at.find((x) => x.t === t)?.to ?? NaN), color: M.palette().contrast, label: "From", hidden: true, fmt: (v) => compass((v + 180) % 360) },
    ];
    if (!VB.waves) lines.length = 0; // no cell, or not yet: the empty message, not empty axes
    const glyphs = at.filter((x) => x.t >= x0 && x.t <= x1 && x.hs >= 0.05).map((x) => ({ x: x.t, deg: x.to, color: M.palette().line, title: `toward ${compass(x.to)}` }));
    return {
      opts: { xs, lines, glyphs, unit: ` ${u.label}`, zero: true, hoverDigits: u.digits, marker: { x: Date.now() / 1000, label: "now" }, empty: VB.waves === null ? "No NWPS water cell within 2 km of this point." : "The wave model is loading." },
      legend: [["NWS wave model (NWPS)", M.palette().line, 1, "NWPS model"]],
      note: "NWS NWPS, raw, 1.8 km cell &middot; not scored",
    };
  },
};

export const VCURRENT: Fig = {
  title: "Surface current, next 72 hours",
  sub: "NECOFS model",
  varies: false,
  in: (k) => k === "wind",
  depthTabs: false,
  seasonal: false,
  available: isVirtual,
  window: ahead(DAY, 3 * DAY),
  maxSpan: 4 * DAY,
  build: (_d, _depth, x0, x1) => {
    loadVirtualCurrent();
    const xs = grid(x0, x1, 400).map((t) => Math.round(t / HOUR) * HOUR);
    const cs = currentSpeed();
    const at = VB.current?.at ?? [];
    const lines: Line[] = [
      { ys: xs.map((t) => Math.hypot(linear(at, t, (x) => x.u), linear(at, t, (x) => x.v)) * cs.perCms), color: M.palette().line, width: 2, dash: "6 3", label: "NECOFS surface current", fmt: (v) => `${v.toFixed(cs.digits)} ${cs.label}` },
    ];
    const toward = (t: number) => ((Math.atan2(linear(at, t, (x) => x.u), linear(at, t, (x) => x.v)) * 180) / Math.PI + 360) % 360;
    lines.push({ ys: xs.map((t) => (at.length ? toward(t) : NaN)), color: M.palette().line, label: "Toward", hidden: true, fmt: (v) => compass(v) });
    if (!VB.current) lines.length = 0;
    // Arrows on whole hours, between the model's 2 h steps (which fall on odd hours, where the row's thinning to
    // every 2, 3 or 6 hours would drop them all); faint under 10 cm/s (0.2 kt), near slack, where the direction turns.
    const glyphs = [];
    for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= x1; t += HOUR) {
      const u = linear(at, t, (x) => x.u), v = linear(at, t, (x) => x.v);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const deg = toward(t);
      glyphs.push({ x: t, deg, color: M.palette().line, faint: Math.hypot(u, v) < 10, title: `toward ${compass(deg)}` });
    }
    const now = Date.now() / 1000;
    const slack = (VB.current?.slack ?? []).filter((s) => s > now).slice(0, 4).map((s) => fmtWhen.format(new Date(s * 1000)));
    return {
      opts: { xs, lines, glyphs, unit: ` ${cs.label}`, zero: true, minPad: 0.1, hoverDigits: cs.digits, marker: { x: now, label: "now" }, empty: VB.current === null ? "This point is outside the NECOFS model's mesh." : "The current model is loading." },
      legend: [["NECOFS surface current", M.palette().line, 1, "NECOFS model"]],
      note: `NECOFS, raw, surface, every 2 h${slack.length ? ` &middot; slack about ${slack.join(", ")}` : ""} &middot; not scored`,
    };
  },
};

export const VSST: Fig = {
  title: "Water temperature, last 90 days",
  sub: "MUR satellite",
  varies: false,
  in: (k) => k === "wind",
  depthTabs: false,
  seasonal: false,
  available: isVirtual,
  window: ahead(90 * DAY, DAY),
  maxSpan: 91 * DAY,
  build: (_d, _depth, x0, x1) => {
    loadVirtualSst();
    const at = (VB.sst?.at ?? []).filter(([t]) => t >= x0 - DAY && t <= x1);
    const xs = at.map(([t]) => t);
    return {
      opts: { xs: xs.length ? xs : grid(x0, x1, 90), lines: xs.length ? [{ ys: at.map(([, c]) => cToF(c)), color: M.palette().line, width: 1.8, label: "Satellite (MUR)", fmt: (v) => `${v.toFixed(1)} °F` }] : [], unit: "°F", empty: VB.sst === null ? "No satellite pixel at this point." : "The satellite analysis is loading." },
      legend: [["Satellite (MUR)", M.palette().line, 1]],
      note: `MUR satellite, 1 km, the skin of the water${VB.sst ? ` &middot; latest ${fmtDay.format(new Date(`${VB.sst.newest}T12:00:00Z`))}` : ""}`,
    };
  },
};
