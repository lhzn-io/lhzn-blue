/** Line charts in the chart-room style: a linear, multi-line variant of the csb-census horizon chart.
 *
 * Lines break at missing values (never interpolated across gaps). Times are epoch seconds; axis and
 * tooltip labels are shown in Eastern time, where the readers are.
 */

import { arrowMarkup } from "./wind-dir";

const SVG = "http://www.w3.org/2000/svg";
export const YELLOW = "#decf03";
const TZ = "America/New_York";
const DAY = 86400;

/** A theme token from site.css (charts follow the light and dark themes), read once per theme: the theme is the root's
 * data-theme, the only thing that changes the tokens. */
const TOKENS = new Map<string, string>();
let tokensTheme: string | undefined;
export const cssVar = (name: string): string => {
  const theme = document.documentElement.dataset.theme ?? "";
  if (theme !== tokensTheme) {
    TOKENS.clear();
    tokensTheme = theme;
  }
  let v = TOKENS.get(name);
  if (v === undefined) TOKENS.set(name, (v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()));
  return v;
};

export function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export interface Line {
  ys: number[]; // aligned with ChartOptions.xs; NaN for missing
  color: string;
  width?: number;
  opacity?: number;
  dash?: string;
  label: string;
  tip?: boolean; // include in the tooltip (default true)
  hidden?: boolean; // tooltip only: not drawn and not used for the y range (e.g. wind direction)
  dots?: boolean; // draw each value as a dot instead of a connected line (e.g. one peak per day)
  fmt?: (v: number) => string; // tooltip text for this line's value, instead of value + unit
}

export interface Band {
  y0: number;
  y1: number;
  fill: string;
}

/** A shaded range between two series (e.g. a forecast's typical miss), drawn under the lines. */
export interface Area {
  lo: number[]; // aligned with ChartOptions.xs; NaN for missing
  hi: number[];
  fill: string;
  opacity?: number;
}

export interface Span {
  x0: number; // epoch seconds
  x1: number;
  fill: string;
  title?: string;
}

export interface ChartOptions {
  xs: number[];
  lines: Line[];
  unit: string; // appended to values, e.g. "°F"
  zero?: boolean; // emphasize y = 0
  bands?: Band[];
  areas?: Area[];
  spans?: Span[]; // shaded time intervals, full height
  marker?: { x: number; label: string; color?: string }; // a vertical rule, e.g. "now" (default the --now gold)
  asOfColor?: string; // the page timeline's rule (default the --now gold)
  hoverDigits?: number;
  floor?: number; // the value axis reaches at least down to this (keeps a reference level in view)
  ceil?: number; // the value axis stops here; higher values run along the top edge (the tooltip keeps the true value)
  empty?: string; // message (HTML) when the window holds no data
  /** The label of the line under the pointer (e.g. a forecast run) for the hovered sample and the value at the
   * pointer, or null; reported to the page as a "linepick" event on the plot when it changes. */
  pick?: (i: number, value: number) => string | null;
  /** Arrows in a row along the top (e.g. wind direction); the value axis leaves them room. Thinned to whole-hour
   * steps that fit the plot's width. */
  glyphs?: Glyph[];
}

/** An arrow at a time, pointing `deg` degrees clockwise from north (up). */
export interface Glyph {
  x: number; // epoch seconds, on a whole hour
  deg: number;
  color: string;
  faint?: boolean; // drawn pale (e.g. a light wind, whose direction wanders)
  dashed?: boolean; // a dashed shaft: a model value where there is no observation
  title?: string;
}

const GLYPH_PX = 22; // the row's height, and the least room between arrows
const GLYPH_STEPS = [1, 2, 3, 6, 12, 24, 48, 96, 168, 336, 672]; // hours between arrows

/** The arrows that fit: every n hours, n the smallest step leaving GLYPH_PX between them. */
function thinGlyphs(gs: Glyph[], x0: number, x1: number, widthPx: number): Glyph[] {
  const pxPerHour = (widthPx * 3600) / Math.max(1, x1 - x0);
  const n = GLYPH_STEPS.find((h) => h * pxPerHour >= GLYPH_PX) ?? GLYPH_STEPS[GLYPH_STEPS.length - 1];
  return gs.filter((g) => g.x > x0 && g.x < x1 && Math.round(g.x / 3600) % n === 0);
}

