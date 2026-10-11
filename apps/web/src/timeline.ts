/** The page's "as of" time: one cursor for the map's fields and every chart. Two scales: hours (24h back to 72h
 * ahead, for the currents forecast) and days (the last 90 days, for the satellite history). Left of now is measured
 * or analysed; right of now is forecast only. The cursor is kept as hours from now, so "+5h" stays five hours ahead
 * as the clock moves; 0 is live now. */

export type ScaleKind = "hours" | "days";

interface Scale {
  past: number; // hours back
  ahead: number; // hours ahead
  step: number; // hours per step
  tick: number; // hours between small ticks
  playMs: number; // milliseconds per step when playing
}

const SCALES: Record<ScaleKind, Scale> = {
  hours: { past: 24, ahead: 72, step: 1, tick: 6, playMs: 450 },
  days: { past: 89 * 24, ahead: 0, step: 24, tick: 7 * 24, playMs: 220 },
};

let scale: ScaleKind = "hours";
let offset = 0; // hours from now
let playing = 0;
let bar: HTMLElement | null = null;
const listeners = new Set<(t: number | null) => void>();

const fmtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric" });

/** Epoch seconds of the cursor, or null when it is at now. */
export function asOf(): number | null {
  return offset === 0 ? null : Math.round(Date.now() / 3.6e6 + offset) * 3600;
}

export function onAsOf(fn: (t: number | null) => void): void {
  listeners.add(fn);
}

function set(h: number): void {
  const s = SCALES[scale];
  offset = Math.max(-s.past, Math.min(s.ahead, Math.round(h / s.step) * s.step));
  sync();
  const t = asOf();
  listeners.forEach((fn) => fn(t));
}

/** Switch between the hours scale (currents, no layer) and the days scale (satellite history). The cursor keeps
 * its time where the new scale holds it, and is clamped otherwise. */
export function setScale(kind: ScaleKind): void {
  if (kind === scale) return;
  stop();
  scale = kind;
  if (bar) build();
  set(offset);
}

const ICON_PLAY = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor"/></svg>`;

function label(): string {
  if (offset === 0) return "Now";
  const t = new Date((asOf() ?? 0) * 1000);
  if (scale === "days") return `${fmtDay.format(t)}, ${Math.round(-offset / 24)}d ago`;
  const when = fmtWhen.format(t);
  return offset < 0 ? `${when}, ${-offset}h ago` : `${when}, in ${offset}h, forecast`;
}

function sync(): void {
  if (!bar) return;
  const range = bar.querySelector<HTMLInputElement>(".tl-range")!;
  range.value = String(offset);
  range.setAttribute("aria-valuetext", offset === 0 ? "now" : label());
  bar.querySelector<HTMLElement>(".tl-label")!.innerHTML = label();
  bar.querySelector<HTMLButtonElement>(".tl-now")!.hidden = offset === 0;
  bar.classList.toggle("ahead", offset > 0);
  const play = bar.querySelector<HTMLButtonElement>(".tl-play")!;
  play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  play.title = playing ? "Pause" : "Play";
  play.setAttribute("aria-label", play.title);
}

function stop(): void {
  window.clearInterval(playing);
  playing = 0;
  sync();
}

/** Play forward a step at a time to the end of the scale, then wrap to its start. */
function play(): void {
  const s = SCALES[scale];
  playing = window.setInterval(() => set(offset >= s.ahead ? -s.past : offset + s.step), s.playMs);
  sync();
}

/** Ticks: on the hours scale every 6h, taller at each local midnight; on the days scale every week, taller at each
 * month's first day. The forecast's ticks are fainter. */
function ticks(): string {
  const s = SCALES[scale];
  const span = s.past + s.ahead;
  const now = Math.round(Date.now() / 3.6e6);
  const out: string[] = [];
  for (let h = -s.past; h <= s.ahead; h += scale === "days" ? 24 : 1) {
    const t = new Date((now + h) * 3.6e6);
    let kind: string | null;
    if (h === 0) kind = "now";
    else if (scale === "days") kind = fmtDate.format(t) === "1" ? "day" : (-h / 24) % 7 === 0 ? "hour" : null;
    else {
      const etHour = Number(fmtHour.format(t)) % 24;
      kind = etHour === 0 ? "day" : etHour % s.tick === 0 ? "hour" : null;
    }
    if (kind) out.push(`<i class="tl-tick ${kind}${h > 0 ? " ahead" : ""}" style="left:${(100 * (h + s.past)) / span}%"></i>`);
  }
  return out.join("");
}

function build(): void {
  const s = SCALES[scale];
  bar!.style.setProperty("--tl-now", `${(100 * s.past) / (s.past + s.ahead)}%`);
  bar!.dataset.scale = scale;
  bar!.querySelector<HTMLElement>(".tl-ticks")!.innerHTML = ticks();
  const range = bar!.querySelector<HTMLInputElement>(".tl-range")!;
  range.min = String(-s.past);
  range.max = String(s.ahead);
  range.step = String(s.step);
  range.setAttribute("aria-label", scale === "days" ? "Days back" : "Hours from now");
}

/** A hairline along the bottom of the map, drawn on the map itself: play, the line (past solid, forecast dotted,
 * with ticks), a needle for the time, the time, and Now. No accent colour, so it does not pull the eye from the map. */
export function mountTimeline(box: HTMLElement): void {
  if (bar) return;
  bar = document.createElement("div");
  bar.className = "timeline";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Time for the map and charts");
  bar.innerHTML = `<button type="button" class="tl-play"></button>
    <div class="tl-track"><span class="tl-ticks" aria-hidden="true"></span><input class="tl-range" type="range" value="0"></div>
    <span class="tl-label" aria-live="polite"></span><button type="button" class="tl-now" hidden>now</button>`;
  box.appendChild(bar);
  build();
  const range = bar.querySelector<HTMLInputElement>(".tl-range")!;
  range.addEventListener("input", () => {
    if (playing) stop();
    set(Number(range.value));
  });
  bar.querySelector<HTMLButtonElement>(".tl-play")!.addEventListener("click", () => (playing ? stop() : play()));
  bar.querySelector<HTMLButtonElement>(".tl-now")!.addEventListener("click", () => {
    stop();
    set(0);
  });
  // The label names a clock time, so refresh it as the hour turns.
  window.setInterval(() => offset !== 0 && sync(), 60_000);
  sync();
}
