/**
 * Portsmouth Harbor (/portsmouth-harbor/, unlisted; /piscataqua/ redirects here): the UNH G-2000 buoy's current
 * profiler at the mouth of the Piscataqua River, with NOAA water level,
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
import { setPlayButton, timeTrack } from "./time-axis";
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
// Speeds in the reader's unit, as on the Sound page (the same saved choice): knots by default.
const UNITS = {
  kt: { perCms: 0.0194384, label: "kt", digits: 1 },
  mph: { perCms: 0.0223694, label: "mph", digits: 1 },
  ms: { perCms: 0.01, label: "m/s", digits: 2 },
} as const;
type Unit = keyof typeof UNITS;
let U: Unit = "kt";
try {
  const saved = localStorage.getItem("lhzn-blue-wind-unit");
  if (saved && saved in UNITS) U = saved as Unit;
} catch {
  /* private mode: knots */
}
const PER = () => UNITS[U].perCms; // cm/s to the reader's unit
const UL = () => UNITS[U].label;
/** A speed (cm/s) in the reader's unit, to the given decimals (default: the unit's own). */
const spdTxt = (cms: number, digits: number = UNITS[U].digits) => `${(cms * PER()).toFixed(digits)} ${UL()}`;
/** A round figure for a scale's end (two significant figures): 0.5 m/s, 0.97 kt, 1.1 mph. */
const spdNice = (cms: number) => `${Number((cms * PER()).toPrecision(2))} ${UL()}`;
const CELLS = 20;
// The buoy logs directions against its compass, which reads magnetic as far as the data show (they fit NOAA's flood
// and ebb best turned 15 to 35 degrees west). The page turns them to true north by the World Magnetic Model's
// declination at the buoy (WMM2025, 2026: 14.2 degrees west), as the 3D pane does; the data file keeps them as logged.
const DECLINATION = -14.2;
const trueDir = (d: number) => Math.round((((d + DECLINATION) % 360) + 360) % 360);
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
  // One chip in the masthead holds it all, as on the Sound page: the quiet-buoy note first when there is one, then how
  // old each source is. Hover or focus shows it; a tap on a touch screen opens it in a dialog (wireNotice).
  const quiet = b && now() - sec(b.last) > STALE_S;
  const note = !b
    ? "No buoy profiles could be read. The tide and the predicted current are live."
    : quiet
      ? `The buoy has been quiet since ${fmtTime.format(new Date(b.last))}. Its plots show its last 30 days of records; the model, the tide and the predicted current are live. Jump to in the time bar goes to its last record.`
      : "";
  const text = [note, `${parts.join(" · ")}.`].filter(Boolean).join(" ");
  $("outage-pop").textContent = text;
  $("outage-dialog-text").textContent = text;
  $("outage-label").textContent = note ? "Buoy data" : "Data";
  $("outage-icon").classList.toggle("pq-notice-calm", !note); // the delayed colour only when there is something to say
  $("outage-icon").hidden = false;
}

function wireNotice(): void {
  const dialog = $("outage-dialog") as HTMLDialogElement;
  $("outage-icon").addEventListener("click", () => {
    if (!matchMedia("(hover: hover)").matches) dialog.showModal();
  });
  $("outage-dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
}

// ---------- The daily strips: one row per Eastern day, the buoy's cells 1 to 10 down each row ----------

let stripCount = 7; // rows shown: 7, 16, or 0 for the buoy's whole record
let stripAlign: "clock" | "tide" = "clock"; // rows from Eastern midnight, or lunar days from a Fort Point high tide
const LUNAR_DAY = 89424; // s: 24 h 50 min 24 s, two semidiurnal tides
// The row labels' column: short, so the strips get the width ("Wed 10/7"; a tidal row's "10/7 3:12 AM").
const labelW = () => (stripAlign === "tide" ? 86 : 68);
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
 * (tide), across the buoy's record, with the row holding the selected time in the middle where the record allows (so
 * at its ends, and while the buoy is quiet, the rows run up to its last record). */
function stripDays(): number[] {
  const b = D.buoy;
  const last = b ? sec(b.last) : now();
  const first = b ? sec(b.t0) : last - 30 * 86400;
  const ref = Math.max(first, Math.min(T, last));
  const highs = (D.tide?.hilo ?? []).filter((e) => e.type === "H").map((e) => sec(e.t));
  // Every row of the record: each start, oldest first, then the end of the last row.
  const rows: number[] = [];
  if (stripAlign === "tide" && highs.length) {
    const anchor = highs.reduce((a, h) => (Math.abs(h - ref) < Math.abs(a - ref) ? h : a), highs[0]);
    const lastRow = anchor + Math.floor((last - anchor) / LUNAR_DAY) * LUNAR_DAY;
    for (let s = lastRow; s + LUNAR_DAY > first; s -= LUNAR_DAY) rows.unshift(s);
    rows.push(lastRow + LUNAR_DAY);
  } else {
    const lastRow = etMidnight(last);
    for (let s = lastRow; ; s = etMidnight(s - 12 * HOUR)) {
      rows.unshift(s);
      if (s <= first) break;
    }
    rows.push(etMidnight(lastRow + 36 * HOUR)); // the next midnight closes the last row (23 or 25 h across a clock change)
  }
  const n = rows.length - 1;
  if (!stripCount || stripCount >= n) return rows;
  let i = 0;
  while (i < n - 1 && ref >= rows[i + 1]) i++;
  const lo = Math.max(0, Math.min(n - stripCount, i - Math.floor((stripCount - 1) / 2)));
  return rows.slice(lo, lo + stripCount + 1);
}

