/**
 * The Piscataqua River (/piscataqua/, unlisted): the UNH G-2000 buoy's current profiler, with NOAA water level,
 * tide and tidal current predictions nearby. One file, v1/piscataqua.json (jobs: piscataqua.py), refreshed hourly.
 *
 * Gaps are expected: the buoy's shore PC uploads when it can, so its records may end days before now. The page says
 * how old each source is, draws gaps as gaps, starts at the buoy's last record when the buoy is quiet, and keeps the
 * live NOAA panels running to now and two days ahead.
 */
import "./site.css";
import "./away-links";
import "./forecast-page.css";
import "./piscataqua-page.css";
import { cssVar, el, markAsOf, renderLines, type Line } from "./chart";
import { CURRENTS_FLOOR, CURRENTS_RAMP, CURRENTS_RAMP_DARK, CURRENTS_TOP } from "./currents-ramp";
import { MEASURED_TOP, measuredColour } from "./measured-ramp";
import type { Map as MapLibreMap, ExpressionSpecification, GeoJSONSource } from "maplibre-gl";

interface Series { t0: string; step: number; v: (number | null)[] }
interface Station extends Series { id: string; name: string; lat: number; lon: number }
interface Buoy {
  name: string; lat: number; lon: number; position_as_of: string; instrument: string; file_updated: string; last: string;
  t0: string; t: number[]; spd: (number | null)[][]; dir: (number | null)[][]; temp: (number | null)[]; pressure: (number | null)[];
  pitch: (number | null)[]; roll: (number | null)[]; flag: number[];
}
interface Tide extends Station { hilo: { t: string; m: number; type: "H" | "L" }[] }
interface Current extends Station { flood_dir: number; ebb_dir: number; depth_m: number; events: { t: string; type: string; v: number }[] }
interface Data { generated_at: string; buoy?: Buoy; water_level?: Station; tide?: Tide; current?: Current; moon?: { t: string; phase: string }[] }
interface CurMesh { nodes: [number, number][]; triangles: [number, number, number][]; centres: [number, number][]; arrow_level: number[] }
interface AtBuoy { element: number; lon: number; lat: number; t0: string; step: number; u: (number | null)[]; v: (number | null)[] }
interface CurField { t0: string; step: number; steps: number; u: number[][]; v: number[][]; generated_at: string; at_buoy?: AtBuoy }
interface CurHistory { t0: number; step: number; hours: number; elements: number; scale: number; body: Int8Array }

const DATA = "/data/v1";
const TZ = "America/New_York";
const MIN = 60;
const HOUR = 3600;
const FT = 3.28084;
const KT = 0.0194384; // cm/s to kt
const CELLS = 20;
const LIKELY_BED = 10; // cells deeper than this read like noise: likely at or below the seabed (about 10 m of water)
const COLUMN_CELLS = LIKELY_BED; // averaged for the along-channel comparison: the water column above the likely seabed
const STALE_S = 3 * HOUR;
const SPEED_TOP = MEASURED_TOP; // m/s: the measured ramp's fixed top
const ARROW_PX_PER_MS = 175; // profile bars: 0.1 m/s is 17.5 px
const BAR_X = 58; // the profile panel: where the speed bars start
const BAR_MAX = 140; // and their longest

const $ = (id: string) => document.getElementById(id)!;
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const sec = (iso: string) => Date.parse(iso) / 1000;

let D: Data;
let CUR: { mesh: CurMesh; field: CurField } | null = null; // NECOFS surface currents over the harbour, when available
let HIST: CurHistory | null = null; // the model's past hours (the archive's hindcast), loaded when the time goes back
let histState: "idle" | "loading" | "done" | "failed" = "idle";
let buoyT: number[] = []; // epoch seconds of each profile
let X0 = 0;
let X1 = 0;
let T = 0; // the selected time
// The plots' window: SPAN seconds centred on the selected time (clamped to the data), or the whole record.
let SPAN: number | null = 3 * 86400;
let V0 = 0;
let V1 = 0;
function view(): void {
  if (SPAN == null || SPAN >= X1 - X0) {
    [V0, V1] = [X0, X1];
    return;
  }
  V0 = Math.min(Math.max(X0, T - SPAN / 2), X1 - SPAN);
  V1 = V0 + SPAN;
}
const now = () => Date.now() / 1000;

