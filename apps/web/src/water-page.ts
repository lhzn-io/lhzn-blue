/** The water levels page: observed hourly water level (shore.json) against NOAA's tide predictions (shore-tides.json)
 * at the four shore stations, west to east. Plain SVG drawn from the theme tokens; colours are CSS variables in
 * style attributes, so a theme switch needs no redraw.
 *
 * The observed level is the mean of the 6-minute readings in [hour, hour + 1); NOAA's hourly prediction is the
 * level at the top of the hour. They are compared over the same hour: the prediction is averaged over the hour
 * (Simpson's rule, with the half-hour value from a cubic through the four nearest hours). Without this, a
 * 30-minute offset on a tide rising 1.5 ft an hour would read as a 0.7 ft departure.
 */
import "./site.css";
import "./away-links";
import "./water-page.css";
import { el, niceStep } from "./chart";
import { setPlayButton, timeTrack } from "./time-axis";

const DATA = "/data/v1";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TZ = "America/New_York";
const IDS = ["KPTN", "BRPT", "NWHV", "NLON"] as const;
type Sid = (typeof IDS)[number];
const FALLBACK: Record<Sid, { name: string; km: number; lon: number; lat: number }> = {
  KPTN: { name: "Kings Point", km: 0, lon: -73.7649, lat: 40.8103 },
  BRPT: { name: "Bridgeport", km: 62, lon: -73.18397, lat: 41.17582 },
  NWHV: { name: "New Haven", km: 90, lon: -72.9083, lat: 41.2833 },
  NLON: { name: "New London", km: 160, lon: -72.09556, lat: 41.371666 },
};

