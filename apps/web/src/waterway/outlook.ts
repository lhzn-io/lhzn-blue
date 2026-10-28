/** The outlook under the status table (the weather view): the next 48 hours at one station, every row on the same time
 * axis (wind, gusts, pressure, air, then the wave model at a buoy or the tide at the nearest gauge). Empty until the
 * forecast has loaded. */
import { compass } from "../wind-dir";
import { HOUR } from "../series";
import { fmtWhen, fmtWhenMin } from "./format";
import { waveFmt, waveUnit, WIND_UNITS, windFmt, windVal, WU } from "./units";
import type { FcValue, StationData } from "./station-data";
import { FORECAST_PAGE } from "./data";
import { FCST, forecastAt, hrrrAsOf, loadForecast, runSpread } from "./forecast";
import { loadNwps, NWPS, nwpsAsOf, nwpsAt } from "./nwps";
import { M } from "./models";
import { TIDES } from "./tides";

// "Sat 1 PM": the weekday and the hour, without Intl's comma.
const fmtHourET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
/** "Sat 1p", "Fri 3:34a": short times for the outlook's text column. */
const shortWhen = (ms: number, minutes = false) =>
  (minutes ? fmtWhenMin : fmtWhen).format(new Date(ms)).replace(/:00 /, " ").replace(" AM", "a").replace(" PM", "p");

/** The station the outlook shows (the page's choice until a reader picks another row), and the row under the pointer,
 * shown while it is there. */
export const OUTLOOK: { pin: string; peek: string | null } = { pin: "", peek: null };
const OL_W = 160;
const OL_H = 22;

/** The nearest NOAA tide gauge to a station (a shore station is its own). */
function tideGauge(d: StationData, stations: StationData[]): StationData | undefined {
  if (d.kind === "shore") return d;
  const shore = stations.filter((s) => s.kind === "shore");
  const k = Math.cos((d.meta.lat * Math.PI) / 180);
  const dist = (s: StationData) => (s.meta.lat - d.meta.lat) ** 2 + ((s.meta.lon - d.meta.lon) * k) ** 2;
  return shore.length ? shore.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : undefined;
}

const olX = (t: number, t0: number) => ((t - t0) / (48 * HOUR)) * OL_W;

/** Midnights (Eastern) as faint ticks, so every row reads on the same days. */
function olDays(t0: number): string {
  let out = "";
  for (let h = 1; h < 48; h++) {
    const t = t0 + h * HOUR;
    if (fmtHourET.format(new Date(t * 1000)) === "0") out += `<line x1="${olX(t, t0).toFixed(1)}" x2="${olX(t, t0).toFixed(1)}" y1="0" y2="${OL_H}" stroke="currentColor" opacity="0.18"/>`;
  }
  return out;
}

