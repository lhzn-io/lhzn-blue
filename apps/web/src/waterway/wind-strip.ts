/** Wind across a waterway (the weather view, under the table): one row per station that measures wind, west to east,
 * grouped by NWS zone; each hour coloured by speed on the map's wind scale. Measured hours first; where a buoy is out,
 * the newest HRRR run fills in, hatched as a model; the next 48 h are HRRR's forecast. A red ribbon over each zone marks
 * the NWS advisories; a rule marks the page's time. */
import { ARROW_PATH, compass, LIGHT_KT, windArrow } from "../wind-dir";
import { WIND_STRIP_HASH } from "../advisory";
import { DAY, HOUR } from "../series";
import { fmtWhenMin, hourOf } from "./format";
import { AT } from "./cursor";
import { WIND_UNITS, windFmt, WU } from "./units";
import type { StationData } from "./station-data";
import { FCST, forecastAt, hrrrAsOf, loadForecast } from "./forecast";
import { ADV, ADV_WIND, advisoriesFor, loadAdvisories, zoneOf } from "./advisories";
import { M } from "./models";

type Theme = "dark" | "light";
const currentTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

const WS_STOPS: Record<Theme, [number, string][]> = {
  light: [[0, "#f1edf8"], [6, "#d9cdee"], [12, "#b7a2dd"], [18, "#9070c6"], [25, "#6a47a8"], [35, "#3f2477"]],
  dark: [[0, "#2b2440"], [6, "#3f3366"], [12, "#5d4a92"], [18, "#8167bd"], [25, "#a990dd"], [35, "#d6c7f5"]],
};
export const WS_BACK = 14 * DAY, WS_AHEAD = 48 * HOUR;
const WS_REACH = { back: WS_BACK, ahead: 72 * HOUR }; // the time slider's hours scale in this view (timeline.ts)
const WS = { W: 480, L: 34, R: 4, top: 12, row: 8, ribbon: 3, gap: 7, bot: 13 };
/** The strip's station rows as last drawn (viewBox units), for the pointer to find its station. */
const WS_ROWS: { d: StationData; y0: number; y1: number }[] = [];

/** The strip's hour and station row under a pointer event, or null off the clickable span. */
export function wsPoint(e: MouseEvent): { svg: SVGSVGElement; t: number; row: (typeof WS_ROWS)[number] | undefined } | null {
  const target = e.target as Element;
  const svg = target.closest<SVGSVGElement>(".ws-svg");
  if (!svg || !target.closest(".ws-hit")) return null;
  const r = svg.getBoundingClientRect();
  const H = svg.viewBox.baseVal.height || r.height;
  const vx = ((e.clientX - r.left) / r.width) * WS.W;
  const vy = ((e.clientY - r.top) / r.height) * H;
  const { t0, t1 } = windStripSpan();
  const t = t0 + ((vx - WS.L) / (WS.W - WS.L - WS.R)) * (t1 - t0);
  if (t < t0 || t > t1) return null;
  return { svg, t, row: WS_ROWS.find((w) => vy >= w.y0 && vy < w.y1) };
}

export function hideWsTip(): void {
  const tip = document.querySelector<HTMLElement>(".ws-tip");
  if (tip) tip.hidden = true;
}

/** The station's wind at an hour, as the strip draws it: measured, else the forecast (or the model under a buoy that
 * is out), with how to act on it. */
export function showWsTip(svg: SVGSVGElement, e: MouseEvent, d: StationData, t: number): void {
  const sec = svg.closest<HTMLElement>(".ws");
  if (!sec) return;
  let tip = sec.querySelector<HTMLElement>(".ws-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip ws-tip";
    sec.append(tip);
  }
  const h = hourOf(t);
  const now = Date.now() / 1000;
  const u = WIND_UNITS[WU].label;
  const obs = h <= now ? d.met?.wind?.at(h) ?? NaN : NaN;
  const f = Number.isFinite(obs) || (h <= now && d.kind !== "buoy") ? null : forecastAt(d.meta.id, h);
  const kt = Number.isFinite(obs) ? obs : f?.spd ?? NaN;
  const from = Number.isFinite(obs) ? d.met?.dir?.at(h) ?? NaN : f?.dir ?? NaN;
  const gust = Number.isFinite(obs) ? d.met?.gust?.at(h) ?? NaN : f?.gust ?? NaN;
  const what = Number.isFinite(obs) ? "measured" : !f ? "" : h > now ? "HRRR forecast" : "HRRR, buoy out";
  const wind = Number.isFinite(kt)
    ? `<div>${Number.isFinite(from) ? windArrow(from, kt < LIGHT_KT) : ""}${windFmt(kt)} ${u}${Number.isFinite(from) ? ` from ${compass(from)}` : ""}<b>${what}</b></div>` +
      (Number.isFinite(gust) ? `<div>gusts ${windFmt(gust)} ${u}</div>` : "")
    : "<div>no reading</div>";
  tip.innerHTML = `<span class="tip-time">${d.meta.name}, ${fmtWhenMin.format(new Date(h * 1000))}</span>${wind}<span class="tip-time ws-tip-hint">click: set the time &middot; double-click: wind chart</span>`;
  tip.hidden = false;
  const box = sec.getBoundingClientRect();
  const x = e.clientX - box.left;
  const right = x > box.width * 0.6;
  tip.style.left = right ? "" : `${x + 14}px`;
  tip.style.right = right ? `${box.width - x + 14}px` : "";
  tip.style.top = `${e.clientY - box.top + 14}px`;
}