function ago(t: number): string {
  const s = Math.max(0, now() - t);
  if (s < HOUR) return `${Math.round(s / MIN)} min ago`;
  if (s < 48 * HOUR) return `${Math.round(s / HOUR)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The value of a regular series at time t (linear between neighbours; null across a gap). */
function at(s: Series | undefined, t: number): number | null {
  if (!s || !s.v.length) return null;
  const f = (t - sec(s.t0)) / s.step;
  const i = Math.floor(f);
  if (i < 0 || i >= s.v.length) return null;
  const a = s.v[i];
  const b = i + 1 < s.v.length ? s.v[i + 1] : null;
  if (a == null) return null;
  return b == null ? (f - i < 0.5 ? a : null) : a + (b - a) * (f - i);
}

/** The profile nearest t, within 15 minutes, or -1. */
function nearestProfile(t: number): number {
  if (!buoyT.length) return -1;
  let lo = 0;
  let hi = buoyT.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (buoyT[mid] <= t) lo = mid;
    else hi = mid;
  }
  const i = Math.abs(buoyT[lo] - t) <= Math.abs(buoyT[hi] - t) ? lo : hi;
  return Math.abs(buoyT[i] - t) <= 15 * MIN ? i : -1;
}

// ---------- Colour ----------

const light = () => document.documentElement.dataset.theme === "light";
/** The buoy's measured speeds: the gilded measured ramp (models keep the teal currents ramp). */
const speedColour = (ms: number): string => measuredColour(ms, light());

// ---------- Freshness ----------

function drawFresh(): void {
  const parts: string[] = [];
  const b = D.buoy;
  if (b) parts.push(`UNH buoy: last profile ${fmtShort.format(new Date(b.last))} (${ago(sec(b.last))})`);
  else parts.push("UNH buoy: no profiles available");
  const wl = D.water_level;
  if (wl?.v.length) {
    let i = wl.v.length - 1;
    while (i > 0 && wl.v[i] == null) i--;
    const t = sec(wl.t0) + i * wl.step;
    parts.push(`Seavey Island water level: ${fmtShort.format(new Date(t * 1000))} (${ago(t)})`);
  }
  parts.push(`refreshed ${ago(sec(D.generated_at))}`);
  $("fresh").textContent = parts.join(" · ");
  const stale = $("stale");
  if (b && now() - sec(b.last) > STALE_S) {
    stale.hidden = false;
    stale.innerHTML = `<b>The buoy has been quiet since ${fmtTime.format(new Date(b.last))}.</b> Its plots show its last 30 days of records; the map, the tide and the predicted current are live. <button type="button" class="pq-jump" id="jump">Go to its last record</button>`;
    $("jump").addEventListener("click", () => setT(sec(b.last)));
  } else if (!b) {
    stale.hidden = false;
    stale.innerHTML = "<b>No buoy profiles could be read.</b> The tide and the predicted current are live.";
  } else stale.hidden = true;
}

// ---------- The daily strips: one row per Eastern day, the buoy's cells 1 to 10 down each row ----------

let stripCount = 7; // rows shown: 7, 16, or 0 for the buoy's whole record
let stripAlign: "clock" | "tide" = "clock"; // rows from Eastern midnight, or lunar days from a Fort Point high tide
const LUNAR_DAY = 89424; // s: 24 h 50 min 24 s, two semidiurnal tides
const LABEL_W = 104; // the row labels' column
const CELL_H = 3; // px per cell in a strip
const ROW_GAP = 8;
const HOURS_H = 14; // the hour labels above the first strip
const rowH = () => COLUMN_CELLS * CELL_H;
let strips: number[] = []; // the start (Eastern midnight, epoch s) of each row, oldest first, plus the end of the last

const fmtParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Eastern midnight at or before t. */
function etMidnight(t: number): number {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return t - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second));
}

/** The rows' start times, oldest first, plus the end of the last: Eastern days (clock) or lunar days from a high tide
 * (tide), ending with the row that holds the selected time (the buoy's last record while it is quiet). */
function stripDays(): number[] {
  const b = D.buoy;
  const last = b ? sec(b.last) : now();
  const ref = Math.min(T, last);
  const first = b ? sec(b.t0) : ref - 30 * 86400;
  const highs = (D.tide?.hilo ?? []).filter((e) => e.type === "H").map((e) => sec(e.t));
  if (stripAlign === "tide" && highs.length) {
    const anchor = highs.reduce((a, h) => (Math.abs(h - ref) < Math.abs(a - ref) ? h : a), highs[0]);
    const end = anchor + Math.floor((ref - anchor) / LUNAR_DAY) * LUNAR_DAY;
    const starts = [end];
    while (stripCount ? starts.length < stripCount : starts[0] > first) starts.unshift(starts[0] - LUNAR_DAY);
    starts.push(end + LUNAR_DAY);
    return starts;
  }
  const end = etMidnight(ref);
  const starts = [end];
  while (stripCount ? starts.length < stripCount : starts[0] > first) starts.unshift(etMidnight(starts[0] - 12 * HOUR));
  starts.push(etMidnight(end + 36 * HOUR)); // the next midnight closes the last row (23 or 25 h across a clock change)
  return starts;
}

function drawHeat(): void {
  strips = stripDays();
  const n = strips.length - 1;
  const box = $("heat");
  const cv = $("heat-canvas") as HTMLCanvasElement;
  const W = Math.max(200, box.clientWidth);
  const SW = W - LABEL_W; // the strips' width
  const H = HOURS_H + n * (rowH() + ROW_GAP);
  box.style.height = `${H}px`;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  const top = (r: number) => HOURS_H + r * (rowH() + ROW_GAP);
  const x = (r: number, t: number) => LABEL_W + ((t - strips[r]) / (strips[r + 1] - strips[r])) * SW;
  // Each strip's ground (no record shows as ground) and its six-hour rules.
  for (let r = 0; r < n; r++) {
    g.fillStyle = cssVar("--chart-shade") || "rgba(0,0,0,0.05)";
    g.fillRect(LABEL_W, top(r), SW, rowH());
  }
  const b = D.buoy;
  if (b) {
    let r = 0;
    for (let k = 0; k < buoyT.length; k++) {
      const t = buoyT[k];
      if (t < strips[0] || t >= strips[n]) continue;
      while (r < n - 1 && t >= strips[r + 1]) r++;
      const next = k + 1 < buoyT.length && buoyT[k + 1] - t <= 30 * MIN ? buoyT[k + 1] : t + 10 * MIN;
      const xa = x(r, t);
      const xb = Math.min(LABEL_W + SW, Math.max(xa + 0.6, x(r, next)));
      for (let c = 0; c < COLUMN_CELLS; c++) {
        const v = b.spd[k][c];
        if (v == null) continue;
        g.fillStyle = speedColour(v / 100);
        g.fillRect(xa, top(r) + c * CELL_H, xb - xa + 0.4, CELL_H + 0.2);
      }
    }
  }
  // Highs and lows (NOAA Fort Point predictions): a tick above the strip for a high, a dot for a low.
  g.fillStyle = cssVar("--fc-mid");
  g.strokeStyle = cssVar("--fc-mid");
  for (const e of D.tide?.hilo ?? []) {
    const t = sec(e.t);
    if (t < strips[0] || t >= strips[n]) continue;
    let r = 0;
    while (r < n - 1 && t >= strips[r + 1]) r++;
    const xe = x(r, t);
    if (e.type === "H") {
      g.fillRect(xe - 0.6, top(r) - 5, 1.2, 4);
    } else {
      g.beginPath();
      g.arc(xe, top(r) - 3, 1.4, 0, 2 * Math.PI);
      g.fill();
    }
  }
  // Tidal rows: each Eastern midnight as a line through its row, walking about 50 minutes earlier down the rows.
  if (stripAlign === "tide") {
    g.fillStyle = cssVar("--ink");
    g.globalAlpha = 0.7;
    for (let r = 0; r < n; r++) {
      for (let m = etMidnight(strips[r + 1]); m > strips[r]; m = etMidnight(m - 12 * HOUR)) g.fillRect(x(r, m) - 0.75, top(r) - 2, 1.5, rowH() + 4);
    }
    g.globalAlpha = 1;
  }
  // Labels: the hours across the top, and each row with its new or full moon.
  const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
  const fmtHigh = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const labels: string[] = [];
  const ticks: [number, string][] = stripAlign === "tide"
    ? [[0, "high"], [0.25, "low"], [0.5, "high"], [0.75, "low"]]
    : [[0, "midnight"], [0.25, "6 AM"], [0.5, "noon"], [0.75, "6 PM"]];
  for (const [f, text] of ticks) labels.push(`<span class="pq-hour" style="left:${LABEL_W + f * SW}px">${text}</span>`);
  const moons = (D.moon ?? []).filter((m) => m.phase === "new" || m.phase === "full");
  for (let r = 0; r < n; r++) {
    const m = moons.find((q) => sec(q.t) >= strips[r] && sec(q.t) < strips[r + 1]);
    const moon = m ? `<i class="pq-moon pq-moon-${m.phase}" title="${m.phase} moon: spring tides follow"></i>` : "";
    const name = stripAlign === "tide" ? fmtHigh.format(new Date(strips[r] * 1000)) : fmtDay.format(new Date((strips[r] + 12 * HOUR) * 1000));
    labels.push(`<span class="pq-day" style="top:${top(r) + rowH() / 2}px">${name}${moon}</span>`);
  }
  $("heat-labels").innerHTML = labels.join("");
  const stops = Array.from({ length: 17 }, (_, i) => `${speedColour((i / 16) * SPEED_TOP)} ${(i / 16) * 100}%`).join(",");
  $("heat-scale").innerHTML =
    `<span>0</span><i style="background:linear-gradient(90deg,${stops})"></i><span>${SPEED_TOP} m/s (${(SPEED_TOP * 1.94384).toFixed(1)} kt) and up</span>` +
    `<span class="pq-faded">${stripAlign === "tide" ? "Each row is a lunar day (24 h 50 min) from a high tide at Fort Point, so slack water lines up; the dark lines are midnight, Eastern time. " : ""}Measured speed (gold; the model is teal), cells 1 to 10 down each strip. Ticks above a strip mark high tides, dots low tides. <i class="pq-moon pq-moon-new"></i> New and <i class="pq-moon pq-moon-full"></i> full moons bring the spring tides.</span>`;
  placeCursor();
}

function placeCursor(): void {
  const cur = $("heat-cursor");
  const n = strips.length - 1;
  if (n < 1 || T < strips[0] || T >= strips[n]) {
    cur.hidden = true;
    return;
  }
  let r = 0;
  while (r < n - 1 && T >= strips[r + 1]) r++;
  const SW = Math.max(200, $("heat").clientWidth) - LABEL_W;
  cur.hidden = false;
  cur.style.left = `${LABEL_W + ((T - strips[r]) / (strips[r + 1] - strips[r])) * SW}px`;
  cur.style.top = `${HOURS_H + r * (rowH() + ROW_GAP) - 3}px`;
  cur.style.height = `${rowH() + 6}px`;
}

// ---------- The profile panel ----------

function drawProfile(): void {
  const b = D.buoy;
  const box = $("profile");
  const k = nearestProfile(T);
  const W = 300;
  const rowH = 17;
  const H = 28 + CELLS * rowH + 34;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "Current profile at the selected time" });
  const ink = cssVar("--ink");
  const dim = cssVar("--dim");
  const text = (x: number, y: number, s: string, attrs: Record<string, string | number> = {}) => {
    const t = el("text", { x, y, "font-family": "var(--mono)", "font-size": 10, fill: dim, ...attrs });
    t.textContent = s;
    svg.append(t);
  };
  text(6, 14, "cell");
  text(BAR_X - 14, 14, "to", { "text-anchor": "middle" });
  text(BAR_X, 14, "speed");
  text(W - 62, 14, "cm/s", { "text-anchor": "end" });
  text(W - 6, 14, "deg", { "text-anchor": "end" });
  if (b && k >= 0) {
    for (let c = 0; c < CELLS; c++) {
      const y = 28 + c * rowH + rowH / 2;
      const faded = c >= LIKELY_BED;
      const op = faded ? 0.4 : 1;
      text(6, y + 3.5, String(c + 1), { opacity: op });
      const v = b.spd[k][c];
      const dirDeg = b.dir[k][c];
      if (v == null || dirDeg == null) continue;
      // Speed as a bar in the speed's colour; direction as a north-up arrow beside it.
      const len = Math.min(BAR_MAX, (v / 100) * ARROW_PX_PER_MS);
      const colour = faded ? dim : cssVar("--accent");
      svg.append(el("rect", { x: BAR_X, y: y - 5, width: Math.max(1, len), height: 10, fill: speedColour(v / 100), stroke: cssVar("--rule"), "stroke-width": 0.5, opacity: op }));
      const ax = BAR_X - 14;
      const arrow = el("path", { d: "M0,-6 L3.6,3 L0,1 L-3.6,3 Z", fill: colour, opacity: op, transform: `translate(${ax},${y}) rotate(${dirDeg})` });
      svg.append(arrow);
      text(W - 62, y + 3.5, String(v), { "text-anchor": "end", fill: faded ? dim : ink, opacity: op });
      text(W - 6, y + 3.5, String(dirDeg), { "text-anchor": "end", opacity: op });
    }
    const y = 28 + CELLS * rowH + 18;
    svg.append(el("rect", { x: BAR_X, y: y - 5, width: 0.1 * ARROW_PX_PER_MS, height: 10, fill: speedColour(0.1), stroke: cssVar("--rule"), "stroke-width": 0.5 }));
    text(BAR_X + 0.1 * ARROW_PX_PER_MS + 6, y + 3.5, "10 cm/s (0.19 kt)");
    $("prof-cap").textContent = `Profile at ${fmtTime.format(new Date(buoyT[k] * 1000))}`;
    const tmp = b.temp[k];
    const p = b.pressure[k];
    const flag = b.flag[k] === 1 ? "" : b.flag[k] === 3 ? " Flagged suspect: the buoy was tilted more than 20 degrees." : " Flagged: the instrument reported an error.";
    $("prof-note").textContent =
      `Water ${tmp != null ? `${tmp.toFixed(1)} °C (${(tmp * 1.8 + 32).toFixed(1)} °F)` : "temperature missing"} at the profiler, ${p != null ? `${p.toFixed(2)} dbar` : ""} below the surface. Arrows point where the water goes, north up, as logged (likely magnetic, about 15° west of true here).${flag}`;
  } else {
    $("prof-cap").textContent = "Profile";
    const why = !b ? "No buoy profiles could be read." : T > sec(b.last) ? `No profile at this time: the buoy has been quiet since ${fmtTime.format(new Date(b.last))}.` : "No profile within 15 minutes of this time (a gap in the buoy's record).";
    text(W / 2, H / 2, "No profile at this time", { "text-anchor": "middle" });
    $("prof-note").textContent = why;
  }
  box.replaceChildren(svg);
}

// ---------- The NOAA plots ----------

function grid(step: number): number[] {
  const xs: number[] = [];
  for (let t = Math.ceil(V0 / step) * step; t <= V1; t += step) xs.push(t);
  return xs;
}

function drawTide(): void {
  const xs = grid(6 * MIN);
  const lines: Line[] = [
    { ys: xs.map((t) => at(D.tide, t)).map((v) => (v == null ? NaN : v * FT)), color: cssVar("--fc-mid"), width: 1.4, label: "Predicted, Fort Point", fmt: (v) => `${v.toFixed(1)} ft` },
    { ys: xs.map((t) => at(D.water_level, t)).map((v) => (v == null ? NaN : v * FT)), color: cssVar("--now"), width: 2, label: "Observed, Seavey Island", fmt: (v) => `${v.toFixed(1)} ft` },
  ];
  renderLines($("tide-plot"), { xs, lines, unit: " ft", marker: { x: now(), label: "now" }, empty: "No tide data for this window." });
}

function drawFlow(): void {
  const xs = grid(10 * MIN);
  const c = D.current;
  const b = D.buoy;
  const flood = ((c?.flood_dir ?? 342) * Math.PI) / 180;
  const along = (t: number): number => {
    if (!b) return NaN;
    const k = nearestProfile(t);
    if (k < 0 || Math.abs(buoyT[k] - t) > 6 * MIN) return NaN;
    let sum = 0;
    let n = 0;
    for (let cell = 0; cell < COLUMN_CELLS; cell++) {
      const v = b.spd[k][cell];
      const d = b.dir[k][cell];
      if (v == null || d == null) continue;
      sum += v * Math.cos((d * Math.PI) / 180 - flood);
      n++;
    }
    return n ? (sum / n) * KT : NaN;
  };
  const ab = CUR?.field.at_buoy;
  const modelAlong = (t: number): number => {
    // Hourly model values joined by straight lines between neighbouring hours; a missing hour stays a gap.
    if (!ab) return NaN;
    const f = (t - sec(ab.t0)) / ab.step;
    const k = Math.floor(f);
    if (k < 0 || k + 1 >= ab.u.length) return NaN;
    const [u0, v0, u1, v1] = [ab.u[k], ab.v[k], ab.u[k + 1], ab.v[k + 1]];
    if (u0 == null || v0 == null || u1 == null || v1 == null) return NaN;
    const u = u0 + (u1 - u0) * (f - k);
    const v = v0 + (v1 - v0) * (f - k);
    return (u * Math.sin(flood) + v * Math.cos(flood)) * KT;
  };
  const lines: Line[] = [
    { ys: xs.map((t) => at(c, t)).map((v) => (v == null ? NaN : v * KT)), color: cssVar("--fc-mid"), width: 1.4, label: "Predicted, harbour entrance", fmt: (v) => `${v.toFixed(2)} kt` },
    { ys: xs.map(modelAlong), color: MODEL_LINE(), width: 1.4, dash: "5 3", label: "NECOFS model at the buoy (surface)", fmt: (v) => `${v.toFixed(2)} kt` },
    { ys: xs.map(along), color: cssVar("--now"), width: 1.6, label: "UNH buoy, cells 1 to 10", fmt: (v) => `${v.toFixed(2)} kt` },
  ];
  renderLines($("flow-plot"), { xs, lines, unit: " kt", zero: true, marker: { x: now(), label: "now" }, empty: "No current data for this window." });
}

// ---------- The readout and the time control ----------

function drawRead(): void {
  const parts = [`<b>${fmtTime.format(new Date(T * 1000))}</b>`];
  const wl = at(D.water_level, T);
  const pr = at(D.tide, T);
  if (wl != null) parts.push(`water level ${(wl * FT).toFixed(1)} ft observed`);
  if (pr != null) parts.push(`${(pr * FT).toFixed(1)} ft predicted`);
  const cp = at(D.current, T);
  if (cp != null) parts.push(`predicted current ${Math.abs(cp * KT).toFixed(1)} kt ${cp >= 0 ? "flood" : "ebb"}`);
  const next = D.current?.events.find((e) => sec(e.t) > T && e.type === "slack");
  if (next) parts.push(`next slack ${fmtShort.format(new Date(sec(next.t) * 1000))}`);
  $("read").innerHTML = parts.join(" &middot; ");
}

function setT(t: number): void {
  T = Math.min(X1, Math.max(X0, Math.round(t / (10 * MIN)) * 10 * MIN));
  ($("slider") as HTMLInputElement).value = String(T);
  const [a, b] = [V0, V1];
  view();
  const n = strips.length - 1;
  const outside = n < 1 || Math.min(T, D.buoy ? sec(D.buoy.last) : T) < strips[0] || Math.min(T, D.buoy ? sec(D.buoy.last) : T) >= strips[n];
  if (V0 !== a || V1 !== b || outside) drawPlots();
  markAsOf(T);
  placeCursor();
  paintCurrents();
  refreshTip();
  drawProfile();
  drawRead();
}

let playing = 0;
function wireTime(): void {
  const s = $("slider") as HTMLInputElement;
  s.min = String(X0);
  s.max = String(X1);
  s.addEventListener("input", () => setT(Number(s.value)));
  $("back").addEventListener("click", () => setT(T - 10 * MIN));
  const zoom = $("zoom");
  zoom.addEventListener("click", () => {
    SPAN = SPAN == null ? 3 * 86400 : null;
    zoom.textContent = SPAN == null ? "3 days" : "Full record";
    zoom.setAttribute("aria-pressed", String(SPAN == null));
    view();
    drawPlots();
  });
  $("fwd").addEventListener("click", () => setT(T + 10 * MIN));
  const pick = (attr: string, on: (v: string) => void) => {
    document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
        on(btn.getAttribute(attr)!);
        drawPlots();
      }),
    );
  };
  pick("data-rows", (v) => (stripCount = Number(v)));
  pick("data-align", (v) => (stripAlign = v === "tide" ? "tide" : "clock"));
  $("to-now").addEventListener("click", () => setT(now()));
  const play = $("play");
  play.addEventListener("click", () => {
    if (playing) {
      window.clearInterval(playing);
      playing = 0;
      play.textContent = "Play";
      play.setAttribute("aria-pressed", "false");
      return;
    }
    // Through the buoy's record, 10 minutes a frame; from the start again at its end.
    const b = D.buoy;
    const start = b ? sec(b.t0) : X0;
    const end = b ? sec(b.last) : X1;
    if (T >= end) setT(Math.max(start, end - 2 * 86400));
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    playing = window.setInterval(() => setT(T + 10 * MIN >= end ? Math.max(start, end - 2 * 86400) : T + 10 * MIN), 60);
  });
  $("heat").addEventListener("click", (e) => {
    const box = ($("heat-canvas") as HTMLCanvasElement).getBoundingClientRect();
    const px = e.clientX - box.left - LABEL_W;
    const row = Math.floor((e.clientY - box.top - HOURS_H + ROW_GAP / 2) / (rowH() + ROW_GAP));
    if (px < 0 || row < 0 || row >= strips.length - 1) return;
    setT(strips[row] + (px / (box.width - LABEL_W)) * (strips[row + 1] - strips[row]));
  });
}

// ---------- The map: NECOFS surface currents, the buoy and the NOAA stations ----------

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
let MAP: MapLibreMap | null = null;
let curFrame: number | null = -2; // the model frame on the map (null: none at the selected time; -2: not drawn yet)

const curRamp = () => (light() ? CURRENTS_RAMP : CURRENTS_RAMP_DARK);
/** The Sound page's currents colours: one fixed scale on a log-speed axis (cm/s in the feature state "s"). */
const curFill = (): ExpressionSpecification =>
  ["interpolate", ["linear"], ["ln", ["max", ["/", ["coalesce", ["feature-state", "s"], 0], 100], CURRENTS_FLOOR]], ...curRamp().flatMap(([ms, c]) => [Math.log(ms), c])] as ExpressionSpecification;

/** The model hour shown at time t: the forecast's frame, else the history's (a negative index -1 - k), else null. */
function curFrameAt(t: number): number | null {
  if (CUR) {
    const k = Math.round((t - sec(CUR.field.t0)) / CUR.field.step);
    if (k >= 0 && k < CUR.field.steps) return k;
  }
  if (HIST) {
    const k = Math.round((t - HIST.t0) / HIST.step);
    if (k >= 0 && k < HIST.hours && HIST.body[2 * k * HIST.elements] !== -128) return -1 - k;
  }
  return null;
}

/** East and north components (cm/s) of frame f at element i. */
function curUV(f: number, i: number): [number, number] {
  if (f >= 0) return [CUR!.field.u[f][i], CUR!.field.v[f][i]];
  const h = HIST!;
  const k = -1 - f;
  return [h.body[2 * k * h.elements + i] * h.scale, h.body[(2 * k + 1) * h.elements + i] * h.scale];
}

/** The history file, once, when the time first goes before the forecast. */
async function loadHistory(): Promise<void> {
  if (histState !== "idle" || !CUR || T >= sec(CUR.field.t0)) return;
  histState = "loading";
  $("map-when").textContent = "Fetching the model's past hours…";
  try {
    const r = await fetch(`${DATA}/fields/piscataqua-currents-history.bin`, { cache: "no-cache" });
    if (!r.ok) throw new Error(String(r.status));
    const buf = await r.arrayBuffer();
    const n = new DataView(buf).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as { t0: string; step: number; hours: number; elements: number; scale: number };
    if (head.elements !== CUR.mesh.triangles.length) throw new Error("mesh mismatch");
    HIST = { t0: sec(head.t0), step: head.step, hours: head.hours, elements: head.elements, scale: head.scale, body: new Int8Array(buf, 4 + n) };
    histState = "done";
  } catch {
    histState = "failed";
  }
  curFrame = -2;
  paintCurrents();
}

function curPoints(f: number | null) {
  if (!CUR || f == null) return { type: "FeatureCollection" as const, features: [] };
  const m = CUR.mesh;
  return {
    type: "FeatureCollection" as const,
    features: m.centres.map((pt, i) => {
      const [u, v] = curUV(f, i);
      return { type: "Feature" as const, properties: { level: m.arrow_level[i], s: Math.hypot(u, v), d: (Math.atan2(u, v) * 180) / Math.PI }, geometry: { type: "Point" as const, coordinates: pt } };
    }),
  };
}

function addCurrentLayers(map: MapLibreMap): void {
  if (!CUR || map.getSource("cur-mesh")) return;
  const m = CUR.mesh;
  if (!map.hasImage("cur-arrow")) {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d")!;
    g.beginPath();
    for (const [x, y] of [[16, 2], [25, 16], [19, 15], [19, 30], [13, 30], [13, 15], [7, 16]]) g.lineTo(x, y);
    g.closePath();
    g.fill();
    map.addImage("cur-arrow", g.getImageData(0, 0, 32, 32), { sdf: true });
  }
  map.addSource("cur-mesh", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: m.triangles.map((t, i) => ({ type: "Feature", id: i, properties: {}, geometry: { type: "Polygon", coordinates: [[m.nodes[t[0]], m.nodes[t[1]], m.nodes[t[2]], m.nodes[t[0]]]] } })),
    },
  });
  map.addSource("cur-points", { type: "geojson", data: curPoints(null) });
  const labels = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
  map.addLayer({ id: "cur-fill", type: "fill", source: "cur-mesh", paint: { "fill-color": curFill(), "fill-opacity": ["case", ["==", ["feature-state", "s"], null], 0, 0.85] as ExpressionSpecification, "fill-antialias": false } }, labels);
  // Arrows thinned by zoom, as on the Sound page, shifted for a harbour-sized view.
  const shown = (level: number): ExpressionSpecification => ["case", ["<=", ["get", "level"], level], 0.9, 0];
  map.addLayer({
    id: "cur-arrows",
    type: "symbol",
    source: "cur-points",
    layout: {
      "icon-image": "cur-arrow", "icon-rotate": ["get", "d"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["get", "s"], 0, 0.28, 40, 0.42, 150, 0.7],
    },
    paint: {
      "icon-color": light() ? "#1c2a48" : "#f4f1e8",
      "icon-opacity": ["step", ["zoom"], shown(3), 12.5, shown(4), 13.5, shown(5), 14.5, shown(6)] as ExpressionSpecification,
    },
  });
  curFrame = -2;
  paintCurrents();
}

/** Shade each triangle by speed at the model hour nearest the selected time (none outside the run), and the arrows. */
function paintCurrents(): void {
  const map = MAP;
  if (!map || !CUR || !map.getSource("cur-mesh")) return;
  if (CUR && T < sec(CUR.field.t0)) void loadHistory();
  const f = curFrameAt(T);
  if (f === curFrame) return;
  curFrame = f;
  for (let i = 0; i < CUR.mesh.triangles.length; i++) {
    const uv = f == null ? null : curUV(f, i);
    map.setFeatureState({ source: "cur-mesh", id: i }, { s: uv ? Math.hypot(uv[0], uv[1]) : null });
  }
  (map.getSource("cur-points") as GeoJSONSource).setData(curPoints(f));
  const c = CUR.field;
  if (f != null) {
    const t = f >= 0 ? sec(c.t0) + f * c.step : HIST!.t0 + (-1 - f) * HIST!.step;
    $("map-when").textContent = `NECOFS model ${f >= 0 ? "forecast" : "hindcast"} for ${fmtTime.format(new Date(t * 1000))}`;
  } else if (histState === "loading") $("map-when").textContent = "Fetching the model's past hours…";
  else {
    const first = HIST ? HIST.t0 : sec(c.t0);
    const end = sec(c.t0) + (c.steps - 1) * c.step;
    $("map-when").textContent = `NECOFS: no model hour at this time (the model covers ${fmtShort.format(new Date(first * 1000))} to ${fmtShort.format(new Date(end * 1000))})`;
  }
}

function drawMapScale(): void {
  const box = $("map-scale");
  if (!CUR) {
    box.innerHTML = `<span class="pq-faded">The model's surface currents are not available right now.</span>`;
    return;
  }
  const pos = (ms: number) => ((Math.log(ms) - Math.log(CURRENTS_FLOOR)) / (Math.log(CURRENTS_TOP) - Math.log(CURRENTS_FLOOR))) * 100;
  const stops = curRamp().map(([ms, c]) => `${c} ${pos(ms).toFixed(1)}%`).join(",");
  box.innerHTML = `<span>${CURRENTS_FLOOR * 100} cm/s</span><i style="background:linear-gradient(90deg,${stops})"></i><span>${CURRENTS_TOP} m/s (6 kt)</span><span class="pq-faded">the Sound page's currents scale; arrows show where the water goes</span>`;
}