const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const fmtKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtFull = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric" });
const $ = (id: string) => document.getElementById(id)!;
const sgn = (v: number, d = 1) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(d)}`;
const v = (name: string) => `var(--${name})`;

// ---------------------------------------------------------------------------------------------
// Data

interface ShoreJson {
  generated_at: string;
  stations: Record<string, { t0: string; step: number; level_ft: (number | null)[] }>;
}
interface TideStation {
  name: string;
  km: number | null;
  lat?: number;
  lon?: number;
  pred?: { t0: string; step: number; ft: (number | null)[] };
  hilo?: { t: string; ft: number; type: "H" | "L" }[];
  datums_ft?: Record<string, number>;
  flood_ft?: Record<string, number | null>;
  last_error?: string;
}
interface TidesJson {
  generated_at: string;
  stations: Record<string, TideStation>;
  moon?: { t: string; phase: Phase }[];
}
type Phase = "new" | "first_quarter" | "full" | "last_quarter";
interface Extreme {
  t: number;
  p: number; // predicted, ft MLLW
  type: "H" | "L";
  o?: number; // observed, ft MLLW
}
interface Station {
  id: Sid;
  name: string;
  km: number;
  lon: number;
  lat: number;
  o0: number;
  obs: (number | null)[];
  p0: number;
  pred: (number | null)[];
  hilo: Extreme[];
  dat: Record<string, number>;
  fl: Record<string, number | null>;
  lastObs: number; // start of the last observed hour
}

let S: Record<Sid, Station>;
let MOON: { t: number; phase: Phase }[] = [];

function obsAt(s: Station, h: number): number {
  const x = s.obs[Math.round((h - s.o0) / HOUR)];
  return x == null ? NaN : x;
}
function predAt(s: Station, h: number): number {
  const x = s.pred[Math.round((h - s.p0) / HOUR)];
  return x == null ? NaN : x;
}
/** NOAA's prediction averaged over [h, h + 1 hour), to compare with the observed hourly mean. */
function predMean(s: Station, h: number): number {
  const a = predAt(s, h), b = predAt(s, h + HOUR);
  const a0 = predAt(s, h - HOUR), b1 = predAt(s, h + 2 * HOUR);
  const mid = Number.isFinite(a0) && Number.isFinite(b1) ? (-a0 + 9 * a + 9 * b - b1) / 16 : (a + b) / 2;
  return (a + 4 * mid + b) / 6;
}
const departure = (s: Station, h: number) => obsAt(s, h) - predMean(s, h);

function model(shore: ShoreJson, tides: TidesJson): Record<Sid, Station> {
  const out = {} as Record<Sid, Station>;
  for (const id of IDS) {
    const o = shore.stations[id];
    const t = tides.stations[id] ?? ({} as TideStation);
    const f = FALLBACK[id];
    const o0 = o ? Date.parse(o.t0) : 0;
    const obs = o?.level_ft ?? [];
    let last = obs.length - 1;
    while (last >= 0 && obs[last] == null) last--;
    const s: Station = {
      id,
      name: t.name || f.name,
      km: t.km ?? f.km,
      lon: f.lon,
      lat: f.lat,
      o0,
      obs,
      p0: t.pred ? Date.parse(t.pred.t0) : 0,
      pred: t.pred?.ft ?? [],
      hilo: (t.hilo ?? []).map((e) => ({ t: Date.parse(e.t), p: e.ft, type: e.type })),
      dat: t.datums_ft ?? {},
      fl: t.flood_ft ?? {},
      lastObs: last >= 0 ? o0 + last * HOUR : 0,
    };
    // Observed extreme: the highest (or lowest) hourly mean whose hour is centred within 2 hours of the predicted
    // time, corrected by the same statistic of the hour-averaged prediction (hourly means flatten a peak by up
    // to 0.15 ft at Kings Point; the correction keeps that out of the comparison).
    for (const e of s.hilo) {
      if (e.t > s.lastObs + HOUR) continue;
      const hs: number[] = [];
      for (let h = Math.floor((e.t - 2.5 * HOUR) / HOUR) * HOUR; h <= e.t + 2 * HOUR; h += HOUR) if (Math.abs(h + HOUR / 2 - e.t) <= 2 * HOUR) hs.push(h);
      const pairs = hs.map((h) => [obsAt(s, h), predMean(s, h)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      if (pairs.length < 3) continue;
      const pick = e.type === "H" ? Math.max : Math.min;
      e.o = e.p + pick(...pairs.map((p) => p[0])) - pick(...pairs.map((p) => p[1]));
    }
    out[id] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SVG helpers

type Attrs = Record<string, string | number>;
function add<K extends keyof SVGElementTagNameMap>(parent: Element, name: K, attrs: Attrs, text?: string): SVGElementTagNameMap[K] {
  const node = el(name, attrs);
  if (text != null) node.textContent = text;
  parent.append(node);
  return node;
}
function tip(node: SVGElement, text: string): void {
  add(node, "title", {}, text);
}
const lin = (d0: number, d1: number, r0: number, r1: number) => (x: number) => r0 + ((x - d0) / (d1 - d0)) * (r1 - r0);
const narrow = () => ($("lad-chart").clientWidth || window.innerWidth) < 560;

interface Frame {
  svg: SVGSVGElement;
  g: SVGGElement;
  w: number;
  h: number;
}
function frame(box: HTMLElement, height: number, m: { t: number; r: number; b: number; l: number }, label: string): Frame {
  const W = Math.max(260, Math.floor(box.clientWidth));
  box.replaceChildren();
  const svg = el("svg", { viewBox: `0 0 ${W} ${height}`, width: W, height, class: "wp-svg", role: "img", "aria-label": label });
  const g = add(svg, "g", { transform: `translate(${m.l},${m.t})` });
  box.append(svg);
  return { svg, g, w: W - m.l - m.r, h: height - m.t - m.b };
}

function hline(g: Element, x0: number, x1: number, y: number, color: string, dash = "", width = 1.2, opacity = 1): void {
  add(g, "line", { x1: x0, x2: x1, y1: y, y2: y, style: `stroke:${color};stroke-width:${width};stroke-dasharray:${dash || "none"};opacity:${opacity}` });
}
/** A reference level across the plot, labelled at its right end inside the plot. */
function refLine(g: Element, w: number, y: number, color: string, dash: string, label: string, above = true, left = false): void {
  hline(g, 0, w, y, color, dash);
  add(g, "text", { x: left ? 2 : w - 2, y: above ? y - 4 : y + 11, "text-anchor": left ? "start" : "end", class: "wp-ref" }, label);
}
function yAxis(g: Element, y: (v: number) => number, lo: number, hi: number, w: number, unit = " ft", grid = true): void {
  const step = niceStep(hi - lo, 5);
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) {
    const yy = y(t);
    if (grid) hline(g, 0, w, yy, v("chart-grid"), "", 1);
    add(g, "text", { x: -6, y: yy + 3, "text-anchor": "end" }, `${+t.toFixed(2)}${unit}`);
  }
}
/** Day ticks along the bottom: ET midnights every `every` days, aligned so a tick falls on the last whole day. */
function dayTicks(g: Element, x: (t: number) => number, t0: number, t1: number, h: number, every: number): void {
  const mids: number[] = [];
  for (let t = t0 - DAY; t <= t1 + DAY; t += HOUR) {
    // ET midnight: the hour whose ET date differs from the hour before.
    if (fmtKey.format(t) !== fmtKey.format(t - HOUR) && t >= t0 && t <= t1) mids.push(t);
  }
  const keep = mids.filter((_, i) => (mids.length - 1 - i) % every === 0);
  const x0 = x(t0), x1 = x(t1);
  for (const t of keep) {
    const xt = x(t);
    add(g, "line", { x1: xt, x2: xt, y1: h, y2: h + 4, style: `stroke:${v("chart-axis")}` });
    // A label near either end is anchored inward so it never runs past the plot.
    const anchor = xt > x1 - 22 ? "end" : xt < x0 + 22 ? "start" : "middle";
    add(g, "text", { x: xt, y: h + 15, "text-anchor": anchor }, fmtDay.format(t));
  }
}

/** A moon phase glyph: filled for new, open for full, half filled for the quarters (the dark half filled). */
function moonGlyph(g: Element, x: number, y: number, r: number, phase: Phase): SVGGElement {
  const m = add(g, "g", { transform: `translate(${x},${y})` });
  const ink = v("ink-mute");
  add(m, "circle", { r, style: `fill:${phase === "new" ? ink : v("bg")};stroke:${ink};stroke-width:1` });
  if (phase === "first_quarter" || phase === "last_quarter") {
    const s = phase === "first_quarter" ? 0 : 1; // first quarter: lit on the right, so the left half is dark
    add(m, "path", { d: `M0,${-r} A${r},${r} 0 0 ${s} 0,${r} Z`, style: `fill:${ink}` });
  }
  return m;
}
const PHASE_NAME: Record<Phase, string> = { new: "new moon", first_quarter: "first quarter moon", full: "full moon", last_quarter: "last quarter moon" };
function moonRow(g: Element, x: (t: number) => number, t0: number, t1: number, y: number): void {
  for (const m of MOON) {
    if (m.t < t0 || m.t > t1) continue;
    tip(moonGlyph(g, x(m.t), y, 4, m.phase), `${PHASE_NAME[m.phase]}, ${fmtFull.format(m.t)}`);
  }
}
function moonKey(): string {
  const glyph = (p: Phase) => {
    const r = 4, ink = "var(--ink-mute)";
    const half = p === "first_quarter" || p === "last_quarter" ? `<path d="M0,${-r} A${r},${r} 0 0 ${p === "first_quarter" ? 0 : 1} 0,${r} Z" style="fill:${ink}"/>` : "";
    return `<svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"><circle r="${r}" style="fill:${p === "new" ? ink : "var(--bg)"};stroke:${ink}"/>${half}</svg>`;
  };
  return `${glyph("new")}new ${glyph("first_quarter")}first quarter ${glyph("full")}full ${glyph("last_quarter")}last quarter moon`;
}