function drawHeat(): void {
  strips = stripDays();
  const n = strips.length - 1;
  const box = $("heat");
  const cv = $("heat-canvas") as HTMLCanvasElement;
  const W = Math.max(200, box.clientWidth);
  const SW = W - labelW(); // the strips' width
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
  const x = (r: number, t: number) => labelW() + ((t - strips[r]) / (strips[r + 1] - strips[r])) * SW;
  // Each strip's ground (no record shows as ground) and its six-hour rules.
  for (let r = 0; r < n; r++) {
    g.fillStyle = cssVar("--chart-shade") || "rgba(0,0,0,0.05)";
    g.fillRect(labelW(), top(r), SW, rowH());
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
      const xb = Math.min(labelW() + SW, Math.max(xa + 0.6, x(r, next)));
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
  const fmtDayP = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "numeric", day: "numeric" });
  const fmtHighP = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  const part = (f: Intl.DateTimeFormat, d: Date) => Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const fmtDay = { format: (d: Date) => { const p = part(fmtDayP, d); return `${p.weekday} ${p.month}/${p.day}`; } };
  const fmtHigh = { format: (d: Date) => { const p = part(fmtHighP, d); return `${p.month}/${p.day} ${p.hour}:${p.minute} ${p.dayPeriod}`; } };
  const labels: string[] = [];
  const ticks: [number, string][] = stripAlign === "tide"
    ? [[0, "high"], [0.25, "low"], [0.5, "high"], [0.75, "low"]]
    : [[0, "midnight"], [0.25, "6 AM"], [0.5, "noon"], [0.75, "6 PM"]];
  for (const [f, text] of ticks) labels.push(`<span class="pq-hour" style="left:${labelW() + f * SW}px">${text}</span>`);
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
    `<span>0</span><i style="background:linear-gradient(90deg,${stops})"></i><span>${spdNice(SPEED_TOP * 100)} and up</span>` +
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
  const SW = Math.max(200, $("heat").clientWidth) - labelW();
  cur.hidden = false;
  cur.style.left = `${labelW() + ((T - strips[r]) / (strips[r + 1] - strips[r])) * SW}px`;
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
  text(W - 62, 14, UL(), { "text-anchor": "end" });
  text(W - 6, 14, "deg", { "text-anchor": "end" });
  if (b && k >= 0) {
    for (let c = 0; c < CELLS; c++) {
      const y = 28 + c * rowH + rowH / 2;
      const faded = c >= LIKELY_BED;
      const op = faded ? 0.4 : 1;
      text(6, y + 3.5, String(c + 1), { opacity: op });
      const v = b.spd[k][c];
      const logged = b.dir[k][c];
      const dirDeg = logged == null ? null : trueDir(logged);
      if (v == null || dirDeg == null) continue;
      // Speed as a bar in the speed's colour; direction as a north-up arrow beside it.
      const len = Math.min(BAR_MAX, (v / 100) * ARROW_PX_PER_MS);
      const colour = faded ? dim : cssVar("--accent");
      svg.append(el("rect", { x: BAR_X, y: y - 5, width: Math.max(1, len), height: 10, fill: speedColour(v / 100), stroke: cssVar("--rule"), "stroke-width": 0.5, opacity: op }));
      const ax = BAR_X - 14;
      const arrow = el("path", { d: "M0,-6 L3.6,3 L0,1 L-3.6,3 Z", fill: colour, opacity: op, transform: `translate(${ax},${y}) rotate(${dirDeg})` });
      svg.append(arrow);
      text(W - 62, y + 3.5, (v * PER()).toFixed(2), { "text-anchor": "end", fill: faded ? dim : ink, opacity: op });
      text(W - 6, y + 3.5, String(dirDeg), { "text-anchor": "end", opacity: op });
    }
    const y = 28 + CELLS * rowH + 18;
    svg.append(el("rect", { x: BAR_X, y: y - 5, width: 0.1 * ARROW_PX_PER_MS, height: 10, fill: speedColour(0.1), stroke: cssVar("--rule"), "stroke-width": 0.5 }));
    text(BAR_X + 0.1 * ARROW_PX_PER_MS + 6, y + 3.5, spdTxt(10, 2));
    $("prof-cap").textContent = `Profile at ${fmtTime.format(new Date(buoyT[k] * 1000))}`;
    const tmp = b.temp[k];
    const p = b.pressure[k];
    const flag = b.flag[k] === 1 ? "" : b.flag[k] === 3 ? " Flagged suspect: the buoy was tilted more than 20 degrees." : " Flagged: the instrument reported an error.";
    $("prof-note").textContent =
      `Water ${tmp != null ? `${tmp.toFixed(1)} °C (${(tmp * 1.8 + 32).toFixed(1)} °F)` : "temperature missing"} at the profiler, ${p != null ? `${p.toFixed(2)} dbar` : ""} below the surface. Arrows point where the water goes, true north up (turned 14.2° from the logged directions, taken as magnetic; inferred, not confirmed).${flag}`;
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

function drawTide(plot = $("tide-plot")): void {
  const xs = grid(6 * MIN);
  const lines: Line[] = [
    { ys: xs.map((t) => at(D.tide, t)).map((v) => (v == null ? NaN : v * FT)), color: cssVar("--fc-mid"), width: 1.4, label: "Predicted, Fort Point", fmt: (v) => `${v.toFixed(1)} ft` },
    { ys: xs.map((t) => at(D.water_level, t)).map((v) => (v == null ? NaN : v * FT)), color: cssVar("--now"), width: 2, label: "Observed, Seavey Island", fmt: (v) => `${v.toFixed(1)} ft` },
  ];
  renderLines(plot, { xs, lines, unit: " ft", ...MARKS(), empty: "No tide data for this window." });
}

function drawFlow(plot = $("flow-plot")): void {
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
      const d = b.dir[k][cell] == null ? null : trueDir(b.dir[k][cell]!);
      if (v == null || d == null) continue;
      sum += v * Math.cos((d * Math.PI) / 180 - flood);
      n++;
    }
    return n ? (sum / n) * PER() : NaN;
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
    return (u * Math.sin(flood) + v * Math.cos(flood)) * PER();
  };
  const lines: Line[] = [
    { ys: xs.map((t) => at(c, t)).map((v) => (v == null ? NaN : v * PER())), color: cssVar("--fc-mid"), width: 1.4, label: "Predicted, harbour entrance", fmt: (v) => `${v.toFixed(2)} ${UL()}` },
    { ys: xs.map(modelAlong), color: MODEL_LINE(), width: 1.4, dash: "5 3", label: "NECOFS model at the buoy (surface)", fmt: (v) => `${v.toFixed(2)} ${UL()}` },
    { ys: xs.map(along), color: cssVar("--now"), width: 1.6, label: "UNH buoy, cells 1 to 10", fmt: (v) => `${v.toFixed(2)} ${UL()}` },
  ];
  $("flow-unit").textContent = UL();
  renderLines(plot, { xs, lines, unit: ` ${UL()}`, zero: true, ...MARKS(), empty: "No current data for this window." });
}

