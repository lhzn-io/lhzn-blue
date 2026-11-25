/**
 * Median dual cells of a triangle mesh's nodes: for each node, the polygon through the centroids of the triangles
 * around it and the midpoints of its edges. A node-centred model (NECOFS's waves, for one) holds each value over this
 * cell, so drawing it shows the model's own resolution with no interpolation.
 *
 * `lon`, `lat`: node coordinates; `tri`: three node indices per triangle. Returns one closed ring per node (empty for a
 * node no triangle uses). A node on the mesh's edge (a coast or the subset's edge) gets a partial cell that runs from
 * one edge midpoint round to the other and back through the node itself.
 */
export type Ring = [number, number][];

export function dualCells(lon: ArrayLike<number>, lat: ArrayLike<number>, tri: ArrayLike<number>): Ring[] {
  const n = lon.length;
  const nt = Math.floor(tri.length / 3);
  // Edge use counts: an edge in one triangle only is on the mesh's edge.
  const edgeUse = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const key = ek(tri[3 * t + k], tri[3 * t + ((k + 1) % 3)]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  // Per node: its corner points (keyed, so a midpoint shared by two triangles appears once) and whether it is on the edge.
  const pts: Map<number, [number, number]>[] = Array.from({ length: n }, () => new Map());
  const onEdge = new Uint8Array(n);
  for (let t = 0; t < nt; t++) {
    const v = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
    const cx = (lon[v[0]] + lon[v[1]] + lon[v[2]]) / 3;
    const cy = (lat[v[0]] + lat[v[1]] + lat[v[2]]) / 3;
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const cell = pts[a];
      cell.set(-1 - t, [cx, cy]); // centroids keyed negative, midpoints by edge
      for (const b of [v[(k + 1) % 3], v[(k + 2) % 3]]) {
        const key = ek(a, b);
        if (!cell.has(key)) cell.set(key, [(lon[a] + lon[b]) / 2, (lat[a] + lat[b]) / 2]);
        if (edgeUse.get(key) === 1) onEdge[a] = 1;
      }
    }
  }
  const out: Ring[] = [];
  for (let i = 0; i < n; i++) {
    const cell = [...pts[i].values()];
    if (!cell.length) {
      out.push([]);
      continue;
    }
    const k = Math.cos((lat[i] * Math.PI) / 180);
    const ang = (p: [number, number]) => Math.atan2(p[1] - lat[i], (p[0] - lon[i]) * k);
    cell.sort((p, q) => ang(p) - ang(q));
    let ring: Ring = cell;
    if (onEdge[i]) {
      // Start after the widest angular gap (the side with no triangle), and close through the node.
      let gap = -1;
      let at = 0;
      for (let j = 0; j < cell.length; j++) {
        const a = ang(cell[j]);
        const b = j + 1 < cell.length ? ang(cell[j + 1]) : ang(cell[0]) + 2 * Math.PI;
        if (b - a > gap) {
          gap = b - a;
          at = j + 1;
        }
      }
      ring = [...cell.slice(at), ...cell.slice(0, at), [lon[i], lat[i]]];
    }
    out.push([...ring, ring[0]]);
  }
  return out;
}

/** Arrow thinning levels for scattered points, as the jobs' arrow_levels: at level k, each cell of size base / 2**k
 * gives one point that has no level yet; the rest take the last level. */
export function pointLevels(lon: ArrayLike<number>, lat: ArrayLike<number>, base = 0.16, levels = 4): number[] {
  const n = lon.length;
  const lvl = new Array<number>(n).fill(levels);
  for (let k = 0; k < levels; k++) {
    const size = base / 2 ** k;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (lvl[i] !== levels) continue;
      const key = `${Math.floor(lon[i] / size)},${Math.floor(lat[i] / size)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lvl[i] = k;
    }
  }
  return lvl;
}
