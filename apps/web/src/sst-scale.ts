/**
 * The sea surface temperature scale: one fixed scale all year, linear from 1.5 to 25.5 C (about the 0.5th to 99.5th
 * percentile of 2022 to 2026 MUR over the map's water) with compressed tails out to -2 and 28 C, so routine days use
 * the core and the deepest and brightest colours stay for outlier days. Thermal hues (cmocean, Thyng et al. 2016) at
 * the same lightness, with the salmon-orange step moved to rose so fall water never reads as the advisory brick.
 * Interpolate linearly in temperature between stops; clamp outside.
 */
export const SST_STOPS: [number, string][] = [
  [-2, "#172034"], [-1, "#16233c"], [0, "#142648"], [1, "#122a59"], [2, "#132e6d"], [2.5, "#173078"], [3, "#1d3182"],
  [3.5, "#24328c"], [4, "#2d3395"], [4.5, "#393594"], [5, "#433794"], [5.5, "#4b3994"], [6, "#533b93"], [6.5, "#5a3d93"],
  [7, "#614093"], [7.5, "#674292"], [8, "#6c4592"], [8.5, "#724892"], [9, "#794a91"], [9.5, "#814b90"], [10, "#894d8e"],
  [10.5, "#904e8c"], [11, "#97518a"], [11.5, "#9d5389"], [12, "#a35687"], [12.5, "#a85985"], [13, "#ad5c84"],
  [13.5, "#b15f82"], [14, "#b66284"], [14.5, "#bb6485"], [15, "#bf6787"], [15.5, "#c46a88"], [16, "#c96c89"],
  [16.5, "#ce6f8b"], [17, "#d2728c"], [17.5, "#d7758d"], [18, "#dc788e"], [18.5, "#e27b8c"], [19, "#e87f85"],
  [19.5, "#ed847f"], [20, "#f18b78"], [20.5, "#f29171"], [21, "#f3996c"], [21.5, "#f2a166"], [22, "#efa962"],
  [22.5, "#ebb25f"], [23, "#e6bb5e"], [23.5, "#e7c15d"], [24, "#e9c75c"], [24.5, "#ebcd5b"], [25, "#ecd45a"],
  [26, "#ece159"], [27, "#ebee59"], [28, "#e8fa5b"],
];

/** Spacing of the isotherms drawn over the SST layer, C. */
export const SST_ISOTHERM_STEP = 1;

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The colour of a value on a [value, hex] stop list, interpolated linearly in the value and clamped at the ends. */
export function stopColour(stops: [number, string][], v: number): [number, number, number] {
  if (v <= stops[0][0]) return rgb(stops[0][1]) as [number, number, number];
  for (let k = 1; k < stops.length; k++) {
    const [v1, c1] = stops[k];
    if (v <= v1) {
      const [v0, c0] = stops[k - 1];
      const f = (v - v0) / (v1 - v0 || 1);
      const a = rgb(c0);
      const b = rgb(c1);
      return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * f)) as [number, number, number];
    }
  }
  return rgb(stops[stops.length - 1][1]) as [number, number, number];
}

/**
 * Isotherms of a regular grid by marching squares: line segments, in lon/lat, at every multiple of `step` the field
 * crosses. Values sit at cell centres (lon0 + i dlon, lat0 + j dlat), rows from the south; squares with a missing
 * corner (land, gaps) are skipped, so lines end at the coast.
 */
export function isotherms(
  values: Float32Array | number[],
  grid: { lon0: number; lat0: number; dlon: number; dlat: number; nx: number; ny: number },
  step: number,
): { level: number; segs: [number, number][][] }[] {
  const { lon0, lat0, dlon, dlat, nx, ny } = grid;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) if (Number.isFinite(v)) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  if (!Number.isFinite(lo)) return [];
  const out: { level: number; segs: [number, number][][] }[] = [];
  const at = (i: number, j: number) => values[j * nx + i];
  for (let level = Math.ceil(lo / step) * step; level <= hi; level += step) {
    const segs: [number, number][][] = [];
    // Corners a (i,j), b (i+1,j), c (i+1,j+1), d (i,j+1); the crossing on an edge is interpolated linearly.
    const cross = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): [number, number] => {
      const f = (level - v0) / (v1 - v0);
      return [lon0 + (x0 + (x1 - x0) * f) * dlon, lat0 + (y0 + (y1 - y0) * f) * dlat];
    };
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
        const k = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
        if (k === 0 || k === 15) continue;
        const ab = () => cross(i, j, a, i + 1, j, b);
        const bc = () => cross(i + 1, j, b, i + 1, j + 1, c);
        const cd = () => cross(i + 1, j + 1, c, i, j + 1, d);
        const da = () => cross(i, j + 1, d, i, j, a);
        switch (k) {
          case 1: case 14: segs.push([da(), ab()]); break;
          case 2: case 13: segs.push([ab(), bc()]); break;
          case 3: case 12: segs.push([da(), bc()]); break;
          case 4: case 11: segs.push([bc(), cd()]); break;
          case 6: case 9: segs.push([ab(), cd()]); break;
          case 7: case 8: segs.push([cd(), da()]); break;
          case 5: segs.push([da(), ab()], [bc(), cd()]); break; // saddles: one fixed pairing
          case 10: segs.push([ab(), bc()], [cd(), da()]); break;
        }
      }
    }
    if (segs.length) out.push({ level, segs });
  }
  return out;
}