const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const fmtMonth = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", year: "numeric" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric" });

export function niceStep(span: number, target = 4): number {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

/** Year, month (0-based) and day of an instant on the Eastern calendar. */
const etParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" });
function etDate(t: number): [number, number, number] {
  const p = Object.fromEntries(etParts.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month) - 1, Number(p.day)];
}

/** Epoch seconds of midnight, Eastern time, on a calendar date (month 0-based; days may overflow). */
const etHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
function etMidnight(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m, d, 5); // midnight in standard time (UTC-5)
  const h = Number(etHour.format(new Date(guess))); // 0 in standard time, 1 in daylight time
  return guess / 1000 - h * 3600;
}

/**
 * Time rules at Eastern midnights, labelled on the Eastern calendar: years, months, weeks (Mondays) or days by
 * span. The rules sit where their labels say (a rule at midnight UTC on the 1st would fall on the evening
 * before in New York, and a month label there would name the previous month).
 */
function timeRules(x0: number, x1: number): [number, string][] {
  const span = x1 - x0;
  const out: [number, string][] = [];
  const [y0, m0, d0] = etDate(x0);
  if (span > 3 * 366 * DAY) {
    for (let y = y0 + 1; etMidnight(y, 0, 1) < x1; y++) out.push([etMidnight(y, 0, 1), String(y)]);
    return out;
  }
  if (span > 150 * DAY) {
    for (let k = 1; ; k++) {
      const t = etMidnight(y0, m0 + k, 1);
      if (t >= x1) break;
      const [, m] = etDate(t);
      out.push([t, m === 0 ? fmtMonth.format(new Date(t * 1000)) : fmtDay.format(new Date(t * 1000)).split(" ")[0]]);
    }
    return out;
  }
  const weekly = span > 12 * DAY;
  for (let k = 1; ; k++) {
    const t = etMidnight(y0, m0, d0 + k);
    if (t >= x1) break;
    if (weekly && new Date(t * 1000).getUTCDay() !== 1) continue; // Mondays (the UTC day of an ET midnight is the same date)
    out.push([t, fmtDay.format(new Date(t * 1000))]);
  }
  return out;
}

/** Emphasize the lines whose label starts with `label` and dim the rest; null restores all. */
/** Emphasise one line by its label (or none): drawn darker and heavier, the rest unchanged. */
export function emphasise(plot: HTMLElement, label: string | null): void {
  plot.querySelectorAll<SVGPathElement>("path[data-label]").forEach((p) => p.classList.toggle("lit", label !== null && p.dataset.label === label));
}

export function highlight(plot: HTMLElement, label: string | null): void {
  plot.querySelectorAll<SVGPathElement>("path[data-label]").forEach((p) => {
    const on = label === null || (p.dataset.label ?? "").startsWith(label);
    p.style.opacity = on ? "" : "0.1";
    if (label !== null && on) p.parentNode?.append(p); // bring to front
  });
}

let asOfT: number | null = null;

function placeAsOf(rule: SVGLineElement): void {
  const x0 = Number(rule.dataset.x0);
  const x1 = Number(rule.dataset.x1);
  const inside = asOfT != null && asOfT >= x0 && asOfT <= x1;
  rule.setAttribute("visibility", inside ? "visible" : "hidden");
  if (inside) {
    const xx = ((asOfT! - x0) / (x1 - x0)) * 1000;
    rule.setAttribute("x1", String(xx));
    rule.setAttribute("x2", String(xx));
  }
}

/** Move the page timeline's rule on every chart (null hides it: the cursor is at now). */
export function markAsOf(t: number | null): void {
  asOfT = t;
  document.querySelectorAll<SVGLineElement>("line.asof").forEach(placeAsOf);
}

export interface Rendered {
  x0: number;
  x1: number;
  /** Epoch seconds under a client x coordinate. */
  timeAt(clientX: number): number;
}

