/**
 * "Forecast verification" (/long-island-sound/forecast/): NOAA HRRR wind forecasts at the four Long Island
 * Sound buoys, compared with what the buoys measured.
 *
 * Three files: forecast-verification.json (the archive's statistics since January 2024), forecast-hrrr.json
 * (every recent HRRR run at the buoys) and live.json (the buoys' recent hourly means). Colour follows the site:
 * gold for observed, willow blues for order (strong for recent runs and short leads, pale for old or long),
 * the page's ink for references, amber only for states that must stand out.
 */
import "./site.css";
import { mountAdvisories } from "./advisory";
import "./forecast-page.css";
import { cssVar, el, niceStep, renderLines, type Line } from "./chart";

const DATA = "/data/v1";
const $ = (id: string) => document.getElementById(id)!;
const BUOYS = ["EXRX", "WLIS", "ARTG", "CLIS"] as const;
type Buoy = (typeof BUOYS)[number];
const NAMES: Record<string, string> = {
  EXRX: "Execution Rocks",
  WLIS: "Western Sound",
  ARTG: "ARTG buoy",
  CLIS: "Central Sound",
  all: "All four buoys",
};
const MS_TO_KT = 1.943844;
const HOUR = 3600;
const TZ = "America/New_York";

// ---------- Data shapes ----------

interface Stats {
  n: number;
  bias: number;
  mae: number;
  rmse: number;
  forecast_mean: number;
  observed_mean_at_sensor: number;
  dir_n: number;
  dir_bias: number;
  dir_mae: number;
  air_n: number;
  air_bias: number;
  air_mae: number;
  pressure_n: number;
  pressure_bias: number;
  pressure_mae: number;
  hist?: number[];
}
interface Verification {
  generated_at: string;
  first_valid: string;
  through: string;
  method: { observed: string; speed_at_10m: string; direction: string; bins: string };
  units: Record<string, string>;
  leads: number[];
  by_lead: Record<string, { all: Stats; buoys: Record<string, Stats | undefined> }>;
  bins: Record<string, Record<string, Record<string, Stats | undefined>>>;
  recent: { days: string[]; bands: Record<string, Record<string, (Stats | null)[]>> };
}
type Num = number | null;
interface HrrrPoint {
  u10: Num[];
  v10: Num[];
}
interface Hrrr {
  generated_at: string;
  cycles: Record<string, { leads: number[]; points: Record<string, HrrrPoint | undefined> }>;
}
interface Met {
  t0: string;
  step: number;
  wind_kt: Num[];
}
interface Live {
  met: Record<string, Met | undefined>;
}

// ---------- Formatting ----------

const fmtFull = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric" });
const fmtShort = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric" });
// The archive's first and last valid hours are UTC instants on day boundaries: name their UTC dates (01:00 UTC on
// January 1 would otherwise read as December 31 in New York).
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
const fmtMonthYear = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const fmtDayUtc = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MINUS = "−";
const sec = (iso: string) => Date.parse(iso) / 1000;
const atS = (t: number) => new Date(t * 1000);
/** A value with its sign: "+1.2", "−0.4", "0.0". */
function signed(v: number, d = 1): string {
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return s;
  return (v > 0 ? "+" : MINUS) + s;
}
const fix = (v: number, d = 1) => (v < 0 ? MINUS : "") + Math.abs(v).toFixed(d);
const narrow = () => window.innerWidth < 560;

// ---------- Theme colours ----------

interface Colours {
  bg: string;
  ink: string;
  strong: string;
  mid: string;
  pale: string;
  now: string;
}
let C: Colours;
function readColours(): void {
  C = {
    bg: cssVar("--bg"),
    ink: cssVar("--ink"),
    strong: cssVar("--fc-strong"),
    mid: cssVar("--fc-mid"),
    pale: cssVar("--fc-pale"),
    now: cssVar("--now"),
  };
}
function hexRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
}
/** Mix two hex colours: t = 0 gives a, t = 1 gives b. */
function mix(a: string, b: string, t: number): string {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  const k = Math.max(0, Math.min(1, t));
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}
/** The willow ramp for order: 0 is strong (recent, short lead), 1 is pale (old, long lead). */
const ramp = (t: number) => (t < 0.5 ? mix(C.strong, C.mid, t * 2) : mix(C.mid, C.pale, (t - 0.5) * 2));

// ---------- Small SVG helpers ----------