export function windColour(kt: number): string {
  const st = WS_STOPS[currentTheme()];
  const v = Math.max(0, Math.min(kt, st[st.length - 1][0]));
  let i = 1;
  while (i < st.length - 1 && v > st[i][0]) i++;
  const [k0, c0] = st[i - 1], [k1, c1] = st[i];
  const f = (v - k0) / (k1 - k0 || 1);
  const ch = (c: string, j: number) => parseInt(c.slice(1 + 2 * j, 3 + 2 * j), 16);
  return `rgb(${[0, 1, 2].map((j) => Math.round(ch(c0, j) + (ch(c1, j) - ch(c0, j)) * f)).join(",")})`;
}

/** The strip's time span (whole hours), shared by the drawing and the click handler. */
function windStripSpan(): { t0: number; t1: number } {
  const now = hourOf(Date.now() / 1000);
  return { t0: now - WS_BACK, t1: now + WS_AHEAD };
}

/** Move a drawn strip's cursor to the page's time; false when the strip is out of date (drawn in an earlier hour),
 * so it must be drawn again. */
export function moveStripCursor(section: HTMLElement): boolean {
  const { t0, t1 } = windStripSpan();
  const svg = section.querySelector<SVGSVGElement>("svg.ws-svg");
  if (!svg || section.dataset.t0 !== String(t0)) return false;
  let line = svg.querySelector<SVGLineElement>(".hi-cursor");
  const cur = AT ?? null;
  if (cur == null || cur < t0 || cur > t1) {
    line?.remove();
    return true;
  }
  if (!line) {
    line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "hi-cursor");
    line.setAttribute("y1", String(WS.top - 2));
    line.setAttribute("y2", String(svg.viewBox.baseVal.height - WS.bot));
    const hit = svg.querySelector(".ws-hit"); // under the clickable span, as drawn
    if (hit) hit.before(line);
    else svg.append(line);
  }
  const x = (WS.L + ((cur - t0) / (t1 - t0)) * (WS.W - WS.L - WS.R)).toFixed(1);
  line.setAttribute("x1", x);
  line.setAttribute("x2", x);
  return true;
}

