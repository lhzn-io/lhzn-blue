/** The page's "as of" time: one cursor for the map's fields and every chart, shown across the top of a waterway page,
 * above the map and the table.
 *
 * The row is the view's window: hours (a day or two weeks back to 72h ahead, for the forecast and the currents) or
 * days (the last 90, for the satellite history), with a needle for the time and a shaded band for the span the frame
 * on the map covers (a 7-day composite, a day, a 2h model step). Its dates are under it, the moon's phases over it.
 * Past solid, forecast dotted; no accent colour.
 * The cursor is kept as hours from now, so "+5h" stays five hours ahead as the clock moves; 0 is live now. */

import { moonGlyph, moonPhases } from "./moon";

export type ScaleKind = "hours" | "days";

interface Scale {
  past: number; // hours back
  ahead: number; // hours ahead
  step: number; // hours per step
  playMs: number; // milliseconds per step when playing
}

const SCALES: Record<ScaleKind, Scale> = {
  hours: { past: 24, ahead: 72, step: 1, playMs: 450 },
  days: { past: 89 * 24, ahead: 0, step: 24, playMs: 220 },
};

let scale: ScaleKind = "hours";
let offset = 0; // hours from now
let frame = { back: 0, ahead: 0 }; // the span the map's frame covers, in hours around the cursor
let playing = 0;
let root: HTMLElement | null = null;
const listeners = new Set<(t: number | null) => void>();
const builders = new Set<() => void>(); // rows that share the detail row's scale, redrawn when it changes

const fmtClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" });
const fmtFull = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric" });
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric" });
const fmtWeekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
const fmtMonth = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short" });

/** Epoch seconds of the cursor, or null when it is at now. */
export function asOf(): number | null {
  return offset === 0 ? null : Math.round(Date.now() / 3.6e6 + offset) * 3600;
}

export function onAsOf(fn: (t: number | null) => void): void {
  listeners.add(fn);
}

/** The detail row's window: its scale and its first and last hour (epoch seconds), for rows drawn on the same scale. */
export function detailWindow(): { scale: ScaleKind; t0: number; t1: number } {
  const s = SCALES[scale];
  const now = Math.round(Date.now() / 3.6e6) * 3600;
  return { scale, t0: now - s.past * 3600, t1: now + s.ahead * 3600 };
}

/** Call fn whenever the detail row is rebuilt (a new scale or reach), and once now if the row exists. */
export function onBuild(fn: () => void): void {
  builders.add(fn);
  if (root) fn();
}

/** The time rows' element, for a row placed with them (under the time row). */
export function timelineRoot(): HTMLElement | null {
  return root;
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
  if (root) build();
  set(offset);
}

/** How far back the hours scale reaches: two weeks in the Wind view (its strip spans them), a day elsewhere. */
export function setHoursBack(h: number): void {
  if (SCALES.hours.past === h) return;
  SCALES.hours.past = h;
  if (scale !== "hours") return;
  if (root) build();
  set(offset);
}

/** The cursor and its scale, for links ("-6h", "-30d"). */
export function position(): { offset: number; scale: ScaleKind } {
  return { offset, scale };
}

/** Move the cursor (hours from now), clamped to the current scale: a link opening the page at a time. */
export function setOffset(h: number): void {
  set(h);
}

/** The span the map's frame covers, in hours before and after the cursor (0, 0: none drawn). */
export function setFrame(back: number, ahead: number): void {
  frame = { back, ahead };
  sync();
}

const ICON_PLAY = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor"/></svg>`;

/** The time, short: the clock hour and how far from now, signed ("10 PM −13.7d", "7 PM +5h"); the date is on the
 * track beneath. With the weekday where the time is the page's only statement of it (a plot page): "Thu 7 PM +5h".
 * On the days scale, the date ("Oct 15 −13d"). */
let weekday = false;
export function showWeekday(on: boolean): void {
  weekday = on;
  sync();
}
function label(): string {
  if (offset === 0) return "now";
  const t = new Date((asOf() ?? 0) * 1000);
  const sign = offset < 0 ? "−" : "+";
  if (scale === "days") return `${fmtDay.format(t)} ${sign}${Math.round(Math.abs(offset) / 24)}d`;
  const h = Math.abs(offset);
  return `${weekday ? `${fmtWeekday.format(t)} ` : ""}${fmtClock.format(t)} ${sign}${h < 48 ? `${h}h` : `${(h / 24).toFixed(1)}d`}`;
}