interface Frame {
  svg: SVGSVGElement;
  W: number;
  H: number;
}
function frame(box: HTMLElement, H: number, label: string): Frame {
  const W = Math.max(280, Math.floor(box.clientWidth));
  const svg = el("svg", { class: "fc-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": label });
  box.replaceChildren(svg);
  return { svg, W, H };
}
function text(parent: SVGElement, x: number, y: number, s: string, attrs: Record<string, string | number> = {}): SVGTextElement {
  const t = el("text", { x, y, ...attrs });
  t.textContent = s;
  parent.append(t);
  return t;
}
function line(parent: SVGElement, x1: number, y1: number, x2: number, y2: number, style: string): SVGLineElement {
  const l = el("line", { x1, y1, x2, y2, style });
  parent.append(l);
  return l;
}
function path(parent: SVGElement, d: string, style: string): SVGPathElement {
  const p = el("path", { d, style });
  parent.append(p);
  return p;
}
const GRID = "stroke: var(--chart-grid); stroke-dasharray: 2 4";
const ZERO = "stroke: var(--chart-zero)";
const AXIS = "stroke: var(--chart-axis)";
/** Nice value ticks covering lo..hi. */
function ticks(lo: number, hi: number, target = 4): { lo: number; hi: number; step: number; vals: number[] } {
  const step = niceStep(Math.max(1e-6, hi - lo), target);
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const vals: number[] = [];
  for (let v = a; v <= b + step / 1000; v += step) vals.push(+v.toFixed(6));
  return { lo: a, hi: b, step, vals };
}
const tickText = (v: number, step: number) => fix(v, step < 1 ? 1 : 0).replace(/^−0(\.0)?$/, "0");

/** The site's hanging tabs as a single-choice group. */
function tabs(host: HTMLElement, items: [string, string][], current: string, pick: (k: string) => void): void {
  host.replaceChildren(
    ...items.map(([k, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.dataset.k = k;
      b.textContent = label;
      b.setAttribute("aria-pressed", String(k === current));
      return b;
    }),
  );
  host.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-k]");
    if (!b) return;
    host.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    pick(b.dataset.k!);
  };
}

// ---------- State ----------

let V: Verification;
let HR: Hrrr | null = null;
let LIVE: Live | null = null;
let FACTOR = 1.098;

// ---------- Observations ----------

/** Observed speed at 10 m (kt) for the hour starting at t, or NaN. */
function obsAt(b: string, t: number): number {
  const m = LIVE?.met[b];
  if (!m) return NaN;
  const i = (t - sec(m.t0)) / (m.step || HOUR);
  if (!Number.isInteger(i) || i < 0 || i >= m.wind_kt.length) return NaN;
  const v = m.wind_kt[i];
  return v == null || !Number.isFinite(v) ? NaN : v * FACTOR;
}
/** Time of the buoy's latest observed hour (epoch seconds), or -Infinity. */
function lastObs(b: string): number {
  const m = LIVE?.met[b];
  if (!m) return -Infinity;
  for (let i = m.wind_kt.length - 1; i >= 0; i--) {
    const v = m.wind_kt[i];
    if (v != null && Number.isFinite(v)) return sec(m.t0) + i * (m.step || HOUR);
  }
  return -Infinity;
}

// ---------- Section 1 and 2: lede and headline numbers ----------

function drawIntro(): void {
  const total = V.leads.reduce((s, L) => s + (V.by_lead[String(L)]?.all.n ?? 0), 0);
  const since = fmtMonthYear.format(new Date(V.first_valid));
  $("lede").innerHTML = `NOAA HRRR at four buoys since ${since}: <b>${total.toLocaleString("en-US")}</b> forecast hours, 1 to 48 hours ahead.`;

  const L1 = V.by_lead["1"].all;
  const L18 = V.by_lead["18"]?.all ?? L1;
  const L48 = V.by_lead["48"]?.all ?? V.by_lead[String(V.leads[V.leads.length - 1])].all;
  // The month with the coldest air bias (18 to 24 h), to say when HRRR runs coldest over the water.
  const months = V.bins["18-24"]?.month ?? {};
  let coldest = "";
  let coldV = Infinity;
  for (const [k, s] of Object.entries(months)) if (s && s.air_n > 100 && s.air_bias < coldV) [coldest, coldV] = [k, s.air_bias];
  const airF = L18.air_bias * 1.8;
  const cards: [string, string, string, string][] = [
    // Typical errors are a size either way (mean absolute error): plus or minus; the biases below carry a sign.
    [`±${L1.mae.toFixed(1)}`, "kt", "Typical speed error, 1 h ahead", `mean absolute error over ${L1.n.toLocaleString("en-US")} forecast hours at 4 buoys`],
    [`±${L48.mae.toFixed(1)}`, "kt", "Typical speed error, 48 h ahead", `${(L48.mae - L1.mae).toFixed(1)} kt more than 1 h ahead`],
    [signed(L18.dir_bias, 0), "deg", "Direction bias, 18 h ahead", `HRRR turned clockwise of the buoy on average; typical miss ${L18.dir_mae.toFixed(0)} deg (wind 6 kt and up)`],
    [
      signed(L18.air_bias, 1),
      "°C",
      "Air temperature bias, 18 h ahead",
      `${signed(airF, 1)} °F; HRRR runs colder than the buoys${coldest ? `, most in ${MONTHS[Number(coldest) - 1]} (${signed(coldV, 1)} °C)` : ""}`,
    ],
  ];
  $("cards").innerHTML = cards
    // The display face's minus sign is set wide; the big figures use its en dash instead.
    .map(([n, u, l, s]) => `<div class="readout"><div class="num">${n.replace(MINUS, "–")}<small>${u}</small></div><span class="lab">${l}</span><span class="sub">${s}</span></div>`)
    .join("");
}

