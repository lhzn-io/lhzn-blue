/**
 * The Piscataqua River mouth (/piscataqua/, unlisted): the UNH G-2000 buoy's current profiler, with NOAA water level,
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
import { CURRENTS_RAMP, CURRENTS_RAMP_DARK } from "./currents-ramp";

interface Series { t0: string; step: number; v: (number | null)[] }
interface Station extends Series { id: string; name: string; lat: number; lon: number }
interface Buoy {
  name: string; lat: number; lon: number; position_as_of: string; instrument: string; file_updated: string; last: string;
  t0: string; t: number[]; spd: (number | null)[][]; dir: (number | null)[][]; temp: (number | null)[]; pressure: (number | null)[];
  pitch: (number | null)[]; roll: (number | null)[]; flag: number[];
}
interface Tide extends Station { hilo: { t: string; m: number; type: "H" | "L" }[] }
interface Current extends Station { flood_dir: number; ebb_dir: number; depth_m: number; events: { t: string; type: string; v: number }[] }
interface Data { generated_at: string; buoy?: Buoy; water_level?: Station; tide?: Tide; current?: Current }

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
const SPEED_TOP = 0.8; // m/s: the page's fixed colour scale (the entrance's predicted peaks are about 0.6 to 0.9 m/s)
const ARROW_PX_PER_MS = 175; // profile bars: 0.1 m/s is 17.5 px
const BAR_X = 58; // the profile panel: where the speed bars start
const BAR_MAX = 140; // and their longest

const $ = (id: string) => document.getElementById(id)!;
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const sec = (iso: string) => Date.parse(iso) / 1000;

let D: Data;
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
function speedColour(ms: number): string {
  const ramp = light() ? CURRENTS_RAMP : CURRENTS_RAMP_DARK;
  // A fixed page scale, 0 to SPEED_TOP m/s, spread (by square root, so slow water still reads) over the currents ramp's full lightness range.
  const f = Math.sqrt(Math.min(1, Math.max(0, ms / SPEED_TOP)));
  return ramp[Math.round(f * (ramp.length - 1))][1];
}

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
    stale.innerHTML = `<b>The buoy has been quiet since ${fmtTime.format(new Date(b.last))}.</b> The current plots show its last 30 days of records; the tide and the predicted current are live.`;
  } else if (!b) {
    stale.hidden = false;
    stale.innerHTML = "<b>No buoy profiles could be read.</b> The tide and the predicted current are live.";
  } else stale.hidden = true;
}

// ---------- The time-by-cell plot ----------

function drawHeat(): void {
  const box = $("heat");
  const cv = $("heat-canvas") as HTMLCanvasElement;
  const W = Math.max(200, box.clientWidth - 44);
  const H = box.clientHeight - 16;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  g.fillStyle = cssVar("--chart-shade") || "rgba(0,0,0,0.04)";
  g.fillRect(0, 0, W, H);
  const b = D.buoy;
  const px = (t: number) => ((t - V0) / (V1 - V0)) * W;
  const rowH = H / CELLS;
  if (b) {
    for (let k = 0; k < buoyT.length; k++) {
      const t = buoyT[k];
      const next = k + 1 < buoyT.length && buoyT[k + 1] - t <= 30 * MIN ? buoyT[k + 1] : t + 10 * MIN;
      const xa = px(t);
      const xb = Math.max(xa + 0.6, px(next));
      if (xb < 0 || xa > W) continue;
      const row = b.spd[k];
      for (let c = 0; c < CELLS; c++) {
        const v = row[c];
        if (v == null) continue;
        g.globalAlpha = c >= LIKELY_BED ? 0.35 : 1;
        g.fillStyle = speedColour(v / 100);
        g.fillRect(xa, c * rowH, xb - xa + 0.4, rowH + 0.4);
      }
    }
    g.globalAlpha = 1;
    // The likely seabed.
    g.strokeStyle = cssVar("--dim");
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, LIKELY_BED * rowH);
    g.lineTo(W, LIKELY_BED * rowH);
    g.stroke();
    g.setLineDash([]);
  }
  // "now" and the future, as on the other plots.
  const xn = px(now());
  if (xn < W) {
    g.fillStyle = cssVar("--chart-shade") || "rgba(0,0,0,0.05)";
    g.fillRect(Math.max(0, xn), 0, W - Math.max(0, xn), H);
  }
  const labels: string[] = [];
  for (const c of [1, 5, 10, 15, 20]) labels.push(`<span class="ylab" style="top:${(((c - 0.5) / CELLS) * 100).toFixed(1)}%">${c}</span>`);
  labels.push(`<span class="ylab pq-bed" style="top:${((LIKELY_BED / CELLS) * 100).toFixed(1)}%">bed?</span>`);
  for (const [t, text] of dayTicks()) labels.push(`<span class="month" style="left:${((px(t) / (W + 44)) * 100).toFixed(2)}%">${text}</span>`);
  if (xn < W) labels.push(`<span class="arriving" style="left:${((xn / (W + 44)) * 100).toFixed(2)}%">now</span>`);
  $("heat-labels").innerHTML = labels.join("");
  const stops = Array.from({ length: 17 }, (_, i) => `${speedColour((i / 16) * SPEED_TOP)} ${(i / 16) * 100}%`).join(",");
  $("heat-scale").innerHTML = `<span>0</span><i style="background:linear-gradient(90deg,${stops})"></i><span>${SPEED_TOP} m/s (${(SPEED_TOP * 1.94384).toFixed(1)} kt) and up</span><span class="pq-faded">cells below the dashed line: faded, likely at or below the seabed</span>`;
  placeCursor();
}

function dayTicks(): [number, string][] {
  const out: [number, string][] = [];
  const span = V1 - V0;
  const every = span > 20 * 86400 ? 7 : span > 8 * 86400 ? 2 : 1;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  const d = new Date(V0 * 1000);
  d.setUTCHours(4, 0, 0, 0); // about Eastern midnight
  for (let t = d.getTime() / 1000, n = 0; t <= V1; t += 86400, n++) if (t >= V0 && n % every === 0) out.push([t, fmt.format(new Date(t * 1000))]);
  return out;
}

function placeCursor(): void {
  const box = $("heat");
  const W = Math.max(200, box.clientWidth - 44);
  $("heat-cursor").style.left = `${((T - V0) / (V1 - V0)) * W}px`;
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
    text(W / 2, H / 2, why.length > 52 ? why.slice(0, 52) + "…" : why, { "text-anchor": "middle" });
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
  const lines: Line[] = [
    { ys: xs.map((t) => at(c, t)).map((v) => (v == null ? NaN : v * KT)), color: cssVar("--fc-mid"), width: 1.4, label: "Predicted, harbour entrance", fmt: (v) => `${v.toFixed(2)} kt` },
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
  if (V0 !== a || V1 !== b) drawPlots();
  markAsOf(T);
  placeCursor();
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
    placeCursor();
  });
  $("fwd").addEventListener("click", () => setT(T + 10 * MIN));
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
    const r = ($("heat-canvas") as HTMLCanvasElement).getBoundingClientRect();
    if (e.clientX <= r.right) setT(V0 + ((e.clientX - r.left) / r.width) * (V1 - V0));
  });
}

// ---------- The map ----------

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
let restyleMap: () => void = () => undefined;

async function drawMap(): Promise<void> {
  const box = $("map");
  try {
    await import("maplibre-gl/dist/maplibre-gl.css");
    const maplibregl = (await import("maplibre-gl")).default;
    const style = light() ? STYLE_LIGHT : STYLE_DARK;
    const map = new maplibregl.Map({ container: box, style, center: [-70.72, 43.07], zoom: 12.6, attributionControl: { compact: true }, cooperativeGestures: true });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const pins: [number, number, string, string][] = [
      [BUOY_LON(), BUOY_LAT(), "UNH buoy", "pq-pin pq-pin-buoy"],
      [D.water_level?.lon ?? -70.7411, D.water_level?.lat ?? 43.0797, "Seavey Island (water level)", "pq-pin"],
      [D.tide?.lon ?? -70.7117, D.tide?.lat ?? 43.0717, "Fort Point (tide)", "pq-pin"],
      [D.current?.lon ?? -70.7053, D.current?.lat ?? 43.0624, "Harbor Entrance (current)", "pq-pin"],
    ];
    for (const [lon, lat, label, cls] of pins) {
      const m = document.createElement("div");
      m.className = cls;
      m.innerHTML = `<i></i><span>${label}</span>`;
      new maplibregl.Marker({ element: m, anchor: "left" }).setLngLat([lon, lat]).addTo(map);
    }
    const lons = pins.map((p) => p[0]);
    const lats = pins.map((p) => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 50, bottom: 50, left: 50, right: 200 }, duration: 0, maxZoom: 14 });
    restyleMap = () => map.setStyle(light() ? STYLE_LIGHT : STYLE_DARK);
  } catch {
    box.innerHTML = `<p class="note">The map could not be loaded.</p>`;
  }
}
const BUOY_LAT = () => D.buoy?.lat ?? 43.0687;
const BUOY_LON = () => D.buoy?.lon ?? -70.7079;

// ---------- Method ----------

function drawMethod(): void {
  const b = D.buoy;
  const items: [string, string][] = [
    ["Buoy", `The University of New Hampshire's G-2000 metocean buoy at the mouth of the Piscataqua, drawn at its last GPS fix (${b?.position_as_of ?? "2024-11-21"}). Its ${b?.instrument ?? "current profiler"} looks down from just below the surface.`],
    ["Cells", "Numbered from the surface. The cell size is not yet confirmed with the buoy's owners; cells below about 10 read like noise (2 to 6 cm/s against 10 to 18 above), consistent with about 1 m cells in about 10 m of water, so they are faded."],
    ["Directions", "As logged, the direction the water moves toward. They follow NOAA's predicted flood and ebb best when turned 15 to 35 degrees west, so they are probably magnetic (declination here is about 15 degrees west); they are not corrected."],
    ["Quality", "Provisional and not yet quality-controlled by the owners. Each profile is flagged when the instrument reports an error or an impossible speed (over 3 m/s), and suspect when the buoy is tilted more than 20 degrees."],
    ["Tide", "Observed water level at NOAA Seavey Island (8419870), 3 km up-river; tide predictions for NOAA Fort Point (8423898), 0.5 km from the buoy. Both above MLLW."],
    ["Current", "NOAA's tidal current predictions for Portsmouth Harbor Entrance (PIR0701), 0.7 km from the buoy, at 2.4 m, along the flood axis (342 degrees) with ebb negative. The buoy's line is its cells 1 to 10 (the water column above the likely seabed) averaged and projected on the same axis, with its directions as logged."],
    ["Gaps", "The buoy reports through a shore computer, so its record can stop for days. The page shows how old each source is and draws gaps as gaps; the NOAA panels run to now and two days ahead."],
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
  const b = D.buoy;
  if (b) buoyT = b.t.map((m) => sec(b.t0) + m * MIN);
  const ends = [D.tide, D.current].filter((s): s is Tide | Current => !!s?.v.length).map((s) => sec(s.t0) + (s.v.length - 1) * s.step);
  X1 = Math.max(now() + HOUR, ...ends);
  X0 = Math.min(b ? sec(b.t0) : now() - 7 * 86400, now() - 7 * 86400);
  const stale = !b || now() - sec(b.last) > STALE_S;
  T = b ? (stale ? sec(b.last) : now()) : now();
  wireTime();
  wireTheme(() => {
    drawAll();
    restyleMap();
  });
  drawMethod();
  drawAll();
  void drawMap();
  let pending = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(drawAll, 120);
  });
}

void main();
