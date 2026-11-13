/** Surface current at a buoy or a virtual buoy, measured beside forecast, along the flood direction (flood into the Sound up, ebb out down): the
 * HF radar's hourly totals on the 1 km cell holding the point (the last 72 hours the network has published; western
 * Sound only), the NECOFS forecast made a day ahead (each hour from the run issued 24 to 48 hours before it, kept at the
 * radar cells by the jobs' hfradar.model_runs) and the latest NECOFS run on the triangle holding the point. The miss
 * between measured and forecast is shaded. Arrows along the top are the current's direction (where the water goes),
 * never the wind's.
 *
 * The flood direction is the radar's principal axis at the cell (the model's, from its strongest current, where the
 * radar does not reach), with flood its westward end: in the Sound the flood runs west, toward the East River. */
import type { Area, Glyph, Line } from "@lhzn-io/timecharts/chart";
import { DAY, getJson, grid, HOUR } from "@lhzn-io/timecharts/series";
import { compass } from "@lhzn-io/timecharts/wind-dir";
import type { CurrentsField, CurrentsMesh, RadarField } from "../fields";
import { DATA, requestRedraw } from "./data";
import type { Fig } from "./figures";
import { MODEL } from "./meter";
import { M } from "./models";
import { currentSpeed } from "./units";

type UV = { t: number; u: number; v: number };
interface Radar { km: number; cell: number; at: (UV & { weak: boolean; edge: boolean })[] }
interface Run { issued: number; t0: number; step: number; steps: number; cells: number[]; u: string; v: string }
interface Runs { encoding: { step_cms: number; missing: number }; runs: Run[] }
interface Pair { latest?: UV[] | null; radar?: Radar | null; runs?: Runs | null }

const pairs = new Map<string, Pair>();
let meshCurrents: Promise<{ mesh: CurrentsMesh; c: CurrentsField }> | null = null;
let radarFile: Promise<RadarField> | null = null;
let runsFile: Promise<Runs | null> | null = null;
let fieldsMod: Promise<typeof import("../fields")> | null = null;
const fields = () => (fieldsMod ??= import("../fields"));

