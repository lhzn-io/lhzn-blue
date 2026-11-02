/** Wind direction, shown the same way on every page: compass names, a small downwind arrow for readouts, and the
 * row of arrows along the top of the wind charts (chart.ts `glyphs`).
 *
 * Directions arrive as the meteorological convention, degrees the wind blows FROM, clockwise from true north. The
 * arrows point the other way, downwind, the way a flag streams and the way the water is pushed.
 */
import type { Glyph } from "./chart";

const HOUR = 3600;
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** Degrees as a 16-point compass name. */
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Under this the direction is loose (a light wind wanders): its arrow is drawn faint. */
export const LIGHT_KT = 3;

/** A fine arrow pointing up (north) in a -6..6 box: a full-length shaft, so the tail reads as a tail, and a small open
 * head at the tip. Stroked, not filled. */
export const ARROW_PATH = "M0 5.5 V-5.5 M-2.3 -2.8 L0 -5.5 L2.3 -2.8";
const SHAFT = "M0 5.5 V-5.5";
const HEAD = "M-2.3 -2.8 L0 -5.5 L2.3 -2.8";

/** The arrow drawn in the current colour, rotated to `deg` (clockwise from north); `width` in box units. A dashed
 * shaft marks a model value standing in where there is no observation (the head stays solid, so it still points). */
export const arrowMarkup = (deg: number, width = 1.1, dashed = false) => {
  const pen = `fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
  return dashed
    ? `<g transform="rotate(${deg.toFixed(0)})"><path d="${SHAFT}" ${pen} stroke-dasharray="2 1.6" stroke-linecap="butt"/><path d="${HEAD}" ${pen}/></g>`
    : `<path transform="rotate(${deg.toFixed(0)})" d="${ARROW_PATH}" ${pen}/>`;
};

/** A small arrow pointing downwind, with the compass point the wind comes from, for a readout. */
export function windArrow(fromDeg: number, faint = false): string {
  const to = (fromDeg + 180) % 360;
  return `<svg class="wind-arrow${faint ? " faint" : ""}" viewBox="-6 -6 12 12" width="12" height="12" role="img" aria-label="from ${compass(fromDeg)}"><title>from ${compass(fromDeg)} (${Math.round(fromDeg)}°), blowing toward ${compass(to)}</title>${arrowMarkup(to)}</svg>`;
}

/** The wind at an hour, for an arrow: degrees it blows from, speed in knots (for the faint light-wind arrows), the
 * arrow's colour (measured and forecast differ), and whether it is a model value standing in for a missing
 * observation (a dashed shaft). */
export interface WindAt {
  from: number;
  kt: number;
  color: string;
  dashed?: boolean;
}

/** One arrow per whole hour from x0 to x1 where the direction is known (the chart thins them to fit its width). */
export function windGlyphs(x0: number, x1: number, at: (t: number) => WindAt | null): Glyph[] {
  const out: Glyph[] = [];
  for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= x1; t += HOUR) {
    const w = at(t);
    if (!w || !Number.isFinite(w.from)) continue;
    out.push({
      x: t,
      deg: (w.from + 180) % 360,
      color: w.color,
      faint: Number.isFinite(w.kt) && w.kt < LIGHT_KT,
      dashed: w.dashed,
      title: `from ${compass(w.from)} (${Math.round(w.from)}°)${w.dashed ? ", model" : ""}`,
    });
  }
  return out;
}

/** A measured direction, or else (where `fill` gives one) a model's, dashed. */
export function measuredOr(from: number, kt: number, color: string, fill: () => WindAt | null): WindAt | null {
  if (Number.isFinite(from)) return { from, kt, color };
  const m = fill();
  return m ? { ...m, dashed: true } : null;
}
