/** A current meter's section in the Tides view (Groton, in the Thames River): the measured current at the bin NOAA
 * predicts, beside NOAA's prediction and the NECOFS model, the three compared over the plot's window; and every bin
 * across the channel. Data: the meter's bins (shore.json, the jobs' meters.py) and the prediction and model at the
 * meter (current-phase.json, the jobs' phase.py, which pairs the two at its reference points). */
import type { Glyph } from "../chart";
import type { Pin } from "../map";
import { getJson, grid, HOUR, type Hourly, type LastObs } from "../series";
import type { PhaseFile } from "../phase";
import { compass } from "../wind-dir";
import type { Built } from "./figures";
import { ago, fmtDate } from "./format";
import { AT, atLabel } from "./cursor";
import { DATA, requestRedraw } from "./data";
import { readoutHtml } from "./readouts";
import { obsState, type StationData } from "./station-data";
import { WIND_UNITS, WU } from "./units";

/** The plots' colours, from the page's palette: measured gold, NOAA's prediction blue, the model teal, and the bins'
 * ramp from the nearest to the farthest. */
export interface MeterColours {
  measured: string;
  ramp: (u: number) => string; // 0 nearest the meter, 1 farthest
}
const light = () => document.documentElement.dataset.theme === "light";
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PREDICTED = () => css("--fc-mid") || "#4a7fae";
const MODEL = () => (light() ? "#1f7f86" : "#5fc3c4");

/* ---------- The prediction and the model at the meter ---------- */

type PhaseSeries = { t0: string; step: number; kt: (number | null)[] };
type PhasePoint = PhaseFile["points"][number] & { noaa: (PhaseSeries & { events?: { t: string; type: string; kt: number }[] }) | null; necofs: PhaseSeries | null };

let phase: PhaseFile | null = null;
let phaseLoad: Promise<void> | null = null;

/** The phase file's point at a meter (by its NOAA station), once loaded (asked for on first use); null before. */
function pointOf(d: StationData): PhasePoint | null {
  loadMeterModel();
  const id = d.meter?.coops;
  return (phase?.points.find((p) => (p as PhasePoint).noaa?.station === id) as PhasePoint | undefined) ?? null;
}

/** Load the prediction and model once (the strip under the time bar may have asked for the same file); the page
 * redraws when they arrive. */
function loadMeterModel(): void {
  phaseLoad ??= getJson<PhaseFile>(`${DATA}/current-phase.json`)
    .then((f) => {
      phase = f;
      requestRedraw();
    })
    .catch(() => undefined);
}

/** A series' value at t (epoch seconds), linear between its steps; NaN outside it or across a gap. */
function at(s: PhaseSeries | null | undefined, t: number): number {
  if (!s) return NaN;
  const f = (t - Date.parse(s.t0) / 1000) / s.step;
  const i = Math.floor(f);
  const a = s.kt[i];
  const b = s.kt[i + 1];
  if (a == null || i < 0) return NaN;
  if (f === i) return a;
  return b == null ? NaN : a + (b - a) * (f - i);
}

const realtime = (d: StationData): Hourly | null => d.meter?.bins[d.meter.realtime - 1] ?? null;
const measuredAt = (d: StationData, t: number) => realtime(d)?.at(t) ?? NaN;
const predictedAt = (d: StationData, t: number) => at(pointOf(d)?.noaa, t);
const modelAt = (d: StationData, t: number) => at(pointOf(d)?.necofs, t);

/** A bin's hourly current at t: speed (knots) and the direction it runs toward (degrees true), from its parts along
 * and across the flood direction; null where either part is missing. */
function flowAt(d: StationData, i: number, t: number): { kt: number; toward: number } | null {
  const m = d.meter!;
  const a = m.bins[i]?.at(t) ?? NaN;
  const x = m.across[i]?.at(t) ?? NaN;
  if (!Number.isFinite(a) || !Number.isFinite(x)) return null;
  return { kt: Math.hypot(a, x), toward: (m.flood + (Math.atan2(x, a) * 180) / Math.PI + 360) % 360 };
}
const LIGHT_CURRENT_KT = 0.05; // under this the direction wanders: drawn faint