/** Whether a point is inside a triangle (lon, lat as plane coordinates: the triangles are under 2 km). */
function inside(p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean {
  const s = (q: [number, number], r: [number, number]) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

async function loadLatest(lat: number, lon: number): Promise<UV[] | null> {
  meshCurrents ??= Promise.all([getJson<CurrentsMesh>(`${DATA}/fields/currents-mesh.json`), fields().then((f) => f.loadCurrents(`${DATA}/fields/`))]).then(([mesh, c]) => ({ mesh, c }));
  const { mesh, c } = await meshCurrents;
  const p: [number, number] = [lon, lat];
  const e = mesh.triangles.findIndex(([a, b, d]) => inside(p, mesh.nodes[a], mesh.nodes[b], mesh.nodes[d]));
  if (e < 0) return null;
  const t0 = Date.parse(c.t0) / 1000;
  return Array.from({ length: c.steps }, (_, j) => ({ t: t0 + j * c.step, u: c.u[j][e], v: c.v[j][e] }));
}

async function loadRadar(lat: number, lon: number): Promise<Radar | null> {
  radarFile ??= getJson<RadarField>(`${DATA}/fields/hfradar.json`);
  const [f, r] = await Promise.all([fields(), radarFile]);
  const id = f.radarCellAt(r, lon, lat);
  if (id < 0) return null;
  const { lon0, lat0, dlon, dlat, nx } = r.grid;
  const cell = r.cells[id];
  const cx = lon0 + (cell % nx) * dlon;
  const cy = lat0 + Math.floor(cell / nx) * dlat;
  const km = Math.hypot((cx - lon) * Math.cos((lat * Math.PI) / 180), cy - lat) * 111.2;
  const at: Radar["at"] = [];
  r.frames.forEach((fr, k) => {
    const { u, v } = f.radarUV(r, k);
    if (!Number.isFinite(u[id])) return;
    const q = f.radarQuality(r, k, id);
    at.push({ t: Date.parse(fr.valid_time) / 1000, u: u[id], v: v[id], weak: q.weak, edge: q.edge });
  });
  return { km, cell, at };
}

function loadRuns(): Promise<Runs | null> {
  runsFile ??= getJson<{ encoding: Runs["encoding"]; runs: (Omit<Run, "issued" | "t0"> & { issued: string; t0: string })[] }>(`${DATA}/fields/necofs-at-radar.json`)
    .then((j) => ({ encoding: j.encoding, runs: j.runs.map((r) => ({ ...r, issued: Date.parse(r.issued) / 1000, t0: Date.parse(r.t0) / 1000 })) }))
    .catch(() => null);
  return runsFile;
}

/** The point's sources, each loaded once (a redraw follows each). */
function pairAt(lat: number, lon: number): Pair {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  let p = pairs.get(key);
  if (!p) {
    const q: Pair = {};
    pairs.set(key, q);
    p = q;
    const settle = <T,>(pr: Promise<T>, put: (v: T | null) => void, what: string) =>
      pr.then(put, (err) => { console.warn(`current pair: ${what}`, err); put(null); }).finally(requestRedraw);
    settle(loadLatest(lat, lon), (v) => (q.latest = v), "latest run");
    settle(loadRadar(lat, lon), (v) => (q.radar = v), "radar");
    settle(loadRuns(), (v) => (q.runs = v), "runs");
  }
  return p;
}

const lerp = (at: UV[], t: number): { u: number; v: number } | null => {
  for (let k = 0; k + 1 < at.length; k++) {
    if (t >= at[k].t && t <= at[k + 1].t) {
      const f = (t - at[k].t) / (at[k + 1].t - at[k].t || 1);
      return { u: at[k].u + (at[k + 1].u - at[k].u) * f, v: at[k].v + (at[k + 1].v - at[k].v) * f };
    }
  }
  return null;
};

const decoded = new WeakMap<Run, { u: Int8Array; v: Int8Array }>();
const b64 = (s: string) => Int8Array.from(atob(s), (c) => (c.charCodeAt(0) << 24) >> 24);

/** The forecast made a day ahead at the radar cell: for an hour, the run issued 24 to 48 hours before it (the newest
 * such), read between its 2 h steps; null where no kept run is that far ahead. */
function dayAhead(runs: Runs | null | undefined, cell: number, t: number): { u: number; v: number } | null {
  if (!runs) return null;
  const run = [...runs.runs].reverse().find((r) => t - r.issued >= DAY && t - r.issued < 2 * DAY);
  if (!run) return null;
  const i = run.cells.indexOf(cell);
  if (i < 0) return null;
  let d = decoded.get(run);
  if (!d) {
    d = { u: b64(run.u), v: b64(run.v) };
    decoded.set(run, d);
  }
  const n = run.cells.length;
  const k = (t - run.t0) / run.step;
  const k0 = Math.floor(k);
  if (k0 < 0 || k0 + 1 >= run.steps) return null;
  const at = (j: number, a: Int8Array) => (a[j * n + i] === runs.encoding.missing ? NaN : a[j * n + i] * runs.encoding.step_cms);
  const f = k - k0;
  const u = at(k0, d.u) * (1 - f) + at(k0 + 1, d.u) * f;
  const v = at(k0, d.v) * (1 - f) + at(k0 + 1, d.v) * f;
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

/** The flood direction (unit east, north): the radar's principal axis over its clean hours (24 or more),
 * else the latest run's strongest current; its westward end. */
function floodAxis(p: Pair): { ax: number; ay: number; from: "radar" | "model" } | null {
  const clean = (p.radar?.at ?? []).filter((x) => !x.weak && !x.edge);
  let ax = 0, ay = 0, from: "radar" | "model" = "radar";
  if (clean.length >= 24) {
    const mu = clean.reduce((s, x) => s + x.u, 0) / clean.length, mv = clean.reduce((s, x) => s + x.v, 0) / clean.length;
    let suu = 0, svv = 0, suv = 0;
    for (const x of clean) {
      suu += (x.u - mu) ** 2;
      svv += (x.v - mv) ** 2;
      suv += (x.u - mu) * (x.v - mv);
    }
    const th = 0.5 * Math.atan2(2 * suv, suu - svv); // the principal axis's angle from east
    [ax, ay] = [Math.cos(th), Math.sin(th)];
  } else if (p.latest?.length) {
    from = "model";
    let best = 0;
    for (const s of p.latest) {
      const sp = Math.hypot(s.u, s.v);
      if (sp > best) [best, ax, ay] = [sp, s.u / sp, s.v / sp];
    }
    if (!best) return null;
  } else return null;
  if (ax > 0) [ax, ay] = [-ax, -ay];
  return { ax, ay, from };
}

const toward = (u: number, v: number) => ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
const fmtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });
const pct = (x: number) => `${Math.round(x * 100)}%`;

export const CURRENT_PAIR: Fig = {
  title: "Surface current, flood and ebb",
  sub: "into the Sound up, out down: HF radar against the NECOFS forecast",
  varies: false,
  in: (k) => k === "wind",
  depthTabs: false,
  seasonal: false,
  available: (d) => d.kind === "virtual" || d.kind === "buoy",
  window: () => {
    const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
    return [now - 3 * DAY, now + 2 * DAY];
  },
  maxSpan: 6 * DAY,
  build: (d, _depth, x0, x1) => {
    const p = pairAt(d.meta.lat, d.meta.lon);
    const cs = currentSpeed();
    const P = M.palette();
    const model = MODEL();
    const fmt = (v: number) => `${v >= 0 ? "flood" : "ebb"} ${Math.abs(v).toFixed(cs.digits)} ${cs.label}`;
    const fmtSpeed = (v: number) => `${v.toFixed(cs.digits)} ${cs.label}`;
    const xs = [...new Set(grid(x0, x1, 400).map((t) => Math.round(t / HOUR) * HOUR))];
    const axis = floodAxis(p);
    const along = (u: number, v: number) => (axis ? (u * axis.ax + v * axis.ay) * cs.perCms : NaN);
    const hourly = new Map((p.radar?.at ?? []).map((x) => [x.t, x]));
    const cell = p.radar?.cell ?? -1;
    const latestAt = (t: number) => (p.latest ? lerp(p.latest, t) : null);
    const aheadAt = (t: number) => (cell >= 0 ? dayAhead(p.runs, cell, t) : null);
    const val = (x: { u: number; v: number } | null) => (x ? along(x.u, x.v) : NaN);
    const measured = (t: number, clean: boolean | null) => {
      const x = hourly.get(t);
      if (!x || (clean === true && (x.weak || x.edge)) || (clean === false && !(x.weak || x.edge))) return NaN;
      return along(x.u, x.v);
    };
    // The miss is shaded against the day-ahead forecast where the kept runs reach that far, else the latest run.
    const hasAhead = xs.some((t) => hourly.has(t) && aheadAt(t));
    const ref = (t: number) => (hasAhead ? aheadAt(t) : latestAt(t));
    const refLabel = hasAhead ? "the forecast made a day ahead" : "the latest run";
    const area: Area = {
      lo: xs.map((t) => { const m = measured(t, true), f = val(ref(t)); return Number.isFinite(m) && Number.isFinite(f) ? Math.min(m, f) : NaN; }),
      hi: xs.map((t) => { const m = measured(t, true), f = val(ref(t)); return Number.isFinite(m) && Number.isFinite(f) ? Math.max(m, f) : NaN; }),
      fill: P.miss,
      opacity: 0.35,
    };
    const lines: Line[] = [
      { ys: xs.map((t) => val(latestAt(t))), color: model, width: 1.6, dash: "6 3", label: "NECOFS, latest run", fmt },
      { ys: xs.map((t) => val(aheadAt(t))), color: model, width: 1.2, opacity: 0.7, dash: "2 3", label: "NECOFS, a day ahead", fmt },
      // A faint line joins consecutive radar hours only (a missing hour breaks it), so the tide reads through the dots.
      { ys: xs.map((t) => measured(t, null)), color: P.now, width: 1, opacity: 0.35, label: "HF radar, hourly", tip: false },
      { ys: xs.map((t) => measured(t, true)), color: P.now, dots: true, label: "HF radar, measured", fmt },
      { ys: xs.map((t) => measured(t, false)), color: P.now, opacity: 0.4, dots: true, label: "HF radar, edge or weak geometry", fmt },
      { ys: xs.map((t) => { const x = hourly.get(t); return x ? Math.hypot(x.u, x.v) * cs.perCms : NaN; }), color: P.now, label: "Measured speed", hidden: true, fmt: fmtSpeed },
      { ys: xs.map((t) => { const x = hourly.get(t); return x ? toward(x.u, x.v) : NaN; }), color: P.now, label: "Measured toward", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
      { ys: xs.map((t) => { const x = latestAt(t); return x ? toward(x.u, x.v) : NaN; }), color: model, label: "Model toward", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
    ];
    // Arrows: the current's direction (where the water goes), gold where measured, the model's dashed after.
    const glyphs: Glyph[] = [];
    const lastRadar = p.radar?.at.length ? p.radar.at[p.radar.at.length - 1].t : -Infinity;
    for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= x1; t += HOUR) {
      const x = hourly.get(t);
      if (x) {
        glyphs.push({ x: t, deg: toward(x.u, x.v), color: P.now, faint: x.weak || x.edge || Math.hypot(x.u, x.v) < 10, title: `current measured toward ${compass(toward(x.u, x.v))}` });
        continue;
      }
      if (t <= lastRadar) continue;
      const m = latestAt(t);
      if (!m) continue;
      glyphs.push({ x: t, deg: toward(m.u, m.v), color: model, dashed: true, faint: Math.hypot(m.u, m.v) < 10, title: `current forecast toward ${compass(toward(m.u, m.v))}` });
    }
    // How wrong the forecast was, over the clean radar hours it covers: RMS miss along the flood direction, and the measured
    // flood and ebb as a share of the forecast's (each over the hours the forecast floods or ebbs).
    const hours = (p.radar?.at ?? []).filter((x) => !x.weak && !x.edge).map((x) => ({ m: along(x.u, x.v), f: val(ref(x.t)) })).filter((h) => Number.isFinite(h.m) && Number.isFinite(h.f));
    let miss = "";
    if (hours.length >= 6) {
      const rms = Math.sqrt(hours.reduce((s, h) => s + (h.m - h.f) ** 2, 0) / hours.length);
      const share = (sign: number) => {
        const hs = hours.filter((h) => Math.sign(h.f) === sign);
        const f = hs.reduce((s, h) => s + Math.abs(h.f), 0);
        return hs.length >= 3 && f > 0 ? hs.reduce((s, h) => s + Math.max(0, sign * h.m), 0) / f : NaN;
      };
      const fl = share(1), eb = share(-1);
      miss =
        `against ${refLabel} over ${hours.length} measured hours: RMS miss ${fmtSpeed(rms)} along the flood direction` +
        `${Number.isFinite(eb) ? `; the ebb ran ${pct(eb)} of the forecast's` : ""}${Number.isFinite(fl) ? `, the flood ${pct(fl)}` : ""}`;
    }
    const axisNote = axis ? `flood toward ${Math.round(toward(axis.ax, axis.ay))}° (the ${axis.from === "radar" ? "radar's" : "model's"} principal axis)` : "";
    const radarNote =
      p.radar === undefined ? "HF radar loading" : p.radar === null ? "HF radar does not reach this point (western Sound only)" : `HF radar, 1 km cell ${p.radar.km.toFixed(1)} km away, hourly, to ${p.radar.at.length ? fmtWhen.format(new Date(lastRadar * 1000)) : "--"}`;
    const runsNote = p.runs?.runs.length ? `NECOFS runs kept from ${fmtWhen.format(new Date(p.runs.runs[0].issued * 1000))}` : "";
    const none = p.latest === null && p.radar === null;
    const legend: [string, string, number, string?][] = [
      ["HF radar, measured", P.now, 1, "HF radar (measured)"],
      ["HF radar, edge or weak geometry", P.now, 0.4, "edge or weak geometry"],
      ["NECOFS, a day ahead", model, 0.7, "NECOFS, forecast a day ahead"],
      ["NECOFS, latest run", model, 1, "NECOFS, latest run"],
      ["", P.miss, 1, "shaded: the miss"],
      ["", P.now, 1, "arrows: the current's direction"],
    ];
    return {
      opts: {
        xs,
        lines: none ? [] : lines,
        areas: none ? [] : [area],
        glyphs,
        unit: ` ${cs.label}`,
        zero: true,
        minPad: 0.1,
        hoverDigits: cs.digits,
        marker: { x: Date.now() / 1000, label: "now" },
        empty: none ? "Neither the HF radar nor the NECOFS model reaches this point." : "The current data are loading.",
      },
      legend: p.radar === null ? legend.filter(([l]) => !l.startsWith("HF radar") && l !== "NECOFS, a day ahead") : legend,
      note: [axisNote, miss, radarNote, runsNote].filter(Boolean).join(" &middot; "),
    };
  },
};