async function drawMap(): Promise<void> {
  const box = $("map");
  try {
    await import("maplibre-gl/dist/maplibre-gl.css");
    const maplibregl = (await import("maplibre-gl")).default;
    const map = new maplibregl.Map({ container: box, style: light() ? STYLE_LIGHT : STYLE_DARK, center: [-70.71, 43.068], zoom: 13.2, attributionControl: { compact: true }, cooperativeGestures: true });
    MAP = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const pins: [number, number, string, string][] = [
      [BUOY_LON(), BUOY_LAT(), "UNH buoy", "pq-pin pq-pin-buoy"],
      [D.water_level?.lon ?? -70.7411, D.water_level?.lat ?? 43.0797, "Seavey Island (water level)", "pq-pin"],
      [D.tide?.lon ?? -70.7117, D.tide?.lat ?? 43.0717, "Fort Point (tide)", "pq-pin"],
      [D.current?.lon ?? -70.7053, D.current?.lat ?? 43.0624, "Harbor Entrance (predicted current)", "pq-pin"],
    ];
    for (const [lon, lat, label, cls] of pins) {
      const el = document.createElement("div");
      el.className = cls;
      el.innerHTML = `<i></i><span>${label}</span>`;
      new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([lon, lat]).addTo(map);
    }
    const lons = pins.map((q) => q[0]);
    const lats = pins.map((q) => q[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 60, bottom: 60, left: 40, right: 220 }, duration: 0, maxZoom: 14 });
    map.on("style.load", () => addCurrentLayers(map)); // also after a theme switch, which replaces the style
    wireMapTip(map, new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "pq-tip", offset: 12, maxWidth: "260px" }), pins);
  } catch {
    box.innerHTML = `<p class="note">The map could not be loaded.</p>`;
  }
}
/* The map's tooltip: what is under the pointer at the selected time (the model's current over the water; the buoy's
   measurement or a NOAA station's reading at its pin). It follows the pointer, a tap shows it on a touch screen, and
   it updates when the time moves. */
