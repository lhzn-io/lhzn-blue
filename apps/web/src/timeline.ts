/** The page's "as of" time: one cursor for the map's fields and every chart, shown below the map in two rows.
 *
 * The detail row is the map's window: hours (24h back to 72h ahead, for the currents forecast and no layer) or days
 * (the last 90, for the satellite history), with a needle for the time and a shaded band for the span the frame on
 * the map covers (a 7-day composite, a day, a 2h model step). Directly below it, a fixed context row spans the whole
 * horizon the page considers, 90 days back to 72h ahead, on a compressed scale (now at 78%, so the forecast stays
 * readable), with the detail window bracketed on it. Past solid, forecast dotted; no accent colour.
 * The cursor is kept as hours from now, so "+5h" stays five hours ahead as the clock moves; 0 is live now. */

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
const CONTEXT = { past: 90 * 24, ahead: 72 };
const NOW_AT = 0.78; // where now sits on the context row

let scale: ScaleKind = "hours";
let offset = 0; // hours from now
let frame = { back: 0, ahead: 0 }; // the span the map's frame covers, in hours around the cursor
let playing = 0;
let root: HTMLElement | null = null;
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
  if (root) build();
  set(offset);
}

/** The span the map's frame covers, in hours before and after the cursor (0, 0: none drawn). */
export function setFrame(back: number, ahead: number): void {
  frame = { back, ahead };
  sync();
}

const ICON_PLAY = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor"/></svg>`;

function label(): string {
  if (offset === 0) return "now";
  const t = new Date((asOf() ?? 0) * 1000);
  if (scale === "days") return `${fmtDay.format(t)}, ${Math.round(-offset / 24)}d ago`;
  const when = fmtWhen.format(t);
  return offset < 0 ? `${when}, ${-offset}h ago` : `${when}, in ${offset}h`;
}

const pct = (f: number) => `${(100 * Math.max(0, Math.min(1, f))).toFixed(3)}%`;
/** Position on the detail row (0..1) of an offset in hours. */
const dx = (h: number) => {
  const s = SCALES[scale];
  return (h + s.past) / (s.past + s.ahead);
};
/** Position on the context row (0..1): compressed, with now at NOW_AT. */
const cx = (h: number) => (h <= 0 ? NOW_AT * (1 + h / CONTEXT.past) : NOW_AT + (1 - NOW_AT) * (h / CONTEXT.ahead));

function sync(): void {
  if (!root) return;
  const s = SCALES[scale];
  const range = root.querySelector<HTMLInputElement>(".tl-range")!;
  range.value = String(offset);
  range.setAttribute("aria-valuetext", label());
  root.querySelector<HTMLElement>(".tl-label")!.textContent = label();
  root.querySelector<HTMLButtonElement>(".tl-now")!.hidden = offset === 0;
  const f0 = Math.max(-s.past, offset - frame.back);
  const f1 = Math.min(s.ahead, offset + frame.ahead);
  const band = root.querySelector<HTMLElement>(".tl-frame")!;
  band.hidden = f1 <= f0;
  band.style.left = pct(dx(f0));
  band.style.width = pct(dx(f1) - dx(f0));
  root.querySelector<HTMLElement>(".tl-needle")!.style.left = pct(dx(offset));
  root.querySelector<HTMLElement>(".tl-cneedle")!.style.left = pct(cx(offset));
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
 * first day. The forecast's are fainter. */
function detailTicks(): string {
  const s = SCALES[scale];
  const now = Math.round(Date.now() / 3.6e6);
  const out: string[] = [];
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
  // The context row: the whole horizon, with the detail window bracketed.
  const marks: [number, string][] = [[-90 * 24, "90d"], [-60 * 24, "60d"], [-30 * 24, "30d"], [0, "now"], [72, "+72h"]];
  root!.querySelector<HTMLElement>(".tl-ctrack")!.innerHTML =
    `<i class="tl-cline" style="left:0;width:${pct(cx(0))}"></i><i class="tl-cline ahead" style="left:${pct(cx(0))};right:0"></i>` +
    `<i class="tl-bracket" style="left:${pct(cx(-s.past))};width:${pct(cx(s.ahead) - cx(-s.past))}"></i>` +
    `<i class="tl-tick now" style="left:${pct(cx(0))}"></i><i class="tl-cneedle"></i>` +
    marks.map(([h, t], i) => `<span class="tl-mark${i === 0 ? " first" : i === marks.length - 1 ? " last" : ""}" style="left:${pct(cx(h))}">${t}</span>`).join("");
}

/** The time rows, below the map: play, the detail row with its label in a fixed slot, then the context row. */
export function mountTimeline(box: HTMLElement): void {
  if (root) return;
  root = document.createElement("div");
  root.className = "timeline";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Time for the map and charts");
  root.innerHTML = `<div class="tl-row"><button type="button" class="tl-play"></button>
      <div class="tl-track"><span class="tl-ticks" aria-hidden="true"></span><i class="tl-frame" aria-hidden="true"></i><i class="tl-needle" aria-hidden="true"></i>
        <input class="tl-range" type="range" value="0"></div>
      <span class="tl-slot"><span class="tl-label" aria-live="polite"></span><button type="button" class="tl-now" hidden>now</button></span></div>
    <div class="tl-row tl-context" aria-hidden="true"><span></span><div class="tl-ctrack"></div><span class="tl-slot"></span></div>`;
  box.appendChild(root);
  build();
  const range = root.querySelector<HTMLInputElement>(".tl-range")!;
  range.addEventListener("input", () => {
    if (playing) stop();
    set(Number(range.value));
  });
  root.querySelector<HTMLButtonElement>(".tl-play")!.addEventListener("click", () => (playing ? stop() : play()));
  root.querySelector<HTMLButtonElement>(".tl-now")!.addEventListener("click", () => {
    stop();
    set(0);
  });
  // The label names a clock time, so refresh it as the hour turns.
  window.setInterval(() => offset !== 0 && sync(), 60_000);
  sync();
}