/* The small chart under the profile: the current or the tide over the plots' window, with a one-line key; Expand
   opens both at full size in a dialog, drawn only while it is open. */
let sparkTab: "flow" | "tide" = "flow";
function drawSpark(): void {
  const plot = $("spark-plot");
  if (sparkTab === "tide") drawTide(plot);
  else drawFlow(plot);
  const keys: [string, string][] = sparkTab === "tide"
    ? [["var(--now)", "observed"], ["var(--fc-mid)", "predicted"]]
    : [["var(--fc-mid)", "NOAA predicted"], [MODEL_LINE(), "NECOFS"], ["var(--now)", "buoy"]];
  const unit = sparkTab === "tide" ? "ft above MLLW" : `${UL()}, flood positive`;
  $("spark-legend").innerHTML = keys.map(([c, label]) => `<span><i style="background:${c}"></i>${label}</span>`).join("") + `<span class="pq-spark-unit">${unit}</span>`;
}
const chartsOpen = () => ($("charts-dialog") as HTMLDialogElement).open;

function wireCharts(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-spark]").forEach((b) =>
    b.addEventListener("click", () => {
      sparkTab = b.dataset.spark === "tide" ? "tide" : "flow";
      document.querySelectorAll<HTMLButtonElement>("[data-spark]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawSpark();
      markAsOf(T);
      writeLink();
    }),
  );
  const dialog = $("charts-dialog") as HTMLDialogElement;
  $("charts-open").addEventListener("click", () => {
    dockBar($("charts-bar"));
    dialog.showModal();
    drawTide();
    drawFlow();
    markAsOf(T);
  });
  $("charts-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
  dialog.addEventListener("close", () => dockBar(null));
}

/** The plots' two time rules, off the gold this page uses for observations: the selected time in the page's purple,
 * as on the strips' cursor and the time bar, and the present moment dashed in grey. */
const MARKS = () => ({ asOfColor: cssVar("--pq-time"), marker: { x: now(), label: "now", color: cssVar("--dim") } });

// ---------- The readout and the time control ----------