let tipAt: { x: number; y: number } | null = null;
let refreshTip: () => void = () => undefined;
const KTS = (cms: number) => `${(cms * KT).toFixed(2)} kt (${Math.round(cms)} cm/s)`;
const TOWARD = (u: number, v: number) => `${Math.round(((Math.atan2(u, v) * 180) / Math.PI + 360) % 360)}°`;

function buoyTip(): string {
  const b = D.buoy;
  if (!b) return "<b>UNH buoy</b><br>No profiles could be read.";
  const k = nearestProfile(T);
  if (k < 0) return `<b>UNH buoy</b><br>No profile at this time; quiet since ${fmtShort.format(new Date(b.last))}.`;
  let su = 0;
  let sv = 0;
  let n = 0;
  for (let c = 0; c < COLUMN_CELLS; c++) {
    const s = b.spd[k][c];
    const d = b.dir[k][c];
    if (s == null || d == null) continue;
    su += s * Math.sin((d * Math.PI) / 180);
    sv += s * Math.cos((d * Math.PI) / 180);
    n++;
  }
  const top = b.spd[k][0];
  return `<b class="pq-tip-measured">UNH buoy, measured</b><br>${fmtTime.format(new Date(buoyT[k] * 1000))}` +
    (n ? `<br>Cells 1 to 10 averaged: ${KTS(Math.hypot(su, sv) / n)} toward ${TOWARD(su, sv)}` : "") +
    (top != null && b.dir[k][0] != null ? `<br>Cell 1: ${KTS(top)} toward ${b.dir[k][0]}°` : "") +
    `<br><small>Directions as logged, likely magnetic.</small>`;
}