/** A filled area between zero and the values of one sign; gaps (NaN) break it. */
function signedArea(pts: [number, number][], x: (t: number) => number, y: (v: number) => number, sign: 1 | -1): string {
  let d = "";
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length > 1) d += `M${x(run[0][0])},${y(0)}` + run.map(([t, val]) => `L${x(t).toFixed(1)},${y(sign > 0 ? Math.max(0, val) : Math.min(0, val)).toFixed(1)}`).join("") + `L${x(run[run.length - 1][0])},${y(0)}Z`;
    run = [];
  };
  for (const p of pts) {
    if (Number.isFinite(p[1])) run.push(p);
    else flush();
  }
  flush();
  return d;
}

// ---------------------------------------------------------------------------------------------
// Station selector, shared by the ladder and the highest tides ahead

let station: Sid = "KPTN";
const pickers: HTMLElement[] = [];
function picker(id: string): void {
  const box = $(id);
  pickers.push(box);
  box.innerHTML = IDS.map((s) => `<button class="tab" type="button" data-k="${s}" aria-pressed="${s === station}">${S[s].name}</button>`).join("");
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    station = b.dataset.k as Sid;
    for (const p of pickers) p.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.k === station)));
    drawLadder();
    drawKing();
  });
}
function labelPickers(): void {
  for (const p of pickers) p.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.textContent = narrow() ? b.dataset.k! : S[b.dataset.k as Sid].name));
}

// ---------------------------------------------------------------------------------------------
// The tide ladder

