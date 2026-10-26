/**
 * Per-buoy views for a single-depth buoy (the region page's UNH stations), after the Sound page's station figures:
 * this year against earlier years, the last 30 days beside earlier years' median, the 7-day change, and the buoy's
 * weather. Written apart from lis.ts (whose figures depend on its own page state); they take what they need as
 * arguments. Data: the buoy's hourly window (live.json, the last 30 days) and its daily record (history.json).
 */
import { chainButton } from "./links";
import { renderLines, type Area, type Line } from "./chart";
import { Daily, Hourly, yearLines } from "./series";
import { percentileText, seasonalPercentile, SEASONS } from "./trends";

const HOUR = 3600;
const DAY = 86400;

export type BuoyView = "temp" | "salinity" | "oxygen" | "quality" | "weather";
export const BUOY_VIEWS: [BuoyView, string][] = [
  ["temp", "Temperature"], ["salinity", "Salinity"], ["oxygen", "Oxygen"], ["quality", "Water quality"], ["weather", "Weather"],
];

export interface BuoyMeta { id: string; name: string; place: string; depth_m: number; oxygen_unit: string; record_start?: string }
interface Frame { t0: string | null; step: number; [col: string]: unknown }
export interface BuoyCtx {
  buoys: BuoyMeta[];
  live: Record<string, Frame & { last_obs?: Record<string, unknown> | null }> | undefined;
  hist: Record<string, Frame> | undefined;
  now: number;
  wind: { label: string; perKt: number; digits: number };
  colors: { measured: string; second: string; dim: string; asOf: string };
}

/** What each water variable is called and drawn with. */
const VARS: Record<string, { col: string; title: string; unit: (b: BuoyMeta) => string; digits: number; tip: (v: number, b: BuoyMeta) => string }> = {
  temp: { col: "water_f", title: "water temperature", unit: () => "°F", digits: 1, tip: (v) => `${v.toFixed(1)} °F` },
  salinity: { col: "salinity", title: "salinity", unit: () => "", digits: 2, tip: (v) => v.toFixed(2) },
  oxygen: { col: "oxygen", title: "dissolved oxygen", unit: (b) => b.oxygen_unit, digits: 1, tip: (v, b) => `${v.toFixed(1)} ${b.oxygen_unit}` },
  chl: { col: "chl", title: "chlorophyll", unit: () => "mg/m³", digits: 2, tip: (v) => `${v.toFixed(2)} mg/m³` },
  turb: { col: "turb", title: "turbidity", unit: () => "FTU", digits: 1, tip: (v) => `${v.toFixed(1)} FTU` },
};
const VIEW_VARS: Record<Exclude<BuoyView, "weather">, string[]> = { temp: ["temp"], salinity: ["salinity"], oxygen: ["oxygen"], quality: ["chl", "turb"] };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------- Series ----------

function hourly(f: Frame | undefined, col: string): Hourly | null {
  return f?.t0 ? Hourly.fromArray(f.t0, f[col] as (number | null)[] | undefined) : null;
}

/** The daily record, with the days the hourly window covers taken from it (their means): the record's last days are
 * refreshed once a day, the window every hour. */
function daily(ctx: BuoyCtx, id: string, col: string): Daily | null {
  const rec = ctx.hist?.[id];
  const base = rec?.t0 ? Daily.fromArray(rec.t0, rec[col] as (number | null)[] | undefined) : null;
  const h = hourly(ctx.live?.[id], col);
  if (!h) return base;
  const t0 = base ? base.t0 : Math.floor(h.t0 / DAY) * DAY;
  const t1 = Math.floor(ctx.now / DAY) * DAY;
  const v = new Float64Array(Math.round((t1 - t0) / DAY) + 1).fill(NaN);
  base?.v.forEach((x, i) => { if (i < v.length) v[i] = x; });
  for (let d = Math.floor(h.t0 / DAY) * DAY; d <= t1; d += DAY) {
    let sum = 0, n = 0;
    for (let t = d; t < d + DAY; t += HOUR) { const x = h.at(t); if (Number.isFinite(x)) { sum += x; n++; } }
    if (n >= 12) v[Math.round((d - t0) / DAY)] = sum / n; // a day the window covers at least half of
  }
  return new Daily(t0, v);
}