/** Draw into a `.plot` wrapper holding an <svg> and a `.plot-labels` div; a `.tip` tooltip is added. */
export function renderLines(plot: HTMLElement, o: ChartOptions): Rendered {
  const svg = plot.querySelector("svg")!;
  const labelsEl = plot.querySelector<HTMLElement>(".plot-labels")!;
  let tip = plot.querySelector<HTMLElement>(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    plot.append(tip);
  }
  let marks = plot.querySelector<HTMLElement>(".cursor-vals");
  if (!marks) {
    marks = document.createElement("div");
    marks.className = "cursor-vals";
    marks.setAttribute("aria-hidden", "true");
    plot.append(marks);
  }
  marks.replaceChildren();
  const theme = {
    grid: cssVar("--chart-grid"),
    rule: cssVar("--chart-rule"),
    zero: cssVar("--chart-zero"),
    cursor: cssVar("--chart-cursor"),
    shade: cssVar("--chart-shade"),
    now: cssVar("--now"),
  };
  const W = 1000;
  const H = 100;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.replaceChildren();
  const { xs } = o;
  const [x0, x1] = [xs[0] ?? 0, xs[xs.length - 1] ?? 1];
  const timeAt = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    return x0 + ((clientX - box.left) / Math.max(1, box.width)) * (x1 - x0);
  };
  const rendered = { x0, x1, timeAt };
  if (xs.length < 2) return rendered;
  const all = o.lines.filter((l) => !l.hidden).flatMap((l) => l.ys).filter((v) => Number.isFinite(v));
  if (o.zero) all.push(0);
  for (const a of o.areas ?? []) all.push(...a.hi.filter((v) => Number.isFinite(v)));
  if (!all.length) {
    // Keep the shared time axis, so an empty chart lines up with its neighbours, and say why it is empty.
    const rules = timeRules(x0, x1);
    const every = Math.ceil(rules.length / Math.max(3, Math.floor((plot.clientWidth || 600) / 64)));
    labelsEl.innerHTML =
      rules
        .filter((_, i) => i % every === 0)
        .map(([t, text]) => `<span class="month" style="left:${(100 * (t - x0)) / (x1 - x0)}%">${text}</span>`)
        .join("") + `<span class="axis"></span><span class="empty">${o.empty ?? "No data in this window"}</span>`;
    return rendered;
  }
  let lo = Math.min(...all, o.floor ?? Infinity);
  let hi = Math.max(...all);
  if (o.ceil !== undefined) hi = Math.min(hi, o.ceil);
  const pad = Math.max(0.5, (hi - lo) * 0.08);
  lo -= pad;
  hi += pad;
  const glyphs = o.glyphs?.length ? thinGlyphs(o.glyphs, x0, x1, svg.clientWidth || 600) : [];
  if (glyphs.length) {
    // The arrow row's band at the top, kept clear of the lines.
    const f = Math.min(0.4, GLYPH_PX / Math.max(1, svg.clientHeight || plot.clientHeight - 16 || 174));
    hi += ((hi - lo) * f) / (1 - f);
  }
  const px = (t: number) => ((t - x0) / (x1 - x0)) * W;
  const py = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const labels: string[] = [];
  labelsEl.classList.toggle("has-glyphs", glyphs.length > 0);
  for (const g of glyphs) {
    labels.push(
      `<span class="glyph${g.faint ? " faint" : ""}" style="left:${(100 * px(g.x)) / W}%;color:${g.color}"${g.title ? ` title="${g.title}"` : ""}>` +
        `<svg viewBox="-6 -6 12 12" width="14" height="14" aria-hidden="true">${arrowMarkup(g.deg, 1, g.dashed)}</svg></span>`,
    );
  }

  for (const b of o.bands ?? []) {
    const ya = py(Math.min(hi, Math.max(lo, b.y1)));
    const yb = py(Math.min(hi, Math.max(lo, b.y0)));
    svg.append(el("rect", { x: 0, y: ya, width: W, height: Math.max(0, yb - ya), fill: b.fill }));
  }
  // Time spans (e.g. an advisory in force), full height, under the rules and lines.
  for (const s of o.spans ?? []) {
    if (s.x1 <= x0 || s.x0 >= x1) continue;
    const xa = px(Math.max(x0, s.x0));
    const xb = px(Math.min(x1, s.x1));
    const r = el("rect", { x: xa, y: 0, width: Math.max(1, xb - xa), height: H, fill: s.fill });
    if (s.title) r.append(Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "title"), { textContent: s.title }));
    svg.append(r);
  }

  // Time rules: every rule drawn, labels thinned to what the plot width can hold.
  const rules = timeRules(x0, x1);
  const every = Math.ceil(rules.length / Math.max(3, Math.floor((plot.clientWidth || 600) / 64)));
  rules.forEach(([t, text], i) => {
    const xx = px(t);
    svg.append(el("line", { x1: xx, x2: xx, y1: 0, y2: H, stroke: theme.rule, "vector-effect": "non-scaling-stroke" }));
    if (i % every === 0) labels.push(`<span class="month" style="left:${(100 * xx) / W}%">${text}</span>`);
  });
  labels.push(`<span class="axis"></span>`);

  // Value rules.
  const ys = niceStep(hi - lo);
  const digits = Math.min(2, (String(+ys.toPrecision(3)).split(".")[1] ?? "").length); // 2.5 keeps its half
  for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
    const yy = py(v);
    const isZero = o.zero && Math.abs(v) < ys / 1000;
    svg.append(
      el("line", {
        x1: 0, x2: W, y1: yy, y2: yy,
        stroke: isZero ? theme.zero : theme.grid,
        "stroke-dasharray": isZero ? "" : "2 4",
        "vector-effect": "non-scaling-stroke",
      }),
    );
    labels.push(`<span class="ylab" style="top:${(100 * yy) / H}%">${v.toFixed(digits)}${o.unit}</span>`);
  }

  if (o.marker && o.marker.x > x0 && o.marker.x < x1) {
    const xx = px(o.marker.x);
    svg.append(el("rect", { x: xx, y: 0, width: Math.max(0, W - xx), height: H, fill: theme.shade }));
    svg.append(el("line", { x1: xx, x2: xx, y1: 0, y2: H, stroke: o.marker.color ?? theme.now, "stroke-opacity": 0.7, "stroke-dasharray": "3 3", "vector-effect": "non-scaling-stroke" }));
    labels.push(`<span class="arriving" style="left:${(100 * xx) / W}%">${o.marker.label}</span>`);
  }

  // Areas: one polygon per run of hours where both edges are known.
  for (const a of o.areas ?? []) {
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        const top = run.map((i) => `${px(xs[i]).toFixed(1)},${py(Math.min(a.hi[i], hi)).toFixed(2)}`);
        const bot = run.slice().reverse().map((i) => `${px(xs[i]).toFixed(1)},${py(Math.max(a.lo[i], lo)).toFixed(2)}`);
        svg.append(el("path", { d: `M${top.join("L")}L${bot.join("L")}Z`, fill: a.fill, "fill-opacity": a.opacity ?? 0.2, stroke: "none" }));
      }
      run = [];
    };
    xs.forEach((_, i) => (Number.isFinite(a.lo[i]) && Number.isFinite(a.hi[i]) ? run.push(i) : flush()));
    flush();
  }

  // The page timeline's time, drawn under the lines.
  const asof = el("line", { x1: 0, x2: 0, y1: 0, y2: H, class: "asof", stroke: o.asOfColor ?? theme.now, "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" });
  asof.dataset.x0 = String(x0);
  asof.dataset.x1 = String(x1);
  placeAsOf(asof);
  svg.append(asof);

  // Lines last, so the highlighted one sits on top (callers pass it last).
  for (const line of o.lines) {
    if (line.hidden) continue;
    if (line.dots) {
      // Zero-length segments with round caps: true dots under preserveAspectRatio="none" (circles would stretch).
      let d = "";
      line.ys.forEach((v, i) => {
        if (Number.isFinite(v)) d += `M${px(xs[i]).toFixed(1)},${py(Math.min(v, hi)).toFixed(2)}l0,0.001`;
      });
      if (d) {
        svg.append(
          el("path", {
            d, fill: "none", stroke: line.color, "data-label": line.label,
            "stroke-width": line.width ?? 3.5, "stroke-opacity": line.opacity ?? 1,
            "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
          }),
        );
      }
      continue;
    }
    let d = "";
    let pen = false;
    line.ys.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${px(xs[i]).toFixed(1)},${py(Math.min(v, hi)).toFixed(2)}`;
      pen = true;
    });
    if (!d) continue;
    svg.append(
      el("path", {
        d, fill: "none", stroke: line.color, "data-label": line.label,
        "stroke-width": line.width ?? 1.2,
        "stroke-opacity": line.opacity ?? 1,
        "stroke-dasharray": line.dash ?? "",
        "stroke-linejoin": "round",
        "vector-effect": "non-scaling-stroke",
      }),
    );
  }
  labelsEl.innerHTML = labels.join("");

  // Cursor and tooltip.
  const cursor = el("line", { x1: 0, x2: 0, y1: 0, y2: H, stroke: theme.cursor, "stroke-width": 1, "vector-effect": "non-scaling-stroke", visibility: "hidden" });
  svg.append(cursor);
  const hd = o.hoverDigits ?? 1;
  const tipLines = o.lines.filter((l) => l.tip !== false).reverse();
  let picked: string | null = null;
  const show = (clientX: number, clientY?: number) => {
    const t = timeAt(clientX);
    const i = Math.max(0, Math.min(xs.length - 1, Math.round((t - x0) / (xs[1] - xs[0]))));
    const xx = px(xs[i]);
    cursor.setAttribute("x1", String(xx));
    cursor.setAttribute("x2", String(xx));
    cursor.setAttribute("visibility", "visible");
    const value = (l: Line) => (l.fmt ? l.fmt(l.ys[i]) : l.ys[i].toFixed(hd) + o.unit);
    const have = tipLines.filter((l) => Number.isFinite(l.ys[i])).slice(0, 12);
    const frac = xx / W;
    // On-line values, in pixels within the plot. Labels go right of the cursor, or left near the right edge.
    // Measured from the drawing area, not the plot box (which also holds the value axis on the right).
    const box = svg.getBoundingClientRect();
    const outer = plot.getBoundingClientRect();
    const top = box.top - outer.top;
    const x = box.left - outer.left + frac * box.width;
    const pts = have
      .filter((l) => !l.hidden)
      .map((l) => ({ l, y: top + (py(Math.min(l.ys[i], hi)) / H) * box.height, at: 0 }))
      .sort((a, b) => a.y - b.y);
    // Spread the labels: push each below the one above it, then pull the stack back up if it runs off the bottom.
    const gap = 13;
    const floor = top + box.height - gap / 2;
    pts.forEach((p, k) => (p.at = Math.max(p.y, k ? pts[k - 1].at + gap : top + gap / 2)));
    for (let k = pts.length - 1; k >= 0; k--) pts[k].at = Math.min(pts[k].at, k === pts.length - 1 ? floor : pts[k + 1].at - gap);
    const side = frac > 0.6 ? "left" : "right";
    marks!.innerHTML = pts
      .map(
        ({ l, y, at }) =>
          `<i class="cv-dot" style="left:${x}px;top:${y}px;background:${l.color}"></i>` +
          `<span class="cv-lab ${side}" style="left:${x}px;top:${at}px"><i style="background:${l.color};opacity:${Math.max(0.5, l.opacity ?? 1)}"></i>${l.label}<b>${value(l)}</b></span>`,
      )
      .join("");
    // The box: the time, and values with no line of their own; on the other side of the cursor from the labels.
    const extra = have.filter((l) => l.hidden).map((l) => `<div>${l.label}<b>${value(l)}</b></div>`);
    tip!.innerHTML = `<span class="tip-time">${fmtHour.format(new Date(xs[i] * 1000))}</span>${extra.join("")}${have.length ? "" : "<div>no data</div>"}`;
    tip!.hidden = false;
    tip!.style.left = side === "left" ? `${x + 10}px` : "";
    tip!.style.right = side === "left" ? "" : `${outer.width - x + 10}px`;
    if (o.pick && clientY != null) {
      const label = o.pick(i, lo + (1 - (clientY - box.top) / box.height) * (hi - lo));
      if (label && label !== picked) {
        picked = label;
        plot.dispatchEvent(new CustomEvent("linepick", { detail: label }));
      }
    }
  };
  const hide = () => {
    cursor.setAttribute("visibility", "hidden");
    tip!.hidden = true;
    marks!.replaceChildren();
  };
  svg.onpointermove = (e) => {
    if (e.pointerType === "mouse" || plot.dataset.zoom === "1") show(e.clientX, e.clientY);
  };
  svg.onpointerleave = hide;
  return rendered;
}