// ---------- Section 3: how the forecast came in ----------

interface Run {
  issue: number;
  pts: Map<number, { L: number; v: number }>; // valid time -> lead and speed (kt)
}
let convBuoy: Buoy = "EXRX";
let convXs: number[] = [];
let convRuns: Run[] = [];
let convT = 0; // index into convXs
let convX0 = 0;
let convX1 = 1;

function runsFor(b: Buoy): Run[] {
  if (!HR) return [];
  const out: Run[] = [];
  for (const [key, c] of Object.entries(HR.cycles)) {
    const issue = sec(key.replace(/Z$/, ":00:00Z"));
    const p = c.points[b];
    if (!Number.isFinite(issue) || !p) continue;
    const pts = new Map<number, { L: number; v: number }>();
    c.leads.forEach((L, i) => {
      const u = p.u10[i];
      const v = p.v10[i];
      if (u == null || v == null || !Number.isFinite(u) || !Number.isFinite(v)) return;
      pts.set(issue + L * HOUR, { L, v: Math.hypot(u, v) * MS_TO_KT });
    });
    if (pts.size) out.push({ issue, pts });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

/** The default hour for a buoy: its latest observation if the runs cover it, else the latest run's first hour. */
function defaultT(b: Buoy): number {
  const lo = lastObs(b);
  let i = convXs.indexOf(lo);
  if (i < 0 && convRuns.length) i = convXs.indexOf(convRuns[convRuns.length - 1].issue + HOUR);
  return i < 0 ? convXs.length - 1 : i;
}

function setupConv(): void {
  if (!HR || !Object.keys(HR.cycles).length) {
    $("conv-note").hidden = false;
    $("conv-note").textContent = "The recent HRRR runs could not be loaded, so this chart is empty for now.";
    return;
  }
  // Default: the buoy with the latest observation.
  convBuoy = BUOYS.reduce((a, b) => (lastObs(b) > lastObs(a) ? b : a), BUOYS[0]);
  tabs($("conv-buoy"), BUOYS.map((b) => [b, NAMES[b]]), convBuoy, (k) => {
    convBuoy = k as Buoy;
    buildConv();
    convT = defaultT(convBuoy);
    drawConv();
  });
  const slider = $("conv-t") as HTMLInputElement;
  slider.addEventListener("input", () => {
    convT = Number(slider.value);
    placeCursor();
    drawPanel();
  });
  // Tap or drag on the chart to pick the hour.
  const plot = $("conv-plot");
  const svg = plot.querySelector("svg")!;
  let dragging = false;
  const pick = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const t = convX0 + ((clientX - box.left) / Math.max(1, box.width)) * (convX1 - convX0);
    convT = Math.max(0, Math.min(convXs.length - 1, Math.round((t - convX0) / HOUR)));
    slider.value = String(convT);
    placeCursor();
    drawPanel();
  };
  svg.addEventListener("pointerdown", (e) => {
    dragging = true;
    pick(e.clientX);
  });
  svg.addEventListener("pointermove", (e) => {
    if (dragging) pick(e.clientX);
  });
  const stop = () => (dragging = false);
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  svg.addEventListener("pointerleave", stop);
  buildConv();
  convT = defaultT(convBuoy);
}

function buildConv(): void {
  convRuns = runsFor(convBuoy);
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of convRuns) for (const t of r.pts.keys()) [lo, hi] = [Math.min(lo, t), Math.max(hi, t)];
  convXs = [];
  if (Number.isFinite(lo)) for (let t = lo; t <= hi; t += HOUR) convXs.push(t);
  const slider = $("conv-t") as HTMLInputElement;
  slider.max = String(Math.max(0, convXs.length - 1));
}

function drawConv(): void {
  if (!convXs.length) return;
  const slider = $("conv-t") as HTMLInputElement;
  slider.value = String(convT);
  const b = convBuoy;
  $("conv-cap").textContent = `${NAMES[b]}: wind at 10 m`;
  const first = convRuns[0].issue;
  const last = convRuns[convRuns.length - 1].issue;
  const lines: Line[] = convRuns.map((r) => {
    const age = last > first ? (last - r.issue) / (last - first) : 0; // 0 newest, 1 oldest
    return {
      ys: convXs.map((t) => r.pts.get(t)?.v ?? NaN),
      color: ramp(age),
      opacity: 0.85 - 0.55 * age,
      width: 1,
      label: `Run of ${fmtShort.format(atS(r.issue))}`,
      tip: false,
    };
  });
  const obs = convXs.map((t) => obsAt(b, t));
  lines.push({ ys: obs, color: C.now, width: 2.4, label: "Observed, 10 m" });
  const now = Date.now() / 1000;
  const r = renderLines($("conv-plot"), {
    xs: convXs,
    lines,
    unit: " kt",
    floor: 0,
    marker: now > convXs[0] && now < convXs[convXs.length - 1] ? { x: now, label: "now" } : undefined,
    empty: "No HRRR runs to show",
  });
  convX0 = r.x0;
  convX1 = r.x1;

  // Say when the buoy's observations stop, if they stop inside the window.
  const lo = lastObs(b);
  const note = $("conv-note");
  const stale = now - lo > 3 * HOUR;
  note.hidden = !stale;
  if (stale)
    note.innerHTML = Number.isFinite(lo)
      ? `<b>No observation from ${NAMES[b]} since ${fmtFull.format(atS(lo))}.</b> The runs after that are shown without the observed line.`
      : `<b>No recent observations from ${NAMES[b]}.</b> The runs are shown without the observed line.`;
  placeCursor();
  drawPanel();
}