/** Hourly for the percentiles: the daily record spread over its hours, under the hourly window. */
function longHourly(ctx: BuoyCtx, id: string, col: string): Hourly | null {
  const d = daily(ctx, id, col);
  return Hourly.merge(d ? d.toHourly() : null, hourly(ctx.live?.[id], col));
}

/** Earlier years' lines in a muted ink, the newest strongest; this year in the measured gold, on top. */
function yearsOf(s: Daily, xs: number[], ctx: BuoyCtx, label: (v: number) => string): Line[] {
  const lines = yearLines(s, xs, ctx.now).filter((y) => y.offset === 0 || y.coverage >= 0.5);
  const past = lines.filter((y) => y.offset > 0);
  const out: Line[] = past.map((y, i) => ({
    ys: y.values, color: ctx.colors.dim, width: 1, opacity: Math.max(0.22, 0.7 - i * 0.07), label: String(y.year), fmt: label,
  }));
  const cur = lines.find((y) => y.offset === 0);
  if (cur) out.push({ ys: cur.values, color: ctx.colors.measured, width: 2.2, label: String(cur.year), fmt: label });
  return out;
}

const dayGrid = (t0: number, t1: number) => { const xs: number[] = []; for (let t = Math.floor(t0 / DAY) * DAY; t <= t1; t += DAY) xs.push(t); return xs; };
const hourGrid = (t0: number, t1: number) => { const xs: number[] = []; for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) xs.push(t); return xs; };

// ---------- Markup ----------

export function buoyViewSwitchHtml(view: BuoyView, views: [BuoyView, string][] = BUOY_VIEWS): string {
  return `<span class="rg-seg rg-views" role="group" aria-label="Buoy view">${views.map(([k, label]) => `<button type="button" class="rg-btn" data-bview="${k}" aria-pressed="${k === view}">${label}</button>`).join("")}</span>`;
}

const plot = (id: string, label: string) => `<div class="plot rg-plot" id="pl-${id}"><svg role="img" aria-label="${esc(label)}"></svg><div class="plot-labels" aria-hidden="true"></div></div>`;
// The title leads with the buoy's code ("GBB: Wind"), as on every station plot.
const fig = (id: string, title: string, sub: string, label: string) => `<figure class="rg-fig"><figcaption><span class="cap-label"><span class="cap-code">${id.split("-")[0]}</span>: ${esc(title)}</span> <span class="cap-sub">${sub}</span>${chainButton(`pl-${id}`, esc(label))}</figcaption>${plot(id, label)}</figure>`;

function readout(ctx: BuoyCtx, b: BuoyMeta, key: string): string {
  const v = VARS[key];
  const h = hourly(ctx.live?.[b.id], v.col);
  const t = h?.lastValid();
  if (!h || t == null || !Number.isFinite(t)) return `<p class="rg-read"><b>${esc(v.title[0].toUpperCase() + v.title.slice(1))}</b>: no recent readings.</p>`;
  const now = h.at(t);
  const pct = seasonalPercentile(longHourly(ctx, b.id, v.col), SEASONS.water);
  const ctxText = pct ? ` ${percentileText(pct)}` : "";
  return `<p class="rg-read"><b>${esc(v.title[0].toUpperCase() + v.title.slice(1))} ${v.tip(now, b)}</b>${ctxText ? `. ${esc(ctxText.trim())}` : ""}.</p>`;
}

