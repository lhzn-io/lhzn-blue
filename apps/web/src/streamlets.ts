/**
 * Streamlines with streamlets over a model's surface currents or wind, and wave crests over its waves, after Ware,
 * Kelley and Pilar (2014, BAMS 95, 1573-1581) and Pilar and Ware (2013): a dense pattern of evenly spaced lines
 * (Jobard and Lefer 1997), with marks along each line that have a much stronger head than tail, which show the
 * direction of flow more clearly than a grid of arrows; and for waves, lines along the crests (across the direction of
 * travel, as a sailor sees them) with a short tick on the side the waves travel toward.
 *
 * What is drawn, and how it stays faithful to the model:
 * - The lines are traced through the model's own cells (triangles, or each grid cell as two triangles). Cell values
 *   are averaged to the nodes and interpolated linearly inside each triangle, so a line bends smoothly; it stops at the
 *   edge of the model's water and never crosses land or a gap.
 * - Lines are SEP_PX apart on screen (the paper: the spacing has an optimum on screen, so the drawing changes with
 *   scale), and closer, down to SEP_MIN_PX, where the model's own cells are smaller than that on screen. Dense lines
 *   therefore mean a finer mesh; the cells' shading underneath still shows each cell as the model has it.
 * - Flow: streamlets sit evenly in travel time along a line, as particles released at a steady rate would: closer
 *   together where the flow is slow. Animated, they move at the flow's own speed, all at one speed-up, so relative
 *   speeds read true. They are the flow at one instant, not where the water (or air) goes over the following hours.
 * - Crests: still lines (Ware, Kelley and Pilar animate the wind, not the wave fronts), so they stay evenly spaced;
 *   the spacing says nothing about wavelength (a 4 s wave is about 25 m long, far below map scale). Along each crest,
 *   on the side the waves travel toward, a glyph gives the value at that point as a wind barb does: a bar per unit and
 *   a triangle per five (their Fig. 11: feet of significant height). Without a glyph scale, a short tick instead.
 * - Raw (setRaw): no interpolation in space. Each line follows its own triangle's value, so it turns at the edges of the
 *   model's cells, and each glyph reads the cell it sits in.
 *
 * Drawn on a 2D canvas over the map, in one ink, and rebuilt when the frame, the view or the size changes.
 */
import type maplibregl from "maplibre-gl";

export interface FlowMesh {
  nodes: [number, number][];
  triangles: [number, number, number][];
}

export interface StreamOptions {
  /** "flow": streamlines with streamlets; "crest": lines across the direction of travel, with ticks. */
  mode?: "flow" | "crest";
  /** Below this magnitude (the field's own units) a line stops: slack water, calm air, no waves. */
  floor?: number;
  /** Flow, animated: one unit of the field per second crosses the view's width in this many seconds x 100 (the
   * default, 20, suits currents in cm/s: 1 m/s crosses the view in 20 s). */
  crossS?: number;
  /** Crests: field units to glyph units (e.g. 3.28084 for feet from metres); without it, a plain tick. */
  glyph?: number;
}

const SEP_PX = 44; // line spacing on screen
const SEP_MIN_PX = 22; // the closest lines come, where the model's cells are smaller than SEP_PX on screen
const TEST = 0.5; // a line stops when it comes within TEST x the local spacing of another
const STEP_PX = 2; // integration step on screen
const MAX_STEPS = 700; // per direction
const MIN_POINTS = 8; // shorter lines are dropped
const MAX_LINES = 900;
const MARK_GAP_PX = 30; // streamlet spacing along a line at the view's median speed
const MARK_MIN_GAP_PX = 14; // never closer than this, however slow the flow
const HEAD_R = 1.4; // head radius, CSS px
const TAIL_PX = 13; // the tail behind each head, thinning and fading to nothing
const FADES = 4; // tail drawn in this many segments of rising width and opacity
const TICK_GAP_PX = 34; // crests: a tick every this far along a crest
const TICK_PX = 4; // crests: tick length, toward where the waves travel
const GLYPH_GAP_PX = 70; // crests: a glyph every this far along a crest
const BAR_PX = 4; // glyph: bar length, toward where the waves travel
const BAR_STEP_PX = 3.2; // glyph: bars this far apart along the crest
const TRI_BASE_PX = 6; // glyph: triangle base along the crest
const TRI_PX = 7; // glyph: triangle height
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
  const cell = Math.sqrt((area / Math.max(1, t)) * 2) || 1e-4;
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
  // Each node's triangles, for averaging cell values to the nodes.
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

