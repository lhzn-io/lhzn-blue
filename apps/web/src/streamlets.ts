/**
 * Streamlines with streamlets over a model's surface currents, after Ware, Kelley and Pilar (2014, BAMS 95,
 * 1573-1581) and Pilar and Ware (2013): a dense pattern of evenly spaced streamlines (Jobard and Lefer 1997), and along
 * each line small elements with a much stronger head than tail, which show the direction of flow more clearly than a
 * grid of arrows.
 *
 * What is drawn, and how it stays faithful to the model:
 * - The lines are traced through the model's own triangles. Element velocities are averaged to the nodes and
 *   interpolated linearly inside each triangle, so a line bends smoothly; it stops at the edge of the model's water and
 *   never crosses land or a gap.
 * - Lines are SEP_PX apart on screen (the paper: the spacing has an optimum on screen, so the drawing changes with
 *   scale), and closer, down to SEP_MIN_PX, where the model's own elements are smaller than that on screen. Dense lines
 *   therefore mean a finer mesh; the triangles' speed shading underneath still shows each element as the model has it.
 * - Streamlets sit evenly in travel time along a line, as particles released at a steady rate would: closer together
 *   where the water is slow, further apart where it is fast. Animated, they move at the current's own speed, all at one
 *   speed-up (1 m/s crosses the view's width in CROSS_S seconds), so relative speeds read true.
 * - They are the flow at one instant, not where the water goes over a tide that reverses about every 6 hours.
 *
 * Drawn on a 2D canvas over the map, in the map's ink (speed is the shading's job, direction the streamlets'), and
 * rebuilt when the frame, the view or the size changes.
 */
import type maplibregl from "maplibre-gl";

export interface FlowMesh {
  nodes: [number, number][];
  triangles: [number, number, number][];
}

const SEP_PX = 44; // line spacing on screen
const SEP_MIN_PX = 22; // the closest lines come, where the model's elements are smaller than SEP_PX on screen
const TEST = 0.5; // a line stops when it comes within TEST x the local spacing of another
const STEP_PX = 2; // integration step on screen
const MAX_STEPS = 700; // per direction
const MIN_POINTS = 8; // shorter lines are dropped
const MAX_LINES = 900;
const V_FLOOR_CMS = 1; // below this a line stops (slack water)
const MARK_GAP_PX = 30; // streamlet spacing along a line at the view's median speed
const MARK_MIN_GAP_PX = 14; // never closer than this, however slow the water
const HEAD_R = 2.6; // head radius, CSS px
const TAIL_PX = 13; // the tail behind each head, thinning and fading to nothing
const FADES = 4; // tail drawn in this many segments of rising width and opacity
const CROSS_S = 20; // animated: 1 m/s crosses the view's width in this many seconds
const MARGIN_PX = 24; // lines are traced this far past the edges, so none starts abruptly at the frame

/** The mesh in Web Mercator units (conformal, so east and north scale alike), with a bin grid for point location. */
interface Index {
  x: Float64Array; // node positions
  y: Float64Array;
  tri: Int32Array; // three nodes per triangle
  inv: Float64Array; // per triangle: x0, y0 and the inverse of its edge matrix (barycentric weights)
  size: Float64Array; // per triangle: the side of the equilateral triangle of its area
  minX: number;
  minY: number;
  cell: number;
  nx: number;
  ny: number;
  start: Int32Array; // CSR: bin b holds list[start[b] .. start[b+1])
  list: Int32Array;
  nodeTris: { start: Int32Array; list: Int32Array };
}

const merc = (lon: number, lat: number): [number, number] => [(lon * Math.PI) / 180, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];

const indexCache = new WeakMap<FlowMesh, Index>();