export function buoyCardsHtml(ctx: BuoyCtx, view: BuoyView): string {
  return ctx.buoys.map((b) => {
    const first = ctx.hist?.[b.id]?.t0 as string | undefined;
    const record = first ? `Record from ${new Date(first).getUTCFullYear()}` : "No longer record";
    let body = "";
    if (view === "weather") {
      const w = ctx.live?.[b.id]?.last_obs as Record<string, number | null> | undefined;
      body = `<p class="rg-read">${w?.wind_kt != null ? `<b>Wind ${(w.wind_kt * ctx.wind.perKt).toFixed(ctx.wind.digits)} ${ctx.wind.label}</b>${w.gust_kt != null ? `, gusts ${(w.gust_kt * ctx.wind.perKt).toFixed(ctx.wind.digits)}` : ""}` : "No recent wind"}${w?.air_f != null ? `; air ${w.air_f.toFixed(1)} °F` : ""}${w?.pressure_mb != null ? `; ${w.pressure_mb.toFixed(1)} mbar` : ""}. Direction not shown: UNH flags it suspect.</p>` +
        fig(`${b.id}-wind`, "Wind", `${ctx.wind.label}, the last 30 days: hourly, with each day's peak gust`, `Wind at the ${b.name}`) +
        fig(`${b.id}-air`, "Air and water", "°F, the last 30 days", `Air and water temperature at the ${b.name}`) +
        fig(`${b.id}-pres`, "Pressure", "mbar, the last 30 days", `Pressure at the ${b.name}`);
    } else {
      for (const key of VIEW_VARS[view]) {
        const v = VARS[key];
        const unit = v.unit(b);
        body += readout(ctx, b, key) +
          fig(`${b.id}-${key}-yoy`, "This year against earlier years", `${esc(v.title)}${unit ? `, ${esc(unit)}` : ""}, daily means, the same dates each year`, `${v.title} at the ${b.name}, this year and earlier years`) +
          fig(`${b.id}-${key}-30d`, "The last 30 days", `hourly, with earlier years' median for the dates`, `${v.title} at the ${b.name}, the last 30 days`) +
          fig(`${b.id}-${key}-chg`, "7-day change", `${esc(v.title)} now against a week before, each year`, `7-day change in ${v.title} at the ${b.name}`);
      }
    }
    return `<article class="rg-card rg-buoy" id="st-${b.id}"><h3 class="rg-card-h">${esc(b.name)}${chainButton(`st-${b.id}`, esc(b.name))}</h3><p class="rg-card-sub">${esc(b.place)}. University of New Hampshire, ${b.depth_m} m down. ${record}.</p>${body}</article>`;
  }).join("");
}

// ---------- Drawing ----------

const marks = (ctx: BuoyCtx) => ({ asOfColor: ctx.colors.asOf });