function drawRead(): void {
  const parts = [`<b>${fmtTime.format(new Date(T * 1000))}</b>`];
  const wl = at(D.water_level, T);
  const pr = at(D.tide, T);
  if (wl != null) parts.push(`water level ${(wl * FT).toFixed(1)} ft observed`);
  if (pr != null) parts.push(`${(pr * FT).toFixed(1)} ft predicted`);
  const cp = at(D.current, T);
  if (cp != null) parts.push(`predicted current ${spdTxt(Math.abs(cp))} ${cp >= 0 ? "flood" : "ebb"}`);
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
  PANE?.setTime(T);
  drawProfile();
  drawRead();
  writeLink();
}

/** Widen the slider's range to take in [t0, t1] (the 3D pane's data window, once it is known). */
function extendRange(t0: number, t1: number): void {
  // On the 10-minute grid: the slider steps from its min, so an off-grid min would put every step 2 or 8 min off.
  X0 = Math.floor(Math.min(X0, t0) / (10 * MIN)) * 10 * MIN;
  X1 = Math.ceil(Math.max(X1, t1) / (10 * MIN)) * 10 * MIN;
  const s = $("slider") as HTMLInputElement;
  s.min = String(X0);
  s.max = String(X1);
}

let placed = false; // whether the viewer has moved the time (Play then starts where they put it)
/** A time change from the viewer's own controls. While playing, Play starts over from the new time, so it runs
 * through the record the viewer moved to rather than snapping back to the old one. */
function moveT(t: number): void {
  placed = true;
  setT(t);
  if (playing) startPlay();
}

// ---------- The link: the page's state in its address, so a copied URL opens the same view ----------
// t=20260928T0120Z (once the reader has moved the time), view=map, days=16|all, align=tide, chart=tide, span=all; the
// 3D panel's p, cells, curtain, bed, tr=0, mesh=0, vx and cam (eye and target, scene metres); the map's
// map=lon,lat,zoom. Defaults are left out. Units stay the reader's own choice.

const LINK = new URLSearchParams(location.search);
const stamp = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";
function unstamp(s: string | null): number | null {
  const m = s?.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)Z$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : null;
}
/** The 3D panel's choices, as the pane's getState keys and the link's names, with their defaults. */
const PANE_LINK: [key: string, name: string, def: string | number | boolean][] = [
  ["profiles", "p", "both"], ["cells", "cells", "surface"], ["curtainMode", "curtain", "off"], ["bed", "bed", "dem"],
  ["tracers", "tr", true], ["edges", "mesh", true], ["exag", "vx", 10],
];
/** The pane state a link asks for (setState's shape), or null. */
function paneFromLink(): Record<string, unknown> | null {
  const s: Record<string, unknown> = {};
  for (const [key, name, def] of PANE_LINK) {
    const v = LINK.get(name);
    if (v == null) continue;
    s[key] = typeof def === "boolean" ? v !== "0" : typeof def === "number" ? Number(v) : v;
  }
  const cam = LINK.get("cam")?.split(",").map(Number);
  if (cam?.length === 6 && cam.every(Number.isFinite)) s.cam = cam;
  return Object.keys(s).length ? s : null;
}
const mapFromLink = (): [number, number, number] | null => {
  const m = LINK.get("map")?.split(",").map(Number);
  return m?.length === 3 && m.every(Number.isFinite) ? [m[0], m[1], m[2]] : null;
};