function buildIndex(m: FlowMesh): Index {
  const n = m.nodes.length;
  const t = m.triangles.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [a, b] = merc(m.nodes[i][0], m.nodes[i][1]);
    x[i] = a;
    y[i] = b;
    if (a < minX) minX = a;
    if (a > maxX) maxX = a;
    if (b < minY) minY = b;
    if (b > maxY) maxY = b;
  }
  const tri = new Int32Array(t * 3);
  const inv = new Float64Array(t * 6);
  const size = new Float64Array(t);
  let area = 0;
  for (let k = 0; k < t; k++) {
    const [i0, i1, i2] = m.triangles[k];
    tri.set([i0, i1, i2], k * 3);
    const ax = x[i1] - x[i0], ay = y[i1] - y[i0], bx = x[i2] - x[i0], by = y[i2] - y[i0];
    const det = ax * by - bx * ay;
    inv.set([x[i0], y[i0], by / det, -bx / det, -ay / det, ax / det], k * 6);
    const a = Math.abs(det) / 2;
    size[k] = Math.sqrt((4 * a) / Math.sqrt(3));
    area += a;
  }
  // Bins about two triangles across on average, so a lookup tests a handful.
  const cell = Math.sqrt((area / t) * 2) || 1e-4;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell));
  const count = new Int32Array(nx * ny + 1);
  const span = (k: number) => {
    const i0 = tri[k * 3], i1 = tri[k * 3 + 1], i2 = tri[k * 3 + 2];
    const bx0 = Math.max(0, Math.floor((Math.min(x[i0], x[i1], x[i2]) - minX) / cell));
    const bx1 = Math.min(nx - 1, Math.floor((Math.max(x[i0], x[i1], x[i2]) - minX) / cell));
    const by0 = Math.max(0, Math.floor((Math.min(y[i0], y[i1], y[i2]) - minY) / cell));
    const by1 = Math.min(ny - 1, Math.floor((Math.max(y[i0], y[i1], y[i2]) - minY) / cell));
    return [bx0, bx1, by0, by1];
  };
  for (let k = 0; k < t; k++) {
    const [bx0, bx1, by0, by1] = span(k);
    for (let j = by0; j <= by1; j++) for (let i = bx0; i <= bx1; i++) count[j * nx + i + 1]++;
  }
  for (let b = 0; b < nx * ny; b++) count[b + 1] += count[b];
  const start = count.slice();
  const fill = count.slice();
  const list = new Int32Array(count[nx * ny]);
  for (let k = 0; k < t; k++) {
    const [bx0, bx1, by0, by1] = span(k);
    for (let j = by0; j <= by1; j++) for (let i = bx0; i <= bx1; i++) list[fill[j * nx + i]++] = k;
  }
  // Each node's triangles, for averaging element velocities to the nodes.
  const nc = new Int32Array(n + 1);
  for (let k = 0; k < t * 3; k++) nc[tri[k] + 1]++;
  for (let i = 0; i < n; i++) nc[i + 1] += nc[i];
  const nf = nc.slice();
  const nl = new Int32Array(t * 3);
  for (let k = 0; k < t * 3; k++) nl[nf[tri[k]]++] = Math.floor(k / 3);
  return { x, y, tri, inv, size, minX, minY, cell, nx, ny, start, list, nodeTris: { start: nc, list: nl } };
}

/** The triangle holding a point and its barycentric weights, or -1; `hint` is tried first (the last step's). */
function locate(ix: Index, px: number, py: number, hint: number, w: Float64Array): number {
  const test = (k: number) => {
    const o = k * 6;
    const dx = px - ix.inv[o], dy = py - ix.inv[o + 1];
    const w1 = ix.inv[o + 2] * dx + ix.inv[o + 3] * dy;
    const w2 = ix.inv[o + 4] * dx + ix.inv[o + 5] * dy;
    const w0 = 1 - w1 - w2;
    if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) return false;
    w[0] = w0;
    w[1] = w1;
    w[2] = w2;
    return true;
  };
  if (hint >= 0 && test(hint)) return hint;
  const i = Math.floor((px - ix.minX) / ix.cell);
  const j = Math.floor((py - ix.minY) / ix.cell);
  if (i < 0 || j < 0 || i >= ix.nx || j >= ix.ny) return -1;
  const b = j * ix.nx + i;
  for (let q = ix.start[b]; q < ix.start[b + 1]; q++) if (test(ix.list[q])) return ix.list[q];
  return -1;
}