/** The chosen hour as a rule across the runs chart. */
function placeCursor(): void {
  const svg = $("conv-plot").querySelector("svg")!;
  let rule = svg.querySelector<SVGLineElement>("line.fc-cursor");
  if (!rule) {
    rule = el("line", { class: "fc-cursor", y1: 0, y2: 100, stroke: C.ink, "stroke-width": 1.6, "vector-effect": "non-scaling-stroke" });
    svg.append(rule);
  }
  const t = convXs[convT];
  const x = ((t - convX0) / Math.max(1, convX1 - convX0)) * 1000;
  rule.setAttribute("x1", String(x));
  rule.setAttribute("x2", String(x));
}

function drawPanel(): void {
  const b = convBuoy;
  const T = convXs[convT];
  const forT = convRuns
    .map((r) => r.pts.get(T))
    .filter((p): p is { L: number; v: number } => !!p)
    .sort((a, c) => c.L - a.L);
  const oT = obsAt(b, T);
  const haveObs = Number.isFinite(oT);

  // The readout under the slider.
  const when = fmtFull.format(atS(T));
  // The observation against the shortest-lead run for the hour, signed: + is wind above the forecast.
  const last = forT[forT.length - 1];
  const obsText = haveObs
    ? `; observed <b>${oT.toFixed(0)} kt</b>${last ? `, <b>${signed(oT - last.v, 0)} kt</b> against the ${last.L} h forecast` : ""}`
    : "; no observation yet";
  $("conv-read").innerHTML = forT.length === 1
    ? `<b>${when}</b>: 1 run, <b>${forT[0].v.toFixed(0)} kt</b> (${forT[0].L} h out)${obsText}`
    : forT.length
    ? `<b>${when}</b>: ${forT.length} run${forT.length > 1 ? "s" : ""}, from <b>${forT[0].v.toFixed(0)} kt</b> (${forT[0].L} h out) to <b>${forT[forT.length - 1].v.toFixed(0)} kt</b> (${forT[forT.length - 1].L} h out)${obsText}`
    : `<b>${when}</b>: no run covers this hour${obsText}`;

  // The panel: speed against lead, 48 h out on the left to 1 h out on the right.
  const box = $("conv-panel");
  const H = narrow() ? 230 : 262;
  const { svg, W } = frame(box, H, `What each HRRR run said for ${when}`);
  const m = { t: 18, r: 10, b: 30, l: 30 };
  const w = W - m.l - m.r;
  const h = H - m.t - m.b;
  const maxL = 48;
  const x = (L: number) => m.l + ((maxL - L) / (maxL - 1)) * w;
  // The typical error band: around the observation, or around the latest run when nothing is observed yet.
  const ref = haveObs ? oT : forT.length ? forT[forT.length - 1].v : NaN;
  const band = V.leads.map((L) => {
    const s = V.by_lead[String(L)];
    return { L, e: (s?.buoys[b]?.mae ?? s?.all.mae ?? NaN) as number };
  });
  const vals = [...forT.map((p) => p.v), ...(Number.isFinite(ref) ? band.map((d) => ref + d.e) : []), 0, haveObs ? oT : 0];
  const tk = ticks(0, Math.max(5, ...vals.filter(Number.isFinite)) * 1.05, 4);
  const y = (v: number) => m.t + h - ((v - tk.lo) / (tk.hi - tk.lo)) * h;
  for (const v of tk.vals) {
    line(svg, m.l, y(v), m.l + w, y(v), v === 0 ? AXIS : GRID);
    text(svg, m.l - 5, y(v) + 3, tickText(v, tk.step), { "text-anchor": "end" });
  }
  for (const L of [48, 36, 24, 12, 1]) text(svg, x(L), m.t + h + 13, `${L} h`, { "text-anchor": L === 48 ? "start" : L === 1 ? "end" : "middle" });
  text(svg, m.l + w, m.t + h + 26, "how far ahead the run was made", { "text-anchor": "end" });
  text(svg, m.l, m.t - 5, "kt", { "text-anchor": "start" });
  if (Number.isFinite(ref)) {
    const okBand = band.filter((d) => Number.isFinite(d.e));
    const top = okBand.map((d) => `${x(d.L).toFixed(1)},${y(ref + d.e).toFixed(1)}`);
    const bot = okBand.map((d) => `${x(d.L).toFixed(1)},${y(Math.max(0, ref - d.e)).toFixed(1)}`).reverse();
    path(svg, `M${top.join("L")}L${bot.join("L")}Z`, `fill: ${C.mid}; fill-opacity: 0.16; stroke: none`);
    path(svg, `M${top.join("L")}`, `fill: none; stroke: ${C.mid}; stroke-dasharray: 4 3; stroke-width: 1`);
    path(svg, `M${bot.slice().reverse().join("L")}`, `fill: none; stroke: ${C.mid}; stroke-dasharray: 4 3; stroke-width: 1`);
  }
  if (haveObs) {
    line(svg, m.l, y(oT), m.l + w, y(oT), `stroke: ${C.now}; stroke-width: 2.2`);
    text(svg, m.l + w, y(oT) - 5, `observed ${oT.toFixed(0)} kt`, { "text-anchor": "end", class: "val" });
  } else {
    text(svg, m.l + 6, m.t + 14, "no observation yet", { class: "note" });
  }
  if (forT.length > 1) path(svg, "M" + forT.map((p) => `${x(p.L).toFixed(1)},${y(p.v).toFixed(1)}`).join("L"), `fill: none; stroke: ${C.mid}; stroke-width: 1; stroke-opacity: 0.7`);
  for (const p of forT) {
    const c = el("circle", { cx: x(p.L), cy: y(p.v), r: 3.4, style: `fill: ${ramp((p.L - 1) / (maxL - 1))}; stroke: ${C.bg}; stroke-width: 1` });
    const tt = el("title", {});
    tt.textContent = `${p.L} h out: ${p.v.toFixed(1)} kt`;
    c.append(tt);
    svg.append(c);
  }
  $("conv-panel-note").textContent = Number.isFinite(ref)
    ? `Dots: each run, darker for shorter leads. Shaded: ${haveObs ? "the observation" : "the latest run"} plus or minus the typical speed error at ${NAMES[b]} for each lead time, from the archive.`
    : "No run covers this hour.";
}