function linkURL(): string {
  const q: [string, string][] = [];
  if (placed) q.push(["t", stamp(T)]);
  if (VIEW === "map") q.push(["view", "map"]);
  if (stripCount !== 7) q.push(["days", stripCount ? String(stripCount) : "all"]);
  if (stripAlign === "tide") q.push(["align", "tide"]);
  if (sparkTab === "tide") q.push(["chart", "tide"]);
  if (SPAN == null) q.push(["span", "all"]);
  // The 3D view's and the map's own state while they exist; before then, whatever the link asked for, kept.
  const ps = PANE ? (PANE.getState?.() as Record<string, unknown> | undefined) : undefined;
  for (const [key, name, def] of PANE_LINK) {
    if (ps) {
      const v = ps[key];
      if (v !== undefined && v !== def) q.push([name, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]);
    } else if (LINK.has(name)) q.push([name, LINK.get(name)!]);
  }
  const cam = ps ? (ps.cam as number[] | undefined)?.join(",") : LINK.get("cam");
  if (cam) q.push(["cam", cam]);
  if (MAP) {
    const c = MAP.getCenter();
    q.push(["map", `${c.lng.toFixed(4)},${c.lat.toFixed(4)},${MAP.getZoom().toFixed(2)}`]);
  } else if (LINK.has("map")) q.push(["map", LINK.get("map")!]);
  const s = q.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ",")}`).join("&");
  return location.pathname + (s ? `?${s}` : "");
}
/** Keep the address current (replacing the history entry, at most every 0.4 s, so Play does not flood it). */
let linkPending = 0;
function writeLink(): void {
  if (linkPending) return;
  linkPending = window.setTimeout(() => {
    linkPending = 0;
    history.replaceState(null, "", linkURL());
  }, 400);
}
/** At load: the time and the plain controls a link asks for (the views and the 3D panel follow in showView). */
function readLink(): void {
  const t = unstamp(LINK.get("t"));
  if (t != null) {
    T = t;
    placed = true;
    extendRange(t - 86400, t + 86400);
  }
  const days = LINK.get("days");
  if (days === "all") stripCount = 0;
  else if (days === "16") stripCount = 16;
  if (LINK.get("align") === "tide") stripAlign = "tide";
  if (LINK.get("chart") === "tide") sparkTab = "tide";
  if (LINK.get("span") === "all") SPAN = null;
  const press = (attr: string, value: string) =>
    document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value)));
  press("data-rows", String(stripCount));
  press("data-align", stripAlign);
  press("data-spark", sparkTab);
  const zoom = $("zoom");
  zoom.textContent = SPAN == null ? "3 days" : "Full record";
  zoom.setAttribute("aria-pressed", String(SPAN == null));
}

/** Where Play runs, as [first, end, loop]: from the selected time to the end of the record that holds it (the 3D
 * data window, else the buoy's record), else on to the slider's end; at the end it goes back to loop (the 3D window's
 * start, which is short enough to replay whole, else where Play started). Before the viewer has moved the time, the
 * 3D view plays its data window, as at the live time it would hold one frame. */
function playRange(): [number, number, number] {
  const inside = (r: [number, number] | null) => !!r && T >= r[0] && T < r[1];
  const b = D.buoy;
  const buoy: [number, number] | null = b ? [sec(b.t0), sec(b.last)] : null;
  if (inside(PANE_RANGE)) return [T, PANE_RANGE![1], PANE_RANGE![0]];
  if (inside(buoy)) return [T, buoy![1], T];
  if (VIEW === "3d" && PANE_RANGE && !placed) return [PANE_RANGE[0], PANE_RANGE[1], PANE_RANGE[0]];
  return [T, X1, T];
}

let playing = 0;
/** Play (or play again) from the current time: 10 minutes a frame to the end of its record, then round again. */
function startPlay(): void {
  window.clearInterval(playing);
  const [start, end, loop] = playRange();
  if (T !== start) setT(start);
  setPlayButton($("play"), true);
  playing = window.setInterval(() => setT(T + 10 * MIN >= end ? loop : T + 10 * MIN), 60);
}
function stopPlay(): void {
  window.clearInterval(playing);
  playing = 0;
  setPlayButton($("play"), false);
}

function wireTime(): void {
  const s = $("slider") as HTMLInputElement;
  timeTrack(s, (v) => v); // the slider's values are the time itself
  setPlayButton($("play"), false);
  s.min = String(X0);
  s.max = String(X1);
  s.addEventListener("input", () => moveT(Number(s.value)));
  const jump = $("jump") as HTMLSelectElement;
  (jump.querySelector('option[value="buoy"]') as HTMLOptionElement).disabled = !D.buoy;
  jump.addEventListener("change", async () => {
    const to = jump.value;
    jump.value = "";
    if (to === "buoy" && D.buoy) moveT(sec(D.buoy.last));
    else if (to === "pane") {
      // The window is known once the pane has loaded its data; from the map, switch to 3D first.
      if (VIEW !== "3d") await showView("3d");
      const r = await paneRange;
      if (r) moveT(r[0]);
    }
  });
  $("back").addEventListener("click", () => moveT(T - 10 * MIN));
  const zoom = $("zoom");
  zoom.addEventListener("click", () => {
    SPAN = SPAN == null ? 3 * 86400 : null;
    zoom.textContent = SPAN == null ? "3 days" : "Full record";
    zoom.setAttribute("aria-pressed", String(SPAN == null));
    view();
    drawPlots();
    writeLink();
  });
  $("fwd").addEventListener("click", () => moveT(T + 10 * MIN));
  const pick = (attr: string, on: (v: string) => void) => {
    document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
        on(btn.getAttribute(attr)!);
        drawPlots();
        writeLink();
      }),
    );
  };
  pick("data-rows", (v) => (stripCount = Number(v)));
  pick("data-align", (v) => (stripAlign = v === "tide" ? "tide" : "clock"));
  $("to-now").addEventListener("click", () => moveT(now()));
  // Copy link: the address as it stands now (time, views, 3D camera and layers, map position).
  const share = $("share");
  share.addEventListener("click", async () => {
    window.clearTimeout(linkPending);
    linkPending = 0;
    history.replaceState(null, "", linkURL());
    const label = share.querySelector("span")!;
    try {
      await navigator.clipboard.writeText(location.href);
      label.textContent = "Copied";
    } catch {
      window.prompt("Copy this link", location.href); // no clipboard access (an http page, or refused)
    }
    window.setTimeout(() => (label.textContent = "Copy link"), 1600);
  });
  $("play").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
  // The strips scrub: press anywhere on a strip (or the cursor's knob) and drag. A drag stays on the row it started
  // in, so the time runs smoothly along one day; a vertical touch drag still scrolls the page (touch-action: pan-y).
  const heat = $("heat");
  let dragRow = -1;
  const timeAt = (e: PointerEvent, row: number) => {
    const box = ($("heat-canvas") as HTMLCanvasElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - box.left - labelW()) / (box.width - labelW())));
    return strips[row] + f * (strips[row + 1] - strips[row]);
  };
  heat.addEventListener("pointerdown", (e) => {
    const box = ($("heat-canvas") as HTMLCanvasElement).getBoundingClientRect();
    const onKnob = (e.target as HTMLElement).classList.contains("pq-knob");
    let row = Math.floor((e.clientY - box.top - HOURS_H + ROW_GAP / 2) / (rowH() + ROW_GAP));
    if (onKnob) {
      const n = strips.length - 1;
      row = 0;
      while (row < n - 1 && T >= strips[row + 1]) row++;
    } else if (e.clientX - box.left < labelW() || row < 0 || row >= strips.length - 1) return;
    dragRow = row;
    heat.setPointerCapture(e.pointerId);
    heat.classList.add("pq-dragging");
    if (!onKnob) moveT(timeAt(e, row));
    e.preventDefault();
  });
  heat.addEventListener("pointermove", (e) => {
    if (dragRow >= 0 && dragRow < strips.length - 1) moveT(timeAt(e, dragRow));
  });
  const end = () => {
    dragRow = -1;
    heat.classList.remove("pq-dragging");
  };
  heat.addEventListener("pointerup", end);
  heat.addEventListener("pointercancel", end);
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
  box.innerHTML = `<span>${spdNice(CURRENTS_FLOOR * 100)}</span><i style="background:linear-gradient(90deg,${stops})"></i><span>${spdNice(CURRENTS_TOP * 100)}</span><span class="pq-faded">the Sound page's currents scale; arrows show where the water goes</span>`;
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
    const linked = mapFromLink(); // a shared link's centre and zoom, else the buoy and the three stations in view
    if (linked) map.jumpTo({ center: [linked[0], linked[1]], zoom: linked[2] });
    else map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 60, bottom: 60, left: 40, right: 220 }, duration: 0, maxZoom: 14 });
    map.on("moveend", writeLink);
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
const KTS = (cms: number) => spdTxt(cms, 2);
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
    const d = b.dir[k][c] == null ? null : trueDir(b.dir[k][c]!);
    if (s == null || d == null) continue;
    su += s * Math.sin((d * Math.PI) / 180);
    sv += s * Math.cos((d * Math.PI) / 180);
    n++;
  }
  const top = b.spd[k][0];
  return `<b class="pq-tip-measured">UNH buoy, measured</b><br>${fmtTime.format(new Date(buoyT[k] * 1000))}` +
    (n ? `<br>Cells 1 to 10 averaged: ${KTS(Math.hypot(su, sv) / n)} toward ${TOWARD(su, sv)}` : "") +
    (top != null && b.dir[k][0] != null ? `<br>Cell 1: ${KTS(top)} toward ${trueDir(b.dir[k][0]!)}°` : "") +
    `<br><small>Directions turned to true north from the logged (inferred magnetic) values.</small>`;
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
  return `<b>NOAA Portsmouth Harbor Entrance</b><br>${v == null ? "No prediction at this time." : `Predicted ${spdTxt(Math.abs(v), 2)} ${v >= 0 ? "flood" : "ebb"} at 2.4 m`}` +
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