export function drawBuoyFigures(ctx: BuoyCtx, view: BuoyView): void {
  const el = (id: string) => document.getElementById(`pl-${id}`);
  const nowDay = Math.floor(ctx.now / DAY) * DAY;
  for (const b of ctx.buoys) {
    const live = ctx.live?.[b.id];
    if (view === "weather") {
      const xs = hourGrid(ctx.now - 30 * DAY, ctx.now);
      const at = (col: string, scale = 1) => { const h = hourly(live, col); return xs.map((t) => (h ? h.at(t) * scale : NaN)); };
      const k = ctx.wind.perKt;
      const gusts = hourly(live, "gust_kt");
      const gustDaily = xs.map((t) => {
        if (!gusts || t % DAY !== 12 * HOUR) return NaN; // one dot a day, at noon UTC: the day's peak
        let m = -Infinity;
        for (let s = t - 12 * HOUR; s < t + 12 * HOUR; s += HOUR) { const x = gusts.at(s); if (Number.isFinite(x) && x > m) m = x; }
        return Number.isFinite(m) ? m * k : NaN;
      });
      const wfmt = (v: number) => `${v.toFixed(ctx.wind.digits)} ${ctx.wind.label}`;
      const w = el(`${b.id}-wind`);
      if (w) renderLines(w, { xs, unit: ` ${ctx.wind.label}`, ...marks(ctx), empty: "No wind readings.", lines: [
        { ys: gustDaily, color: ctx.colors.second, dots: true, width: 3, label: "Day's peak gust", fmt: wfmt },
        { ys: at("wind_kt", k), color: ctx.colors.measured, width: 1.4, label: "Wind", fmt: wfmt },
      ] });
      const a = el(`${b.id}-air`);
      if (a) renderLines(a, { xs, unit: "°F", ...marks(ctx), empty: "No readings.", lines: [
        { ys: at("air_f"), color: ctx.colors.second, width: 1.2, label: "Air", fmt: (v) => `${v.toFixed(1)} °F` },
        { ys: at("water_f"), color: ctx.colors.measured, width: 1.8, label: "Water", fmt: (v) => `${v.toFixed(1)} °F` },
      ] });
      const p = el(`${b.id}-pres`);
      if (p) renderLines(p, { xs, unit: "", ...marks(ctx), empty: "No pressure readings.", lines: [
        { ys: at("pressure_mb"), color: ctx.colors.measured, width: 1.6, label: "Pressure", fmt: (v) => `${v.toFixed(1)} mbar` },
      ] });
      continue;
    }
    for (const key of VIEW_VARS[view]) {
      const v = VARS[key];
      const fmt = (x: number) => v.tip(x, b);
      const d = daily(ctx, b.id, v.col);
      // This year against earlier years: 96 days back to 14 ahead, as on the Sound page.
      const yoy = el(`${b.id}-${key}-yoy`);
      const yxs = dayGrid(nowDay - 96 * DAY, nowDay + 14 * DAY);
      if (yoy) renderLines(yoy, { xs: yxs, unit: v.unit(b) ? ` ${v.unit(b)}` : "", ...marks(ctx), empty: "No record for these dates.", lines: d ? yearsOf(d, yxs, ctx, fmt) : [] });
      // The last 30 days, hourly, with the median of earlier years' daily values for each date (where there are 3).
      const thirty = el(`${b.id}-${key}-30d`);
      const hxs = hourGrid(ctx.now - 30 * DAY, ctx.now);
      const h = hourly(live, v.col);
      const med = hxs.map((t) => {
        if (!d) return NaN;
        const vals = yearLines(d, [t], ctx.now).filter((y) => y.offset > 0).map((y) => y.values[0]).filter(Number.isFinite).sort((p, q) => p - q);
        return vals.length >= 3 ? vals[Math.floor(vals.length / 2)] : NaN;
      });
      const spread = hxs.map((t) => {
        if (!d) return [NaN, NaN];
        const vals = yearLines(d, [t], ctx.now).filter((y) => y.offset > 0).map((y) => y.values[0]).filter(Number.isFinite).sort((p, q) => p - q);
        return vals.length >= 3 ? [vals[0], vals[vals.length - 1]] : [NaN, NaN];
      });
      const areas: Area[] = [{ lo: spread.map((s) => s[0]), hi: spread.map((s) => s[1]), fill: ctx.colors.dim, opacity: 0.12 }];
      if (thirty) renderLines(thirty, { xs: hxs, unit: v.unit(b) ? ` ${v.unit(b)}` : "", areas, ...marks(ctx), empty: "No readings in the last 30 days.", lines: [
        { ys: med, color: ctx.colors.dim, width: 1, dash: "4 3", label: "Earlier years' median", fmt },
        { ys: hxs.map((t) => (h ? h.at(t) : NaN)), color: ctx.colors.measured, width: 1.6, label: "Hourly", fmt },
      ] });
      // 7-day change, each year: the daily value against the one a week before.
      const chg = el(`${b.id}-${key}-chg`);
      if (chg) {
        const c = d ? new Daily(d.t0 + 7 * DAY, d.v.map((x, i) => (i + 7 < d.v.length ? d.v[i + 7] - x : NaN))) : null;
        renderLines(chg, { xs: yxs, unit: v.unit(b) ? ` ${v.unit(b)}` : "", zero: true, ...marks(ctx), empty: "No record for these dates.",
          lines: c ? yearsOf(c, yxs, ctx, (x) => `${x >= 0 ? "+" : ""}${fmt(x)}`) : [] });
      }
    }
  }
}
