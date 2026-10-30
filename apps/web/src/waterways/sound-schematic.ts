/** The schematic Sound (the Sound's tides view): a Sound-only module, which the Sound's page includes. */
import { getJson, HOUR } from "../series";
import { AT, atLabel } from "../waterway/cursor";
import { feet, lastValue, signedFt } from "../waterway/format";
import type { StationData } from "../waterway/station-data";
import { predictedLevel } from "../waterway/cells";
import { OUTLOOK } from "../waterway/outlook";
import { departure, TIDES } from "../waterway/tides";
import { M } from "../waterway/models";

/** The Tides view draws the Sound as a diagram over the map box: the gauges are points, and a basemap would invite
 * the eye to read the water between them, which is not measured. The outline (public/schematic-lis.json, from
 * scripts/build-schematic.py) is the currents model's coastline smoothed at 1 km, north up, at true scale, in km east
 * and north of Kings Point. Each gauge on the site carries its level and its departure from NOAA's prediction at the
 * timeline's time (ahead of the record, the predicted level); live USGS gauges not yet on the site are drawn as
 * dashed rings. */
interface Schematic {
  north: [number, number][];
  south: [number, number][];
  gauges: { id: string; name: string; side: "N" | "S"; kind: "site" | "usgs"; usgs?: string; at: [number, number] }[];
  islands?: [number, number][][];
  rivers?: { name: string; line: [number, number][] }[];
  fine?: { north: [number, number][]; south: [number, number][] };
}
let SCHEM: Schematic | null = null;
let schemLoading: Promise<void> | null = null;
let schemWired = false;
let tiltMode: "dep" | "level" = "dep"; // the diagram's tilt band: departure from prediction, or level from mean sea level
let tiltShore: "both" | "N" | "S" = "both"; // which shore's gauges the band joins (each shore its own line)
// The diagram's pan and zoom (k: scale, tx/ty: offset in px); while it moves, labels keep their offsets from their pins.
let schemView = { k: 1, tx: 0, ty: 0 };
let schemMoving = false;
let schemIdle = 0;
const schemRel = new Map<string, { dx0: number; dy0: number; dx1: number; dy1: number }>();
let schemLayout: { key: string; boxes: Map<string, { x0: number; y0: number; x1: number; y1: number }> } | null = null;

/** What the diagram needs from the page: its stations, and the table to redraw when the diagram's choices change. */
interface SchematicHost {
  stations(): StationData[];
  redrawTable(): void;
}
let HOST: SchematicHost;
export function configureSchematic(host: SchematicHost): void {
  HOST = host;
}