/* ---------- Units ---------- */

const unit = () => ({ label: WIND_UNITS[WU].label, factor: WIND_UNITS[WU].factor, digits: WU === "ms" ? 3 : 2 });
const val = (kt: number) => kt * unit().factor;
const speed = (kt: number) => `${Math.abs(val(kt)).toFixed(unit().digits)} ${unit().label}`;
const phaseWord = (kt: number) => (Math.abs(kt) < 0.05 ? "near slack" : kt > 0 ? "flood" : "ebb");
const dist = (m: number) => `${Math.round(m)} m`;
const fmtAlong = (v: number) => `${Math.abs(v).toFixed(unit().digits)} ${unit().label} ${v >= 0 ? "flood" : "ebb"}`;

/* ---------- The comparison ---------- */

/** One estimate scored against the meter over [x0, x1], hourly where both have a value: the RMS difference (knots),
 * the estimate's flood and ebb strength against the meter's (each the 90th percentile of the current's size that way),
 * and the mean time from the meter's slack to the estimate's nearest slack of the same turn (minutes; positive: the
 * estimate turns later). */
export interface Score { hours: number; rms: number; flood: number; ebb: number; slackMin: number; slacks: number }

function p90(xs: number[]): number {
  if (xs.length < 6) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * (s.length - 1)))];
}

/** Times (epoch seconds) a series crosses zero, by linear interpolation between hours, with the turn's sign (+1 into
 * flood, -1 into ebb). */
function crossings(ts: number[], ys: number[]): { t: number; dir: number }[] {
  const out: { t: number; dir: number }[] = [];
  for (let i = 1; i < ts.length; i++) {
    const [a, b] = [ys[i - 1], ys[i]];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || Math.sign(a) === Math.sign(b) || a === 0) continue;
    out.push({ t: ts[i - 1] + ((ts[i] - ts[i - 1]) * a) / (a - b), dir: b > a ? 1 : -1 });
  }
  return out;
}

export function score(d: StationData, other: (d: StationData, t: number) => number, x0: number, x1: number): Score | null {
  const end = Math.min(x1, Date.now() / 1000);
  const ts: number[] = [];
  for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= end; t += HOUR) ts.push(t);
  const m = ts.map((t) => measuredAt(d, t));
  const o = ts.map((t) => other(d, t));
  const both = ts.map((_, i) => Number.isFinite(m[i]) && Number.isFinite(o[i]));
  const n = both.filter(Boolean).length;
  if (n < 24) return null;
  const sq = ts.reduce((s, _, i) => (both[i] ? s + (o[i] - m[i]) ** 2 : s), 0);
  const pick = (ys: number[], sign: number) => ys.filter((v, i) => both[i] && v * sign > 0).map(Math.abs);
  const mc = crossings(ts, m.map((v, i) => (both[i] ? v : NaN)));
  const oc = crossings(ts, o.map((v, i) => (both[i] ? v : NaN)));
  const lags: number[] = [];
  for (const c of mc) {
    const near = oc.filter((x) => x.dir === c.dir && Math.abs(x.t - c.t) <= 3 * HOUR).sort((a, b) => Math.abs(a.t - c.t) - Math.abs(b.t - c.t))[0];
    if (near) lags.push((near.t - c.t) / 60);
  }
  return {
    hours: n,
    rms: Math.sqrt(sq / n),
    flood: p90(pick(o, 1)) / p90(pick(m, 1)),
    ebb: p90(pick(o, -1)) / p90(pick(m, -1)),
    slackMin: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : NaN,
    slacks: lags.length,
  };
}

const ratio = (r: number) => (Number.isFinite(r) ? `${r.toFixed(2)} times` : "--");
const minutes = (v: number) => (Number.isFinite(v) ? `${Math.abs(Math.round(v))} min ${v >= 0 ? "later" : "earlier"}` : "--");
function scoreText(name: string, s: Score | null): string {
  if (!s) return `${name}: too few hours beside the meter to compare`;
  return `${name} against the meter over ${s.hours} hours: RMS difference ${speed(s.rms)}; flood strength ${ratio(s.flood)} the meter's, ebb ${ratio(s.ebb)}; slack ${minutes(s.slackMin)} on average (${s.slacks} slacks)`;
}