function drawLadder(): void {
  const s = S[station];
  const now = s.lastObs;
  const from = now - 28 * DAY, to = now + 21 * DAY;
  const ev = s.hilo.filter((e) => e.t >= from && e.t <= to);
  const box = $("lad-chart");
  if (!ev.length) {
    box.textContent = "No predictions for this station yet.";
    return;
  }
  const nar = narrow();
  const { svg, g, w, h } = frame(box, nar ? 300 : 340, { t: 20, r: 6, b: 24, l: 48 }, `Tide ladder, ${s.name}`);
  const x = lin(from, to, 0, w);
  const vals = ev.flatMap((e) => (e.o != null ? [e.p, e.o] : [e.p]));
  const top = Math.max(...vals, s.fl.nws_moderate ?? s.fl.nws_minor ?? s.dat.MHHW ?? 0) + 0.3;
  const bot = Math.min(-1, Math.min(...vals) - 0.3);
  const y = lin(bot, top, h, 0);
  add(g, "rect", { x: x(now), y: 0, width: w - x(now), height: h, style: `fill:${v("panel")};opacity:0.75` });
  yAxis(g, y, bot, top, w);
  add(g, "line", { x1: x(now), x2: x(now), y1: -4, y2: h, style: `stroke:${v("wp-gold")};stroke-width:1.2` });
  add(g, "text", { x: x(now) + 5, y: h - 6, class: "wp-ref" }, "ahead: predicted");
  if (s.fl.nws_moderate != null) refLine(g, w, y(s.fl.nws_moderate), v("wp-flood"), "6 3", "moderate flood");
  if (s.fl.nws_minor != null) refLine(g, w, y(s.fl.nws_minor), v("wp-flood"), "", "minor flood", false);
  if (s.dat.MHHW != null) refLine(g, w, y(s.dat.MHHW), v("faint"), "5 4", "MHHW", false);
  refLine(g, w, y(0), v("faint"), "2 3", "MLLW", false, true);
  moonRow(g, x, from, to, -12);
  const beyond = (e: Extreme) => e.o != null && (e.o - e.p) * (e.type === "H" ? 1 : -1) > 0.5;
  const r = nar ? 2.2 : 2.8;
  for (const e of ev) {
    if (e.o == null) continue;
    add(g, "line", { x1: x(e.t), x2: x(e.t), y1: y(e.p), y2: y(e.o), style: `stroke:${beyond(e) ? v("wp-amber") : v("wp-willow")};stroke-width:${beyond(e) ? 2 : 1.4}` });
  }
  for (const e of ev) add(g, "circle", { cx: x(e.t), cy: y(e.p), r, style: `fill:${v("bg")};stroke:${v("ink-mute")};stroke-width:1` });
  for (const e of ev) if (e.o != null) add(g, "circle", { cx: x(e.t), cy: y(e.o), r: r + 0.3, style: `fill:${beyond(e) ? v("wp-amber") : v("wp-gold")}` });
  dayTicks(g, x, from, to, h, nar ? 14 : 7);
  // The readout follows the pointer to the nearest mark.
  const ring = add(g, "circle", { r: 6, cx: -99, cy: -99, style: `fill:none;stroke:${v("ink")};stroke-width:1` });
  const read = $("lad-read");
  const show = (e: Extreme) => {
    ring.setAttribute("cx", String(x(e.t)));
    ring.setAttribute("cy", String(y(e.o ?? e.p)));
    const kind = e.type === "H" ? "High" : "Low";
    read.textContent = e.o != null
      ? `${kind}, ${fmtFull.format(e.t)}: predicted ${e.p.toFixed(1)} ft, observed ${e.o.toFixed(1)} ft (${sgn(e.o - e.p)} ft)`
      : `${kind}, ${fmtFull.format(e.t)}: predicted ${e.p.toFixed(1)} ft`;
  };
  const hit = add(g, "rect", { x: 0, y: 0, width: w, height: h, class: "wp-hit" });
  hit.addEventListener("pointermove", (evt) => {
    const px = (evt as PointerEvent).clientX - svg.getBoundingClientRect().left - 48;
    let best = ev[0];
    for (const e of ev) if (Math.abs(x(e.t) - px) < Math.abs(x(best.t) - px)) best = e;
    show(best);
  });
  // Start on the most recent observed high.
  const lastHigh = [...ev].reverse().find((e) => e.type === "H" && e.o != null);
  if (lastHigh) show(lastHigh);
  else read.textContent = "";
}

// ---------------------------------------------------------------------------------------------
// The departure from prediction (small multiples, one row per station, west to east)