export function syncSchematic(): void {
  const map = document.getElementById("map");
  if (!map) return;
  let box = map.querySelector<HTMLElement>(".schematic");
  if (M.view() !== "tides") {
    box?.remove();
    return;
  }
  if (!SCHEM) {
    schemLoading ??= getJson<Schematic>("/schematic-lis.json")
      .then((s) => {
        SCHEM = s;
        syncSchematic();
      })
      .catch(() => undefined);
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.className = "schematic";
    box.innerHTML = `<div class="sc-draw"></div><div class="sc-tilt-mode" role="group" aria-label="Tilt"><button type="button" data-mode="dep" aria-pressed="true">departure</button><button type="button" data-mode="level" aria-pressed="false">level</button><span class="sc-sep"></span><button type="button" data-shore="both" aria-pressed="true">both</button><button type="button" data-shore="N" aria-pressed="false">north shore</button><button type="button" data-shore="S" aria-pressed="false">Long Island</button></div><button type="button" class="sc-reset" hidden>Reset</button><button type="button" class="sc-ibtn" aria-expanded="false" aria-controls="sc-info" title="About this diagram">i</button><div class="sc-info" id="sc-info" hidden></div>`;
    map.appendChild(box);
    const btn = box.querySelector<HTMLButtonElement>(".sc-ibtn")!;
    const info = box.querySelector<HTMLElement>(".sc-info")!;
    const toggle = (open: boolean) => {
      info.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(info.hidden !== false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !info.hidden) toggle(false);
    });
    document.addEventListener("click", (e) => {
      if (!info.hidden && !info.contains(e.target as Node)) toggle(false);
    });
    box.querySelector(".sc-tilt-mode")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (b.dataset.mode) tiltMode = b.dataset.mode as "dep" | "level";
      if (b.dataset.shore) tiltShore = b.dataset.shore as "both" | "N" | "S";
      box!.querySelectorAll<HTMLButtonElement>(".sc-tilt-mode button[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.mode === tiltMode)));
      box!.querySelectorAll<HTMLButtonElement>(".sc-tilt-mode button[data-shore]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.shore === tiltShore)));
      syncSchematic();
    });
    const drawEl = box.querySelector<HTMLElement>(".sc-draw")!;
    const resetBtn = box.querySelector<HTMLButtonElement>(".sc-reset")!;
    const moved = () => {
      const w = drawEl.clientWidth, h = drawEl.clientHeight;
      const v = schemView;
      v.k = Math.min(8, Math.max(1, v.k));
      v.tx = Math.min(w * 0.25, Math.max(w * (1 - v.k) - w * 0.25, v.tx));
      v.ty = Math.min(h * 0.25, Math.max(h * (1 - v.k) - h * 0.25, v.ty));
      if (v.k === 1 && Math.abs(v.tx) < 1 && Math.abs(v.ty) < 1) v.tx = v.ty = 0;
      resetBtn.hidden = v.k === 1 && v.tx === 0 && v.ty === 0;
      schemMoving = true;
      requestAnimationFrame(syncSchematic);
      clearTimeout(schemIdle);
      schemIdle = window.setTimeout(() => {
        schemMoving = false;
        syncSchematic();
      }, 220);
    };
    const zoomAt = (cx: number, cy: number, f: number) => {
      const v = schemView;
      const k = Math.min(8, Math.max(1, v.k * f));
      v.tx = cx - ((cx - v.tx) * k) / v.k;
      v.ty = cy - ((cy - v.ty) * k) / v.k;
      v.k = k;
      moved();
    };
    drawEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = drawEl.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let pinch = 0;
    drawEl.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragged = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    drawEl.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (pointers.size === 1) {
        if (!dragged && Math.hypot(dx, dy) < 4) return;
        if (!dragged) drawEl.setPointerCapture(e.pointerId);
        dragged = true;
        schemView.tx += dx;
        schemView.ty += dy;
        p.x = e.clientX;
        p.y = e.clientY;
        moved();
      } else if (pointers.size === 2) {
        p.x = e.clientX;
        p.y = e.clientY;
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = drawEl.getBoundingClientRect();
        if (pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch);
        pinch = d;
        dragged = true;
      }
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
    };
    drawEl.addEventListener("pointerup", up);
    drawEl.addEventListener("pointercancel", up);
    drawEl.addEventListener("click", (e) => {
      if (dragged) {
        e.stopPropagation();
        dragged = false;
      }
    }, true);
    const reset = () => {
      schemView = { k: 1, tx: 0, ty: 0 };
      moved();
    };
    drawEl.addEventListener("dblclick", reset);
    resetBtn.addEventListener("click", reset);
    const idOf = (e: Event) => (e.target as Element).closest<SVGGElement>("g[data-id]")?.dataset.id ?? null;
    box.addEventListener("mouseover", (e) => {
      const id = idOf(e);
      if (id && id !== (OUTLOOK.peek ?? OUTLOOK.pin)) {
        OUTLOOK.peek = id;
        HOST.redrawTable();
      }
    });
    box.addEventListener("mouseleave", () => {
      if (OUTLOOK.peek) {
        OUTLOOK.peek = null;
        HOST.redrawTable();
      }
    });
    box.addEventListener("click", (e) => {
      const id = idOf(e);
      if (id) {
        OUTLOOK.pin = id;
        OUTLOOK.peek = null;
        HOST.redrawTable();
      }
    });
  }
  if (!schemWired) {
    schemWired = true;
    let frame = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncSchematic);
    });
  }
  const draw = box.querySelector<HTMLElement>(".sc-draw")!;
  draw.innerHTML = schematicSvg(SCHEM, draw.clientWidth || 800, draw.clientHeight || 500);
  box.querySelector<HTMLElement>(".sc-info")!.innerHTML = schematicInfo(SCHEM);
}