/** A regular grid's cells (corners shared, (nx+1) x (ny+1) of them) as two triangles each, leaving out the cells
 * `skip` marks (land in the wave model); `cell[k]` is triangle k's cell, for spreading cell values onto triangles. */
export function gridMesh(nx: number, ny: number, cornerLon: number[], cornerLat: number[], skip?: ArrayLike<number>): { mesh: FlowMesh; cell: Int32Array } {
  const nodes: [number, number][] = cornerLon.map((x, i) => [x, cornerLat[i]]);
  const triangles: [number, number, number][] = [];
  const cells: number[] = [];
  const c = (j: number, i: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const id = j * nx + i;
      if (skip?.[id]) continue;
      triangles.push([c(j, i), c(j, i + 1), c(j + 1, i + 1)], [c(j, i), c(j + 1, i + 1), c(j + 1, i)]);
      cells.push(id, id);
    }
  return { mesh: { nodes, triangles }, cell: Int32Array.from(cells) };
}

interface Line {
  x: Float32Array; // screen positions, CSS px, upstream to downstream (flow) or along the crest
  y: Float32Array;
  s: Float32Array; // arc length from the first point
  tau: Float32Array; // flow: travel time from the upstream end, display seconds
  tx: Float32Array; // crest: the unit direction the waves travel, on screen
  ty: Float32Array;
  h: Float32Array; // crest: the field's magnitude at each point (the glyph's value)
}

export class Streamlets {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly ix: Index;
  private readonly mode: "flow" | "crest";
  private readonly floor: number;
  private readonly crossS: number;
  private nu: Float32Array; // node values, the field's units
  private nv: Float32Array;
  private tu: Float32Array; // triangle values, for raw mode
  private tv: Float32Array;
  private raw = false;
  private readonly glyph: number;
  private hasField = false;
  private lines: Line[] = [];
  private gap = 1; // streamlet spacing in travel time
  private ink = "#1c2a48";
  private ground = "#ffffff";
  private lineAlpha = 0.15;
  private animate = false;
  private raf = 0;
  private t0 = performance.now();
  private pending = 0;
  private readonly onMoveStart = () => {
    this.canvas.style.opacity = "0";
  };
  private readonly onSettle = () => this.schedule();