function drawDeparture(): void {
  const nar = narrow();
  const rowH = nar ? 58 : 66;
  const box = $("dep-chart");
  const { g, w } = frame(box, IDS.length * rowH + 34, { t: 14, r: 4, b: 20, l: nar ? 50 : 92 }, "Observed minus predicted water level, four stations");
  const t1 = Math.max(...IDS.map((id) => S[id].lastObs));
  const t0 = Math.max(t1 - 45 * DAY, Math.min(...IDS.map((id) => S[id].p0 + HOUR)));
  const x = lin(t0, t1, 0, w);
  const series = IDS.map((id) => {
    const pts: [number, number][] = [];
    for (let h = t0; h <= t1; h += HOUR) pts.push([h + HOUR / 2, departure(S[id], h)]);
    return { id, pts };
  });
  const ext = Math.max(0.5, ...series.flatMap((r) => r.pts.map((p) => (Number.isFinite(p[1]) ? Math.abs(p[1]) : 0))));
  const lim = Math.ceil(ext * 10) / 10;
  const y = lin(-lim, lim, rowH - 8, 0);
  let big: { id: Sid; t: number; v: number } | null = null;
  series.forEach((r, i) => {
    const row = add(g, "g", { transform: `translate(0,${i * rowH})` });
    hline(row, 0, w, y(0), v("rule"), "", 1);
    add(row, "path", { d: signedArea(r.pts, x, y, 1), style: `fill:${v("wp-amber")};opacity:0.6` });
    add(row, "path", { d: signedArea(r.pts, x, y, -1), style: `fill:${v("wp-willow")};opacity:0.6` });
    add(row, "text", { x: -8, y: y(0) + 3, "text-anchor": "end", class: "wp-stn" }, nar ? r.id : S[r.id].name);
    for (const [t, d] of r.pts) if (Number.isFinite(d) && (!big || Math.abs(d) > Math.abs(big.v))) big = { id: r.id, t, v: d };
  });
  add(g, "text", { x: w, y: -4, "text-anchor": "end" }, `each row spans ±${lim.toFixed(1)} ft`);
  dayTicks(g, x, t0, t1, IDS.length * rowH - 6, nar ? 14 : 7);
  const days = Math.round((t1 - t0) / DAY);
  const b = big as { id: Sid; t: number; v: number } | null;
  $("dep-say").innerHTML = b
    ? `Largest in ${days} days: <b>${sgn(b.v)} ft at ${S[b.id].name}</b>, ${fmtHour.format(b.t - HOUR / 2)}.`
    : "No overlapping observations and predictions yet.";
}

// ---------------------------------------------------------------------------------------------
// The Sound tilts: a profile along the Sound and a minimap, on one clock

let tiltMode: "level" | "dep" = "level";
let tiltTimer: number | null = null;
const TRAIL = 6;

function tiltSpan(): { t0: number; t1: number } {
  const t1 = Math.min(...IDS.map((id) => S[id].lastObs));
  return { t0: t1 - 10 * DAY, t1 };
}
function tiltValue(s: Station, h: number): number {
  return tiltMode === "level" ? obsAt(s, h) - (s.dat.MSL ?? NaN) : departure(s, h);
}
function tiltHour(): number {
  const { t0 } = tiltSpan();
  return t0 + Number(($("tilt-t") as HTMLInputElement).value) * HOUR;
}

function drawTilt(): void {
  const T = tiltHour();
  const lim = tiltMode === "level" ? 5 : 2;
  const label = tiltMode === "level" ? "ft from mean sea level" : "ft, observed minus predicted";
  drawProfile(T, lim, label);
  drawMinimap(T, lim);
  const vals = IDS.map((id) => `${id} ${(() => { const q = tiltValue(S[id], T); return Number.isFinite(q) ? sgn(q) : "n/a"; })()}`);
  $("tilt-read").textContent = `${fmtHour.format(T)} hour: ${vals.join(", ")} ft`;
}