/* ---------- The plots ---------- */

export const METER_WINDOW = (d: StationData): [number, number] => [d.now - 7 * 86400, d.now + 2 * 86400];
export const BINS_WINDOW = (d: StationData): [number, number] => [d.now - 3 * 86400, d.now + 3600];
export const meterStart = (d: StationData) => realtime(d)?.t0 ?? d.now;

/** The measured current at the real-time bin, NOAA's prediction for it and the NECOFS model at the nearest element,
 * all along the flood direction, with the measured direction as arrows above; the two estimates scored against the
 * meter over the window in the note. */
export function meterFlowBuilt(d: StationData, x0: number, x1: number, c: MeterColours): Built {
  const xs = grid(x0, x1);
  const m = d.meter!;
  const p = pointOf(d);
  const rt = m.realtime - 1;
  const measuredLabel = `Measured, ${dist(m.binsM[rt])} out`;
  const lines = [
    { ys: xs.map((t) => val(predictedAt(d, t))), color: PREDICTED(), width: 1.2, label: "NOAA prediction", fmt: fmtAlong },
    { ys: xs.map((t) => val(modelAt(d, t))), color: MODEL(), width: 1.2, dash: "5 3", label: "NECOFS model", fmt: fmtAlong },
    { ys: xs.map((t) => val(measuredAt(d, t))), color: c.measured, width: 1.7, label: measuredLabel, fmt: fmtAlong },
    { ys: xs.map((t) => flowAt(d, rt, t)?.toward ?? NaN), color: c.measured, label: "Toward", hidden: true, fmt: (v: number) => `${compass(v)} (${Math.round(v)}°)` },
  ];
  const glyphs: Glyph[] = [];
  for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= x1; t += HOUR) {
    const f = flowAt(d, rt, t);
    if (f) glyphs.push({ x: t, deg: f.toward, color: c.measured, faint: f.kt < LIGHT_CURRENT_KT, title: `toward ${compass(f.toward)} (${Math.round(f.toward)}°), ${speed(f.kt)}` });
  }
  const now = Date.now() / 1000;
  return {
    opts: { xs, lines, glyphs, unit: ` ${unit().label}`, zero: true, hoverDigits: unit().digits, marker: x1 > now ? { x: now, label: "now" } : undefined, empty: "No current readings in this window." },
    legend: [[measuredLabel, c.measured, 1, "Measured"], ["NOAA prediction", PREDICTED(), 1, "NOAA prediction"], ["NECOFS model", MODEL(), 1, "NECOFS model"]],
    note: p
      ? [scoreText("NOAA's prediction", score(d, predictedAt, x0, x1)), scoreText("The NECOFS model", score(d, modelAt, x0, x1))].join("; ")
      : "the prediction and the model are loading",
  };
}

/** Every bin across the channel, nearest the meter strongest in colour; the real-time bin (the one NOAA predicts)
 * heavier. */
export function meterBinsBuilt(d: StationData, x0: number, x1: number, c: MeterColours): Built {
  const xs = grid(x0, x1);
  const m = d.meter!;
  const n = m.binsM.length;
  const lines = m.bins.map((h, i) => ({
    ys: xs.map((t) => val(h?.at(t) ?? NaN)),
    color: c.ramp(n > 1 ? i / (n - 1) : 0),
    width: i === m.realtime - 1 ? 1.7 : 0.9,
    label: `${dist(m.binsM[i])} out`,
    fmt: fmtAlong,
  }));
  return {
    opts: { xs, lines, unit: ` ${unit().label}`, zero: true, hoverDigits: unit().digits, empty: "No current readings in this window." },
    legend: lines.map((l, i) => [l.label, l.color, 1, dist(m.binsM[i])] as [string, string, number, string]),
    note: `each line one bin of the side-looking meter, from ${dist(m.binsM[0])} to ${dist(m.binsM[n - 1])} out from the pier across the channel, ${m.depthM} m below the surface; the heavy line is the bin NOAA predicts`,
  };
}

