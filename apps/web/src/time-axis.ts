/** The site's time track: the line, ticks, dates and moon phases of the time bar (timeline.ts), shared with the
 * sliders on the forecast, models, tides and Portsmouth Harbor pages, so every time control reads the same way.
 *
 * Past solid, ahead dotted, with a mark at now. Ticks at each local midnight, with finer ones every 6 hours, over a
 * month or less; a tick a week (taller on each 1st) over a season; one a month over a longer record. Under the ticks,
 * in the track's lower half, small day labels: weekday and day number over a few days ("Thu 29"), day numbers over
 * weeks, months beyond; the month on each 1st and on the leftmost label. The moon's principal phases along the top
 * edge, each at its own time (spring tides follow new and full moon by a day or two). */

import { moonGlyph, moonPhases } from "./moon";

const TZ = "America/New_York";
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" });
const fmtWeekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
const fmtMonth = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" });
const fmtYear = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" });
const HOUR = 3600;
const DAY = 24 * HOUR;

export const pct = (f: number) => `${(100 * Math.max(0, Math.min(1, f))).toFixed(3)}%`;

const ICON_PLAY = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor"/></svg>`;

/** A play button's face and name for its state, the same on every page. */
export function setPlayButton(b: HTMLElement, playing: boolean): void {
  b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  b.title = playing ? "Pause" : "Play";
  b.setAttribute("aria-label", b.title);
  b.setAttribute("aria-pressed", String(playing));
}

/** The track's ticks, day labels and moons for [t0, t1] (epoch seconds), as positioned HTML. `now` splits the past
 * from what is ahead (fainter) and is marked where it falls in the span. */
export function axisHtml(t0: number, t1: number, now = Date.now() / 1000): string {
  if (!(t1 > t0)) return "";
  const x = (t: number) => (t - t0) / (t1 - t0);
  const ahead = (t: number) => (t > now + 60 ? " ahead" : "");
  const atNow = (t: number) => Math.abs(t - now) < HOUR / 2; // "now" has its own mark
  const room = (t: number) => x(t) <= 0.97; // a label at the right edge would be cut off
  const days = (t1 - t0) / DAY;
  const out: string[] = [];
  let first = true;
  const mon = (d: Date) => `<b class="tl-mon">${fmtMonth.format(d)}</b> `;
  const tick = (t: number, kind: string) => out.push(`<i class="tl-tick ${kind}${ahead(t)}" style="left:${pct(x(t))}"></i>`);
  // Labels sit just right of their tick (the day they name follows its midnight).
  const label = (t: number, text: string) => {
    if (!room(t)) return;
    const d = new Date(t * 1000);
    out.push(`<span class="tl-dlabel${ahead(t)}" style="left:${pct(x(t))}">${first && !text.includes("tl-mon") ? mon(d) : ""}${text}</span>`);
    first = false;
  };
  // Moons over a season at most; across a longer record they would be a row of dots.
  if (days <= 120)
    for (const p of moonPhases(t0, t1))
      out.push(`<i class="tl-moon${ahead(p.t)}" data-phase="${p.phase}" style="left:${pct(x(p.t))}">${moonGlyph(p.phase, 7)}</i>`);
  if (now >= t0 && now <= t1) tick(now, "now");
  if (days <= 30) {
    for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
      const d = new Date(t * 1000);
      const h = Number(fmtHour.format(d)) % 24;
      if (h % 6 !== 0 || atNow(t)) continue;
      tick(t, h === 0 ? "day" : "hour");
      if (h !== 0) continue;
      const n = fmtDate.format(d);
      // The month with its day number: "Fri Oct 30" on the first label, "Sun Nov 1" on a 1st.
      const m = n === "1" || (first && days <= 5) ? mon(d) : "";
      label(t, days <= 5 ? `${fmtWeekday.format(d)} ${m}${n}` : `${m}${n}`);
    }
  } else if (days <= 120) {
    // A day at a time, counted in whole days back from the right end (the satellite history's days); weekly ticks
    // carry their day number, the 1st its month.
    for (let t = t1 - Math.floor((t1 - t0) / DAY) * DAY; t <= t1; t += DAY) {
      const d = new Date(t * 1000);
      const n = fmtDate.format(d);
      const weekly = Math.round((t1 - t) / DAY) % 7 === 0;
      if (atNow(t) || (n !== "1" && !weekly)) continue;
      tick(t, n === "1" ? "day" : "hour");
      if (n === "1") label(t, mon(d).trim());
      else if (Number(n) > 4) label(t, n);
    }
  } else {
    // A long record: a tick on each month's 1st, labelled with the month (the year in January, taller; the leftmost
    // label with its year too).
    for (let t = firstOfMonth(t0); t <= t1; t = firstOfMonth(t + 32 * DAY)) {
      if (t < t0) continue;
      const d = new Date(t * 1000);
      const jan = fmtMonth.format(d) === "Jan";
      tick(t, jan ? "day" : "hour");
      label(t, `<b class="tl-mon">${jan ? fmtYear.format(d) : first ? `${fmtMonth.format(d)} ${fmtYear.format(d)}` : fmtMonth.format(d)}</b>`);
    }
  }
  return out.join("");
}