// ---------- Section 4: forecast speed bins ----------

const BANDS: [string, string][] = [
  ["1-3", "1 to 3 h"],
  ["6-12", "6 to 12 h"],
  ["18-24", "18 to 24 h"],
  ["36-48", "36 to 48 h"],
];
const SPD = ["0-5", "5-10", "10-15", "15-20", "20-25", "25+"];
const spdLabel = (k: string) => (k === "25+" ? "25 kt or more" : k === "0-5" ? "under 5 kt" : `${k.replace("-", " to ")} kt`);
let calBand = "18-24";

function drawCal(): void {
  const bins = V.bins[calBand]?.fspeed ?? {};
  const rows = SPD.filter((k) => bins[k] && bins[k]!.n > 0).map((k) => {
    const s = bins[k]!;
    return { k, s, f: s.forecast_mean, o: s.forecast_mean - s.bias };
  });
  const box = $("cal-chart");
  const H = narrow() ? 280 : 300;
  const { svg, W } = frame(box, H, "Observed wind against HRRR forecast wind, by forecast speed");
  const m = { t: 22, r: 14, b: 34, l: 34 };
  const w = W - m.l - m.r;
  const h = H - m.t - m.b;
  const top = Math.max(30, ...rows.map((r) => Math.max(r.f, r.o))) + 2;
  const tk = ticks(0, top, narrow() ? 3 : 6);
  const x = (v: number) => m.l + (v / tk.hi) * w;
  const y = (v: number) => m.t + h - (v / tk.hi) * h;
  for (const v of tk.vals) {
    line(svg, m.l, y(v), m.l + w, y(v), v === 0 ? AXIS : GRID);
    text(svg, m.l - 5, y(v) + 3, tickText(v, tk.step), { "text-anchor": "end" });
    if (v > 0) text(svg, x(v), m.t + h + 13, tickText(v, tk.step), { "text-anchor": "middle" });
  }
  text(svg, m.l + w, m.t + h + 28, "HRRR forecast, kt at 10 m", { "text-anchor": "end" });
  text(svg, m.l - 28, m.t - 9, "Observed at the buoys, kt at 10 m", { class: "lab" });
  // Perfect agreement, as a reference in the page's ink.
  line(svg, x(0), y(0), x(tk.hi), y(tk.hi), `stroke: ${C.ink}; stroke-opacity: 0.45; stroke-dasharray: 3 4`);
  text(svg, x(tk.hi * 0.9) - 6, y(tk.hi * 0.9) - 6, "forecast = observed", { "text-anchor": "end" });
  const maxN = Math.max(...rows.map((r) => r.s.n));
  for (const r of rows) {
    line(svg, x(r.f), y(r.f), x(r.f), y(r.o), `stroke: ${C.mid}; stroke-width: 2`);
    const rad = 3 + 6 * Math.sqrt(r.s.n / maxN);
    const c = el("circle", { cx: x(r.f), cy: y(r.o), r: rad, style: `fill: ${C.now}; stroke: ${C.bg}; stroke-width: 1` });
    const tt = el("title", {});
    tt.textContent = `HRRR ${spdLabel(r.k)} (mean ${r.f.toFixed(1)} kt): buoys ${r.o.toFixed(1)} kt at 10 m, ${r.s.n.toLocaleString("en-US")} hours`;
    c.append(tt);
    svg.append(c);
    // Above the diagonal (buoys saw more): the label over the dot; below it: to the right, clear of the stem.
    if (r.o >= r.f) text(svg, x(r.f), y(r.o) - rad - 5, `${signed(-r.s.bias)} kt`, { class: "val", "text-anchor": "middle" });
    else text(svg, x(r.f) + rad + 4, y(r.o) + 4, `${signed(-r.s.bias)} kt`, { class: "val" });
  }
  $("cal-legend").innerHTML =
    `<span><i style="background: var(--now)"></i>buoys' mean, raised to 10 m (size: number of hours)</span>` +
    `<span><i style="background: var(--fc-mid)"></i>gap from the forecast</span>` +
    `<span><i style="background: var(--ink); opacity: 0.45"></i>forecast = observed</span>`;

  const hi = rows[rows.length - 1];
  const lo = rows[0];
  const more = (s: Stats) => `${Math.abs(s.bias).toFixed(1)} kt ${s.bias > 0 ? "less" : "more"}`;
  const label = BANDS.find((d) => d[0] === calBand)![1];
  // Does the overstatement of strong wind grow with lead time?
  const hiBias = (band: string) => V.bins[band]?.fspeed?.[hi.k]?.bias ?? NaN;
  const grows = hiBias("36-48") > hiBias("1-3") + 0.3;
  let verdict = "";
  if (hi.s.bias > 0.5 && lo.s.bias < -0.5) verdict = grows ? " The gap grows with lead time." : "";
  $("cal-say").innerHTML =
    `${label} ahead: HRRR <b>${spdLabel(hi.k)}</b>, buoys <b>${more(hi.s)}</b>; HRRR <b>${spdLabel(lo.k)}</b>, buoys <b>${more(lo.s)}</b>.${verdict}`;
}

