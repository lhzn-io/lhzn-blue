/** The time a waterway page shows: null for now (the latest readings), else the time bar's time (epoch seconds). The
 * table, the pins and the readouts all read it, so they agree. Read `AT` live; the time bar's listener sets it. */
import { DAY, grid, type Hourly } from "../series";
import { span } from "./format";
import { zoned } from "../dst";

export let AT: number | null = null;
export function setAt(t: number | null): void {
  AT = t;
}
export const atFuture = () => AT != null && AT * 1000 > Date.now();

const fmtAtWhen = zoned(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" }));
/** "Tue 3 PM, 5h ago" or "Thu 9 AM, in 1d". */
export function atLabel(t: number): string {
  const ms = t * 1000;
  return `${fmtAtWhen.format(new Date(ms)).replace(",", "")}, ${ms < Date.now() ? `${span(ms, Date.now())} ago` : `in ${span(Date.now(), ms)}`}`;
}

/**
 * The last 7 days of an hourly series as a tiny line, scaled to its own week's range: the vertical exaggeration makes
 * a 1-degree swing visible. The range is in the tooltip, so the shape is never read as an absolute value. A tick
 * marks the page's time where the week covers it.
 */
export function sparklineOf(h: Hourly, color: string, unit: string, digits = 1): string {
  const end = h.lastValid();
  const xs = grid(end - 7 * DAY, end, 170);
  const ys = xs.map((t) => h.at(t));
  const ok = ys.filter((v) => Number.isFinite(v));
  if (ok.length < 2) return "";
  const lo = Math.min(...ok);
  const hi = Math.max(...ok);
  const W = 64;
  const H = 16;
  let path = "";
  let pen = false;
  ys.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = (i / (xs.length - 1)) * W;
    const y = H - 1 - ((v - lo) / Math.max(0.2, hi - lo)) * (H - 2);
    path += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  const title = `last 7 days: ${lo.toFixed(digits)} to ${hi.toFixed(digits)} ${unit} (scaled to this range)`;
  const mx = AT != null && AT >= xs[0] && AT <= xs[xs.length - 1] ? ((AT - xs[0]) / (xs[xs.length - 1] - xs[0])) * W : NaN;
  const tick = Number.isFinite(mx) ? `<line x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="0" y2="${H}" stroke="currentColor" stroke-width="1" opacity="0.55"/>` : "";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}"><title>${title}</title><path d="${path}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/>${tick}</svg>`;
}
