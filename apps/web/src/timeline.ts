/** The page's "as of" time: one cursor for the map's fields and every chart, from 24h back to 72h ahead.
 * Left of now is measured or analysed; right of now is forecast only. It is kept as hours from now, so "+5h"
 * stays five hours ahead as the clock moves; 0 is live now. */

export const PAST_H = 24;
export const AHEAD_H = 72;

let offset = 0; // hours from now
let playing = 0;
let bar: HTMLElement | null = null;
const listeners = new Set<(t: number | null) => void>();

const fmtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** Epoch seconds of the cursor, or null when it is at now. */
export function asOf(): number | null {
  return offset === 0 ? null : Math.round(Date.now() / 3.6e6 + offset) * 3600;
}

export function onAsOf(fn: (t: number | null) => void): void {
  listeners.add(fn);
}

function set(h: number): void {
  offset = Math.max(-PAST_H, Math.min(AHEAD_H, Math.round(h)));
  sync();
  const t = asOf();
  listeners.forEach((fn) => fn(t));
}

const ICON_PLAY = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor"/></svg>`;

function label(): string {
  if (offset === 0) return "Now";
  const when = fmtWhen.format(new Date((asOf() ?? 0) * 1000));
  return offset < 0 ? `${when}, ${-offset}h ago` : `${when}, in ${offset}h, forecast`;
}

function sync(): void {
  if (!bar) return;
  bar.querySelector<HTMLInputElement>(".tl-range")!.value = String(offset);
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

/** Play forward an hour at a time to the end of the forecast, then wrap to 24h back. */
function play(): void {
  playing = window.setInterval(() => set(offset >= AHEAD_H ? -PAST_H : offset + 1), 450);
  sync();
}

/** A hairline along the bottom of the map, drawn on the map itself: play, the line (past solid, forecast dotted, a
 * tick each 6h and a taller one at each day), a needle for the time, the time, and Now. No accent colour, so it
 * does not pull the eye from the map. */
export function mountTimeline(box: HTMLElement): void {
  if (bar) return;
  const nowPct = (100 * PAST_H) / (PAST_H + AHEAD_H);
  bar = document.createElement("div");
  bar.className = "timeline";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Time for the map and charts");
  bar.style.setProperty("--tl-now", `${nowPct}%`);
  // Ticks every 6h from now; each local midnight is taller, and the forecast's are fainter.
  const ticks: string[] = [];
  const now = Date.now() / 3.6e6;
  for (let h = -PAST_H; h <= AHEAD_H; h++) {
    const etHour = Number(fmtHour.format(new Date((Math.round(now) + h) * 3.6e6))) % 24;
    if (h !== 0 && etHour % 6 !== 0) continue;
    const kind = h === 0 ? "now" : etHour === 0 ? "day" : "hour";
    ticks.push(`<i class="tl-tick ${kind}${h > 0 ? " ahead" : ""}" style="left:${(100 * (h + PAST_H)) / (PAST_H + AHEAD_H)}%"></i>`);
  }
  bar.innerHTML = `<button type="button" class="tl-play"></button>
    <div class="tl-track"><span class="tl-ticks" aria-hidden="true">${ticks.join("")}</span><input class="tl-range" type="range" min="${-PAST_H}" max="${AHEAD_H}" step="1" value="0"
      aria-label="Hours from now" aria-valuetext="now"></div>
    <span class="tl-label" aria-live="polite"></span><button type="button" class="tl-now" hidden>now</button>`;
  box.appendChild(bar);
  const range = bar.querySelector<HTMLInputElement>(".tl-range")!;
  range.addEventListener("input", () => {
    if (playing) stop();
    set(Number(range.value));
    range.setAttribute("aria-valuetext", offset === 0 ? "now" : `${offset > 0 ? "+" : ""}${offset} hours`);
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