/** The time in full, for screen readers and the label's hover text: "Wed, Oct 15, 10 PM, 13.7 days ago". */
function fullLabel(): string {
  if (offset === 0) return "now";
  const t = new Date((asOf() ?? 0) * 1000);
  const h = Math.abs(offset);
  const far = scale === "days" || h >= 48 ? `${(h / 24).toFixed(scale === "days" ? 0 : 1)} days` : `${h} hours`;
  return `${(scale === "days" ? fmtDay : fmtFull).format(t)}, ${offset < 0 ? `${far} ago` : `in ${far}`}`;
}

const pct = (f: number) => `${(100 * Math.max(0, Math.min(1, f))).toFixed(3)}%`;
/** Position on the detail row (0..1) of an offset in hours. */
const dx = (h: number) => {
  const s = SCALES[scale];
  return (h + s.past) / (s.past + s.ahead);
};

function sync(): void {
  if (!root) return;
  const s = SCALES[scale];
  const range = root.querySelector<HTMLInputElement>(".tl-range")!;
  range.value = String(offset);
  range.setAttribute("aria-valuetext", fullLabel());
  const lab = root.querySelector<HTMLElement>(".tl-label")!;
  lab.textContent = label();
  lab.title = fullLabel();
  root.querySelector<HTMLButtonElement>(".tl-now")!.hidden = offset === 0;
  const unit = scale === "days" ? "d" : "h";
  root.querySelectorAll<HTMLButtonElement>(".tl-step").forEach((b) => {
    const back = b.dataset.dir === "-1";
    b.textContent = `${back ? "\u2212" : "+"}${s.step === 24 ? 1 : s.step}${unit}`;
    b.setAttribute("aria-label", `${back ? "Back" : "Ahead"} one ${scale === "days" ? "day" : "hour"}`);
    b.disabled = back ? offset <= -s.past : offset >= s.ahead;
  });
  const f0 = Math.max(-s.past, offset - frame.back);
  const f1 = Math.min(s.ahead, offset + frame.ahead);
  const band = root.querySelector<HTMLElement>(".tl-frame")!;
  band.hidden = f1 <= f0;
  band.style.left = pct(dx(f0));
  band.style.width = pct(dx(f1) - dx(f0));
  root.querySelector<HTMLElement>(".tl-needle")!.style.left = pct(dx(offset));
  root.querySelector<HTMLElement>(".tl-knob")!.style.left = pct(dx(offset));
  const play = root.querySelector<HTMLButtonElement>(".tl-play")!;
  play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  play.title = playing ? "Pause" : "Play";
  play.setAttribute("aria-label", play.title);
}

function stop(): void {
  window.clearInterval(playing);
  playing = 0;
  sync();
}

/** Play forward a step at a time to the end of the window, then wrap to its start. */
function play(): void {
  const s = SCALES[scale];
  playing = window.setInterval(() => set(offset >= s.ahead ? -s.past : offset + s.step), s.playMs);
  sync();
}

/** Detail ticks: hours scale every 6h, taller at each local midnight; days scale every week, taller at each month's
 * first day. The forecast's are fainter. Under the ticks, in the track's lower half (no added height), small day
 * labels: weekdays over a few days, day numbers over two weeks (the month on the 1st), months and weeks over 90 days.
 * The moon's principal phases along the track's top edge, each at its own time, clear of the dates (so a phone's
 * thinned dates never seem to carry the wrong day's moon). */