/** One quantity over the next 48 hours on the outlook's shared time axis, its peak (or low) marked by a tick. */
function olSpark(ts: number[], ys: number[], t0: number, mark: "max" | "min"): string {
  const ok = ys.filter(Number.isFinite);
  if (ok.length < 2) return `<span class="ol-spark"></span>`;
  const a = Math.min(...ok), b = Math.max(...ok);
  const y = (v: number) => OL_H - 3 - ((v - a) / Math.max(1e-6, b - a)) * (OL_H - 6);
  let path = "";
  let pen = false;
  ts.forEach((t, i) => {
    const v = ys[i];
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${olX(t, t0).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const k = ys.indexOf(mark === "max" ? b : a);
  return `<svg class="ol-spark" viewBox="0 0 ${OL_W} ${OL_H}" preserveAspectRatio="none" aria-hidden="true">${olDays(t0)}<path d="${path}" fill="none" stroke="${M.palette().line}" stroke-width="1.4" vector-effect="non-scaling-stroke"/><line x1="${olX(ts[k], t0).toFixed(1)}" x2="${olX(ts[k], t0).toFixed(1)}" y1="${(y(ys[k]) - 5).toFixed(1)}" y2="${(y(ys[k]) + 5).toFixed(1)}" stroke="${M.palette().line}" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
}

/** The tide on the same axis: NOAA's predicted water level as a curve (it shows the unequal highs of the day), with
 * a tick at each high, amber where the high comes within 1 ft of the NWS minor flood level. */
function olTides(g: StationData | undefined, t0: number): string {
  const p = g ? TIDES?.[g.meta.id]?.pred : undefined;
  if (!g || !p) return `<span class="ol-spark"></span>`;
  const p0 = Date.parse(p.t0) / 1000;
  const ts: number[] = [];
  const ys: number[] = [];
  for (let t = t0; t <= t0 + 48 * HOUR; t += p.step) {
    const v = p.ft[Math.round((t - p0) / p.step)];
    ts.push(t);
    ys.push(v == null ? NaN : v);
  }
  const ok = ys.filter(Number.isFinite);
  if (ok.length < 4) return `<span class="ol-spark"></span>`;
  const a = Math.min(...ok), b = Math.max(...ok);
  const y = (v: number) => OL_H - 3 - ((v - a) / Math.max(1e-6, b - a)) * (OL_H - 6);
  let path = "";
  let pen = false;
  ts.forEach((t, i) => {
    if (!Number.isFinite(ys[i])) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${olX(t, t0).toFixed(1)},${y(ys[i]).toFixed(1)}`;
    pen = true;
  });
  const minor = (TIDES?.[g.meta.id]?.flood_ft?.nws_minor ?? null);
  const ticks = g.tides
    .filter((e) => e.type === "H" && Date.parse(e.t) / 1000 > t0 && Date.parse(e.t) / 1000 <= t0 + 48 * HOUR)
    .map((e) => {
      const x = olX(Date.parse(e.t) / 1000, t0).toFixed(1);
      const c = minor != null && minor - e.ft < 1 ? M.palette().delayed : M.palette().line;
      return `<line x1="${x}" x2="${x}" y1="${(y(e.ft) - 5).toFixed(1)}" y2="${(y(e.ft) + 5).toFixed(1)}" stroke="${c}" stroke-width="1.2" vector-effect="non-scaling-stroke"><title>High ${e.ft.toFixed(1)} ft, ${shortWhen(Date.parse(e.t), true)}</title></line>`;
    })
    .join("");
  return `<svg class="ol-spark" viewBox="0 0 ${OL_W} ${OL_H}" preserveAspectRatio="none" aria-hidden="true">${olDays(t0)}<path d="${path}" fill="none" stroke="${M.palette().line}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>${ticks}</svg>`;
}

/** The Outlook, in Wind and waves only: the next 48 hours at one station, every row on the same time axis.
 * Empty until the forecast has loaded. */
export function outlookHtml(stations: StationData[]): string {
  if (M.view() !== "wind") return "";
  if (!FCST) {
    void loadForecast();
    return "";
  }
  const id = OUTLOOK.peek ?? OUTLOOK.pin;
  const d = stations.find((s) => s.meta.id === id) ?? stations.find((s) => s.kind === "buoy");
  if (!d) return "";
  const t0 = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const ts = Array.from({ length: 48 }, (_, h) => t0 + (h + 1) * HOUR);
  const fs = ts.map((t) => forecastAt(d.meta.id, t));
  if (fs.filter(Boolean).length < 6) return "";
  const col = (f: (v: FcValue) => number) => fs.map((v) => (v ? f(v) : NaN));
  const spd = col((v) => v.spd), gust = col((v) => v.gust), pres = col((v) => v.pres), air = col((v) => v.air);
  const at = (ys: number[], best: number) => ts[ys.indexOf(best)] * 1000;
  const fin = (ys: number[]) => ys.filter(Number.isFinite);
  const u = WIND_UNITS[WU].label;
  const pk = Math.max(...fin(spd)), gk = Math.max(...fin(gust)), pl = Math.min(...fin(pres));
  const pkF = fs[spd.indexOf(pk)]!;
  const spread = runSpread(d.meta.id, ts[spd.indexOf(pk)]);
  const g = tideGauge(d, stations);
  const hi = (g?.tides ?? []).find((e) => e.type === "H" && Date.parse(e.t) > Date.now());
  const airs = fin(air);
  const rows: [string, string, string][] = [
    ["Wind", olSpark(ts, spd.map(windVal), t0, "max"),
      `${windFmt(pk)} ${u} ${shortWhen(at(spd, pk))} ${compass(pkF.dir)}${spread ? ` <small class="ol-more">runs ${windFmt(spread[0])}&ndash;${windFmt(spread[1])}</small>` : ""}`],
    ["Gusts", olSpark(ts, gust.map(windVal), t0, "max"), `${windFmt(gk)} ${u} ${shortWhen(at(gust, gk))}`],
    ["Pressure", olSpark(ts, pres, t0, "min"), `${pl.toFixed(0)} mb ${shortWhen(at(pres, pl))}`],
    ["Air", olSpark(ts, air, t0, "max"), airs.length ? `${Math.round(Math.min(...airs))}&ndash;${Math.round(Math.max(...airs))}&deg;F` : "--"],
  ];
  // Waves: the NWS wave model at a buoy (the newest run for each hour), in place of the tide curve; a shore station,
  // which the wave model does not reach, keeps its tide row. The next high tide stays as a line under the rows.
  if (!NWPS) void loadNwps();
  const hs = d.kind === "buoy" ? ts.map((t) => nwpsAt(d.meta.id, t)?.hs ?? NaN) : [];
  const hsOk = fin(hs);
  const tideText = hi ? `high ${hi.ft.toFixed(1)} ft ${shortWhen(Date.parse(hi.t), true)}` : "--";
  if (hsOk.length >= 6) {
    const wu = waveUnit();
    const hk = Math.max(...hsOk);
    const pkW = nwpsAt(d.meta.id, ts[hs.indexOf(hk)]);
    rows.push([`Waves <small>model</small>`, olSpark(ts, hs.map((m) => m * wu.factor), t0, "max"),
      `${waveFmt(hk)} ${wu.label} ${shortWhen(at(hs, hk))}${pkW && Number.isFinite(pkW.tp) ? ` &middot; ${pkW.tp.toFixed(0)} s` : ""} <small class="ol-more">NWPS, ${nwpsAsOf().replace(/^as of the /, "")}</small>`]);
  } else {
    rows.push([g && g !== d ? `Tide <small>${g.meta.name}</small>` : "Tide", olTides(g, t0), tideText]);
  }
  const tideLine = hsOk.length >= 6 && hi
    ? `<p class="status-key ol-tide">High tide ${hi.ft.toFixed(1)} ft, ${shortWhen(Date.parse(hi.t), true)}${g && g !== d ? ` &middot; ${g.meta.name}` : ""}</p>`
    : "";
  // The title and the rows; how to pick a station, the runs behind it and its verification behind the (i).
  return `<section class="outlook" aria-label="The next 48 hours at ${d.meta.name}">
    <p class="ol-title">Next 48 h &middot; ${d.meta.name} <button type="button" class="fig-info ol-info" aria-controls="ol-src" title="About this forecast">i</button><span class="ol-hint">pick a row above</span><span class="ol-src" id="ol-src">NOAA HRRR, raw${(() => { const a = hrrrAsOf(d.meta.id, ts); return a ? `, ${a}` : ""; })()} &middot; <a href="${FORECAST_PAGE}">verified at the buoys</a></span></p>
    ${rows.map(([k, sp, txt]) => `<div class="ol-row"><span class="ol-k">${k}</span>${sp}<span class="ol-v">${txt}</span></div>`).join("")}
    ${tideLine}
  </section>`;
}