/** What the diagram is and how to read it: kept off the drawing, behind the (i). */
function schematicInfo(sc: Schematic): string {
  const sw = (inner: string) => `<svg width="16" height="12" viewBox="-8 -6 16 12" aria-hidden="true">${inner}</svg>`;
  const lastS = [...sc.gauges].filter((q) => q.side === "S" && q.kind === "site").sort((a, b) => b.at[0] - a.at[0])[0]
    ?? [...sc.gauges].filter((q) => q.side === "S").sort((a, b) => b.at[0] - a.at[0])[0];
  const end = sc.south[sc.south.length - 1];
  const gap = lastS ? Math.round(Math.hypot(end[0] - lastS.at[0], end[1] - lastS.at[1]) / 5) * 5 : 0;
  return `<p><b>Water level at the tide gauges.</b> The gauges are points; nothing is drawn between them, because the water there is not measured.</p>
    <ul class="sc-key">
      <li>${sw('<circle r="3.8" style="fill:var(--wp-gold)"/>')}observed level, ft above MLLW</li>
      <li>${sw('<circle r="3.6" style="fill:var(--bg);stroke:var(--ink-mute)"/>')}predicted level, ahead of the record (NOAA's; ours at the USGS gauges, fitted to each gauge's own record)</li>
      <li>${sw('<line y1="5" y2="-5" style="stroke:var(--wp-willow);stroke-width:2.6"/>')}observed minus predicted; up is higher</li>
      <li>${sw('<line y1="5" y2="-5" style="stroke:var(--wp-amber);stroke-width:2.6"/>')}more than 0.5 ft from the prediction</li>
      <li>${sw('<circle r="3.6" style="fill:var(--bg);stroke:var(--ink-mute);stroke-dasharray:2 1.6"/>')}USGS tide gauge, not shown on this site</li>
    </ul>
    <p>${gap ? `No gauge on Long Island's shore for about ${gap} km east of ${lastS.name}. ` : ""}Outline: the Census Bureau's TIGER shoreline (public domain), smoothed at 0.75 km (finer when zoomed in); north up, to scale; islands at the mouth drawn by their north shores. Drag to pan, scroll or pinch to zoom.</p>`;
}

function schematicSvg(sc: Schematic, W: number, H: number): string {
  const nar = W < 560;
  const [xmin, xmax, ymin, ymax] = [-4, 160, -3, 61];
  const pad = { l: nar ? 22 : 84, r: nar ? 14 : 40, t: nar ? 40 : 60, b: nar ? 46 : 70 };
  // The tilt band takes the foot; the drawing (rivers included) is fitted and centred in the area above it, with a gap
  // for Long Island's callouts and the band's title.
  const topKm = Math.max(ymax, ...(sc.rivers ?? []).flatMap((r) => r.line.map((p) => p[1])));
  const bandY1 = H - 58, bandY0 = bandY1 - Math.min(150, Math.max(90, H * 0.18));
  // What hangs below a Long Island pin: a label at twice the bar scale plus its two lines, then the band's title.
  const sWide = (W - pad.l - pad.r) / (xmax - xmin);
  const gap = 2 * Math.max(14, sWide * 4) + 6 + 30 + 22;
  const area = nar ? { t: pad.t, b: H - pad.b } : { t: 18, b: bandY0 - gap };
  const s = Math.min(sWide, (area.b - area.t) / ((nar ? ymax : topKm) - ymin));
  const ox = pad.l + (W - pad.l - pad.r - (xmax - xmin) * s) / 2;
  const oy = nar
    ? pad.t + (H - pad.t - pad.b - (ymax - ymin) * s) / 2
    : area.t + (area.b - area.t - (topKm - ymin) * s) / 2 + (topKm - ymax) * s;
  const { k: zk, tx, ty } = schemView;
  const X = (x: number) => (ox + (x - xmin) * s) * zk + tx;
  const Y = (y: number) => (oy + (ymax - y) * s) * zk + ty;
  const f1 = (v: number) => v.toFixed(1);
  const path = (pts: [number, number][]) => "M" + pts.map(([x, y]) => `${f1(X(x))},${f1(Y(y))}`).join("L");
  const shore = zk >= 2.5 && sc.fine ? sc.fine : sc; // closer in, the outline smoothed at 0.35 km
  const lines = [shore.north, shore.south, ...(sc.islands ?? [])];
  let g = (sc.rivers ?? []).map((r) => `<path d="${path(r.line)}" class="sc-river"><title>${r.name}</title></path>`).join("");
  g += lines.map((l, i) => `<path d="${path(l)}" class="${i < 2 ? "sc-shore" : "sc-isle"}"/>`).join("");

  // Label placement: each label tries spots around its mark and takes the one that crosses the fewest shore points,
  // overlaps no other label or mark, and stays in the frame.
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const pts: [number, number][] = [];
  lines.forEach((l, k) => { for (let i = 0; i < l.length; i += k < 2 ? 2 : 1) pts.push([X(l[i][0]), Y(l[i][1])]); });
  for (const r of sc.rivers ?? []) for (const [x, y] of r.line) pts.push([X(x), Y(y)]);
  const taken: Box[] = [];
  const CW = 7, LH = 12; // the mono face at 10px: 7 px a character, as measured
  // Each label tries spots out on its shore's land side (near, then farther into the open space) and takes the one that
  // keeps clear of the shore, of other labels and marks, and whose leader line crosses the least shore.
  const leads: [number, number, number, number][] = [];
  const shoreSegs: [number, number, number, number][] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) shoreSegs.push([X(l[i - 1][0]), Y(l[i - 1][1]), X(l[i][0]), Y(l[i][1])]);
  const cross = (a: [number, number, number, number], c: [number, number, number, number]) => {
    const o = (p: number, q: number, r: number, t: number, u: number, v: number) => Math.sign((r - p) * (v - q) - (t - q) * (u - p));
    return o(a[0], a[1], a[2], a[3], c[0], c[1]) !== o(a[0], a[1], a[2], a[3], c[2], c[3]) && o(c[0], c[1], c[2], c[3], a[0], a[1]) !== o(c[0], c[1], c[2], c[3], a[2], a[3]);
  };
  // Leaders are vertical: a label sits straight above (north shore) or below (south shore) its pin, slid sideways
  // only as far as keeps the pin under the label.
  const anchorOf = (px: number, py: number, b: Box): [number, number] => [px, py < b.y0 ? b.y0 : b.y1];
  // Spots are worked out once per size, from fixed-width templates, and reused at every time, so moving the time
  // never moves a label.
  const sizeKey = `${W}x${H}:${zk.toFixed(3)}:${Math.round(tx)}:${Math.round(ty)}`;
  if (!schemLayout || schemLayout.key !== sizeKey) schemLayout = { key: sizeKey, boxes: new Map() };
  const memo = schemLayout.boxes;
  const place = (key: string, px: number, py: number, rows: string[], side: "N" | "S", far = false): { b: Box; lead: boolean } => {
    const rel = schemRel.get(key);
    const kept = memo.get(key) ?? (schemMoving && rel ? { x0: px + rel.dx0, y0: py + rel.dy0, x1: px + rel.dx1, y1: py + rel.dy1 } : undefined);
    if (kept) {
      taken.push(kept);
      leads.push([px, py, ...anchorOf(px, py, kept)]);
      return { b: kept, lead: true };
    }
    const w = Math.max(...rows.map((r) => r.length)) * CW + 6, h = rows.length * LH + 3;
    // The site's gauges at one distance, just clear of the largest bar; the USGS gauges farther out, stepping on. On a
    // phone the site's labels may step out too, stacked at different heights, since side by side they do not fit.
    const near = Math.max(9, 2 * FT);
    const dists = far ? [56, 72, 88, 104, 122, 140] : nar ? [near + 6, near + 22, near + 40, near + 58, near + 76, near + 94] : [near + 6, near + 22];
    const xs = [-w / 2, -8, -w + 8, -w * 0.25, -w * 0.75];
    let best: { b: Box; score: number; lead: boolean } | null = null;
    dists.forEach((d, di) => xs.forEach((dx, xi) => {
      const y0 = side === "N" ? py - d - h : py + d;
      const bx = { x0: px + dx, y0, x1: px + dx + w, y1: y0 + h };
      let score = di * 1.5 + xi * 0.4;
      if (bx.x0 < 2 || bx.y0 < 2 || bx.x1 > W - 2 || bx.y1 > H - 2) score += 1000;
      for (const t of taken) if (bx.x0 < t.x1 + 4 && t.x0 < bx.x1 + 4 && bx.y0 < t.y1 + 3 && t.y0 < bx.y1 + 3) score += 1000;
      const [ax, ay] = anchorOf(px, py, bx);
      for (const [x, y] of pts) if (x > bx.x0 - 6 && x < bx.x1 + 6 && y > bx.y0 - 6 && y < bx.y1 + 6) score += 4;
      for (const [lx, ly0, , ly1] of leads) if (lx > bx.x0 - 3 && lx < bx.x1 + 3 && Math.max(Math.min(ly0, ly1), bx.y0) < Math.min(Math.max(ly0, ly1), bx.y1)) score += 300;
      // The leader may not pass through another label, or cross a shore.
      for (const t of taken) if (ax > t.x0 && ax < t.x1 && Math.max(Math.min(py, ay), t.y0) < Math.min(Math.max(py, ay), t.y1)) score += 300;
      const seg: [number, number, number, number] = [px, py + (ay - py) * 0.15, ax, ay];
      for (const sh of shoreSegs) if (cross(seg, sh)) { score += 600; break; }
      if (!best || score < best.score) best = { b: bx, score, lead: true };
    }));
    // Where no spot fits (a narrow phone), the least crowded one is pulled back inside the frame rather than cut off.
    const b = best!.b;
    const mx = Math.max(2 - b.x0, Math.min(0, W - 2 - b.x1)), my = Math.max(2 - b.y0, Math.min(0, H - 2 - b.y1));
    best!.b = { x0: b.x0 + mx, y0: b.y0 + my, x1: b.x1 + mx, y1: b.y1 + my };
    taken.push(best!.b);
    leads.push([px, py, ...anchorOf(px, py, best!.b)]);
    memo.set(key, best!.b);
    schemRel.set(key, { dx0: best!.b.x0 - px, dy0: best!.b.y0 - py, dx1: best!.b.x1 - px, dy1: best!.b.y1 - py });
    return best!;
  };
  const text = (b: Box, rows: string[], cls: string[]) =>
    rows.map((r, i) => `<text x="${f1(b.x0 + 3)}" y="${f1(b.y0 + 10 + i * LH)}" class="${cls[i] ?? cls[0]} sc-halo">${r}</text>`).join("");
  const leader = (px: number, py: number, b: Box, gap = 5) => {
    const [, ay] = anchorOf(px, py, b);
    const sy = py + Math.sign(ay - py) * gap;
    return Math.abs(ay - sy) < 4 ? "" : `<line x1="${f1(px)}" y1="${f1(sy)}" x2="${f1(px)}" y2="${f1(ay)}" class="sc-lead"/>`;
  };

  // The tilt band at the foot, on the diagram's own x axis: each gauge's point straight under its pin. Kept clear of
  // labels.
  const band = nar ? null : { y0: bandY0, y1: bandY1 };
  if (band) taken.push({ x0: 0, y0: band.y0 - 14, x1: W, y1: band.y1 + 4 });
  // The scale bar and north arrow (drawn last), kept clear of labels too.
  const km = zk >= 4 ? 5 : zk >= 2 ? 10 : 20; // a bar of about the same length at any zoom
  const sk = s * zk;
  const sx = W - (nar ? 14 : 40) - km * sk - 40, sy = H - 18;
  taken.push({ x0: sx - 8, y0: sy - 20, x1: sx + km * sk + 44, y1: H });
  // Marks first (so labels keep off them), then labels.
  const on = OUTLOOK.peek ?? OUTLOOK.pin;
  const shown = sc.gauges.some((q) => q.id === on && q.kind === "site") ? on : "KPTN";
  const FT = Math.max(14, s * 4); // px per foot of departure
  type Mark = { q: Schematic["gauges"][number]; x: number; y: number; svg: string; rows: string[]; cls: string[]; title: string };
  const marks: Mark[] = [];
  for (const q of sc.gauges) {
    const x = X(q.at[0]), y = Y(q.at[1]);
    if (x < -10 || x > W + 10 || y < -10 || y > H + 10) continue; // panned out of view
    if (q.kind === "usgs") {
      if (nar) continue;
      marks.push({ q, x, y, svg: `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.6" class="sc-cand"/>`, rows: [q.name], cls: ["sc-cname"], title: `${q.name}: USGS tide gauge ${q.usgs}, not shown on this site` });
      taken.push({ x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5 });
      continue;
    }
    const d = HOST.stations().find((st) => st.meta.id === q.id && st.kind === "shore");
    if (!d) continue;
    let lv = NaN, dep = NaN, how = "observed";
    if (AT == null) {
      lv = d.levelNow?.ft ?? NaN;
      dep = lastValue(departure(d));
    } else {
      const h = Math.floor(AT / HOUR) * HOUR;
      lv = d.level?.at(h) ?? NaN;
      dep = departure(d)?.at(h) ?? NaN;
      if (!Number.isFinite(lv)) {
        lv = predictedLevel(d, AT);
        dep = NaN;
        how = "predicted";
      }
    }
    const val = Number.isFinite(lv) ? `${feet(lv)} ft${Number.isFinite(dep) ? ` ${signedFt(dep)}` : how === "predicted" ? " pred." : ""}` : "no reading";
    const beyond = Number.isFinite(dep) && Math.abs(dep) > 0.5;
    const bar = Number.isFinite(dep) ? `<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(y)}" y2="${f1(y - dep * FT)}" class="sc-bar${beyond ? " beyond" : ""}"/>` : "";
    const dot = how === "predicted" || !Number.isFinite(lv) ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.6" class="sc-pred"/>` : `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.8" class="sc-obs"/>`;
    const ring = q.id === shown ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="8" class="sc-on"/>` : "";
    taken.push({ x0: x - 9, y0: y - Math.max(9, 2 * FT), x1: x + 9, y1: y + Math.max(9, 2 * FT) });
    const title = `${q.name}: ${Number.isFinite(lv) ? `${feet(lv)} ft above MLLW, ${how}` : "no reading"}${Number.isFinite(dep) ? `, ${signedFt(dep)} ft against the prediction` : ""}${AT != null ? `, ${atLabel(AT)}` : ""}`;
    marks.push({ q, x, y, svg: `${bar}${ring}${dot}<circle cx="${f1(x)}" cy="${f1(y)}" r="12" class="sc-hit"/>`, rows: [q.name, val], cls: ["sc-nm", "sc-val"], title });
  }
  // The site's gauges claim their spots first, then the candidates, then the named places.
  for (const m of [...marks].sort((a, b) => (a.q.kind === "site" ? 0 : 1) - (b.q.kind === "site" ? 0 : 1))) {
    const p = place(m.q.id, m.x, m.y, m.q.kind === "site" ? [m.q.name, "10.0 ft pred."] : m.rows, m.q.side, m.q.kind !== "site");
    const body = `<title>${m.title}</title>${p.lead ? leader(m.x, m.y, p.b) : ""}${m.svg}${text(p.b, m.rows, m.cls)}`;
    g += m.q.kind === "site" ? `<g data-id="${m.q.id}" class="sc-g">${body}</g>` : `<g data-usgs="${m.q.usgs}">${body}</g>`;
  }
  if (band) g += tiltBand(sc, X, W, band);
  // Scale bar and north arrow, at the foot (its middle figure left out on a phone, where the bar is too short for it).
  g += `<g class="sc-scale"><line x1="${f1(sx)}" x2="${f1(sx + km * sk)}" y1="${sy}" y2="${sy}"/>` +
    (nar ? [0, km] : [0, km / 2, km]).map((t) => `<line x1="${f1(sx + t * sk)}" x2="${f1(sx + t * sk)}" y1="${sy - 3}" y2="${sy + 3}"/><text x="${f1(sx + t * sk)}" y="${sy - 7}" text-anchor="middle">${t === km ? `${km} km` : t}</text>`).join("") +
    `<path d="M${f1(sx + km * sk + 28)},${sy + 3} V${sy - 15} M${f1(sx + km * sk + 24.5)},${sy - 9} L${f1(sx + km * sk + 28)},${sy - 16} L${f1(sx + km * sk + 31.5)},${sy - 9}"/>` +
    `<text x="${f1(sx + km * sk + 36)}" y="${sy}">N</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Long Island Sound in outline, with water level at the tide gauges">${g}</svg>`;
}