function stationTip(i: number): string {
  if (i === 1) {
    const v = at(D.water_level, T);
    return `<b>NOAA Seavey Island</b><br>${v == null ? "No reading at this time." : `Water level ${(v * FT).toFixed(1)} ft above MLLW, observed`}`;
  }
  if (i === 2) {
    const v = at(D.tide, T);
    const next = D.tide?.hilo.find((e) => sec(e.t) > T);
    return `<b>NOAA Fort Point</b><br>${v == null ? "No prediction at this time." : `Tide ${(v * FT).toFixed(1)} ft above MLLW, predicted`}` +
      (next ? `<br>Next ${next.type === "H" ? "high" : "low"} ${fmtShort.format(new Date(next.t))}, ${(next.m * FT).toFixed(1)} ft` : "");
  }
  const v = at(D.current, T);
  const next = D.current?.events.find((e) => sec(e.t) > T && e.type === "slack");
  return `<b>NOAA Portsmouth Harbor Entrance</b><br>${v == null ? "No prediction at this time." : `Predicted ${Math.abs(v * KT).toFixed(2)} kt ${v >= 0 ? "flood" : "ebb"} at 2.4 m`}` +
    (next ? `<br>Next slack ${fmtShort.format(new Date(next.t))}` : "");
}

function waterTip(id: number): string {
  const f = curFrameAt(T);
  if (!CUR || f == null) return `<b>NECOFS model</b><br>No model hour at this time.`;
  const [u, v] = curUV(f, id);
  const t = f >= 0 ? sec(CUR.field.t0) + f * CUR.field.step : HIST!.t0 + (-1 - f) * HIST!.step;
  return `<b class="pq-tip-model">NECOFS model, surface</b><br>${KTS(Math.hypot(u, v))} toward ${TOWARD(u, v)}<br><small>${f >= 0 ? "Forecast" : "Hindcast"} for ${fmtTime.format(new Date(t * 1000))}</small>`;
}