interface Line {
  x: Float32Array; // screen positions, CSS px, upstream to downstream
  y: Float32Array;
  s: Float32Array; // arc length from the upstream end
  tau: Float32Array; // travel time from the upstream end, display seconds
}

export class Streamlets {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly ix: Index;
  private nu: Float32Array; // node velocities, cm/s
  private nv: Float32Array;
  private hasField = false;
  private lines: Line[] = [];
  private gap = 1; // streamlet spacing in travel time
  private ink = "#1c2a48";
  private ground = "#ffffff";
  private animate = false;
  private raf = 0;
  private t0 = performance.now();
  private pending = 0;
  private readonly onMoveStart = () => {
    this.canvas.style.opacity = "0";
  };
  private readonly onSettle = () => this.schedule();

  constructor(private readonly map: maplibregl.Map, mesh: FlowMesh) {
    let ix = indexCache.get(mesh);
    if (!ix) {
      ix = buildIndex(mesh);
      indexCache.set(mesh, ix);
    }
    this.ix = ix;
    this.nu = new Float32Array(mesh.nodes.length);
    this.nv = new Float32Array(mesh.nodes.length);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "flow-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    // Over the map's own canvas, under its markers and popups.
    map.getCanvas().after(this.canvas);
    this.g = this.canvas.getContext("2d")!;
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onSettle);
    map.on("resize", this.onSettle);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.pending);
    this.map.off("movestart", this.onMoveStart);
    this.map.off("moveend", this.onSettle);
    this.map.off("resize", this.onSettle);
    this.canvas.remove();
  }

  setStyle(ink: string, ground: string): void {
    this.ink = ink;
    this.ground = ground;
    this.paint();
  }

  setAnimate(on: boolean): void {
    this.animate = on;
    cancelAnimationFrame(this.raf);
    if (on) this.loop();
    else this.paint();
  }

  /** The element velocities for the frame shown (cm/s, east and north), or null outside the model run. */
  setField(u: ArrayLike<number> | null, v: ArrayLike<number> | null): void {
    this.hasField = !!(u && v);
    if (u && v) {
      const { start, list } = this.ix.nodeTris;
      for (let i = 0; i < this.nu.length; i++) {
        let su = 0, sv = 0;
        const a = start[i], b = start[i + 1];
        for (let q = a; q < b; q++) {
          su += u[list[q]];
          sv += v[list[q]];
        }
        this.nu[i] = b > a ? su / (b - a) : 0;
        this.nv[i] = b > a ? sv / (b - a) : 0;
      }
    }
    this.schedule();
  }

  private schedule(): void {
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      this.build();
      this.canvas.style.opacity = "1";
      this.paint();
    });
  }

  /** Trace the lines for the view as it stands (Jobard and Lefer: seeds beside each accepted line, then a sweep). */
  private build(): void {
    const box = this.map.getContainer();
    const W = box.clientWidth, H = box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    this.lines = [];
    if (!this.hasField || !W || !H) return;
    // Mercator to screen is affine for a north-up, unpitched map: fix it from three projected points.
    const c = this.map.getCenter();
    const p0 = this.map.project([c.lng, c.lat]);
    const p1 = this.map.project([c.lng + 0.1, c.lat]);
    const p2 = this.map.project([c.lng, c.lat + 0.1]);
    const [m0x, m0y] = merc(c.lng, c.lat), [m1x] = merc(c.lng + 0.1, c.lat), [, m2y] = merc(c.lng, c.lat + 0.1);
    const sx = (p1.x - p0.x) / (m1x - m0x); // px per Mercator unit, east
    const sy = (p2.y - p0.y) / (m2y - m0y); // negative: screen y runs south
    const toMx = (X: number) => m0x + (X - p0.x) / sx;
    const toMy = (Y: number) => m0y + (Y - p0.y) / sy;
    const scale = Math.abs(sx);
    const ix = this.ix;
    const w = new Float64Array(3);
    let hint = -1;
    let sepHere = SEP_PX;
    /** Screen velocity (px per display second) at a screen point, or false off the model's water. */
    const vel = { x: 0, y: 0, cms: 0 };
    const sample = (X: number, Y: number): boolean => {
      const k = locate(ix, toMx(X), toMy(Y), hint, w);
      if (k < 0) return false;
      hint = k;
      const i0 = ix.tri[k * 3], i1 = ix.tri[k * 3 + 1], i2 = ix.tri[k * 3 + 2];
      const u = w[0] * this.nu[i0] + w[1] * this.nu[i1] + w[2] * this.nu[i2];
      const v = w[0] * this.nv[i0] + w[1] * this.nv[i1] + w[2] * this.nv[i2];
      vel.cms = Math.hypot(u, v);
      const pxPerCms = W / CROSS_S / 100; // 1 m/s crosses the width in CROSS_S
      vel.x = u * pxPerCms;
      vel.y = -v * pxPerCms;
      sepHere = Math.min(SEP_PX, Math.max(SEP_MIN_PX, ix.size[k] * scale));
      return true;
    };

    // The occupancy grid: every accepted point, by cell, with its line and index along the line.
    const cell = SEP_MIN_PX * TEST;
    const gx = Math.ceil((W + 2 * MARGIN_PX) / cell) + 1;
    const gy = Math.ceil((H + 2 * MARGIN_PX) / cell) + 1;
    const grid: number[][] = Array.from({ length: gx * gy }, () => []);
    const ptsX: number[] = [], ptsY: number[] = [], ptsLine: number[] = [], ptsIdx: number[] = [];
    const dead = new Set<number>();
    const cellOf = (X: number, Y: number) => {
      const i = Math.floor((X + MARGIN_PX) / cell), j = Math.floor((Y + MARGIN_PX) / cell);
      return i < 0 || j < 0 || i >= gx || j >= gy ? -1 : j * gx + i;
    };
    const free = (X: number, Y: number, d: number, line: number, idx: number): boolean => {
      const i = Math.floor((X + MARGIN_PX) / cell), j = Math.floor((Y + MARGIN_PX) / cell);
      const r = Math.ceil(d / cell);
      const selfGap = (2 * SEP_PX) / STEP_PX; // a line may pass near its own points only far along it (an eddy)
      for (let jj = Math.max(0, j - r); jj <= Math.min(gy - 1, j + r); jj++)
        for (let ii = Math.max(0, i - r); ii <= Math.min(gx - 1, i + r); ii++)
          for (const q of grid[jj * gx + ii]) {
            if (dead.has(ptsLine[q])) continue;
            if (ptsLine[q] === line && Math.abs(ptsIdx[q] - idx) < selfGap) continue;
            const dx = ptsX[q] - X, dy = ptsY[q] - Y;
            if (dx * dx + dy * dy < d * d) return false;
          }
      return true;
    };
    const add = (X: number, Y: number, line: number, idx: number) => {
      const c2 = cellOf(X, Y);
      if (c2 < 0) return;
      grid[c2].push(ptsX.length);
      ptsX.push(X);
      ptsY.push(Y);
      ptsLine.push(line);
      ptsIdx.push(idx);
    };
    const inside = (X: number, Y: number) => X >= -MARGIN_PX && Y >= -MARGIN_PX && X <= W + MARGIN_PX && Y <= H + MARGIN_PX;

    /** One direction from the seed: midpoint steps of STEP_PX along the flow (dir -1: against it). */
    const half = (X0: number, Y0: number, dir: number, line: number, out: number[]) => {
      let X = X0, Y = Y0;
      for (let n = 1; n <= MAX_STEPS; n++) {
        if (!sample(X, Y) || vel.cms < V_FLOOR_CMS) return;
        let l = Math.hypot(vel.x, vel.y);
        const mx = X + (dir * vel.x * STEP_PX) / (2 * l), my = Y + (dir * vel.y * STEP_PX) / (2 * l);
        if (!sample(mx, my) || vel.cms < V_FLOOR_CMS) return;
        l = Math.hypot(vel.x, vel.y);
        const nx = X + (dir * vel.x * STEP_PX) / l, ny = Y + (dir * vel.y * STEP_PX) / l;
        if (!inside(nx, ny) || !sample(nx, ny)) return;
        const idx = dir * n;
        if (!free(nx, ny, TEST * sepHere, line, idx)) return;
        add(nx, ny, line, idx);
        out.push(nx, ny);
        X = nx;
        Y = ny;
      }
    };

    const raw: { x: number[]; y: number[] }[] = [];
    const trace = (X: number, Y: number): number => {
      if (raw.length >= MAX_LINES || !inside(X, Y) || !sample(X, Y) || vel.cms < V_FLOOR_CMS) return -1;
      const id = raw.length;
      if (!free(X, Y, sepHere, -1, 0)) return -1;
      add(X, Y, id, 0);
      const fwd: number[] = [], back: number[] = [];
      half(X, Y, 1, id, fwd);
      half(X, Y, -1, id, back);
      const n = 1 + (fwd.length + back.length) / 2;
      if (n < MIN_POINTS) {
        dead.add(id);
        raw.push({ x: [], y: [] });
        return -1;
      }
      const xs: number[] = [], ys: number[] = [];
      for (let q = back.length - 2; q >= 0; q -= 2) {
        xs.push(back[q]);
        ys.push(back[q + 1]);
      }
      xs.push(X);
      ys.push(Y);
      for (let q = 0; q < fwd.length; q += 2) {
        xs.push(fwd[q]);
        ys.push(fwd[q + 1]);
      }
      raw.push({ x: xs, y: ys });
      return id;
    };

    /** Seeds one local spacing to either side of a line, every few steps along it, until no more fit. */
    const grow = (first: number) => {
      const queue = [first];
      while (queue.length && raw.length < MAX_LINES) {
        const L = raw[queue.shift()!];
        const every = Math.max(2, Math.floor(SEP_MIN_PX / STEP_PX / 2));
        for (let q = 0; q < L.x.length - 1; q += every) {
          const dx = L.x[q + 1] - L.x[q], dy = L.y[q + 1] - L.y[q];
          const l = Math.hypot(dx, dy) || 1;
          if (!sample(L.x[q], L.y[q])) continue;
          const d = sepHere;
          for (const sgn of [1, -1]) {
            const id = trace(L.x[q] - (sgn * dy * d) / l, L.y[q] + (sgn * dx * d) / l);
            if (id >= 0) queue.push(id);
          }
        }
      }
    };
    // A sweep of the view finds the water the growth has not reached (islands and headlands split it).
    for (let Y = SEP_MIN_PX / 2; Y < H && raw.length < MAX_LINES; Y += SEP_MIN_PX)
      for (let X = SEP_MIN_PX / 2; X < W && raw.length < MAX_LINES; X += SEP_MIN_PX) {
        const id = trace(X, Y);
        if (id >= 0) grow(id);
      }

    // Arc length and travel time along each line, and the streamlet spacing from the view's median speed.
    const speeds: number[] = [];
    for (const r of raw) {
      if (r.x.length < MIN_POINTS) continue;
      const n = r.x.length;
      const L: Line = { x: Float32Array.from(r.x), y: Float32Array.from(r.y), s: new Float32Array(n), tau: new Float32Array(n) };
      for (let q = 1; q < n; q++) {
        const ds = Math.hypot(L.x[q] - L.x[q - 1], L.y[q] - L.y[q - 1]);
        L.s[q] = L.s[q - 1] + ds;
        sample((L.x[q] + L.x[q - 1]) / 2, (L.y[q] + L.y[q - 1]) / 2);
        const v = Math.max(Math.hypot(vel.x, vel.y), 1e-3);
        if (q % 8 === 0) speeds.push(v);
        L.tau[q] = L.tau[q - 1] + ds / v;
      }
      this.lines.push(L);
    }
    speeds.sort((a, b) => a - b);
    const median = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 1;
    this.gap = MARK_GAP_PX / median;
    // Where the water is slow, travel time piles up: hold the streamlets at least MARK_MIN_GAP_PX apart.
    for (const L of this.lines) {
      let shift = 0;
      for (let q = 1; q < L.tau.length; q++) {
        const ds = L.s[q] - L.s[q - 1];
        const dt = L.tau[q] - shift - L.tau[q - 1];
        const cap = (ds / MARK_MIN_GAP_PX) * this.gap;
        if (dt > cap) shift += dt - cap;
        L.tau[q] -= shift;
      }
    }
  }

  private loop(): void {
    this.paint();
    if (this.animate) this.raf = requestAnimationFrame(() => this.loop());
  }

  private paint(): void {
    const g = this.g;
    const dpr = this.canvas.width / Math.max(1, this.map.getContainer().clientWidth);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.lines.length) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = "round";
    g.lineJoin = "round";
    // The lines: faint, one pixel.
    g.globalAlpha = 0.22;
    g.strokeStyle = this.ink;
    g.lineWidth = 1;
    g.beginPath();
    for (const L of this.lines) {
      g.moveTo(L.x[0], L.y[0]);
      for (let q = 1; q < L.x.length; q++) g.lineTo(L.x[q], L.y[q]);
    }
    g.stroke();
    // The streamlets: heads at even travel times along each line; animated, the phase moves with the clock.
    const phase = this.animate ? (((performance.now() - this.t0) / 1000) % this.gap) : this.gap / 2;
    const heads: number[] = []; // x, y, arc length, line
    this.lines.forEach((L, li) => {
      const end = L.tau[L.tau.length - 1];
      for (let t = phase; t <= end; t += this.gap) {
        const q = upper(L.tau, t);
        const a = L.tau[q - 1], b = L.tau[q];
        const f = b > a ? (t - a) / (b - a) : 0;
        heads.push(L.x[q - 1] + f * (L.x[q] - L.x[q - 1]), L.y[q - 1] + f * (L.y[q] - L.y[q - 1]), L.s[q - 1] + f * (L.s[q] - L.s[q - 1]), li);
      }
    });
    // Tails: FADES segments behind each head, thin and faint at the far end.
    for (let k = 0; k < FADES; k++) {
      g.globalAlpha = 0.12 + (0.7 * (k + 1)) / FADES;
      g.lineWidth = 0.6 + ((2 * HEAD_R - 0.8) * k) / FADES;
      g.beginPath();
      for (let h = 0; h < heads.length; h += 4) {
        const L = this.lines[heads[h + 3]];
        const s1 = heads[h + 2] - TAIL_PX + (TAIL_PX * k) / FADES;
        const s2 = heads[h + 2] - TAIL_PX + (TAIL_PX * (k + 1)) / FADES;
        if (s2 <= 0) continue;
        const [x1, y1] = at(L, Math.max(0, s1));
        const [x2, y2] = k === FADES - 1 ? [heads[h], heads[h + 1]] : at(L, s2);
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
      }
      g.stroke();
    }
    // Heads: solid, with a thin rim in the ground's colour so they read over any shade.
    g.globalAlpha = 1;
    g.beginPath();
    for (let h = 0; h < heads.length; h += 4) {
      g.moveTo(heads[h] + HEAD_R, heads[h + 1]);
      g.arc(heads[h], heads[h + 1], HEAD_R, 0, 2 * Math.PI);
    }
    g.fillStyle = this.ink;
    g.fill();
    g.globalAlpha = 0.5;
    g.lineWidth = 0.8;
    g.strokeStyle = this.ground;
    g.stroke();
    g.globalAlpha = 1;
  }
}

/** The first index whose value exceeds t (at least 1), in an ascending array. */
function upper(a: Float32Array, t: number): number {
  let lo = 1, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The point at arc length s along a line. */
function at(L: Line, s: number): [number, number] {
  const q = upper(L.s, s);
  const a = L.s[q - 1], b = L.s[q];
  const f = b > a ? Math.min(1, (s - a) / (b - a)) : 0;
  return [L.x[q - 1] + f * (L.x[q] - L.x[q - 1]), L.y[q - 1] + f * (L.y[q] - L.y[q - 1])];
}