  constructor(private readonly map: maplibregl.Map, mesh: FlowMesh, opts: StreamOptions = {}) {
    let ix = indexCache.get(mesh);
    if (!ix) {
      ix = buildIndex(mesh);
      indexCache.set(mesh, ix);
    }
    this.ix = ix;
    this.mode = opts.mode ?? "flow";
    this.floor = opts.floor ?? 1;
    this.crossS = opts.crossS ?? 20;
    this.glyph = opts.glyph ?? 0;
    this.tu = new Float32Array(mesh.triangles.length);
    this.tv = new Float32Array(mesh.triangles.length);
    if (this.mode === "crest") this.lineAlpha = 0.5;
    this.nu = new Float32Array(mesh.nodes.length);
    this.nv = new Float32Array(mesh.nodes.length);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "flow-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    // Over the map's own canvas (and any earlier set of lines), under its markers and popups.
    const box = map.getCanvasContainer();
    const prev = [...box.querySelectorAll<HTMLCanvasElement>(":scope > .flow-canvas")].pop() ?? map.getCanvas();
    prev.after(this.canvas);
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

  /** The ink for lines and marks, the ground for the marks' thin rim, and optionally the lines' opacity. */
  setStyle(ink: string, ground: string, lineAlpha?: number): void {
    this.ink = ink;
    this.ground = ground;
    if (lineAlpha != null) this.lineAlpha = lineAlpha;
    this.paint();
  }

  setAnimate(on: boolean): void {
    this.animate = on && this.mode === "flow"; // crests stay still
    cancelAnimationFrame(this.raf);
    if (on) this.loop();
    else this.paint();
  }

  /** Raw: no interpolation in space; each line and glyph reads its own triangle's value. */
  setRaw(on: boolean): void {
    if (on === this.raw) return;
    this.raw = on;
    this.schedule();
  }

  /** Each triangle's vector for the frame shown (east and north, in the field's units), or null when there is none. */
  setField(u: ArrayLike<number> | null, v: ArrayLike<number> | null): void {
    this.hasField = !!(u && v);
    if (u && v) {
      this.tu.set(u);
      this.tv.set(v);
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
    const crest = this.mode === "crest";
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
    const pxPerUnit = W / this.crossS / 100; // flow: one field unit (x 100) crosses the width in crossS seconds
    /** At a screen point: the traced direction on screen (the flow, or along the crest) in vel.x/y, its magnitude in
     * the field's units, and the travel direction on screen (crests); false off the model's water. */
    const vel = { x: 0, y: 0, mag: 0, tx: 0, ty: 0 };
    const sample = (X: number, Y: number): boolean => {
      const k = locate(ix, toMx(X), toMy(Y), hint, w);
      if (k < 0) return false;
      hint = k;
      const i0 = ix.tri[k * 3], i1 = ix.tri[k * 3 + 1], i2 = ix.tri[k * 3 + 2];
      const u = this.raw ? this.tu[k] : w[0] * this.nu[i0] + w[1] * this.nu[i1] + w[2] * this.nu[i2];
      const v = this.raw ? this.tv[k] : w[0] * this.nv[i0] + w[1] * this.nv[i1] + w[2] * this.nv[i2];
      vel.mag = Math.hypot(u, v);
      if (crest) {
        const l = vel.mag || 1;
        vel.tx = u / l;
        vel.ty = -v / l;
        vel.x = -vel.ty; // along the crest: the travel direction turned a quarter
        vel.y = vel.tx;
      } else {
        vel.x = u * pxPerUnit;
        vel.y = -v * pxPerUnit;
      }
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
    const ok = () => vel.mag >= this.floor;

    /** One direction from the seed: midpoint steps of STEP_PX along the traced direction (dir -1: the other way). */
    const half = (X0: number, Y0: number, dir: number, line: number, out: number[]) => {
      let X = X0, Y = Y0;
      for (let n = 1; n <= MAX_STEPS; n++) {
        if (!sample(X, Y) || !ok()) return;
        let l = Math.hypot(vel.x, vel.y);
        const mx = X + (dir * vel.x * STEP_PX) / (2 * l), my = Y + (dir * vel.y * STEP_PX) / (2 * l);
        if (!sample(mx, my) || !ok()) return;
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
      if (raw.length >= MAX_LINES || !inside(X, Y) || !sample(X, Y) || !ok()) return -1;
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

    // Arc length along each line; for flow the travel time and the streamlet spacing from the view's median speed,
    // for crests the travel direction at each point.
    const speeds: number[] = [];
    for (const r of raw) {
      if (r.x.length < MIN_POINTS) continue;
      const n = r.x.length;
      const L: Line = {
        x: Float32Array.from(r.x), y: Float32Array.from(r.y), s: new Float32Array(n), tau: new Float32Array(n),
        tx: new Float32Array(crest ? n : 0), ty: new Float32Array(crest ? n : 0), h: new Float32Array(crest ? n : 0),
      };
      for (let q = 0; q < n; q++) {
        if (q > 0) L.s[q] = L.s[q - 1] + Math.hypot(L.x[q] - L.x[q - 1], L.y[q] - L.y[q - 1]);
        if (crest) {
          if (sample(L.x[q], L.y[q])) {
            L.tx[q] = vel.tx;
            L.ty[q] = vel.ty;
            L.h[q] = vel.mag;
          } else if (q > 0) {
            L.tx[q] = L.tx[q - 1];
            L.ty[q] = L.ty[q - 1];
            L.h[q] = L.h[q - 1];
          }
        } else if (q > 0) {
          sample((L.x[q] + L.x[q - 1]) / 2, (L.y[q] + L.y[q - 1]) / 2);
          const v = Math.max(Math.hypot(vel.x, vel.y), 1e-3);
          if (q % 8 === 0) speeds.push(v);
          L.tau[q] = L.tau[q - 1] + (L.s[q] - L.s[q - 1]) / v;
        }
      }
      this.lines.push(L);
    }
    if (crest) return;
    speeds.sort((a, b) => a - b);
    const median = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 1;
    this.gap = MARK_GAP_PX / median;
    // Where the flow is slow, travel time piles up: hold the streamlets at least MARK_MIN_GAP_PX apart.
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
    g.strokeStyle = this.ink;
    if (this.mode === "crest") return this.paintCrests();
    // The lines: faint and fine.
    g.globalAlpha = this.lineAlpha;
    g.lineWidth = 0.8;
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
      g.globalAlpha = 0.08 + (0.5 * (k + 1)) / FADES;
      g.lineWidth = 0.4 + ((2 * HEAD_R - 0.6) * k) / FADES;
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
    g.globalAlpha = 0.75;
    g.beginPath();
    for (let h = 0; h < heads.length; h += 4) {
      g.moveTo(heads[h] + HEAD_R, heads[h + 1]);
      g.arc(heads[h], heads[h + 1], HEAD_R, 0, 2 * Math.PI);
    }
    g.fillStyle = this.ink;
    g.fill();
    g.globalAlpha = 0.35;
    g.lineWidth = 0.6;
    g.strokeStyle = this.ground;
    g.stroke();
    g.globalAlpha = 1;
  }

  /** Crests: still, fine lines, with a glyph (or a tick) on the side the waves travel toward. */
  private paintCrests(): void {
    const g = this.g;
    g.lineWidth = 0.9;
    const stroke = (off: number, alpha: number) => {
      g.globalAlpha = alpha;
      g.beginPath();
      for (const L of this.lines) {
        g.moveTo(L.x[0] + off * L.tx[0], L.y[0] + off * L.ty[0]);
        for (let q = 1; q < L.x.length; q++) g.lineTo(L.x[q] + off * L.tx[q], L.y[q] + off * L.ty[q]);
      }
      g.stroke();
    };
    stroke(0, this.lineAlpha);
    if (!this.glyph) {
      g.beginPath();
      for (const L of this.lines) {
        const end = L.s[L.s.length - 1];
        for (let s = TICK_GAP_PX / 2; s < end; s += TICK_GAP_PX) {
          const q = upper(L.s, s);
          const [x, y] = at(L, s);
          g.moveTo(x, y);
          g.lineTo(x + TICK_PX * L.tx[q], y + TICK_PX * L.ty[q]);
        }
      }
      g.stroke();
      g.globalAlpha = 1;
      return;
    }
    // Glyphs (Ware, Kelley and Pilar's Fig. 11): bars and triangles in a row along the crest, centred on the point,
    // standing on the side the waves travel toward. Bars in one path, triangles in another.
    const bars = new Path2D();
    const tris = new Path2D();
    for (const L of this.lines) {
      const end = L.s[L.s.length - 1];
      for (let s = GLYPH_GAP_PX / 2; s < end; s += GLYPH_GAP_PX) {
        const q = upper(L.s, s);
        const n = Math.round(L.h[q] * this.glyph);
        if (n < 1) continue;
        const [x, y] = at(L, s);
        const nx = L.tx[q], ny = L.ty[q]; // toward where the waves travel
        const ax = -ny, ay = nx; // along the crest
        const five = Math.floor(n / 5), ones = n % 5;
        let o = -(five * (TRI_BASE_PX + 0.5) + ones * BAR_STEP_PX) / 2;
        for (let i = 0; i < five; i++) {
          tris.moveTo(x + ax * o, y + ay * o);
          tris.lineTo(x + ax * (o + TRI_BASE_PX / 2) + nx * TRI_PX, y + ay * (o + TRI_BASE_PX / 2) + ny * TRI_PX);
          tris.lineTo(x + ax * (o + TRI_BASE_PX), y + ay * (o + TRI_BASE_PX));
          tris.closePath();
          o += TRI_BASE_PX + 0.5;
        }
        for (let i = 0; i < ones; i++) {
          bars.moveTo(x + ax * (o + 0.6), y + ay * (o + 0.6));
          bars.lineTo(x + ax * (o + 0.6) + nx * BAR_PX, y + ay * (o + 0.6) + ny * BAR_PX);
          o += BAR_STEP_PX;
        }
      }
    }
    g.globalAlpha = Math.min(1, this.lineAlpha + 0.35);
    g.lineWidth = 1.2;
    g.stroke(bars);
    g.fillStyle = this.ink;
    g.fill(tris);
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
