/** Columnar frames, as the jobs write them: `{t0, step, <column>: values[]}` (an hourly or other regular grid). */

export interface Frame {
  t0: string | null;
  step: number;
  [col: string]: unknown;
}

/** Epoch seconds of an ISO time. */
export const sec = (iso: string) => Date.parse(iso) / 1000;

/** The value of a column at time t: the nearest step, within half a step; null outside the frame or in a gap. */
export function at(f: Frame | undefined, col: string, t: number): number | null {
  const v = f?.[col] as (number | null)[] | undefined;
  if (!f?.t0 || !v?.length) return null;
  const i = Math.round((t - sec(f.t0)) / f.step);
  return i >= 0 && i < v.length && v[i] != null ? (v[i] as number) : null;
}

/** A column on a chart's grid, NaN for gaps. */
export const series = (f: Frame | undefined, col: string, xs: number[], scale = 1) =>
  xs.map((t) => {
    const v = at(f, col, t);
    return v == null ? NaN : v * scale;
  });
