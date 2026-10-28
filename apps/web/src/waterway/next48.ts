/** The next 48 hours at a station: wind and gusts measured for the last day and a half, then HRRR's stitched forecast
 * with its typical miss at each lead, the earlier runs faint behind it, and the wind's direction along the top. */
import type { Line } from "../chart";
import { DAY, grid, HOUR } from "../series";
import { compass, measuredOr, windGlyphs, type WindAt } from "../wind-dir";
import { fmtRun } from "./format";
import { WIND_UNITS, windFmt, windVal, WU } from "./units";
import type { Fig } from "./figures";
import { FCST, forecastAt, loadForecast, MS_KT, verTag, vintageLabel, vintageRuns, type FcRun } from "./forecast";
import { M } from "./models";

export const NEXT48: Fig = {
  title: "The next 48 hours",
  varies: false,
  wide: true, // the plot a reader looks ahead with: the full width, like the map and table above
  in: (k) => k === "wind",
  sub: "wind and gusts, measured and forecast",
  depthTabs: false,
  seasonal: false,
  available: (d) => d.kind === "buoy" || d.kind === "shore" || d.kind === "airport", // every station has HRRR runs; drawn once they load
  window: () => {
    const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
    return [now - 36 * HOUR, now + 48 * HOUR];
  },
  maxSpan: 7 * DAY,
  build: (d, _depth, x0, x1) => {
    if (!FCST) void loadForecast();
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
    const older = vintageRuns(d.meta.id, x0, x1).filter((r) => r !== newest).reverse();
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
    const m = d.met;
    const lines: Line[] = [
      ...runLines,
      { ys: fc.map((_, i) => err(xs[i])), color: M.palette().miss, label: "Typical miss at the buoys", hidden: true, tip: false, fmt: (v) => `&plusmn;${windFmt(v)} ${u.label}` },
      { ys: ahead.map((f) => (f ? windVal(f.gust) : NaN)), color: M.palette().contrast, opacity: 0.5, label: "Forecast gust", dots: true, fmt: fmtU },
      { ys: fc.map((v) => windVal(v)), color: M.palette().line, width: 2, dash: "6 3", label: "Stitched forecast", fmt: fmtU },
      { ys: xs.map((t) => windVal(m?.gust?.at(t) ?? NaN)), color: M.palette().contrast, opacity: 0.55, label: "Gust, measured", dots: true, fmt: fmtU },
      { ys: xs.map((t) => windVal(m?.wind?.at(t) ?? NaN)), color: M.palette().now, width: 2.2, label: "Wind, measured", fmt: fmtU },
      { ys: xs.map((t) => m?.dir?.at(t) ?? NaN), color: M.palette().line, label: "From", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
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
      return f ? { from: f.dir, kt: f.spd, color: M.palette().line } : null;
    };
    const windAt = (t: number): WindAt | null => (t <= nowH ? measuredOr(m?.dir?.at(t) ?? NaN, m?.wind?.at(t) ?? NaN, M.palette().now, () => model(t)) : model(t));
    const glyphs = windGlyphs(x0, x1, windAt);
    return {
      opts: {
        xs, lines, glyphs, unit: ` ${u.label}`, zero: true, marker: { x: now, label: "now" }, empty: "No forecast or measurement in this window.", pick,
        areas: [{ lo: fc.map((v, i) => windVal(Math.max(0, v - err(xs[i])))), hi: fc.map((v, i) => windVal(v + err(xs[i]))), fill: M.palette().miss, opacity: 0.22 }],
      },
      legend: [["Measured", M.palette().now, 1], ["Stitched forecast", M.palette().line, 1], ["Typical miss (shaded)", M.palette().miss, 0.5], ["Gusts", M.palette().contrast, 0.55], ["Earlier forecasts", M.palette().line, 0.3]],
      note: `NOAA HRRR, raw &middot; the shading is HRRR's typical miss at each lead, ${verTag()}`,
    };
  },
};
