/** The next 48 hours at a station: wind and gusts measured for the last day and a half, then HRRR's stitched forecast
 * with its typical miss at each lead, the earlier runs faint behind it, and the wind's direction along the top. Past
 * HRRR's reach, GFS in its own color with its own typical miss; "7 days" on the plot widens the window to GFS's. GFS
 * runs beside HRRR's last day as well, in the same pen, so the step where one model hands over to the other reads as the models'
 * difference. Gusts in each source's color: gray measured, lavender HRRR, green GFS (both over HRRR's last day). Along
 * the bottom, a thin faint strip marks the hours the forecast reaches NWS's small craft or gale level, and a stronger
 * one the hours an advisory is in force for the station's zone. */
import type { Line } from "@lhzn-io/timecharts/chart";
import { DAY, grid, HOUR } from "@lhzn-io/timecharts/series";
import { compass, measuredOr, windGlyphs, type WindAt } from "@lhzn-io/timecharts/wind-dir";
import { requestRedraw } from "./data";
import { fmtRun } from "./format";
import { WIND_UNITS, windFmt, windVal, WU } from "./units";
import type { Fig } from "./figures";
import { FCST, forecastAt, gfsAt, gfsBefore, gfsLabels, gfsRuns, gfsRunWind, gfsTag, loadForecast, MS_KT, verTag, vintageLabel, vintageRuns, type FcRun } from "./forecast";
import { revisionsOn } from "./revisions";
import type { FcValue } from "./station-data";
import { M } from "./models";
import { ADV, loadAdvisories, windAdvisorySpans, zoneOf } from "./advisories";
import { loadVirtualWind, virtualMiss } from "./virtual";

const GFS_AHEAD = 168 * HOUR; // GFS's last lead here (the jobs' gfs.LAST_LEAD)
const GFS_PAST_OPACITY = 0.3; // GFS's record (earlier runs, and its last forecast before each hour): one faint pen
const BESIDE = 24 * HOUR; // how far back from HRRR's last hour GFS is drawn beside it
// NWS marine criteria (sustained wind, kt) for the zones here: a small craft advisory from 25 kt, a gale warning from 34.
const LEVELS: [number, string][] = [[25, "Small craft advisory level, 25 kt"], [34, "Gale warning level, 34 kt"]];
const LONG_KEY = "lhzn-blue-7days";
let long = (() => {
  try {
    return localStorage.getItem(LONG_KEY) === "1";
  } catch {
    return false;
  }
})();
const longListeners = new Set<(on: boolean) => void>();
/** Whether the plot shows 7 days ahead (GFS's reach) rather than 48 h; remembered in this browser. */
export const longRange = (): boolean => long;
export const onLongRange = (fn: (on: boolean) => void): void => void longListeners.add(fn);
/** The plot's name, which follows the switch. */

/** The "7 days" switch on a next 48 hours plot (inline or expanded). */
export function mountLongRange(plot: HTMLElement): void {
  plot.querySelector(".range-switch")?.remove();
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "range-switch";
  sw.textContent = "7 days";
  sw.title = "Show the next 7 days: GFS past HRRR's 48 hours";
  sw.setAttribute("aria-pressed", String(long));
  plot.append(sw);
  for (const type of ["pointerdown", "mousedown", "touchstart"]) sw.addEventListener(type, (e) => e.stopPropagation());
  sw.addEventListener("click", (e) => {
    e.stopPropagation(); // not the plot's own click (expand, or a page's time)
    long = !long;
    try {
      localStorage.setItem(LONG_KEY, long ? "1" : "0");
    } catch {
      /* private mode: for this page only */
    }
    document.querySelectorAll(".range-switch").forEach((b) => b.setAttribute("aria-pressed", String(long)));
    longListeners.forEach((fn) => fn(long));
    requestRedraw();
  });
}

