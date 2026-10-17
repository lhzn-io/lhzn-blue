/**
 * The tidal current's phase, as a row under the time bar (Wind & waves): at one of four reference points along the
 * Sound, NECOFS's surface current along the flood axis as a light band (flood up, ebb down) and NOAA's tidal current
 * prediction as a thin line, with NOAA's slack times as ticks and the time bar's cursor through it. A switch picks
 * the point; the label slot reads the phase at the cursor. Data: /data/v1/current-phase.json (the jobs' phase.py).
 *
 * Each point keeps a fixed scale (the job's scale_kt), so the band never rescales as the cursor or the window moves.
 */
import { asOf, detailWindow, onAsOf, onBuild, timelineRoot } from "./timeline";

interface Series {
  t0: string;
  step: number;
  kt: (number | null)[];
}
interface PhasePoint {
  id: string;
  name: string;
  scale_kt: number;
  noaa: (Series & { station: string; flood_dir: number; events: { t: string; type: string; kt: number }[] }) | null;
  necofs: Series | null;
}
export interface PhaseFile {
  generated_at: string;
  points: PhasePoint[];
}

const SHORT: Record<string, string> = { race: "The Race", central: "Central", exrx: "Execution Rocks", throgs: "Throgs Neck" };
const STORE = "lhzn-blue-phase";
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

let file: PhaseFile | null = null;
let row: HTMLElement | null = null;
let visible = false;
let pick = (() => {
  try {
    return localStorage.getItem(STORE) ?? "race";
  } catch {
    return "race";
  }
})();
let unit = { label: "kt", perKt: 1, digits: 1 };

/** The value of a series at t (epoch seconds), linear between its steps; NaN outside it or across a gap. */
function at(s: Series | null, t: number): number {
  if (!s) return NaN;
  const f = (t - Date.parse(s.t0) / 1000) / s.step;
  const i = Math.floor(f);
  const a = s.kt[i];
  const b = s.kt[i + 1];
  if (a == null || i < 0) return NaN;
  if (f === i) return a;
  return b == null ? NaN : a + (b - a) * (f - i);
}

const current = () => file?.points.find((p) => p.id === pick) ?? file?.points[0] ?? null;

/** The band, the prediction line and the slack ticks across the time bar's window. */
function drawTrack(track: HTMLElement): void {
  const p = current();
  const { t0, t1, scale } = detailWindow();
  if (!p || scale !== "hours") {
    track.innerHTML = "";
    return;
  }
  const W = 1000;
  const H = 28;
  const mid = H / 2;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (kt: number) => mid - (Math.max(-p.scale_kt, Math.min(p.scale_kt, kt)) / p.scale_kt) * (mid - 2);
  // NECOFS: the filled band, broken at gaps.
  let band = "";
  const n = p.necofs;
  if (n) {
    const s0 = Date.parse(n.t0) / 1000;
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1) band += `M${run[0][0].toFixed(1)},${mid}` + run.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(2)}`).join("") + `L${run[run.length - 1][0].toFixed(1)},${mid}Z`;
      run = [];
    };
    n.kt.forEach((v, k) => {
      const t = s0 + k * n.step;
      if (v == null || t < t0 - n.step || t > t1 + n.step) return flush();
      run.push([x(t), y(v)]);
    });
    flush();
  }
  // NOAA: the prediction line and its slack ticks.
  let line = "";
  let ticks = "";
  const o = p.noaa;
  if (o) {
    const s0 = Date.parse(o.t0) / 1000;
    let pen = false;
    o.kt.forEach((v, k) => {
      const t = s0 + k * o.step;
      if (v == null || t < t0 - o.step || t > t1 + o.step) {
        pen = false;
        return;
      }
      line += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(2)}`;
      pen = true;
    });
    for (const e of o.events) {
      const t = Date.parse(e.t) / 1000;
      if (e.type === "slack" && t >= t0 && t <= t1) ticks += `M${x(t).toFixed(1)},${mid - 6}L${x(t).toFixed(1)},${mid + 6}`;
    }
  }
  const now = Math.round(Date.now() / 3.6e6) * 3600;
  const cur = asOf() ?? now;
  track.innerHTML =
    `<svg class="ph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="ph-zero"/>` +
    `<path d="${band}" class="ph-band"/><path d="${line}" class="ph-noaa"/><path d="${ticks}" class="ph-slack"/>` +
    `<line x1="${x(cur).toFixed(1)}" x2="${x(cur).toFixed(1)}" y1="0" y2="${H}" class="ph-cursor"/></svg>` +
    `<span class="ph-flood">flood</span><span class="ph-ebb">ebb</span>`;
}

