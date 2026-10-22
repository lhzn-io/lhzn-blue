/**
 * Measured currents (a current profiler's own readings): a gilded ramp, so measurements never share a colour with
 * a model's currents (the teal currents ramp). Gold is the site's colour for observations (the "now" line, the live
 * pin's rim); this ramp runs from the page ground to deep gilt on the light theme and from dark bronze to the brand
 * yellow on the dark one, lightness monotonic in both. One fixed linear scale, 0 to MEASURED_TOP m/s;
 * never rescaled.
 */
export const MEASURED_TOP = 0.5; // m/s: the buoy reads 0.1 to 0.25 m/s most hours, 0.4 m/s at most so far
export const MEASURED_RAMP: readonly string[] = ["#f7f0d8", "#ead28a", "#d0a930", "#a37b00", "#5f4600"];
export const MEASURED_RAMP_DARK: readonly string[] = ["#2b2410", "#5e4b10", "#9c7c0c", "#d6b30a", "#fde047"];

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The colour of a measured speed (m/s) on the light or dark theme. */
export function measuredColour(ms: number, light: boolean): string {
  const ramp = light ? MEASURED_RAMP : MEASURED_RAMP_DARK;
  const f = Math.min(1, Math.max(0, ms / MEASURED_TOP)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(f));
  const a = rgb(ramp[i]);
  const b = rgb(ramp[i + 1]);
  const t = f - i;
  return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * t)).join(",")})`;
}
