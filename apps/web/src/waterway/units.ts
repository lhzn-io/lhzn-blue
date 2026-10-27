/** Speed units for wind and currents, and the wave height that goes with them: data arrive in knots (wind), cm/s
 * (currents) and metres (waves); the reader picks how they are shown, one choice across the site (remembered in this
 * browser only). Read `WU` live; change it with `setUnit`. */

export const WIND_UNITS = {
  kt: { factor: 1, label: "kt", name: "knots", digits: 0 },
  mph: { factor: 1.150779, label: "mph", name: "miles per hour", digits: 0 },
  ms: { factor: 0.514444, label: "m/s", name: "metres per second", digits: 1 },
} as const;
export type WindUnit = keyof typeof WIND_UNITS;

export let WU: WindUnit = "kt";
try {
  const saved = localStorage.getItem("lhzn-blue-wind-unit");
  if (saved && saved in WIND_UNITS) WU = saved as WindUnit;
} catch {
  /* private mode: knots */
}

/** The reader's choice (knots for anything unknown), remembered where the browser allows. */
export function setUnit(u: string | undefined): void {
  WU = u && u in WIND_UNITS ? (u as WindUnit) : "kt";
  try {
    localStorage.setItem("lhzn-blue-wind-unit", WU);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

export const windVal = (kt: number) => kt * WIND_UNITS[WU].factor;
export const windFmt = (kt: number | null | undefined) =>
  kt == null || !Number.isFinite(kt) ? "--" : windVal(kt).toFixed(WIND_UNITS[WU].digits);
/** The current speed unit for currents (stored in cm/s): 1 cm/s is 0.0194384 kt. */
export const currentSpeed = () => ({ label: WIND_UNITS[WU].label, perCms: 0.0194384 * WIND_UNITS[WU].factor, digits: 1 });
export const waveUnit = () => (WU === "ms" ? { label: "m", factor: 1, digits: 2 } : { label: "ft", factor: 3.28084, digits: 1 });
export const waveFmt = (m: number | null | undefined) => (m == null || !Number.isFinite(m) ? "--" : (m * waveUnit().factor).toFixed(waveUnit().digits));