function drawProfile(T: number, lim: number, label: string): void {
  const box = $("tilt-chart");
  const { g, w, h } = frame(box, 250, { t: 20, r: 14, b: 26, l: 40 }, "Water level along the Sound");
  const x = lin(0, 160, 0, w);
  const y = lin(-lim, lim, h, 0);
  yAxis(g, y, -lim, lim, w, "");
  hline(g, 0, w, y(0), v("chart-zero"), "", 1);
  add(g, "text", { x: 0, y: -8, class: "wp-lab" }, label);
  for (let k = TRAIL; k >= 0; k--) {
    const t = T - k * HOUR;
    const pts = IDS.map((id) => [x(S[id].km), y(Math.max(-lim, Math.min(lim, tiltValue(S[id], t))))] as [number, number]).filter((p) => Number.isFinite(p[1]));
    if (pts.length < 2) continue;
    add(g, "path", {
      d: "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L"),
      style: k ? `fill:none;stroke:${v("wp-willow")};stroke-width:1;opacity:${(0.55 - k * 0.07).toFixed(2)}` : `fill:none;stroke:${v("wp-gold")};stroke-width:2.6`,
    });
    if (!k) for (const id of IDS) {
      const q = tiltValue(S[id], t);
      if (!Number.isFinite(q)) continue;
      const cy = y(Math.max(-lim, Math.min(lim, q)));
      add(g, "circle", { cx: x(S[id].km), cy, r: 4, style: `fill:${v("wp-gold")}` });
      add(g, "text", { x: x(S[id].km), y: q >= 0 ? cy - 9 : cy + 16, "text-anchor": S[id].km === 0 ? "start" : S[id].km === 160 ? "end" : "middle", class: "wp-val wp-ref" }, sgn(q));
    }
  }
  for (const id of IDS) {
    const km = S[id].km;
    add(g, "text", { x: x(km), y: h + 16, "text-anchor": km === 0 ? "start" : km === 160 ? "end" : "middle", class: "wp-stn" }, narrow() || w < 420 ? id : S[id].name);
  }
}

// A hand-traced outline of the Sound's water (lon, lat), simplified: the Connecticut shore west to east, round the
// eastern end, and back along Long Island's north shore. Harbour notches reach the gauges at Bridgeport, New Haven
// and New London.
const SOUND: [number, number][] = [
  [-73.79, 40.8], [-73.78, 40.88], [-73.68, 40.95], [-73.62, 40.99], [-73.54, 41.02], [-73.41, 41.07], [-73.33, 41.1], [-73.24, 41.13],
  [-73.2, 41.15], [-73.19, 41.185], [-73.17, 41.185], [-73.16, 41.155], [-73.1, 41.16], [-73.04, 41.2], [-72.94, 41.24], [-72.925, 41.295],
  [-72.895, 41.295], [-72.88, 41.245], [-72.8, 41.255], [-72.68, 41.265], [-72.6, 41.265], [-72.52, 41.255], [-72.44, 41.265], [-72.35, 41.275],
  [-72.2, 41.3], [-72.11, 41.31], [-72.1, 41.385], [-72.085, 41.385], [-72.075, 41.31], [-71.95, 41.31], [-71.86, 41.3],
  [-71.92, 41.26], [-72.05, 41.24], [-72.22, 41.165], [-72.36, 41.1], [-72.53, 41.02], [-72.84, 40.96], [-73.07, 40.95], [-73.15, 40.96],
  [-73.4, 40.94], [-73.48, 40.92], [-73.53, 40.89], [-73.65, 40.86], [-73.72, 40.85], [-73.76, 40.81],
];