// ---------- Section 5: error by lead time ----------

const MEASURES: Record<string, { label: string; unit: string; mae: keyof Stats; bias: keyof Stats; n: keyof Stats }> = {
  speed: { label: "Speed", unit: "kt", mae: "mae", bias: "bias", n: "n" },
  dir: { label: "Direction", unit: "deg", mae: "dir_mae", bias: "dir_bias", n: "dir_n" },
  air: { label: "Air temp", unit: "°C", mae: "air_mae", bias: "air_bias", n: "air_n" },
  pres: { label: "Pressure", unit: "mb", mae: "pressure_mae", bias: "pressure_bias", n: "pressure_n" },
};
let leadVar = "speed";
let leadBuoy = "all";

function drawLead(): void {
  const mz = MEASURES[leadVar];
  const rows = V.leads
    .map((L) => {
      const g = V.by_lead[String(L)];
      return { L, s: leadBuoy === "all" ? g?.all : g?.buoys[leadBuoy] };
    })
    .filter((r): r is { L: number; s: Stats } => !!r.s && (r.s[mz.n] as number) > 0);
  const box = $("lead-chart");
  const H = narrow() ? 230 : 250;
  const { svg, W } = frame(box, H, `Typical error and bias by lead time: ${mz.label}`);
  if (!rows.length) {
    text(svg, 10, 40, "No data for this choice", { class: "note" });
    return;
  }
  const m = { t: 24, r: 12, b: 32, l: 36 };
  const w = W - m.l - m.r;
  const h = H - m.t - m.b;
  const mae = (s: Stats) => s[mz.mae] as number;
  const bias = (s: Stats) => s[mz.bias] as number;
  const vals = rows.flatMap((r) => [mae(r.s), bias(r.s)]);
  const tk = ticks(Math.min(0, ...vals), Math.max(...vals) * 1.08, 4);
  const x = (i: number) => m.l + ((i + 0.5) / rows.length) * w;
  const y = (v: number) => m.t + h - ((v - tk.lo) / (tk.hi - tk.lo)) * h;
  for (const v of tk.vals) {
    line(svg, m.l, y(v), m.l + w, y(v), Math.abs(v) < 1e-9 ? ZERO : GRID);
    text(svg, m.l - 5, y(v) + 3, tickText(v, tk.step), { "text-anchor": "end" });
  }
  rows.forEach((r, i) => text(svg, x(i), m.t + h + 14, `${r.L}`, { "text-anchor": "middle" }));
  text(svg, m.l + w, m.t + h + 28, "hours ahead", { "text-anchor": "end" });
  text(svg, m.l - 30, m.t - 10, `${mz.label}, ${mz.unit}`, { class: "lab" });
  const d = (f: (s: Stats) => number) => "M" + rows.map((r, i) => `${x(i).toFixed(1)},${y(f(r.s)).toFixed(1)}`).join("L");
  path(svg, d(bias), `fill: none; stroke: ${C.mid}; stroke-width: 1.6; stroke-dasharray: 5 4`);
  path(svg, d(mae), `fill: none; stroke: ${C.strong}; stroke-width: 2.2`);
  rows.forEach((r, i) => {
    svg.append(el("circle", { cx: x(i), cy: y(bias(r.s)), r: 2.4, style: `fill: ${C.mid}` }));
    const c = el("circle", { cx: x(i), cy: y(mae(r.s)), r: 3.4, style: `fill: ${C.strong}; stroke: ${C.bg}; stroke-width: 1` });
    const tt = el("title", {});
    tt.textContent = `${r.L} h ahead: typical error ${mae(r.s).toFixed(1)} ${mz.unit}, bias ${signed(bias(r.s))} ${mz.unit} (${(r.s[mz.n] as number).toLocaleString("en-US")} hours)`;
    c.append(tt);
    svg.append(c);
  });
  $("lead-legend").innerHTML =
    `<span><i style="background: var(--fc-strong)"></i>typical error (mean absolute)</span>` +
    `<span><i style="background: var(--fc-mid)"></i>bias, dashed (HRRR minus buoy)</span>` +
    `<span><i style="background: var(--chart-zero)"></i>zero</span>`;
  const a = rows[0];
  const z = rows[rows.length - 1];
  const what = { speed: "speed", dir: "direction", air: "air temperature", pres: "pressure" }[leadVar];
  const why =
    leadVar === "speed" || leadVar === "dir"
      ? ""
      : "";
  $("lead-say").innerHTML =
    `${NAMES[leadBuoy]}, typical ${what} error: <b>${mae(a.s).toFixed(1)} ${mz.unit}</b> at ${a.L} h, <b>${mae(z.s).toFixed(1)} ${mz.unit}</b> at ${z.L} h.${why}`;
}