export const NEXT48: Fig = {
  title: "Wind", // the next 48 hours, or 7 days with the switch on
  varies: false,
  wide: true, // the plot a reader looks ahead with: the full width, like the map and table above
  in: (k) => k === "wind",
  sub: "",
  depthTabs: false,
  seasonal: false,
  available: (d) => d.kind === "buoy" || d.kind === "shore" || d.kind === "airport" || d.kind === "virtual", // every station has HRRR runs (a virtual buoy, its HRRR cell's); drawn once they load
  window: () => {
    const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
    return [now - 36 * HOUR, now + (long ? GFS_AHEAD : 48 * HOUR)];
  },
  reach: () => Math.floor(Date.now() / 1000 / HOUR) * HOUR + GFS_AHEAD, // the zoom reaches GFS's last hour
  maxSpan: 9 * DAY,
  build: (d, _depth, x0, x1) => {
    if (!FCST) void loadForecast();
    const virtual = d.kind === "virtual";
    if (virtual) loadVirtualWind();
    const xs = grid(x0, x1, 400).map((t) => Math.round(t / HOUR) * HOUR);
    const u = WIND_UNITS[WU];
    const fmtU = (v: number) => `${v.toFixed(u.digits)} ${u.label}`;
    const now = Date.now() / 1000;
    const runs = FCST?.runs[d.meta.id] ?? [];
    const newest = runs.find((r) => r.issue <= now);
    const at = (r: FcRun, t: number) => {
      const i = r.leads.indexOf(Math.round((t - r.issue) / HOUR));
      const uu = r.u[i], vv = r.v[i];
      return i < 0 || uu == null || vv == null ? NaN : Math.hypot(uu, vv) * MS_KT;
    };
    // Earlier runs, faint and fainter with age: where they agree the forecast is settled; where they fan out it is not.
    // A virtual buoy's runs are pieces of the map's grid file (each hour from its newest run), so none is drawn alone.
    const older = virtual ? [] : vintageRuns(d.meta.id, x0, x1).filter((r) => r !== newest).reverse();
    const runLines: Line[] = older.map((r, i) => ({
      ys: xs.map((t) => windVal(at(r, t))),
      color: M.palette().line,
      width: 0.8,
      opacity: 0.32 - (0.24 * i) / Math.max(1, older.length - 1),
      label: `HRRR run ${fmtRun.format(new Date(r.issue * 1000))}`,
      tip: false,
    }));
    // Ahead of now: for each hour, the newest run that reaches it (most runs reach 18 h, the 00, 06, 12 and 18 UTC
    // runs 48 h), with that lead's typical error.
    const ahead = xs.map((t) => (t >= Math.floor(now / HOUR) * HOUR ? forecastAt(d.meta.id, t) : null));
    const fc = ahead.map((f) => (f ? f.spd : NaN));
    const err = (t: number) => ahead[xs.indexOf(t)]?.err ?? NaN;
    // From HRRR's last hour: GFS, newest run, with GFS's own typical miss (once HRRR has loaded, so the two never
    // overlap while one is still on its way). GFS starts on that hour, so the two lines meet rather than leave a gap.
    const hrrrEnd = ahead.reduce((e, f, i) => (f ? xs[i] : e), -Infinity);
    const nowH0 = Math.floor(now / HOUR) * HOUR;
    const gAhead: (FcValue | null)[] = xs.map((t) => (FCST && t >= hrrrEnd && t >= nowH0 ? gfsAt(d.meta.id, t) : null));
    const g = gAhead.map((f) => (f ? f.spd : NaN));
    const hasGfs = g.some(Number.isFinite);
    // GFS's typical miss over all of GFS's line: beside HRRR's last day as well as past it (the two bands may overlap).
    const gAll: (FcValue | null)[] = xs.map((t) => (FCST && t >= nowH0 && t > hrrrEnd - BESIDE - HOUR ? gfsAt(d.meta.id, t) : null));
    const gErr = gAll.map((f) => f?.err ?? NaN);
    // GFS beside HRRR from now to the handoff, in the same pen as past it: one GFS line across the forecast.
    const beside = xs.map((t) => (FCST && t <= hrrrEnd && t >= nowH0 ? (gfsAt(d.meta.id, t)?.spd ?? NaN) : NaN));
    // Before now: GFS's last forecast before each hour, thin, so GFS's record runs across the whole window too.
    const gPast = xs.map((t) => (FCST && !virtual && t <= nowH0 ? gfsBefore(d.meta.id, t) : NaN));
    const hasPast = gPast.some(Number.isFinite);
    const hasBeside = beside.some(Number.isFinite);
    // With Revisions on (its run slider reaches GFS too), GFS's earlier runs issued in the window (or the 6 hours before
    // it), faint as HRRR's, each over all the hours it reaches.
    const gOlder = revisionsOn() && !virtual && FCST ? gfsRuns(d.meta.id).slice(1).filter((r) => r.issue >= x0 - 6 * HOUR) : [];
    const gfsRunLines: Line[] = gOlder.map((r) => ({
      ys: xs.map((t) => {
        const w = gfsRunWind(r, t, 12);
        return w ? windVal(Math.hypot(w.u, w.v) * MS_KT) : NaN;
      }),
      color: M.palette().gfs,
      width: 0.8,
      opacity: GFS_PAST_OPACITY,
      label: gfsLabels(d.meta.id, r)[0],
      tip: false,
    }));
    const m = d.met;
    const vm = virtual ? virtualMiss() : null;
    if (!ADV) void loadAdvisories();
    const zone = zoneOf(d.meta.id);
    const inForce = windAdvisorySpans(d.meta.id, x0, x1);
    // The hours the forecast (HRRR, then GFS) reaches an NWS level, sustained: a fainter strip under any advisory NWS
    // has issued, so a blow the forecast shows reads along the bottom before (or without) an advisory.
    const reach: { x0: number; x1: number; rank: 0 | 1 }[] = [];
    xs.forEach((t, i) => {
      if (i > 0 && t === xs[i - 1]) return;
      const v = Number.isFinite(fc[i]) ? fc[i] : g[i];
      const rank = v >= LEVELS[1][0] ? 1 : v >= LEVELS[0][0] ? 0 : -1;
      if (rank < 0) return;
      const a = Math.max(now, t - HOUR / 2), b = t + HOUR / 2;
      const last = reach[reach.length - 1];
      if (last && last.rank === rank && a <= last.x1 + 1) last.x1 = b;
      else reach.push({ x0: a, x1: b, rank: rank as 0 | 1 });
    });
    const reachTitle = (r: { rank: 0 | 1; x0: number; x1: number }) =>
      `Forecast at the ${r.rank ? "gale warning level, 34 kt" : "small craft advisory level, 25 kt"} (sustained): ${fmtRun.format(new Date(r.x0 * 1000))} to ${fmtRun.format(new Date(r.x1 * 1000))}`;
    // A virtual buoy has no measurement: before now, HRRR's newest run for each hour stands in its place, labelled.
    const past = virtual ? xs.map((t) => (t < nowH0 ? (forecastAt(d.meta.id, t)?.spd ?? NaN) : NaN)) : [];
    const lines: Line[] = [
      ...runLines,
      ...gfsRunLines,
      ...(virtual ? [{ ys: past.map((v) => windVal(v)), color: M.palette().line, width: 1.4, opacity: 0.7, label: "HRRR before now", tipLabel: "HRRR", fmt: fmtU }] : []),
      { ys: fc.map((_, i) => err(xs[i])), color: M.palette().miss, label: vm?.label ?? "Typical miss at the buoys", hidden: true, tip: false, fmt: (v) => `&plusmn;${windFmt(v)} ${u.label}` },
      { ys: gErr, color: M.palette().gfs, label: "GFS typical miss", hidden: true, tip: false, fmt: (v) => `&plusmn;${windFmt(v)} ${u.label}` },
      // Forecast gusts in their model's color; over HRRR's last day both, as both lines are drawn there.
      { ys: ahead.map((f) => windVal(f?.gust ?? NaN)), color: M.palette().miss, opacity: 0.9, label: "Gust, HRRR", tipLabel: "HRRR gust", dots: true, fmt: fmtU },
      { ys: gAll.map((f) => windVal(f?.gust ?? NaN)), color: M.palette().gfs, opacity: 0.6, label: "Gust, GFS", tipLabel: "GFS gust", dots: true, fmt: fmtU },
      { ys: fc.map((v) => windVal(v)), color: M.palette().line, width: 2, dash: "6 3", label: "Stitched forecast", tipLabel: "HRRR stitched", fmt: fmtU },
      { ys: g.map((v) => windVal(v)), color: M.palette().gfs, width: 2, dash: "6 3", label: "GFS forecast", tipLabel: "GFS", fmt: fmtU },
      { ys: beside.map((v) => windVal(v)), color: M.palette().gfs, width: 2, dash: "6 3", label: "GFS beside HRRR", tipLabel: "GFS", fmt: fmtU },
      { ys: gPast.map((v) => windVal(v)), color: M.palette().gfs, width: 0.8, opacity: GFS_PAST_OPACITY, label: "GFS before now", tipLabel: "GFS", fmt: fmtU },
      { ys: xs.map((t) => windVal(m?.gust?.at(t) ?? NaN)), color: M.palette().contrast, opacity: 0.55, label: "Gust, measured", tipLabel: "Measured gust", dots: true, fmt: fmtU },
      { ys: xs.map((t) => windVal(m?.wind?.at(t) ?? NaN)), color: M.palette().now, width: 2.2, label: "Wind, measured", tipLabel: "Measured", fmt: fmtU },
      { ys: xs.map((t) => m?.dir?.at(t) ?? NaN), color: M.palette().line, label: "From", hidden: true, tip: false, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
    ];
    // The run whose line is nearest the pointer at the hovered hour (the vintage slider follows it).
    const pick = (i: number, yv: number) => {
      const vals = vintageRuns(d.meta.id, x0, x1).map((r) => ({ r, y: windVal(at(r, xs[i])) })).filter((x) => Number.isFinite(x.y));
      if (!vals.length) return null;
      return vintageLabel(d.meta.id, vals.reduce((a, b) => (Math.abs(b.y - yv) < Math.abs(a.y - yv) ? b : a)).r);
    };
    // Direction: measured up to now (gold), HRRR's dashed in slate where there is no observation, then the
    // stitched forecast's (slate).
    const nowH = Math.floor(now / HOUR) * HOUR;
    const model = (t: number) => {
      const f = forecastAt(d.meta.id, t);
      if (f) return { from: f.dir, kt: f.spd, color: M.palette().line };
      const gf = FCST && t > hrrrEnd && t >= nowH ? gfsAt(d.meta.id, t) : null;
      return gf ? { from: gf.dir, kt: gf.spd, color: M.palette().gfs } : null;
    };
    const windAt = (t: number): WindAt | null => (t <= nowH ? measuredOr(m?.dir?.at(t) ?? NaN, m?.wind?.at(t) ?? NaN, M.palette().now, () => model(t)) : model(t));
    const glyphs = windGlyphs(x0, x1, windAt);
    return {
      opts: {
        xs, lines, glyphs, unit: ` ${u.label}`, zero: true, marker: { x: now, label: "now" },
        spans: [
          ...reach.map((r) => ({ x0: r.x0, x1: r.x1, fill: M.palette().levelStrip[r.rank], title: reachTitle(r), edge: 3 })),
          ...inForce.map((s) => ({ x0: s.x0, x1: s.x1, fill: M.palette().advisoryStrip[s.rank], title: s.title, edge: 5 })),
        ], empty: virtual ? "HRRR at this point is loading." : "No forecast or measurement in this window.", pick: virtual ? undefined : pick,
        areas: [
          // Both bands start at now: before it, the measurement is the record, not a forecast to miss.
          { lo: fc.map((v, i) => windVal(Math.max(0, v - err(xs[i])))), hi: fc.map((v, i) => windVal(v + err(xs[i]))), fill: M.palette().miss, opacity: 0.22, from: now },
          ...(gAll.some(Boolean) ? [{ lo: gAll.map((f) => (f ? windVal(Math.max(0, f.spd - f.err)) : NaN)), hi: gAll.map((f) => (f ? windVal(f.spd + f.err) : NaN)), fill: M.palette().gfs, opacity: 0.12, from: now }] : []),
        ],
      },
      legend: [
        ...(virtual ? ([["HRRR before now", M.palette().line, 0.7, "Before now"]] as [string, string, number, string][]) : ([["Measured", M.palette().now, 1]] as [string, string, number][])),
        ["Stitched forecast", M.palette().line, 1, "HRRR"], ["", M.palette().miss, 0.5, "HRRR error", "band"],
        ...(hasGfs ? ([["GFS forecast", M.palette().gfs, 1, "GFS"], ["", M.palette().gfs, 0.4, "GFS error", "band"]] as [string, string, number, string?, "band"?][]) : []),
        ...(hasBeside && !hasGfs ? ([["GFS beside HRRR", M.palette().gfs, 1, "GFS"]] as [string, string, number, string][]) : []),
      ],
      note: vm ? vm.note : `NOAA HRRR, raw &middot; the shading is HRRR's typical miss at each lead, ${verTag()}` +
        (hasGfs ? ` &middot; past HRRR's 48 hours, NOAA GFS (0.25&deg;, raw), shaded with its own typical miss, ${gfsTag()}` : "") +
        (hasBeside ? ` &middot; GFS also runs beside HRRR from now: where they part, the step at the handoff is the models' difference` : "") +
        (hasPast ? ` &middot; before now, GFS's last forecast before each hour` : "") +
        ` &middot; gusts: gray measured, lavender HRRR, green GFS` +
        (inForce.length ? ` &middot; brick along the bottom: an NWS advisory in force for zone ${zone}` : "") +
        (reach.length ? ` &middot; the fainter, thinner strip along the bottom: the hours the forecast reaches NWS's small craft level (25 kt sustained${reach.some((r) => r.rank) ? "; darker, gale, 34 kt" : ""})` : ""),
    };
  },
};