/** The model triangle containing a point (-1 for land or outside the box): a direct test on the mesh, so the tooltip
 * does not depend on what the map has drawn. */
function elementAt(lon: number, lat: number): number {
  if (!CUR) return -1;
  const { nodes, triangles } = CUR.mesh;
  for (let i = 0; i < triangles.length; i++) {
    const [a, b, c] = triangles[i].map((k) => nodes[k]);
    if (lon < Math.min(a[0], b[0], c[0]) || lon > Math.max(a[0], b[0], c[0]) || lat < Math.min(a[1], b[1], c[1]) || lat > Math.max(a[1], b[1], c[1])) continue;
    const s1 = (b[0] - a[0]) * (lat - a[1]) - (b[1] - a[1]) * (lon - a[0]);
    const s2 = (c[0] - b[0]) * (lat - b[1]) - (c[1] - b[1]) * (lon - b[0]);
    const s3 = (a[0] - c[0]) * (lat - c[1]) - (a[1] - c[1]) * (lon - c[0]);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return i;
  }
  return -1;
}

function wireMapTip(map: MapLibreMap, popup: import("maplibre-gl").Popup, pins: [number, number, string, string][]): void {
  const show = (x: number, y: number) => {
    tipAt = { x, y };
    // A pin within 16 px wins over the water beneath it.
    let best = -1;
    let bestD = 16;
    pins.forEach(([lon, lat], i) => {
      const q = map.project([lon, lat]);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bestD) [best, bestD] = [i, d];
    });
    let html = "";
    if (best === 0) html = buoyTip();
    else if (best > 0) html = stationTip(best);
    else {
      const ll = map.unproject([x, y]);
      const id = elementAt(ll.lng, ll.lat);
      if (id >= 0) html = waterTip(id);
    }
    if (!html) {
      popup.remove();
      return;
    }
    popup.setLngLat(map.unproject([x, y])).setHTML(html);
    if (!popup.isOpen()) popup.addTo(map);
  };
  map.on("mousemove", (e) => show(e.point.x, e.point.y));
  map.on("click", (e) => show(e.point.x, e.point.y)); // a tap on a touch screen
  map.getCanvas().addEventListener("mouseleave", () => {
    tipAt = null;
    popup.remove();
  });
  map.on("movestart", () => {
    tipAt = null;
    popup.remove();
  });
  refreshTip = () => {
    if (tipAt && popup.isOpen()) show(tipAt.x, tipAt.y);
  };
}