/** The slot's reading at the cursor: NOAA's phase and next slack, and NECOFS's speed. */
function readout(): string {
  const p = current();
  if (!p) return "";
  const t = asOf() ?? Date.now() / 1000;
  const v = at(p.noaa, t);
  const ahead = at(p.noaa, t + 1800);
  const m = at(p.necofs, t);
  const sp = (kt: number) => `${(Math.abs(kt) * unit.perKt).toFixed(unit.digits)} ${unit.label}`;
  const parts: string[] = [];
  if (Number.isFinite(v)) {
    const phase = Math.abs(v) < 0.1 ? "slack" : `${v > 0 ? "flood" : "ebb"} ${sp(v)}, ${Math.abs(ahead) > Math.abs(v) ? "building" : "easing"}`;
    const next = p.noaa?.events.find((e) => e.type === "slack" && Date.parse(e.t) / 1000 > t + 600);
    parts.push(`NOAA ${phase}${next ? `; slack ${fmtTime.format(new Date(next.t))}` : ""}`);
  }
  if (Number.isFinite(m)) parts.push(`NECOFS ${Math.abs(m) < 0.1 ? "slack" : `${m > 0 ? "flood" : "ebb"} ${sp(m)}`}`);
  return parts.join(" &middot; ");
}

function render(): void {
  if (!row) return;
  const p = current();
  row.querySelector<HTMLElement>(".ph-pick")!.innerHTML = (file?.points ?? [])
    .map((q) => `<button type="button" data-id="${q.id}" aria-pressed="${q.id === p?.id}" title="${q.name}${q.noaa ? ` (NOAA ${q.noaa.station})` : ""}">${SHORT[q.id] ?? q.name}</button>`)
    .join("");
  row.querySelector<HTMLElement>(".ph-read")!.innerHTML = readout();
  drawTrack(row.querySelector<HTMLElement>(".ph-track")!);
}

function mount(): void {
  const root = timelineRoot();
  if (!root || row) return;
  row = document.createElement("div");
  row.className = "tl-row tl-phase";
  row.innerHTML =
    `<span class="tl-slot ph-slot"><span class="ph-title">Current at</span> <span class="ph-pick" role="group" aria-label="Reference point"></span>` +
    `<button type="button" class="ph-info" aria-label="About the current strip" title="About the current strip">i</button> <span class="ph-read"></span></span>` +
    `<span class="ph-gap"></span><div class="tl-track ph-track"></div>`;
  root.insertBefore(row, root.querySelector(".tl-context"));
  row.querySelector(".ph-pick")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
    if (!b) return;
    pick = b.dataset.id!;
    try {
      localStorage.setItem(STORE, pick);
    } catch {
      /* private mode: for this visit */
    }
    render();
  });
  row.querySelector(".ph-info")!.addEventListener("click", () => document.dispatchEvent(new CustomEvent("lhzn-about", { detail: { key: "current-phase" } })));
  onBuild(() => visible && render());
  onAsOf(() => visible && render());
}

/** Show the strip (Wind & waves, hours scale) with its data, or hide it; the reader's speed unit for its readout. */
export function setPhase(data: PhaseFile | null, show: boolean, speed?: { label: string; perKt: number; digits: number }): void {
  if (speed) unit = speed;
  file = data ?? file;
  mount();
  visible = show && !!file;
  if (row) row.hidden = !visible;
  if (visible) render();
}