/* The 3D view: a separate module with its own model data (/portsmouth-harbor/pane/; a rolling window the jobs keep around
   the buoy's latest record), the default view. The page owns the clock: it passes every time change in, hands over the
   buoy's record (so the view's buoy is the page's), and learns the pane's data window (for Jump to and Play) once its
   data load. */
interface Pane {
  setTime(t: number): void; setTheme(light: boolean): void; setUnits?(unit: "kt" | "mph" | "ms"): void;
  getState?(): Record<string, unknown>; setState?(s: Record<string, unknown>): void; dispose(): void;
}
interface PaneOpts {
  dataBase: string; title?: boolean; buoy?: PaneBuoy; onChange?: () => void; onReady?: (range: { t0: number; t1: number }) => void;
}
/** The buoy's record in the 3D view's shape (its buoy.json): epoch seconds, speeds in cm/s and directions turned to true. */
interface PaneBuoy { name: string; lat: number; lon: number; t: number[]; spd_cm_s: (number | null)[][]; dir_deg_toward_true: (number | null)[][]; declination_deg: number; flag: number[] }
function paneBuoy(): PaneBuoy | undefined {
  const b = D.buoy;
  if (!b) return undefined;
  const t0 = sec(b.t0);
  return {
    name: b.name, lat: b.lat, lon: b.lon,
    t: b.t.map((m) => t0 + m * 60),
    spd_cm_s: b.spd,
    dir_deg_toward_true: b.dir.map((row) => row.map((d) => (d == null ? null : trueDir(d)))),
    declination_deg: DECLINATION,
    flag: b.flag,
  };
}
let PANE: Pane | null = null;
let PANE_RANGE: [number, number] | null = null; // the pane's data window, epoch s
let paneReady: (r: [number, number] | null) => void = () => undefined;
const paneRange = new Promise<[number, number] | null>((res) => (paneReady = res));
const PANE_BASE = "/portsmouth-harbor/pane/"; // the module; its data come from the Worker (Workers KV)
const PANE_DATA = "/data/v1/piscataqua-pane/";
let VIEW: "map" | "3d" = "3d";