/** The strip for a waterway ("the Sound"), in the weather view only. */
export function windAcrossHtml(stations: StationData[], waterway: string): string {
  if (M.view() !== "wind") return "";
  if (!ADV) void loadAdvisories();
  if (!FCST) void loadForecast();
  // Buoys always (an outage is shown, not hidden); shore stations only where they measure wind (New London does not).
  const hasWind = (d: StationData) => !!d.met?.wind && Number.isFinite(d.met.wind.lastValid());
  const rows = stations.filter((d) => d.kind === "buoy" || ((d.kind === "shore" || d.kind === "airport") && hasWind(d))).sort((a, b) => a.meta.lon - b.meta.lon);
  if (!rows.length) return "";
  // Zones in the order their first station appears, west to east; stations keep their order within a zone.
  const zoneOrder: string[] = [];
  for (const d of rows) {
    const z = zoneOf(d.meta.id) ?? "";
    if (!zoneOrder.includes(z)) zoneOrder.push(z);
  }
  const groups = zoneOrder.map((z) => ({ z, rows: rows.filter((d) => (zoneOf(d.meta.id) ?? "") === z) }));
  const { W, L: X0, R: XR, top, row, ribbon, gap, bot } = WS;
  WS_ROWS.length = 0;
  const nowS = Date.now() / 1000;
  const { t0, t1 } = windStripSpan();
  const pw = W - X0 - XR;
  const x = (t: number) => X0 + ((t - t0) / (t1 - t0)) * pw;
  const H = top + groups.reduce((h, g) => h + ribbon + 2 + g.rows.length * row, 0) + gap * (groups.length - 1) + bot;
  const u = WIND_UNITS[WU];
  const fmtU = (kt: number) => `${windFmt(kt)} ${u.label}`;
  let g = "";
  g += `<rect x="${x(nowS).toFixed(1)}" y="${top - 2}" width="${(W - XR - x(nowS)).toFixed(1)}" height="${H - top - bot + 2}" class="hi-ahead-band"/>`;
  let y = top;
  for (const grp of groups) {
    // The zone's advisory ribbon.
    g += `<rect x="${X0}" y="${y}" width="${pw}" height="${ribbon}" class="ws-ribbon"/>`;
    if (grp.z) {
      g += `<text x="${X0 - 4}" y="${y + ribbon + 0.5}" text-anchor="end" class="ws-zone">${grp.z}</text>`;
      const name = ADV?.zones[grp.z]?.name ?? grp.z;
      for (const a of advisoriesFor(grp.rows[0].meta.id)) {
        if (!(a.kind in ADV_WIND) || a.t1 <= t0 || a.t0 >= t1) continue;
        const xa = x(Math.max(t0, a.t0)), xb = x(Math.min(t1, a.t1));
        g += `<rect x="${xa.toFixed(1)}" y="${y}" width="${Math.max(0.8, xb - xa).toFixed(1)}" height="${ribbon}" class="ws-adv${ADV_WIND[a.kind] ? " ws-adv-hi" : ""}"><title>${ADV!.kinds[a.kind]}, ${grp.z} (${name}): ${fmtWhenMin.format(new Date(a.t0 * 1000))} to ${fmtWhenMin.format(new Date(a.t1 * 1000))}</title></rect>`;
      }
    }
    y += ribbon + 2;
    for (const d of grp.rows) {
      WS_ROWS.push({ d, y0: y, y1: y + row });
      g += `<text x="${X0 - 4}" y="${(y + row - 1.5).toFixed(1)}" text-anchor="end"><title>${d.meta.name}</title>${d.meta.id}</text>`;
      // Hours merged into runs of the same whole-knot speed and source, so the strip stays a few hundred shapes.
      type Run = { a: number; b: number; kt: number; src: "obs" | "model" | "fcst"; lead?: number };
      const runs: Run[] = [];
      for (let h = t0; h < t1; h += HOUR) {
        const obs = h <= nowS ? d.met?.wind?.at(h) ?? NaN : NaN;
        let kt = obs, src: Run["src"] = "obs", lead: number | undefined;
        if (!Number.isFinite(kt)) {
          // Past hours: a model only where a buoy is out; a shore station's gap stays a gap. Ahead: the forecast.
          if (h <= nowS && d.kind !== "buoy") continue;
          const f = forecastAt(d.meta.id, h);
          if (!f) continue;
          kt = f.spd;
          src = h > nowS ? "fcst" : "model";
          lead = f.lead;
        }
        const q = Math.round(kt);
        const last = runs[runs.length - 1];
        if (last && last.b === h && last.kt === q && last.src === src) last.b = h + HOUR;
        else runs.push({ a: h, b: h + HOUR, kt: q, src, lead });
      }
      for (const r of runs) {
        const xa = x(r.a), w = Math.max(0.6, x(r.b) - xa);
        const what = r.src === "obs" ? "measured" : r.src === "model" ? "HRRR at the station, the newest run for the hour; a model, not a measurement" : "HRRR forecast";
        g += `<rect x="${xa.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${row - 1}" fill="${windColour(r.kt)}"${r.src === "fcst" ? ' opacity="0.8"' : ""}><title>${d.meta.name}: ${fmtU(r.kt)}, ${fmtWhenMin.format(new Date(r.a * 1000))}${r.b - r.a > HOUR ? ` to ${fmtWhenMin.format(new Date(r.b * 1000))}` : ""} (${what})</title></rect>`;
      }
      // Hours where a buoy was out and the model stands in: one dashed outline per stretch, over the colour (dashed
      // marks a model in place of a reading, as on the charts).
      const spans: [number, number][] = [];
      for (const r of runs) {
        if (r.src !== "model") continue;
        const s = spans[spans.length - 1];
        if (s && s[1] === r.a) s[1] = r.b;
        else spans.push([r.a, r.b]);
      }
      for (const [a, b] of spans) g += `<rect x="${x(a).toFixed(2)}" y="${(y + 0.4).toFixed(1)}" width="${Math.max(0.6, x(b) - x(a)).toFixed(2)}" height="${row - 1.8}" class="ws-model" pointer-events="none"/>`;
      // Direction: a downwind arrow every 12 hours on the speed colour, measured where there is a reading, else the
      // forecast (or the model, for a buoy that is out).
      for (let h = Math.ceil(t0 / (12 * HOUR)) * 12 * HOUR + 6 * HOUR; h < t1; h += 12 * HOUR) {
        const obsDir = h <= nowS ? d.met?.dir?.at(h) ?? NaN : NaN;
        const f = Number.isFinite(obsDir) || (h <= nowS && d.kind !== "buoy") ? null : forecastAt(d.meta.id, h);
        const from = Number.isFinite(obsDir) ? obsDir : f?.dir ?? NaN;
        if (!Number.isFinite(from)) continue;
        const kt = Number.isFinite(obsDir) ? d.met?.wind?.at(h) ?? NaN : f?.spd ?? NaN;
        const s = (row - 1) / 12; // the arrow's -6..6 box to the row's height
        const at = `translate(${x(h).toFixed(1)} ${(y + (row - 1) / 2).toFixed(2)}) scale(${s.toFixed(3)}) rotate(${((from + 180) % 360).toFixed(0)})`;
        // The pen darkens with the wind: barely there in light air, full ink from 25 kt.
        const ink = Number.isFinite(kt) ? 0.15 + 0.75 * Math.min(1, Math.max(0, kt - LIGHT_KT) / (25 - LIGHT_KT)) : 0.4;
        g += `<path d="${ARROW_PATH}" transform="${at}" class="ws-dir" opacity="${ink.toFixed(2)}" pointer-events="none"/>`;
      }
      y += row;
    }
    y += gap;
  }
  // Days: a tick at each Eastern midnight, labelled on Mondays; "now" and the page's time.
  const fmtTick = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", weekday: "short", hour: "numeric", hourCycle: "h23" });
  for (let h = t0; h <= t1; h += HOUR) {
    const p = fmtTick.formatToParts(new Date(h * 1000));
    if (p.find((q) => q.type === "hour")?.value !== "00") continue;
    g += `<line x1="${x(h).toFixed(1)}" x2="${x(h).toFixed(1)}" y1="${H - bot}" y2="${H - bot + 2.5}" class="ws-tick"/>`;
    if (p.find((q) => q.type === "weekday")?.value === "Mon")
      g += `<text x="${x(h).toFixed(1)}" y="${H - 2}" text-anchor="middle">${p.find((q) => q.type === "month")!.value} ${p.find((q) => q.type === "day")!.value}</text>`;
  }
  g += `<line x1="${x(nowS).toFixed(1)}" x2="${x(nowS).toFixed(1)}" y1="${top - 4}" y2="${H - bot}" class="ws-now"/><text x="${x(nowS).toFixed(1)}" y="${top - 5}" text-anchor="middle" class="ws-zone">now</text>`;
  const cur = AT ?? null;
  if (cur != null && cur >= t0 && cur <= t1) g += `<line x1="${x(cur).toFixed(1)}" x2="${x(cur).toFixed(1)}" y1="${top - 2}" y2="${H - bot}" class="hi-cursor"/>`;
  // The span the time slider reaches (all of it, in this view): the part a click acts on.
  const r0 = Math.max(t0, nowS - WS_REACH.back), r1 = Math.min(t1, nowS + WS_REACH.ahead);
  g += `<rect x="${x(r0).toFixed(1)}" y="${top - 2}" width="${(x(r1) - x(r0)).toFixed(1)}" height="${H - top - bot + 2}" class="ws-hit"/>`;
  const sw = (fill: string, extra = "") => `<svg width="10" height="9" class="ws-sw" aria-hidden="true"><rect width="10" height="9" fill="${fill}"${extra}/></svg>`;
  const ramp = `<svg width="64" height="9" class="ws-sw" aria-hidden="true"><defs><linearGradient id="ws-ramp">${WS_STOPS[currentTheme()].map(([k, c]) => `<stop offset="${(k / 35).toFixed(3)}" stop-color="${c}"/>`).join("")}</linearGradient></defs><rect width="64" height="9" fill="url(#ws-ramp)"/></svg>`;
  return `<section class="ws" id="${WIND_STRIP_HASH.slice(1)}" data-t0="${t0}" aria-label="Wind across ${waterway}">
    <p class="ol-title">Wind across ${waterway} <span class="ol-src">west to east, by NWS zone; two weeks back, 48 h ahead &middot; click to move the time</span></p>
    <svg viewBox="0 0 ${W} ${H}" class="hi-svg ws-svg" role="img" aria-label="Hourly wind at each station, two weeks back to 48 hours ahead, with NWS advisories">${g}</svg>
    <p class="status-key">0 ${ramp} ${fmtU(35)} &middot; arrows point downwind, darker in stronger wind &middot; <svg width="14" height="9" class="ws-sw" aria-hidden="true"><rect width="14" height="9" fill="${windColour(16)}"/><rect x="0.6" y="0.6" width="12.8" height="7.8" class="ws-model ws-model-key"/></svg>model where a buoy is out &middot; past now: HRRR forecast${(() => { const a = hrrrAsOf(rows[0].meta.id, Array.from({ length: 48 }, (_, i) => hourOf(nowS) + (i + 1) * HOUR)); return a ? `, ${a}` : ""; })()} &middot; ${sw("var(--advisory)", ' opacity="0.45"')}small craft ${sw("var(--advisory)")}gale or stronger (NWS)</p>
  </section>`;
}