function drawMinimap(T: number, lim: number): void {
  const box = $("tilt-map");
  const W = Math.max(260, Math.floor(box.clientWidth));
  const lon0 = -73.86, lon1 = -71.84, lat0 = 40.76, lat1 = 41.42;
  const k = Math.cos((41.1 * Math.PI) / 180);
  const pad = { l: 6, r: 6 };
  const sc = (W - pad.l - pad.r) / ((lon1 - lon0) * k);
  const barMax = Math.max(34, Math.min(62, W * 0.11));
  const mapH = (lat1 - lat0) * sc;
  const H = Math.ceil(mapH + barMax + 34);
  const top = barMax * 0.75;
  const px = (lon: number) => pad.l + (lon - lon0) * k * sc;
  const py = (lat: number) => top + (lat1 - lat) * sc;
  box.replaceChildren();
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "wp-svg", role: "img", "aria-label": "Minimap of Long Island Sound with the water level at each station" });
  box.append(svg);
  add(svg, "path", { d: "M" + SOUND.map(([a, b]) => `${px(a).toFixed(1)},${py(b).toFixed(1)}`).join("L") + "Z", style: `fill:${v("wp-water")};stroke:${v("wp-coast")};stroke-width:1;stroke-linejoin:round` });
  const bh = (q: number) => (Math.max(-lim, Math.min(lim, q)) / lim) * barMax;
  const colour = (q: number) => (tiltMode === "dep" ? (q >= 0 ? v("wp-amber") : v("wp-willow")) : q >= 0 ? v("wp-cobalt") : v("wp-pale"));
  for (const id of IDS) {
    const s = S[id];
    const cx = px(s.lon), cy = py(s.lat);
    hline(svg, cx - 9, cx + 9, cy, v("ink-mute"), "", 1);
    // the six hours before, as fading ticks: the bar's recent path
    for (let j = TRAIL; j >= 1; j--) {
      const q = tiltValue(s, T - j * HOUR);
      if (Number.isFinite(q)) hline(svg, cx - 6, cx + 6, cy - bh(q), v("ink-mute"), "", 1, 0.6 - j * 0.08);
    }
    const q = tiltValue(s, T);
    if (!Number.isFinite(q)) continue;
    const b = bh(q);
    const bar = add(svg, "rect", { x: cx - 4.5, y: Math.min(cy, cy - b), width: 9, height: Math.max(1, Math.abs(b)), style: `fill:${colour(q)}` });
    tip(bar, `${s.name}: ${sgn(q)} ft`);
    add(svg, "circle", { cx, cy: cy - b, r: 3.2, style: `fill:${v("wp-gold")}` });
    add(svg, "text", { x: cx + 8, y: cy - b + (b >= 0 ? -2 : 9), class: "wp-val wp-ref" }, sgn(q));
  }
  // station codes along the bottom edge, under each station
  for (const id of IDS) {
    const s = S[id];
    add(svg, "text", { x: px(s.lon), y: H - 4, "text-anchor": id === "KPTN" ? "start" : id === "NLON" ? "end" : "middle", class: "wp-stn" }, id);
    add(svg, "line", { x1: px(s.lon), x2: px(s.lon), y1: py(s.lat) + 2, y2: H - 14, style: `stroke:${v("rule")};stroke-dasharray:1 3` });
  }
  add(svg, "text", { x: W - 4, y: 10, "text-anchor": "end" }, tiltMode === "level" ? `bars: ±${lim} ft from mean sea level` : `bars: ±${lim} ft from the prediction`);
}

function wireTilt(): void {
  const range = $("tilt-t") as HTMLInputElement;
  const { t0, t1 } = tiltSpan();
  const n = Math.round((t1 - t0) / HOUR);
  timeTrack(range, (v) => (t0 + v * HOUR) / 1000);
  range.min = "0";
  range.max = String(n);
  range.step = "1";
  range.value = String(n);
  const mode = $("tilt-mode");
  mode.innerHTML = `<button class="tab" type="button" data-k="level" aria-pressed="true">Water level</button><button class="tab" type="button" data-k="dep" aria-pressed="false">Departure</button>`;
  mode.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    tiltMode = b.dataset.k as "level" | "dep";
    mode.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.k === tiltMode)));
    drawTilt();
  });
  range.addEventListener("input", drawTilt);
  const play = $("tilt-play");
  setPlayButton(play, false);
  const stop = () => {
    if (tiltTimer != null) clearInterval(tiltTimer);
    tiltTimer = null;
    setPlayButton(play, false);
  };
  play.addEventListener("click", () => {
    if (tiltTimer != null) return stop();
    if (Number(range.value) >= n) range.value = String(Math.max(0, n - 72)); // replay the last three days
    setPlayButton(play, true);
    tiltTimer = window.setInterval(() => {
      const next = Number(range.value) + 1;
      if (next > n) return stop();
      range.value = String(next);
      drawTilt();
    }, 160);
  });
}

// ---------------------------------------------------------------------------------------------
// The highest tides ahead

function moonPhrase(t: number): string {
  const near = MOON.filter((m) => m.phase === "new" || m.phase === "full");
  if (!near.length) return "";
  const m = near.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const days = Math.round((t - m.t) / DAY);
  const words = ["", "a day", "two days", "three days", "four days", "five days", "six days", "seven days"];
  const n = words[Math.abs(days)] ?? `${Math.abs(days)} days`;
  if (days === 0) return `, on the day of the ${PHASE_NAME[m.phase]}`;
  return `, ${n} ${days > 0 ? "after" : "before"} the ${PHASE_NAME[m.phase]}`;
}