/** Local midnight on the first of the month that holds t (epoch seconds). */
function firstOfMonth(t: number): number {
  const s = Math.round(t / HOUR) * HOUR - (Number(fmtDate.format(new Date(t * 1000))) - 1) * DAY;
  const h = Number(fmtHour.format(new Date(s * 1000))) % 24; // off midnight by the hours of the day, or a DST hour
  return s + (h >= 12 ? 24 - h : -h) * HOUR;
}

/** Dress a page's own range input as the site's time track: the line, ticks, dates and moons drawn behind it, the
 * needle and knob at its value. `timeOf` maps the input's values to epoch seconds (an index into the page's hours, or
 * the time itself). The page keeps its input and its listeners; setting the input's value, min or max (as the page
 * already does, from play, steps or new data) moves the needle or redraws the dates. */
export function timeTrack(input: HTMLInputElement, timeOf: (v: number) => number): { redraw: () => void } {
  const track = document.createElement("div");
  track.className = "tl-track time-track";
  input.replaceWith(track);
  track.innerHTML = `<span class="tl-ticks" aria-hidden="true"></span><i class="tl-needle" aria-hidden="true"></i><i class="tl-knob" aria-hidden="true"></i>`;
  input.classList.add("tl-range");
  track.append(input);
  const ticks = track.querySelector<HTMLElement>(".tl-ticks")!;
  const needle = track.querySelector<HTMLElement>(".tl-needle")!;
  const knob = track.querySelector<HTMLElement>(".tl-knob")!;
  const num = (s: string, d: number) => (s === "" || !Number.isFinite(Number(s)) ? d : Number(s));
  const span = () => ({ lo: num(input.min, 0), hi: num(input.max, 100) });
  const sync = () => {
    const { lo, hi } = span();
    const f = hi > lo ? (num(input.value, lo) - lo) / (hi - lo) : 0;
    needle.style.left = knob.style.left = pct(f);
  };
  // Dates that would run into the one before (a narrow phone, a long first label) are hidden, left to right.
  const thin = () => {
    let right = -Infinity;
    for (const s of ticks.querySelectorAll<HTMLElement>(".tl-dlabel")) {
      s.style.visibility = "";
      const r = s.getBoundingClientRect();
      if (r.width && r.left < right + 4) s.style.visibility = "hidden";
      else right = r.right;
    }
  };
  new ResizeObserver(thin).observe(track);
  void document.fonts?.ready.then(thin); // widths change once the mono face loads
  let drawn = "";
  const redraw = () => {
    const { lo, hi } = span();
    const t0 = timeOf(lo);
    const t1 = timeOf(hi);
    const now = Date.now() / 1000;
    const key = `${t0} ${t1} ${Math.floor(now / HOUR)}`;
    if (key !== drawn && Number.isFinite(t0) && Number.isFinite(t1)) {
      drawn = key;
      track.style.setProperty("--tl-now", pct(t1 > t0 ? (now - t0) / (t1 - t0) : 0));
      ticks.innerHTML = axisHtml(t0, t1, now);
      thin();
    }
    sync();
  };
  // The page sets value, min and max as it always has; the track follows (the input's own properties, wrapped).
  const proto = HTMLInputElement.prototype;
  for (const [prop, after] of [["value", sync], ["min", redraw], ["max", redraw]] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop)!;
    Object.defineProperty(input, prop, {
      configurable: true,
      get: () => desc.get!.call(input),
      set: (v: string) => {
        desc.set!.call(input, v);
        after();
      },
    });
  }
  input.addEventListener("input", sync);
  window.setInterval(redraw, 60_000); // "now" moves along the track as the clock turns
  redraw();
  return { redraw };
}