/** The chart around each meter (stations/meter-charts.json, from scripts/fetch-meter-charts.py): land, piers and
 * wharves, depth contours and the channel, in east and north metres from the meter. Loaded on first use. */
type Geo = { type: string; coordinates: unknown };
interface MeterChart {
  cell: { name: string; scale: number; edition: string; updated: string };
  land: Geo[];
  works: Geo[];
  depths: (Geo & { m: number })[];
  channels: (Geo & { name: string | null; depth_m: number | null })[];
  faces: { distance_m: number; along_deg: number; out_deg: number | null }[];
}
let charts: Record<string, MeterChart> | null = null;
let chartsLoad: Promise<void> | null = null;
function chartOf(d: StationData): MeterChart | null {
  chartsLoad ??= import("../../../../stations/meter-charts.json")
    .then((m) => {
      charts = (m.default as unknown as { meters: Record<string, MeterChart> }).meters;
      requestRedraw();
    })
    .catch(() => undefined);
  return charts?.[d.meta.id] ?? null;
}

/** The plan: north up, the chart around the meter and the meter's beam drawn to scale, and at each bin an arrow for the
 * hour's current, its length by speed on its own scale; NOAA's prediction for the real-time bin beside it, along NOAA's
 * flood or ebb direction. At the page's time, or the latest hour with a reading. */