const restyleMap = () => MAP?.setStyle(light() ? STYLE_LIGHT : STYLE_DARK);
const MODEL_LINE = () => (light() ? "#1f7f86" : "#5fc3c4"); // the model's teal
const BUOY_LAT = () => D.buoy?.lat ?? 43.0687;
const BUOY_LON = () => D.buoy?.lon ?? -70.7079;

// ---------- Method ----------

function drawMethod(): void {
  const b = D.buoy;
  const items: [string, string][] = [
    ["Buoy", `The University of New Hampshire's G-2000 metocean buoy at the mouth of the Piscataqua, drawn at its last GPS fix (${b?.position_as_of ?? "2024-11-21"}). Its <a href="https://www.nortekgroup.com/products">Nortek</a> Aquadopp current profiler looks down from just below the surface, ${b?.instrument ? "20 cells every 10 minutes" : "every 10 minutes"}.`],
    ["Cells", "Numbered from the surface. About 1 m each, which fits the data: cells below about 10 read like noise (2 to 6 cm/s against 10 to 18 above), as expected in about 10 m of water, so they are faded."],
    ["Directions", "As logged, the direction the water moves toward. They follow NOAA's predicted flood and ebb best when turned 15 to 35 degrees west, so they are probably magnetic (declination here is about 15 degrees west); they are shown as logged."],
    ["Quality", 'Provisional, as logged. Following the U.S. IOOS <a href="https://ioos.noaa.gov/project/qartod/">QARTOD</a> manual for current observations <a href="#ref-qartod">[5]</a>, each profile is flagged when the instrument reports an error or an impossible speed (over 3 m/s), and suspect when the buoy is tilted more than 20 degrees.'],
    ["Tide", 'Observed water level at NOAA <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=8419870">Seavey Island (8419870)</a>, 3 km up-river; tide predictions for NOAA <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=8423898">Fort Point (8423898)</a>, 0.5 km from the buoy. Both above MLLW. Moon phases from the <a href="https://aa.usno.navy.mil/data/MoonPhases">US Naval Observatory</a>.'],
    ["Current", 'NOAA\'s tidal current predictions for <a href="https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=PIR0701_12">Portsmouth Harbor Entrance (PIR0701)</a>, 0.7 km from the buoy, at 2.4 m, along the flood axis (342 degrees) with ebb negative. The buoy\'s line is its cells 1 to 10 (the water column above the likely seabed) averaged and projected on the same axis, with its directions as logged. For the estuary\'s tides and their spring-neap modulation see McLaughlin et al. <a href="#ref-mclaughlin">[3]</a>; the lower river\'s main channel runs 0.5 to 2 m/s <a href="#ref-bilgili">[4]</a>.'],
    ["Model", 'The map\'s surface currents are <a href="https://fvcom.smast.umassd.edu/">NECOFS</a>, the Northeast Coastal Ocean Forecast System, run on FVCOM <a href="#ref-chen2003">[1]</a> <a href="#ref-chen2006">[2]</a> (GOM7 mesh, top layer) by the University of Massachusetts Dartmouth (SMAST): on the model\'s own triangles, in the Sound page\'s teal scale, the forecast from a day back to three days ahead, and before that the model\'s hindcast from its daily archive (the last 45 days), so it can be set beside the buoy\'s record. The flood and ebb plot adds the model\'s surface current at the buoy\'s element (about 100 m away), hourly, joined by straight lines.'],
    ["Colours", "Measured currents (the buoy) are gold, the site's colour for observations; the model's currents are teal."],
    ["Gaps", "The buoy reports through a shore computer, so its record can stop for days. The page shows how old each source is and draws gaps as gaps; the map, the tide and the predicted current run to now and beyond."],
  ];
  $("method").innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

// ---------- Theme ----------

function wireTheme(redraw: () => void): void {
  const btn = $("theme-toggle");
  const MOON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const SUN = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
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
    redraw();
  });
}

