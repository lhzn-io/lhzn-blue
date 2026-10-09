/** Line charts in the chart-room style: a linear, multi-line variant of the csb-census horizon chart.
 *
 * Lines break at missing values (never interpolated across gaps). Times are epoch seconds; axis and
 * tooltip labels are shown in Eastern time, where the readers are.
 */

const SVG = "http://www.w3.org/2000/svg";
export const YELLOW = "#decf03";
const TZ = "America/New_York";
const DAY = 86400;

/** A theme token from site.css (charts follow the light and dark themes). */
export const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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

export interface ChartOptions {
  xs: number[];
  lines: Line[];
  unit: string; // appended to values, e.g. "°F"
  zero?: boolean; // emphasize y = 0
  bands?: Band[];
  marker?: { x: number; label: string }; // a vertical rule, e.g. "now"
  hoverDigits?: number;
  floor?: number; // the value axis reaches at least down to this (keeps a reference level in view)
  empty?: string; // message (HTML) when the window holds no data
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

/** Time rules for the span: days, weeks (Mondays), or months, each with a label. */
function timeRules(x0: number, x1: number): [number, string][] {
  const span = x1 - x0;
  const out: [number, string][] = [];
  const start = new Date(x0 * 1000);
  if (span > 3 * 366 * DAY) {
    for (let y = start.getUTCFullYear() + 1; Date.UTC(y, 0, 1) / 1000 < x1; y++) out.push([Date.UTC(y, 0, 1) / 1000, String(y)]);
    return out;
  }
  if (span > 150 * DAY) {
    for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); m.getTime() / 1000 < x1; m.setUTCMonth(m.getUTCMonth() + 1)) {
      const t = m.getTime() / 1000;
      out.push([t, m.getUTCMonth() === 0 ? fmtMonth.format(m) : fmtDay.format(m).split(" ")[0]]);
    }
    return out;
  }
  const step = span > 12 * DAY ? 7 * DAY : DAY;
  let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1) / 1000;
  if (step > DAY) while (new Date(t * 1000).getUTCDay() !== 1) t += DAY;
  for (; t < x1; t += step) out.push([t, fmtDay.format(new Date(t * 1000))]);
  return out;
}

/** Emphasize the lines whose label starts with `label` and dim the rest; null restores all. */
export function highlight(plot: HTMLElement, label: string | null): void {
  plot.querySelectorAll<SVGPathElement>("path[data-label]").forEach((p) => {
    const on = label === null || (p.dataset.label ?? "").startsWith(label);
    p.style.opacity = on ? "" : "0.1";
    if (label !== null && on) p.parentNode?.append(p); // bring to front
  });
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
  const pad = Math.max(0.5, (hi - lo) * 0.08);
  lo -= pad;
  hi += pad;
  const px = (t: number) => ((t - x0) / (x1 - x0)) * W;
  const py = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const labels: string[] = [];

  for (const b of o.bands ?? []) {
    const ya = py(Math.min(hi, Math.max(lo, b.y1)));
    const yb = py(Math.min(hi, Math.max(lo, b.y0)));
    svg.append(el("rect", { x: 0, y: ya, width: W, height: Math.max(0, yb - ya), fill: b.fill }));
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
    svg.append(el("line", { x1: xx, x2: xx, y1: 0, y2: H, stroke: theme.now, "stroke-opacity": 0.7, "stroke-dasharray": "3 3", "vector-effect": "non-scaling-stroke" }));
    labels.push(`<span class="arriving" style="left:${(100 * xx) / W}%">${o.marker.label}</span>`);
  }

  // Lines last, so the highlighted one sits on top (callers pass it last).
  for (const line of o.lines) {
    if (line.hidden) continue;
    if (line.dots) {
      // Zero-length segments with round caps: true dots under preserveAspectRatio="none" (circles would stretch).
      let d = "";
      line.ys.forEach((v, i) => {
        if (Number.isFinite(v)) d += `M${px(xs[i]).toFixed(1)},${py(v).toFixed(2)}l0,0.001`;
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
      d += `${pen ? "L" : "M"}${px(xs[i]).toFixed(1)},${py(v).toFixed(2)}`;
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
  const show = (clientX: number) => {
    const t = timeAt(clientX);
    const i = Math.max(0, Math.min(xs.length - 1, Math.round((t - x0) / (xs[1] - xs[0]))));
    const xx = px(xs[i]);
    cursor.setAttribute("x1", String(xx));
    cursor.setAttribute("x2", String(xx));
    cursor.setAttribute("visibility", "visible");
    const rows = tipLines
      .filter((l) => Number.isFinite(l.ys[i]))
      .slice(0, 10)
      .map(
        (l) =>
          `<div><i style="background:${l.hidden ? "transparent" : l.color};opacity:${Math.max(0.5, l.opacity ?? 1)}"></i>${l.label}<b>${l.fmt ? l.fmt(l.ys[i]) : l.ys[i].toFixed(hd) + o.unit}</b></div>`,
      );
    tip!.innerHTML = `<span class="tip-time">${fmtHour.format(new Date(xs[i] * 1000))}</span>${rows.join("") || "<div>no data</div>"}`;
    tip!.hidden = false;
    const frac = xx / W;
    tip!.style.left = frac > 0.6 ? "" : `calc(${frac * 100}% + 10px)`;
    tip!.style.right = frac > 0.6 ? `calc(${(1 - frac) * 100}% + 10px)` : "";
  };
  const hide = () => {
    cursor.setAttribute("visibility", "hidden");
    tip!.hidden = true;
  };
  svg.onpointermove = (e) => {
    if (e.pointerType === "mouse" || plot.dataset.zoom === "1") show(e.clientX);
  };
  svg.onpointerleave = hide;
  return rendered;
}