const FAN = { h: 300, pxPerM: 640 / 280, pxPerKt: 160, maxPx: 110 }; // drawing units; the width follows the box
export function meterFanSvg(d: StationData, atT: number | null, c: MeterColours, aspect = 640 / 300, pxScale = 1): { svg: string; legend: string; note: string } {
  const W = Math.round(FAN.h * Math.min(4, Math.max(1.2, aspect))); // as wide as the box allows, at the same scale
  const m = d.meter!;
  const chart = chartOf(d);
  const rt = m.realtime - 1;
  const t = Math.floor((atT ?? (m.last ? Date.parse(m.last.time) / 1000 : Date.now() / 1000)) / HOUR) * HOUR;
  const beam = m.beam ?? (m.flood + 270) % 360;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const s = FAN.pxPerM;
  // The frame's centre: the middle of the beam, so the arrows sit in the middle with the pier and the channel either side.
  const mid = (m.binsM[0] + m.binsM[m.binsM.length - 1]) / 2;
  const [ce, cn] = [mid * Math.sin(rad(beam)), mid * Math.cos(rad(beam))];
  const X = (e: number) => W / 2 + (e - ce) * s;
  const Y = (n: number) => FAN.h / 2 - (n - cn) * s;
  const at_ = (r: number): [number, number] => [X(r * Math.sin(rad(beam))), Y(r * Math.cos(rad(beam)))];
  const f1 = (v: number) => v.toFixed(1);
  const ring = (pts: number[][], close: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${f1(X(p[0]))} ${f1(Y(p[1]))}`).join("") + (close ? "Z" : "");
  const pathOf = (g: Geo): string => {
    const k = g.coordinates as never;
    switch (g.type) {
      case "Polygon": return (k as number[][][]).map((r) => ring(r, true)).join("");
      case "MultiPolygon": return (k as number[][][][]).flatMap((p) => p.map((r) => ring(r, true))).join("");
      case "LineString": return ring(k as number[][], false);
      case "MultiLineString": return (k as number[][][]).map((r) => ring(r, false)).join("");
      default: return "";
    }
  };
  const inFrame = (p: number[], pad: number) => Math.abs(X(p[0]) - W / 2) < W / 2 - pad && Math.abs(Y(p[1]) - FAN.h / 2) < FAN.h / 2 - pad;
  const arrow = (x: number, y: number, deg: number, kt: number, colour: string, width: number, opacity: number, dash = "") => {
    const len = Math.min(FAN.maxPx, kt * FAN.pxPerKt);
    if (len < 3) return `<circle cx="${f1(x)}" cy="${f1(y)}" r="2" fill="${colour}" opacity="${opacity}"/>`;
    const [dx, dy] = [Math.sin(rad(deg)), -Math.cos(rad(deg))];
    const [ex, ey] = [x + dx * len, y + dy * len];
    const head = 6;
    const [lx, ly] = [ex - dx * head - dy * head * 0.5, ey - dy * head + dx * head * 0.5];
    const [rx, ry] = [ex - dx * head + dy * head * 0.5, ey - dy * head - dx * head * 0.5];
    return `<g opacity="${opacity}"><line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(ex - dx * head * 0.6)}" y2="${f1(ey - dy * head * 0.6)}" stroke="${colour}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>` +
      `<polygon points="${f1(ex)},${f1(ey)} ${f1(lx)},${f1(ly)} ${f1(rx)},${f1(ry)}" fill="${colour}"/></g>`;
  };
  const ink = "var(--dim)";
  const parts: string[] = [];
  // The chart: the channel faintly, then the depth contours, then land and the piers and wharves over them.
  if (chart) {
    for (const ch of chart.channels) parts.push(`<path d="${pathOf(ch)}" fill="none" stroke="${PREDICTED()}" stroke-opacity="0.6" stroke-width="0.9" stroke-dasharray="5 3"/>`);
    for (const dc of chart.depths) parts.push(`<path d="${pathOf(dc)}" fill="none" stroke="${ink}" stroke-opacity="0.45" stroke-width="0.7"/>`);
    for (const l of chart.land) parts.push(`<path d="${pathOf(l)}" fill="var(--rule)" stroke="${ink}" stroke-width="0.9"/>`);
    for (const w of chart.works) parts.push(`<path d="${pathOf(w)}" fill="${w.type.includes("Polygon") ? "var(--rule)" : "none"}" stroke="${ink}" stroke-width="1.3"/>`);
    const near = (a: number[], b: number[]) => (Math.hypot(X(a[0]) - W / 2, Y(a[1]) - FAN.h / 2) < Math.hypot(X(b[0]) - W / 2, Y(b[1]) - FAN.h / 2) ? a : b);
    // Each contour named once, at its point nearest the frame's centre (inside the frame).
    const named = new Set<number>();
    for (const dc of [...chart.depths].sort((a, b) => a.m - b.m)) {
      if (named.has(dc.m)) continue;
      const lines = (dc.type === "LineString" ? [dc.coordinates] : dc.coordinates) as number[][][];
      const pts = lines.flat().filter((p) => inFrame(p, 30));
      if (!pts.length) continue;
      const p = pts.reduce(near);
      parts.push(`<text x="${f1(X(p[0]) + 3)}" y="${f1(Y(p[1]) - 3)}" fill="${ink}" font-size="9" opacity="0.8">${dc.m} m</text>`);
      named.add(dc.m);
    }
    const ch = chart.channels[0];
    if (ch) {
      const outer = ch.type === "Polygon" ? (ch.coordinates as number[][][])[0] : (ch.coordinates as number[][][][])[0][0];
      // The label just inside the channel's edge, at the in-frame vertex nearest the frame's centre.
      const inside = (e: number, n: number) => {
        let k = false;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
          const [a, b] = [outer[i], outer[j]];
          if (a[1] > n !== b[1] > n && e < ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]) + a[0]) k = !k;
        }
        return k;
      };
      // Points every 5 m along the edge (its straight runs have few vertices), those well inside the frame.
      const pts = outer.slice(1).flatMap((q, i) => {
        const r = outer[i];
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - r[0], q[1] - r[1]) / 5));
        return Array.from({ length: n }, (_, j) => [r[0] + ((q[0] - r[0]) * j) / n, r[1] + ((q[1] - r[1]) * j) / n]);
      }).filter((q) => inFrame(q, 60));
      if (pts.length) {
        const v = pts.reduce(near);
        const off = [[-18, 0], [18, 0], [0, 18], [0, -18], [-18, -18], [18, 18], [-18, 18], [18, -18]].find(([de, dn]) => inside(v[0] + de, v[1] + dn));
        if (off) parts.push(`<text x="${f1(X(v[0] + off[0]))}" y="${f1(Y(v[1] + off[1]))}" fill="${PREDICTED()}" font-size="10" text-anchor="middle">dredged channel</text>`);
      }
    }
  } else {
    // Until the chart loads (or where there is none): the pier as a bar square to the beam.
    const [px, py] = [Math.sin(rad(beam + 90)) * 28, -Math.cos(rad(beam + 90)) * 28];
    const [qx, qy] = at_(0);
    parts.push(`<line x1="${f1(qx - px)}" y1="${f1(qy - py)}" x2="${f1(qx + px)}" y2="${f1(qy + py)}" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`);
  }
  // The beam out to the last bin, the meter a dot at its root.
  const [ox, oy] = at_(0);
  const [bx, by] = at_(m.binsM[m.binsM.length - 1] + 3);
  parts.push(`<line x1="${f1(ox)}" y1="${f1(oy)}" x2="${f1(bx)}" y2="${f1(by)}" stroke="${ink}" stroke-width="0.8" stroke-dasharray="2 3"/>`);
  parts.push(`<circle cx="${f1(ox)}" cy="${f1(oy)}" r="3" fill="${ink}"/>`);
  // NOAA's prediction at the real-time bin, then the measured current at every bin (the real-time bin heavier).
  const p = pointOf(d) as (PhasePoint & { noaa: { flood_dir?: number; ebb_dir?: number } | null }) | null;
  const pk = predictedAt(d, t);
  const [rx, ry] = at_(m.binsM[rt]);
  if (Number.isFinite(pk) && p?.noaa?.flood_dir != null) {
    const dir = pk >= 0 ? p.noaa.flood_dir : (p.noaa.ebb_dir ?? (p.noaa.flood_dir + 180) % 360);
    parts.push(arrow(rx, ry, dir, Math.abs(pk), PREDICTED(), 1.4, 0.9, "4 2"));
  }
  let shown = 0;
  m.binsM.forEach((_, i) => {
    const f = flowAt(d, i, t);
    const [x, y] = at_(m.binsM[i]);
    if (!f) {
      parts.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="2" fill="none" stroke="${ink}"/>`);
      return;
    }
    shown++;
    parts.push(arrow(x, y, f.toward, f.kt, c.measured, i === rt ? 2.2 : 1.3, f.kt < LIGHT_CURRENT_KT ? 0.45 : 1));
  });
  // North is up (the caption says so); the river's flood and ebb axis and the two scales are in the legend, sized to
  // the drawing as shown (pxScale: screen pixels per drawing unit), so nothing covers the chart.
  const [fx, fy] = [Math.sin(rad(m.flood)) * 11, -Math.cos(rad(m.flood)) * 11];
  const axis = `<svg width="30" height="20" viewBox="-15 -10 30 20" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><line x1="${f1(-fx)}" y1="${f1(-fy)}" x2="${f1(fx)}" y2="${f1(fy)}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 2"/><circle cx="${f1(fx)}" cy="${f1(fy)}" r="2" fill="currentColor"/></svg>`;
  const bar = (px: number, colour: string) => `<svg width="${Math.round(px)}" height="6" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><line x1="0" x2="${Math.round(px)}" y1="3" y2="3" stroke="${colour}" stroke-width="2"/></svg>`;
  const furniture =
    `<span class="lg-static" title="NOAA's flood and ebb directions for the meter">${axis}flood ${Math.round(m.flood)}&deg;, ebb ${Math.round((m.flood + 180) % 360)}&deg; (dot: flood)</span>` +
    `<span class="lg-static">${bar(50 * s * pxScale, "currentColor")}50 m</span>` +
    `<span class="lg-static">${bar((0.5 / unit().factor) * FAN.pxPerKt * pxScale, c.measured)}0.5 ${unit().label}</span>`;
  const when = atLabel(t);
  parts.push(`<rect x="${W - 232}" y="${FAN.h - 28}" width="226" height="20" fill="var(--bg)" opacity="0.8"/><text x="${W - 12}" y="${FAN.h - 14}" fill="${ink}" font-size="11" text-anchor="end">${shown ? `measured ${when}` : `no reading at ${when}`}</text>`);
  const label = `Current at each bin of the ${d.meta.name} meter, seen from above on the chart, ${when}`;
  return {
    svg: `<svg role="img" aria-label="${label}" viewBox="0 0 ${W} ${FAN.h}" preserveAspectRatio="xMidYMid meet"><defs><clipPath id="${d.meta.id}-fan-clip"><rect width="${W}" height="${FAN.h}"/></clipPath></defs><g clip-path="url(#${d.meta.id}-fan-clip)">${parts.join("")}</g></svg>`,
    legend: `<span class="lg-static"><i style="background:${c.measured}"></i>Measured, each bin</span><span class="lg-static"><i style="background:${PREDICTED()}"></i>NOAA prediction, ${dist(m.binsM[rt])} bin</span>${furniture}`,
    note: `seen from above, north up, on NOAA's chart${chart ? ` (ENC ${chart.cell.name}, 1:${chart.cell.scale.toLocaleString("en-US")}, edition ${chart.cell.edition}; not for navigation)` : ""}: ` +
      `land, piers and wharves, depth contours in metres below MLLW and the dredged channel; the meter's beam to scale (${dist(m.binsM[0])} to ${dist(m.binsM[m.binsM.length - 1])} out), ` +
      `each arrow the hour's mean current at that bin, its length on the speed scale; the beam's bearing (about ${Math.round(beam)} degrees, square to the end of the charted pier, along which the nearest bin's flow runs) is inferred, as NOAA does not publish it`,
  };
}