// ---------- Section 6: the last 30 days ----------

let cardBand = "1-3";
const CARD_LO = 1.5;
const CARD_HI = 5.5;

/** A day counts in the report card once it holds this many forecast-observation pairs (about 6 hours at 3 leads),
 * so a day cut short by an outage does not stand as a bad day. */
const CARD_MIN_PAIRS = 18;

function drawCard(): void {
  const days = V.recent.days;
  const band = V.recent.bands[cardBand] ?? {};
  const box = $("card-chart");
  const nar = narrow();
  const rowH = nar ? 22 : 26;
  const m = { t: 6, r: 4, b: 22, l: nar ? 44 : 120 };
  const H = m.t + BUOYS.length * rowH + m.b;
  const { svg, W } = frame(box, H, `Daily typical speed error at each buoy, last ${days.length} days`);
  const w = W - m.l - m.r;
  const cw = w / days.length;
  const gap = Math.max(1, Math.min(3, cw * 0.12));
  let worst: { b: string; d: string; s: Stats } | null = null;
  BUOYS.forEach((b, j) => {
    const y0 = m.t + j * rowH;
    text(svg, m.l - 8, y0 + rowH / 2 + 3, nar ? b : NAMES[b], { "text-anchor": "end" });
    (band[b] ?? []).forEach((s, i) => {
      const x0 = m.l + i * cw;
      const ok = !!s && s.n >= CARD_MIN_PAIRS;
      const t = ok ? 0.12 + 0.88 * ((s!.mae - CARD_LO) / (CARD_HI - CARD_LO)) : 0;
      const r = el("rect", {
        x: x0 + gap / 2, y: y0 + 2, width: Math.max(1, cw - gap), height: rowH - 4, rx: 1.5,
        style: ok ? `fill: ${mix(C.bg, C.strong, Math.max(0.12, Math.min(1, t)))}` : "fill: none; stroke: var(--rule)",
      });
      const tt = el("title", {});
      const day = fmtDayUtc.format(new Date(days[i] + "T12:00:00Z"));
      tt.textContent = ok
        ? `${NAMES[b]}, ${day}: typical error ${s!.mae.toFixed(1)} kt, bias ${signed(s!.bias)} kt (${s!.n} forecast hours)`
        : `${NAMES[b]}, ${day}: too few matched hours`;
      r.append(tt);
      svg.append(r);
      if (ok && (!worst || s!.mae > worst.s.mae)) worst = { b, d: day, s: s! };
    });
  });
  const every = nar ? 10 : 5;
  days.forEach((d, i) => {
    if (i % every) return;
    text(svg, m.l + i * cw + cw / 2, H - 6, fmtDayUtc.format(new Date(d + "T12:00:00Z")), { "text-anchor": i === 0 ? "start" : "middle" });
  });
  const steps = [1.5, 2.5, 3.5, 4.5, 5.5];
  $("card-key").innerHTML =
    `<span>typical speed error, kt:</span>` +
    steps
      .map((v) => `<span><i class="sq" style="background:${mix(C.bg, C.strong, 0.12 + 0.88 * ((v - CARD_LO) / (CARD_HI - CARD_LO)))}"></i>${v === 5.5 ? "5.5+" : v.toFixed(1)}</span>`)
      .join("") +
    `<span><i class="sq" style="border: 1px solid var(--rule)"></i>no data</span>`;
  const label = BANDS.find((d) => d[0] === cardBand)?.[1] ?? cardBand;
  const w0 = worst as { b: string; d: string; s: Stats } | null;
  $("card-say").innerHTML =
    `Typical speed error per day, ${label.replace(" h", " hours")} ahead; stronger colour, worse day.` +
    (w0 ? ` Worst: <b>${NAMES[w0.b]}, ${w0.d}, ${w0.s.mae.toFixed(1)} kt</b>.` : "");
}