async function showView(next: "map" | "3d"): Promise<void> {
  VIEW = next;
  $("map").hidden = next !== "map";
  $("pane3d").hidden = next !== "3d";
  $("map-scale").hidden = next !== "map";
  $("view-label").textContent = next === "map" ? "Surface currents, NECOFS model" : "Currents in 3D";
  $("map-when").hidden = next !== "map";
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === next)));
  writeLink(); // the view in the address (3D needs none: it is the default)
  if (next === "map") {
    // The map is built the first time it is shown, so the 3D default never loads MapLibre.
    if (!MAP) await drawMap();
    MAP?.resize();
    return;
  }
  if (PANE) return PANE.setTime(T);
  const box = $("pane3d");
  box.innerHTML = `<p class="note pq-3d-wait">Loading the 3D view…</p>`;
  try {
    const mod = (await import(/* @vite-ignore */ `${PANE_BASE}pane.js`)) as { mountPane: (el: HTMLElement, o: PaneOpts) => Pane };
    box.replaceChildren();
    PANE = mod.mountPane(box, {
      dataBase: PANE_DATA,
      title: false, // the figure's caption names the view
      buoy: paneBuoy(),
      onChange: writeLink,
      onReady: ({ t0, t1 }) => {
        PANE_RANGE = [t0, t1];
        extendRange(t0, t1);
        paneReady(PANE_RANGE);
      },
    });
    PANE.setTheme(light());
    PANE.setUnits?.(U);
    const fromLink = paneFromLink();
    if (fromLink) PANE.setState?.(fromLink);
    PANE.setTime(T);
  } catch {
    box.innerHTML = `<p class="note">The 3D view could not be loaded.</p>`;
    paneReady(null);
  }
}

/** Move the time bar into a box that covers the page (full screen, the charts dialog), or back to its place (null). */
let barHome: Comment | null = null;
function dockBar(into: HTMLElement | null): void {
  const bar = $("timebar");
  if (!barHome) {
    barHome = document.createComment("time bar");
    bar.before(barHome);
  }
  if (into && bar.parentElement !== into) into.append(bar);
  else if (!into && bar.parentElement !== barHome.parentNode) barHome.after(bar);
  bar.classList.toggle("pq-timebar-in", !!into);
}

function wireViews(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => void showView(b.dataset.view === "map" ? "map" : "3d")));
  // Full screen on the view's box (map or 3D); both fill it and follow its size. A fixed full-window class where the
  // Fullscreen API is missing (iPhone Safari). The time bar moves into the box while it is full screen, and back.
  const box = $("viewbox");
  const btn = $("fullscreen");
  const sync = () => {
    const on = document.fullscreenElement === box || box.classList.contains("pq-full");
    btn.textContent = on ? "Exit full screen" : "Full screen";
    btn.setAttribute("aria-pressed", String(on));
    dockBar(on ? box : null);
    $("fs-exit").hidden = !on; // the page's button is outside the box, so the bar carries its own way out
    window.setTimeout(() => MAP?.resize(), 50);
  };
  const toggle = () => {
    if (document.fullscreenElement === box) void document.exitFullscreen();
    else if (box.classList.contains("pq-full")) box.classList.remove("pq-full");
    else if (box.requestFullscreen) void box.requestFullscreen().catch(() => box.classList.add("pq-full"));
    else box.classList.add("pq-full");
    window.setTimeout(sync, 60);
  };
  btn.addEventListener("click", toggle);
  $("fs-exit").addEventListener("click", toggle);
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box.classList.contains("pq-full")) {
      box.classList.remove("pq-full");
      sync();
    }
  });
}
const MODEL_LINE = () => (light() ? "#1f7f86" : "#5fc3c4"); // the model's teal
const BUOY_LAT = () => D.buoy?.lat ?? 43.0687;
const BUOY_LON = () => D.buoy?.lon ?? -70.7079;

// ---------- Method ----------