function detailTicks(): string {
  const s = SCALES[scale];
  const now = Math.round(Date.now() / 3.6e6);
  const out: string[] = [];
  const days = (s.past + s.ahead) / 24;
  let first = true; // the leftmost label carries its month, so every date on the row can be read
  const mon = (t: Date) => `<b class="tl-mon">${fmtMonth.format(t)}</b> `;
  const label = (h: number, t: Date, text: string) => {
    out.push(`<span class="tl-dlabel${h > 0 ? " ahead" : ""}" style="left:${pct(dx(h))}">${first && !text.includes("tl-mon") ? mon(t) : ""}${text}</span>`);
    first = false;
  };
  for (const p of moonPhases((now - s.past) * 3600, (now + s.ahead) * 3600)) {
    const h = p.t / 3600 - now;
    out.push(`<i class="tl-moon${h > 0 ? " ahead" : ""}" data-phase="${p.phase}" style="left:${pct(dx(h))}">${moonGlyph(p.phase, 7)}</i>`);
  }
  for (let h = -s.past; h <= s.ahead; h += scale === "days" ? 24 : 1) {
    const t = new Date((now + h) * 3.6e6);
    let kind: string | null;
    if (h === 0) kind = "now";
    else if (scale === "days") kind = fmtDate.format(t) === "1" ? "day" : (-h / 24) % 7 === 0 ? "hour" : null;
    else {
      const etHour = Number(fmtHour.format(t)) % 24;
      kind = etHour === 0 ? "day" : etHour % 6 === 0 ? "hour" : null;
    }
    if (kind) out.push(`<i class="tl-tick ${kind}${h > 0 ? " ahead" : ""}" style="left:${pct(dx(h))}"></i>`);
    // Labels sit just right of their midnight (the day they name follows it); none on "now", which has its own mark.
    if (h === 0 || dx(h) > 0.97) continue; // a label at the right edge would be cut off
    if (scale === "days") {
      if (fmtDate.format(t) === "1") label(h, t, `<b class="tl-mon">${fmtMonth.format(t)}</b>`);
      else if ((-h / 24) % 7 === 0 && Number(fmtDate.format(t)) > 4) label(h, t, fmtDate.format(t));
    } else if (Number(fmtHour.format(t)) % 24 === 0) {
      const d = fmtDate.format(t);
      // A new month reads "Nov 1" in place; a few-day window names weekdays, with the month on the first.
      label(h, t, days <= 5 ? (d === "1" ? `${mon(t)}${fmtWeekday.format(t)}` : fmtWeekday.format(t)) : d === "1" ? `${mon(t)}1` : d);
    }
  }
  return out.join("");
}

function build(): void {
  const s = SCALES[scale];
  const detail = root!.querySelector<HTMLElement>(".tl-track")!;
  detail.style.setProperty("--tl-now", pct(dx(0)));
  root!.querySelector<HTMLElement>(".tl-ticks")!.innerHTML = detailTicks();
  const range = root!.querySelector<HTMLInputElement>(".tl-range")!;
  range.min = String(-s.past);
  range.max = String(s.ahead);
  range.step = String(s.step);
  range.setAttribute("aria-label", scale === "days" ? "Days back" : "Hours from now");
  builders.forEach((fn) => fn());
}

/** The time row: play, the track with its dates, and the time with its steps in a fixed slot. */
export function mountTimeline(box: HTMLElement): void {
  if (root) return;
  root = document.createElement("div");
  root.className = "timeline";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Time for the map and charts");
  root.innerHTML = `<div class="tl-row"><button type="button" class="tl-play"></button>
      <div class="tl-track"><span class="tl-ticks" aria-hidden="true"></span><i class="tl-frame" aria-hidden="true"></i><i class="tl-needle" aria-hidden="true"></i><i class="tl-knob" aria-hidden="true"></i>
        <input class="tl-range" type="range" value="0"></div>
      <span class="tl-slot"><button type="button" class="tl-step" data-dir="-1"></button><button type="button" class="tl-step" data-dir="1"></button><span class="tl-label" aria-live="polite"></span><button type="button" class="tl-now" hidden>now</button></span></div>`;
  box.appendChild(root);
  build();
  const range = root.querySelector<HTMLInputElement>(".tl-range")!;
  range.addEventListener("input", () => {
    if (playing) stop();
    set(Number(range.value));
  });
  root.querySelector<HTMLButtonElement>(".tl-play")!.addEventListener("click", () => (playing ? stop() : play()));
  root.querySelectorAll<HTMLButtonElement>(".tl-step").forEach((b) =>
    b.addEventListener("click", () => {
      if (playing) stop();
      set(offset + Number(b.dataset.dir) * SCALES[scale].step);
    }),
  );
  root.querySelector<HTMLButtonElement>(".tl-now")!.addEventListener("click", () => {
    stop();
    set(0);
  });
  // The label names a clock time, so refresh it as the hour turns.
  window.setInterval(() => offset !== 0 && sync(), 60_000);
  sync();
}