// ---------- Section 7: method ----------

function drawMethod(): void {
  const from = fmtDate.format(new Date(V.first_valid));
  const to = fmtDate.format(new Date(V.through));
  const items: [string, string][] = [
    ["Compared", `Every archived run, ${from} to ${to}, against the buoy's hourly mean. Error is forecast minus observed; typical error is the mean absolute error.`],
    ["Height", `Buoy wind raised to 10 m (x${FACTOR.toFixed(3)}: 3.8 m anemometer assumed, neutral profile). In stable air the true factor is larger.`],
    ["Direction", "Observed wind 6 kt or more; buoy directions turned to true north; positive is clockwise."],
    ["Raw model", "As issued, uncorrected. A 3 km cell and a point buoy differ, which sets a floor on the error."],
    ["Why HRRR", "Why not ECMWF or GFS? HRRR is NOAA's 3 km model, run every hour, for the next 18 to 48 hours. Global models such as ECMWF and GFS reach further ahead on coarser grids (about 9 to 25 km); across a Sound 5 to 34 km wide that is one or two cells. For the next day or two at the water's edge, the finer grid matters. We will add the global models with their own measured errors at the buoys."],
    ["Other models", `<a href="/long-island-sound/models/">Wind models compared</a>`],
    ["Sources", `NOAA High-Resolution Rapid Refresh (HRRR), read at the buoys with forcingkit; buoy observations from <a href="https://lisicos.uconn.edu/">LISICOS</a>, University of Connecticut. Times are Eastern. Verification updated ${fmtFull.format(new Date(V.generated_at))}.`],
  ];
  $("method").innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

// ---------- Theme ----------

function wireTheme(redraw: () => void): void {
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

// ---------- Boot ----------

async function getJson<T>(name: string): Promise<T | null> {
  try {
    const r = await fetch(`${DATA}/${name}.json`, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function drawAll(): void {
  readColours();
  drawIntro();
  drawConv();
  drawCal();
  drawLead();
  drawCard();
}

async function main(): Promise<void> {
  readColours();
  const [v, h, l] = await Promise.all([getJson<Verification>("forecast-verification"), getJson<Hrrr>("forecast-hrrr"), getJson<Live>("live")]);
  if (!v) {
    const e = $("load-error");
    e.hidden = false;
    e.innerHTML = "<b>The forecast archive could not be loaded.</b> Please try again in a few minutes.";
    $("lede").textContent = "";
    return;
  }
  V = v;
  HR = h;
  LIVE = l;
  const f = /x\s*([\d.]+)/.exec(V.method.speed_at_10m ?? "");
  if (f) FACTOR = Number(f[1]);

  tabs($("cal-band"), BANDS, calBand, (k) => {
    calBand = k;
    drawCal();
  });
  tabs($("lead-var"), Object.entries(MEASURES).map(([k, m]) => [k, m.label]), leadVar, (k) => {
    leadVar = k;
    drawLead();
  });
  tabs($("lead-buoy"), [["all", "All"], ...BUOYS.map((b): [string, string] => [b, b])], leadBuoy, (k) => {
    leadBuoy = k;
    drawLead();
  });
  const cardBands = BANDS.filter(([k]) => V.recent.bands[k]);
  if (!cardBands.some(([k]) => k === cardBand) && cardBands.length) cardBand = cardBands[0][0];
  tabs($("card-band"), cardBands, cardBand, (k) => {
    cardBand = k;
    drawCard();
  });
  setupConv();
  drawMethod();
  drawAll();
  wireTheme(drawAll);

  let lastW = window.innerWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastW) return; // phones fire resize as the address bar moves
    lastW = window.innerWidth;
    clearTimeout(timer);
    timer = window.setTimeout(drawAll, 150);
  });
}

void main();

// The NWS advisories in force on the Sound, in the masthead (links to the Wind view).
const mastEl = document.querySelector(".mast");
if (mastEl) void mountAdvisories(mastEl);