function drawMethod(): void {
  const b = D.buoy;
  const items: [string, string][] = [
    ["Buoy", `The University of New Hampshire's G-2000 metocean buoy at the mouth of the Piscataqua, drawn at its last GPS fix (${b?.position_as_of ?? "2024-11-21"}). Its <a href="https://www.nortekgroup.com/products">Nortek</a> Aquadopp current profiler looks down from just below the surface, ${b?.instrument ? "20 cells every 10 minutes" : "every 10 minutes"}.`],
    ["Cells", "Numbered from the surface. About 1 m each, which fits the data: cells below about 10 read like noise (2 to 6 cm/s against 10 to 18 above), as expected in about 10 m of water, so they are faded."],
    ["Directions", "The direction the water moves toward, turned to true north. The logged directions follow NOAA's predicted flood and ebb best when turned 15 to 35 degrees west, so we take them as magnetic and turn them by the World Magnetic Model's declination at the buoy (WMM2025: 14.2 degrees west). The magnetic reference is inferred from the data, not yet confirmed; the data file keeps the logged values."],
    ["Quality", 'Provisional, as logged. Following the U.S. IOOS <a href="https://ioos.noaa.gov/project/qartod/">QARTOD</a> manual for current observations <a href="#ref-qartod">[5]</a>, each profile is flagged when the instrument reports an error or an impossible speed (over 3 m/s), and suspect when the buoy is tilted more than 20 degrees.'],
    ["Tide", 'Observed water level at NOAA <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=8419870">Seavey Island (8419870)</a>, 3 km up-river; tide predictions for NOAA <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=8423898">Fort Point (8423898)</a>, 0.5 km from the buoy. Both above MLLW. Moon phases from the <a href="https://aa.usno.navy.mil/data/MoonPhases">US Naval Observatory</a>.'],
    ["Current", 'NOAA\'s tidal current predictions for <a href="https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=PIR0701_12">Portsmouth Harbor Entrance (PIR0701)</a>, 0.7 km from the buoy, at 2.4 m, along the flood axis (342 degrees) with ebb negative. The buoy\'s line is its cells 1 to 10 (the water column above the likely seabed) averaged and projected on the same axis, with its directions turned to true north. For the estuary\'s tides and their spring-neap modulation see McLaughlin et al. <a href="#ref-mclaughlin">[3]</a>; the lower river\'s main channel runs 0.5 to 2 m/s <a href="#ref-bilgili">[4]</a>.'],
    ["Model", 'The map\'s surface currents are <a href="https://fvcom.smast.umassd.edu/">NECOFS</a>, the Northeast Coastal Ocean Forecast System, run on FVCOM <a href="#ref-chen2003">[1]</a> <a href="#ref-chen2006">[2]</a> (GOM7 mesh, top layer) by the University of Massachusetts Dartmouth (SMAST): on the model\'s own triangles, in the Sound page\'s teal scale, the forecast from a day back to three days ahead, and before that the model\'s hindcast from its daily archive (the last 45 days), so it can be set beside the buoy\'s record. The flood and ebb plot adds the model\'s surface current at the buoy\'s element (about 100 m away), hourly, joined by straight lines.'],
    ["Colours", "Measured currents (the buoy) are gold, the site's colour for observations; the model's currents are teal."],
    ["Gaps", "The buoy reports through a shore computer, so its record can stop for days. The page shows how old each source is and draws gaps as gaps; the map, the tide and the predicted current run to now and beyond."],
  ];
  $("method").innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

// ---------- Units ----------

/** The kt / mph / m/s switch in the masthead: saved under the Sound page's key, so the choice carries between pages. */
function wireUnits(redraw: () => void): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-unit]");
  const mark = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === U)));
  mark();
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      U = (b.dataset.unit as Unit) in UNITS ? (b.dataset.unit as Unit) : "kt";
      try {
        localStorage.setItem("lhzn-blue-wind-unit", U);
      } catch {
        /* private mode: the choice lasts for this page only */
      }
      mark();
      redraw();
    }),
  );
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
    drawCharts();
    markAsOf(T);
  });
}

/** The small chart always; the full ones only while their dialog is open. */
function drawCharts(): void {
  drawSpark();
  if (chartsOpen()) {
    drawTide();
    drawFlow();
  }
}

function drawAll(): void {
  drawFresh();
  view();
  drawHeat();
  drawCharts();
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
  T = now(); // the live view; the time bar's Jump to reaches a quiet buoy's last record
  wireTime();
  extendRange(X0, X1); // onto the slider's 10-minute grid
  readLink(); // a shared link's time and controls
  wireTheme(() => {
    drawAll();
    drawMapScale();
    restyleMap();
    PANE?.setTheme(light());
  });
  wireUnits(() => {
    drawAll();
    drawMapScale();
    refreshTip();
    PANE?.setUnits?.(U);
  });
  wireViews();
  wireNotice();
  wireCharts();
  drawMethod();
  drawMapScale();
  drawAll();
  void showView(LINK.get("view") === "map" || location.hash === "#map" ? "map" : "3d"); // #map: the earlier form of the link
  let pending = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(drawAll, 120);
  });
}

void main();