/** The Sound's tilt: at the cursor's hour (and faintly the six before), each site gauge's departure from its
 * prediction, or its level from mean sea level, joined west to east. Points sit under their pins (shared x). */
function tiltBand(sc: Schematic, X: (x: number) => number, W: number, band: { y0: number; y1: number }): string {
  const lim = tiltMode === "dep" ? 2 : 5;
  const mid = (band.y0 + band.y1) / 2;
  const y = (v: number) => mid - (Math.max(-lim, Math.min(lim, v)) / lim) * ((band.y1 - band.y0) / 2);
  const T = Math.floor((AT ?? Date.now() / 1000 - HOUR) / HOUR) * HOUR;
  const gauges = sc.gauges.filter((q) => q.kind === "site").map((q) => ({ q, d: HOST.stations().find((st) => st.meta.id === q.id && st.kind === "shore") }))
    .filter((p): p is { q: typeof p.q; d: StationData } => !!p.d).sort((a, b) => a.q.at[0] - b.q.at[0]);
  const value = (d: StationData, h: number) => {
    if (tiltMode === "dep") return departure(d)?.at(h) ?? NaN;
    const msl = TIDES?.[d.meta.id]?.datums_ft?.MSL ?? NaN;
    const lv = d.level?.at(h);
    return (lv != null && Number.isFinite(lv) ? lv : predictedLevel(d, h + HOUR / 2)) - msl;
  };
  const f1 = (v: number) => v.toFixed(1);
  let g = `<line x1="${f1(X(-3))}" x2="${f1(X(160))}" y1="${f1(mid)}" y2="${f1(mid)}" class="tb-zero"/>`;
  g += `<text x="${f1(X(-3) - 6)}" y="${f1(band.y0 + 4)}" text-anchor="end" class="tb-tick">+${lim}</text><text x="${f1(X(-3) - 6)}" y="${f1(mid + 3)}" text-anchor="end" class="tb-tick">0</text><text x="${f1(X(-3) - 6)}" y="${f1(band.y1 + 2)}" text-anchor="end" class="tb-tick">−${lim}</text>`;
  g += `<text x="${f1(X(-3))}" y="${f1(band.y0 - 6)}" class="tb-tick">${tiltMode === "dep" ? "departure from prediction, ft" : "level from mean sea level, ft"}</text>`;
  // One line per shore (north solid, Long Island dashed), so the band never zigzags across the Sound.
  for (const side of (tiltShore === "both" ? ["N", "S"] : [tiltShore]) as ("N" | "S")[]) {
    const own = gauges.filter(({ q }) => q.side === side);
    for (let k = 6; k >= 0; k--) {
      const h = T - k * HOUR;
      const pts = own.map(({ q, d }) => [X(q.at[0]), value(d, h)] as [number, number]).filter((p) => Number.isFinite(p[1]));
      if (pts.length < 2) continue;
      g += `<path d="M${pts.map(([px, v]) => `${f1(px)},${f1(y(v))}`).join("L")}" class="${k ? "tb-trail" : "tb-now"}${side === "S" ? " tb-south" : ""}"${k ? ` style="opacity:${(0.5 - k * 0.06).toFixed(2)}"` : ""}/>`;
      if (!k) for (const [px, v] of pts) g += `<circle cx="${f1(px)}" cy="${f1(y(v))}" r="2.6" class="tb-dot"/>`;
    }
  }
  if (tiltShore === "both") {
    const lx = X(160), ly = band.y0 - 9;
    g += `<line x1="${f1(lx - 196)}" x2="${f1(lx - 178)}" y1="${f1(ly)}" y2="${f1(ly)}" class="tb-now"/><text x="${f1(lx - 172)}" y="${f1(ly + 3)}" class="tb-tick">north shore</text>` +
      `<line x1="${f1(lx - 90)}" x2="${f1(lx - 72)}" y1="${f1(ly)}" y2="${f1(ly)}" class="tb-now tb-south"/><text x="${f1(lx - 66)}" y="${f1(ly + 3)}" class="tb-tick">Long Island</text>`;
  }
  for (const { q } of gauges.filter(({ q }) => tiltShore === "both" || q.side === tiltShore)) g += `<line x1="${f1(X(q.at[0]))}" x2="${f1(X(q.at[0]))}" y1="${f1(band.y1 + 2)}" y2="${f1(band.y1 + 6)}" class="tb-zero"/>`;
  void W;
  return `<g class="tilt-band">${g}</g>`;
}