// ---------- Boot ----------

let framePending = 0;
function drawPlots(): void {
  if (framePending) return;
  framePending = requestAnimationFrame(() => {
    framePending = 0;
    drawHeat();
    drawTide();
    drawFlow();
    markAsOf(T);
  });
}

function drawAll(): void {
  drawFresh();
  view();
  drawHeat();
  drawTide();
  drawFlow();
  setT(T);
}

async function fetchJson<T>(name: string): Promise<T | null> {
  try {
    const r = await fetch(`${DATA}/${name}.json`, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let d: Data | null = null;
  try {
    const r = await fetch(`${DATA}/piscataqua.json`, { cache: "no-cache" });
    d = r.ok ? ((await r.json()) as Data) : null;
  } catch {
    d = null;
  }
  if (!d) {
    const e = $("load-error");
    e.hidden = false;
    e.innerHTML = "<b>The data could not be loaded.</b> Please try again in a few minutes.";
    $("fresh").textContent = "";
    return;
  }
  D = d;
  const [mesh, field] = await Promise.all([fetchJson<CurMesh>("fields/piscataqua-currents-mesh"), fetchJson<CurField>("fields/piscataqua-currents")]);
  CUR = mesh && field && field.steps > 0 ? { mesh, field } : null;
  const b = D.buoy;
  if (b) buoyT = b.t.map((m) => sec(b.t0) + m * MIN);
  const ends = [D.tide, D.current].filter((s): s is Tide | Current => !!s?.v.length).map((s) => sec(s.t0) + (s.v.length - 1) * s.step);
  if (CUR) ends.push(sec(CUR.field.t0) + (CUR.field.steps - 1) * CUR.field.step);
  X1 = Math.max(now() + HOUR, ...ends);
  X0 = Math.min(b ? sec(b.t0) : now() - 7 * 86400, now() - 7 * 86400);
  T = now(); // the live view; a quiet buoy's banner offers a jump to its last record
  wireTime();
  wireTheme(() => {
    drawAll();
    drawMapScale();
    restyleMap();
  });
  drawMethod();
  drawMapScale();
  drawAll();
  void drawMap();
  let pending = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(drawAll, 120);
  });
}

void main();
