/**
 * The moon's principal phases (new, first quarter, full, last quarter), computed in the page: Meeus, Astronomical
 * Algorithms (2nd ed.), chapter 49, with the periodic terms down to 0.0002 days and without the planetary arguments,
 * which keeps the times within a few minutes. For the time bar's dates; spring tides follow new and full moon by a day
 * or two, neaps the quarters.
 */
export type MoonPhase = "new" | "first" | "full" | "last";
export interface MoonEvent {
  phase: MoonPhase;
  t: number; // epoch seconds
}

const PHASES: MoonPhase[] = ["new", "first", "full", "last"];
const rad = (deg: number) => (deg * Math.PI) / 180;
const DELTA_T = 69; // seconds of Terrestrial Time ahead of UTC (ΔT), near enough for the 2020s

/** The time of the phase of lunation k (k a whole number, plus 0, 0.25, 0.5 or 0.75), epoch seconds. */
function phaseTime(k: number): number {
  const T = k / 1236.85;
  const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T ** 2 - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T ** 2;
  const M = rad(2.5534 + 29.1053567 * k - 0.0000014 * T ** 2 - 0.00000011 * T ** 3);
  const Mp = rad(201.5643 + 385.81693528 * k + 0.0107582 * T ** 2 + 0.00001238 * T ** 3 - 0.000000058 * T ** 4);
  const F = rad(160.7108 + 390.67050284 * k - 0.0016118 * T ** 2 - 0.00000227 * T ** 3 + 0.000000011 * T ** 4);
  const O = rad(124.7746 - 1.56375588 * k + 0.0020672 * T ** 2 + 0.00000215 * T ** 3);
  const s = Math.sin;
  const q = ((k % 1) + 1) % 1;
  let c: number;
  if (q === 0 || q === 0.5) {
    const full = q === 0.5;
    c =
      (full ? -0.40614 : -0.4072) * s(Mp) + (full ? 0.17302 : 0.17241) * E * s(M) + (full ? 0.01614 : 0.01608) * s(2 * Mp) +
      (full ? 0.01043 : 0.01039) * s(2 * F) + (full ? 0.00734 : 0.00739) * E * s(Mp - M) - (full ? 0.00515 : 0.00514) * E * s(Mp + M) +
      (full ? 0.00209 : 0.00208) * E * E * s(2 * M) - 0.00111 * s(Mp - 2 * F) - 0.00057 * s(Mp + 2 * F) + 0.00056 * E * s(2 * Mp + M) -
      0.00042 * s(3 * Mp) + 0.00042 * E * s(M + 2 * F) + 0.00038 * E * s(M - 2 * F) - 0.00024 * E * s(2 * Mp - M) - 0.00017 * s(O);
  } else {
    const W = 0.00306 - 0.00038 * E * Math.cos(M) + 0.00026 * Math.cos(Mp) - 0.00002 * Math.cos(Mp - M) + 0.00002 * Math.cos(Mp + M) + 0.00002 * Math.cos(2 * F);
    c =
      -0.62801 * s(Mp) + 0.17172 * E * s(M) - 0.01183 * E * s(Mp + M) + 0.00862 * s(2 * Mp) + 0.00804 * s(2 * F) + 0.00454 * E * s(Mp - M) +
      0.00204 * E * E * s(2 * M) - 0.0018 * s(Mp - 2 * F) - 0.0007 * s(Mp + 2 * F) - 0.0004 * s(3 * Mp) - 0.00034 * E * s(2 * Mp - M) +
      0.00032 * E * s(M + 2 * F) + 0.00032 * E * s(M - 2 * F) - 0.00028 * E * E * s(Mp + 2 * M) + 0.00027 * E * s(2 * Mp + M) - 0.00017 * s(O) +
      (q === 0.25 ? W : -W);
  }
  return (jde + c - 2440587.5) * 86400 - DELTA_T; // Julian ephemeris day to epoch seconds, UTC
}

/** The principal phases between t0 and t1 (epoch seconds), in order. */
export function moonPhases(t0: number, t1: number): MoonEvent[] {
  const k0 = Math.floor((t0 / 86400 + 2440587.5 - 2451550.09766) / 29.530588861) - 1;
  const out: MoonEvent[] = [];
  for (let k = k0; ; k++) {
    for (let i = 0; i < 4; i++) {
      const t = phaseTime(k + i / 4);
      if (t > t1) return out;
      if (t >= t0) out.push({ phase: PHASES[i], t });
    }
  }
}

/** A small moon in outline, with its lit part (class "lit") and its dark part ("dark") as shapes; the stylesheet fills
 * one of them for the theme (the dark part on a light page, as tide tables draw it; the lit part on a dark page). The
 * first quarter is lit on the right, the last on the left, as seen from the north. */
export function moonGlyph(phase: MoonPhase, size = 8): string {
  const r = 3.4;
  const disc = `M0,-${r}A${r},${r} 0 1,1 0,${r}A${r},${r} 0 1,1 0,-${r}Z`;
  const left = `M0,-${r}A${r},${r} 0 0,0 0,${r}Z`;
  const right = `M0,-${r}A${r},${r} 0 0,1 0,${r}Z`;
  const [lit, dark] = phase === "full" ? [disc, ""] : phase === "new" ? ["", disc] : phase === "first" ? [right, left] : [left, right];
  return (
    `<svg class="moon" viewBox="-4 -4 8 8" width="${size}" height="${size}" aria-hidden="true">` +
    `${lit ? `<path class="lit" d="${lit}"/>` : ""}${dark ? `<path class="dark" d="${dark}"/>` : ""}` +
    `<circle r="${r}" fill="none" stroke="currentColor" stroke-width="0.8"/></svg>`
  );
}