function drawKing(): void {
  const s = S[station];
  const now = s.lastObs;
  const highs = s.hilo.filter((e) => e.type === "H" && e.t > now);
  const byDay = new Map<string, Extreme>();
  for (const e of highs) {
    const key = fmtKey.format(e.t);
    const cur = byDay.get(key);
    if (!cur || e.p > cur.p) byDay.set(key, e);
  }
  const days = [...byDay.values()];
  const box = $("king-chart");
  const mhhw = s.dat.MHHW;
  if (!days.length || mhhw == null) {
    box.textContent = "No predictions for this station yet.";
    $("king-say").textContent = "";
    return;
  }
  const nar = narrow();
  const { g, w, h } = frame(box, nar ? 230 : 250, { t: 20, r: 6, b: 24, l: 48 }, `Highest predicted tide each day, ${s.name}`);
  const minor = s.fl.nws_minor;
  const lo = mhhw - 1.5;
  const maxV = Math.max(...days.map((e) => e.p));
  const hi = Math.max(minor ?? mhhw, maxV) + 0.3;
  const y = lin(lo, hi, h, 0);
  const t0 = days[0].t - DAY / 2, t1 = days[days.length - 1].t + DAY / 2;
  const x = lin(t0, t1, 0, w);
  const bw = Math.max(2, (w / days.length) * 0.66);
  yAxis(g, y, lo, hi, w, " ft", false);
  for (const e of days) {
    const colour = e.p >= mhhw + 0.8 ? v("wp-bar-high") : e.p >= mhhw ? v("wp-bar-mid") : v("wp-bar-low");
    const r = add(g, "rect", { x: x(e.t) - bw / 2, y: y(Math.max(lo, e.p)), width: bw, height: h - y(Math.max(lo, e.p)), style: `fill:${colour}` });
    tip(r, `${fmtFull.format(e.t)}: ${e.p.toFixed(2)} ft (${sgn(e.p - mhhw, 2)} ft against MHHW)`);
  }
  if (minor != null) refLine(g, w, y(minor), v("wp-flood"), "", "NWS minor flood");
  refLine(g, w, y(mhhw), v("faint"), "5 4", "MHHW");
  moonRow(g, x, t0, t1, -12);
  dayTicks(g, x, t0, t1, h, nar ? 14 : 7);
  const top = days.reduce((a, b) => (b.p > a.p ? b : a));
  const span = Math.round((t1 - t0) / DAY);
  $("king-say").innerHTML = `Highest predicted at ${s.name}, next ${span} days: <b>${top.p.toFixed(1)} ft, ${fmtFull.format(top.t)}</b>${moonPhrase(top.t)}${minor != null ? `; ${(minor - top.p).toFixed(1)} ft below minor flood` : ""}.`;
}

// ---------------------------------------------------------------------------------------------
// Theme, freshness, start

function wireTheme(): void {
  const btn = $("wp-theme");
  const label = () => {
    const light = document.documentElement.dataset.theme === "light";
    btn.textContent = light ? "Dark" : "Light";
    btn.setAttribute("aria-pressed", String(!light));
    btn.setAttribute("aria-label", light ? "Switch to the dark theme" : "Switch to the light theme");
  };
  label();
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("lhzn-blue-theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    label();
  });
}

function drawAll(): void {
  labelPickers();
  drawTilt();
  drawKing();
  drawLadder();
  drawDeparture();
}

async function main(): Promise<void> {
  wireTheme();
  const get = async <T,>(name: string): Promise<T> => {
    const r = await fetch(`${DATA}/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  let shore: ShoreJson, tides: TidesJson;
  try {
    [shore, tides] = await Promise.all([get<ShoreJson>("shore.json"), get<TidesJson>("shore-tides.json")]);
  } catch (e) {
    $("wp-fresh").innerHTML = `<span class="warn">The water level data could not be loaded (${String((e as Error).message)}). Try again shortly.</span>`;
    return;
  }
  S = model(shore, tides);
  MOON = (tides.moon ?? []).map((m) => ({ t: Date.parse(m.t), phase: m.phase }));
  const last = Math.max(...IDS.map((id) => S[id].lastObs));
  const failed = IDS.filter((id) => tides.stations[id]?.last_error);
  $("wp-fresh").innerHTML =
    `Observed to the hour from ${fmtHour.format(last)} (NOAA, preliminary). Predictions retrieved ${fmtFull.format(Date.parse(tides.generated_at))}. Times Eastern; levels in feet above MLLW.` +
    (failed.length ? ` <span class="warn">Predictions not refreshed for ${failed.join(", ")}.</span>` : "");
  document.querySelectorAll(".wp-moonkey").forEach((n) => (n.innerHTML = MOON.length ? moonKey() : ""));
  picker("king-st");
  picker("lad-st");
  wireTilt();
  drawAll();
  let width = window.innerWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    clearTimeout(timer);
    timer = window.setTimeout(drawAll, 150);
  });
}

main();