/* ---------- Readouts and pin ---------- */

export function meterReadouts(d: StationData): string[] {
  const m = d.meter;
  const o = m?.last;
  const state = o ? obsState({ time: o.time } as LastObs) : "offline";
  const out = [
    readoutHtml(
      o ? `${Math.abs(val(o.along_kt)).toFixed(unit().digits)}<small>${unit().label}</small>` : "--",
      o ? `Current, ${phaseWord(o.along_kt)}` : "Current",
      "mflow",
      o ? `${speed(o.spd_kt)} toward ${compass(o.dir_deg)} (${o.dir_deg}&deg;), ${dist(m!.binsM[m!.realtime - 1])} out &middot; ${ago(o.time)}` : "no recent reading",
      state,
    ),
  ];
  if (pointOf(d)) {
    const [x0, x1] = [d.now - 14 * 86400, d.now];
    for (const [name, f] of [["NOAA prediction", predictedAt], ["NECOFS model", modelAt]] as const) {
      const s = score(d, f, x0, x1);
      out.push(readoutHtml(s ? `${val(s.rms).toFixed(unit().digits)}<small>${unit().label}</small>` : "--", `${name}, RMS difference`, "mflow",
        s ? `slack ${minutes(s.slackMin)}, flood ${ratio(s.flood)} the meter's &middot; last 14 days` : "too few hours to compare"));
    }
  }
  return out;
}

/** The meter's pin: its current at the real-time bin, now or at the page's time. */
export function meterPin(d: StationData): Pin {
  const base = { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, kind: "shore" as const };
  const m = d.meter;
  if (AT != null) {
    const v = measuredAt(d, Math.floor(AT / HOUR) * HOUR);
    return Number.isFinite(v)
      ? { ...base, state: "live", label: `Current ${fmtAlong(val(v))}<br>measured ${atLabel(AT)}` }
      : { ...base, state: "offline", label: `no reading at ${atLabel(AT)}` };
  }
  const o = m?.last;
  return {
    ...base,
    state: o ? obsState({ time: o.time } as LastObs) : "offline",
    label: o ? `Current ${speed(o.spd_kt)} ${phaseWord(o.along_kt)}, toward ${compass(o.dir_deg)}, ${ago(o.time)}<br>${m!.place}, ${dist(m!.binsM[m!.realtime - 1])} out` : "no recent reading",
  };
}

/** The section's record line. */
export const meterRecord = (d: StationData) =>
  `Current meter since ${fmtDate.format(new Date(`${d.meter?.start}T12:00:00Z`))}; hourly, the last 30 days; predictions from NOAA, the model from NECOFS`;
