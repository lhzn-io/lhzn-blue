/** The status table's cells and the map's pins for a waterway's stations, at the page's time (waterway/cursor.ts):
 * the latest readings at now, observations at a past hour, the forecast ahead, and a model's value under a fault,
 * marked as a model. The page supplies its models (forecast, wave model, tide predictions) and its view through
 * configureModels (waterway/models.ts). */
import { compass, LIGHT_KT, windArrow } from "../wind-dir";
import { DO_LEVELS, HOUR, oxygenStatus, type LastObs } from "../series";
import type { Pin } from "../map";
import { ago, f1, feet, fmtClock, fmtDate, fmtRun, fmtUtc, fmtWhenMin, hourOf, lastValue, signed, signedFt, tideText } from "./format";
import { AT, atFuture, atLabel, sparklineOf } from "./cursor";
import { waveFmt, waveUnit, WIND_UNITS, windFmt, WU } from "./units";
import {
  DELAYED_HOURS, DEPTH_LABEL, DEPTHS, isWater, nextTide, obsState, OFFLINE_HOURS, overallState, unitName, WATER_VARS,
  type FcValue, type StationData, type VarKey,
} from "./station-data";
import { M } from "./models";
import { departure, predictedHour, TIDES } from "./tides";
import { forecastAt, standIn, typicalError, verTag } from "./forecast";
import { loadNwps, NWPS, nwpsAt } from "./nwps";

const V = () => WATER_VARS[M.view()];

/**
 * The last 7 days of hourly temperature as a tiny line, scaled to its own week's range: the vertical
 * exaggeration makes a 1-degree swing visible. The range is in the tooltip, so the shape is never read
 * as an absolute value.
 */
export function sparkline(d: StationData, depth: string, color: string): string {
  const h = d.hourly[depth];
  return h ? sparklineOf(h, color, unitName(M.view()), V().digits) : "";
}

/** A table cell at the cursor's time: the observed value where the record covers it, "--" otherwise. */
export function atCell(v: number, shown: string, title: string, spark = "", extra = ""): string {
  if (!Number.isFinite(v)) return `<td class="offline">${spark}<b>--</b><small>${atFuture() ? "no forecast" : "no reading"}</small></td>`;
  return `<td class="asof" title="${title}, observed ${atLabel(AT!)}">${spark}<b>${shown}</b><small>${extra || "observed"}</small></td>`;
}

/** A station's observed value of a variable at a depth and time (temperature in &deg;F): the hourly record where it
 * covers the time, NaN otherwise (no station forecasts before M8). The table, the pins and both prompts read values
 * at the cursor through this, so they agree. A variable not yet loaded (its view never opened) gives NaN. */
export function valueAt(d: StationData, k: VarKey, depth: string, t: number): number {
  const h = k === M.view() ? d.hourly : (k === "temp" ? d.temp : d.views[k])?.hourly;
  return h?.[depth]?.at(t) ?? NaN;
}

/** A pin's water value: the view's variable with its unit. */
export const pinValue = (k: VarKey, v: number) => (k === "temp" ? `${f1(v)}&deg;F` : k === "salinity" ? `salinity ${v.toFixed(2)}` : `oxygen ${v.toFixed(1)} mg/L`);

/** A reading transcribed from the LISICOS panel image (while their server is down): tagged in the cell and noted in
 * its tooltip and readout. LISICOS's observation, read by us; provisional until the server's own record returns. */
export const PANEL_NOTE = "transcribed from the LISICOS station panel image while their data server is down; provisional";
export const panelTag = (o?: { source?: string } | null) => (o?.source === "panel" ? " &middot; panel" : "");
export const panelTitle = (o?: { source?: string } | null) => (o?.source === "panel" ? `; ${PANEL_NOTE}` : "");

/** A table cell holding a forecast: marked as HRRR, with its typical error, never as a measurement. */
export function fcCell(f: FcValue, shown: string, title: string, errText: string): string {
  return `<td class="fcst" title="${title}. HRRR forecast from the ${fmtRun.format(new Date(f.issue * 1000))} run, ${f.lead} h ahead; typically within ${errText} at this lead (verified at the buoys)."><b>${shown}</b><small>HRRR ${errText}</small></td>`;
}

export function runText(issue: number, lead: number): string {
  return `${fmtRun.format(new Date(issue * 1000))} run, ${lead} h ahead`;
}

/** A fault cell with the model's value under it: the fault first ("--", why), then the model, marked as such. */
export function standInCell(fault: string, faultTitle: string, model: string, modelTitle: string, cls = ""): string {
  return `<td class="offline standin${cls ? ` ${cls}` : ""}" title="${faultTitle}"><b>--</b><small>${fault}</small><small class="model" title="${modelTitle}. A model value, not a measurement; the buoy's own sensor is out.">${model}</small></td>`;
}

export function windModelCell(d: StationData, t: number, fault: string, faultTitle: string): string | null {
  const f = standIn(d, t);
  if (!f) return null;
  const u = WIND_UNITS[WU].label;
  return standInCell(fault, faultTitle, `model ${compass(f.dir)} ${windFmt(f.spd)} ${u}`, `HRRR at the buoy: wind ${windFmt(f.spd)} ${u} from ${compass(f.dir)}, gusts ${windFmt(f.gust)} ${u}; ${runText(f.issue, f.lead)}, typically within ${windFmt(f.err)} ${u}`);
}

export function cellHtml(d: StationData, depth: string): string {
  if (d.kind === "shore" && M.view() !== "temp") return `<td class="na" title="Not measured at this station">&middot;</td>`;
  if (!d.depths.includes(depth)) return `<td class="na" title="No ${DEPTH_LABEL[depth].toLowerCase()} sensor published">&middot;</td>`;
  if (AT != null) {
    const v = valueAt(d, M.view(), depth, AT);
    return atCell(v, v.toFixed(V().digits) + (M.view() === "temp" ? "&deg;" : ""), `${DEPTH_LABEL[depth]}: ${v.toFixed(V().digits)} ${unitName(M.view())}`, sparkline(d, depth, M.palette().now));
  }
  const o = d.obs[depth];
  const state = obsState(o);
  const value = o ? V().obs(o) : null;
  if (!o || value == null) return `<td class="offline">--</td>`;
  if (state === "offline") {
    // An old reading is not a current condition: show the outage, not the value.
    const since = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", year: "numeric" }).format(new Date(o.time));
    return `<td class="offline" title="${DEPTH_LABEL[depth]}: last reading ${fmtUtc(o.time)}"><b>--</b><small>since ${since}</small></td>`;
  }
  const shown = value.toFixed(V().digits) + (M.view() === "temp" ? "&deg;" : "");
  // Oxygen under the hypoxia level is marked in the cell, not only by color.
  const low = M.view() === "oxygen" && value < DO_LEVELS.hypoxic;
  const status = M.view() === "oxygen" ? `, ${oxygenStatus(value)}` : "";
  return `<td class="${state}${low ? " low" : ""}" title="${DEPTH_LABEL[depth]}: ${value.toFixed(V().digits)} ${unitName(M.view())}${status}, ${ago(o.time)}${panelTitle(o)}">${sparkline(d, depth, state === "live" ? M.palette().now : M.palette().delayed)}<b>${shown}</b><small>${low ? oxygenStatus(value) + " &middot; " : ""}${ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

/** Latest buoy wind: mean and gust in the chosen unit, a downwind arrow with the compass point it comes
 * from, and air temperature, with a 7-day wind sparkline. */
export function windCell(d: StationData): string {
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f) {
      const u = WIND_UNITS[WU].label;
      return fcCell(f, `${windArrow(f.dir)}${compass(f.dir)} ${windFmt(f.spd)}<small class="g">${u}</small>`, `Wind ${windFmt(f.spd)} ${u} from ${compass(f.dir)}, gusts ${windFmt(f.gust)} ${u}`, `&plusmn;${windFmt(f.err)} ${u}`);
    }
  }
  if (AT != null) {
    const m = d.met;
    const atV = m?.wind?.at(AT) ?? NaN;
    if (!Number.isFinite(atV)) {
      const mc = windModelCell(d, AT, "no reading", `No wind reading at ${atLabel(AT)}`);
      if (mc) return mc;
    }
    if (!m?.wind) return `<td class="na">&middot;</td>`;
    const v = m.wind.at(AT);
    const dir = m.dir?.at(AT) ?? NaN;
    const gust = m.gust?.at(AT) ?? NaN;
    const u = WIND_UNITS[WU].label;
    const from = Number.isFinite(dir) ? compass(dir) : "";
    return atCell(v, `${Number.isFinite(dir) ? windArrow(dir) : ""}${from} ${windFmt(v)}<small class="g">${u}</small>`, `Wind ${windFmt(v)} ${u} from ${from || "--"}, gusts ${windFmt(gust)} ${u}`, sparklineOf(m.wind, M.palette().line, "kt"), `gusts ${windFmt(gust)}`);
  }
  const o = d.met?.last;
  const nowState = o && o.wind_kt != null ? obsState({ time: o.time } as LastObs) : "offline";
  if (nowState === "offline") {
    const mc = windModelCell(d, Date.now() / 1000, "no recent wind", o ? `No wind reading since ${fmtDate.format(new Date(o.time))}` : "No wind reading");
    if (mc) return mc;
  }
  if (!o || o.wind_kt == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent wind</small></td>`;
  const u = WIND_UNITS[WU].label;
  const dir = o.dir_deg != null ? compass(o.dir_deg) : "";
  const title = `Wind ${windFmt(o.wind_kt)} ${u}, gusts ${windFmt(o.gust_kt)} ${u}, from ${dir || "--"}; air ${f1(o.air_f ?? NaN)} F; ${ago(o.time)}${panelTitle(o)}`;
  const spark = d.met?.wind ? sparklineOf(d.met.wind, M.palette().line, "kt") : "";
  return `<td class="${state} wind" title="${title}">${spark}<b>${o.dir_deg != null ? windArrow(o.dir_deg) : ""}${dir} ${windFmt(o.wind_kt)}<small class="g">${u}</small></b><small>gusts ${windFmt(o.gust_kt)} &middot; ${ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

/** Waves: the latest significant height and period where published, the outage with its last reading where
 * not, and "no sensor" where the buoy has none. */
export function wavesCell(d: StationData): string {
  const w = M.waveSensor(d.meta.id);
  if (!w) return `<td class="na">&middot;</td>`;
  const panel = M.wavePanel(d.meta.id);
  if (!w.sensor) return `<td class="na" title="${M.wavesText(d.meta.id)}"><small>no sensor</small></td>`;
  if (!NWPS) void loadNwps();
  const waveModel = (t: number, fault: string, faultTitle: string): string | null => {
    const m = nwpsAt(d.meta.id, hourOf(t));
    if (!m) return null;
    const u = waveUnit().label;
    return standInCell(fault, faultTitle, `model ${waveFmt(m.hs)} ${u}${Number.isFinite(m.tp) ? ` &middot; ${m.tp.toFixed(0)} s` : ""}`,
      `NWS nearshore wave model (NWPS) at the buoy: significant height ${waveFmt(m.hs)} ${u}${Number.isFinite(m.tp) ? `, period ${m.tp.toFixed(1)} s` : ""}${Number.isFinite(m.dir) ? ` from ${compass(m.dir)}` : ""}; ${runText(m.issue, m.lead)}, forced by NWS forecast winds`, "waves");
  };
  if (AT != null) {
    const v = d.waves?.hs?.at(AT) ?? NaN;
    if (!Number.isFinite(v) && !atFuture()) {
      const mc = waveModel(AT, "no reading", `No wave reading at ${atLabel(AT)}`);
      if (mc) return mc;
    }
    return atCell(v, `${waveFmt(v)}<small class="g"> ${waveUnit().label}</small>`, `Significant wave height ${waveFmt(v)} ${waveUnit().label}`);
  }
  const last = M.lastWave(d.meta.id);
  const state = last ? obsState({ time: last.time } as LastObs) : "offline";
  if ((M.wavesPublished(d.meta.id) || last?.source === "panel") && last && state !== "offline") {
    const spark = d.waves?.hs ? sparklineOf(d.waves.hs, M.palette().line, "m significant height", 2) : "";
    return `<td class="${state}" title="Significant wave height ${waveFmt(last.hs_m)} ${waveUnit().label}, highest ${waveFmt(last.hmax_m)}, period ${last.tp_s ?? "--"} s; ${ago(last.time)}${panelTitle(last)}">${spark}<b>${waveFmt(last.hs_m)}<small class="g"> ${waveUnit().label}</small></b><small>${last.tp_s != null ? last.tp_s.toFixed(0) + " s &middot; " : ""}${ago(last.time).replace(" ago", "")}${panelTag(last)}</small></td>`;
  }
  const mc = waveModel(Date.now() / 1000, M.wavesText(d.meta.id, true).replace("offline, last reading", "out since"), M.wavesText(d.meta.id));
  if (mc) return mc;
  const inner = `<b>--</b><small>${M.wavesText(d.meta.id, true)}</small>`;
  return `<td class="offline waves" title="${M.wavesText(d.meta.id)}">${panel ? `<a href="${panel}">${inner}</a>` : inner}</td>`;
}

/** Air temperature at the station, and pressure with its change over the last 3 hours (the forecaster's tendency). */
export function airCell(d: StationData): string {
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f && Number.isFinite(f.air)) return fcCell(f, `${Math.round(f.air)}&deg;`, `Air ${f1(f.air)} F`, `&plusmn;${f.airErr.toFixed(0)}&deg;`);
  }
  if (AT != null) {
    if (!Number.isFinite(d.met?.air?.at(AT) ?? NaN)) {
      const f = standIn(d, AT);
      if (f && Number.isFinite(f.air)) return standInCell("no reading", `No air temperature at ${atLabel(AT)}`, `model ${Math.round(f.air)}&deg;`, `HRRR at the buoy: air ${f1(f.air)} F; ${runText(f.issue, f.lead)}, typically within ${f.airErr.toFixed(0)} F`);
    }
    if (!d.met?.air) return `<td class="na">&middot;</td>`;
    const v = d.met.air.at(AT);
    return atCell(v, `${Math.round(v)}&deg;`, `Air ${f1(v)} F`);
  }
  const o = d.met?.last;
  if (!o || o.air_f == null || obsState({ time: o.time } as LastObs) === "offline") {
    const f = standIn(d, Date.now() / 1000);
    if (f && Number.isFinite(f.air)) return standInCell("offline", "No recent air temperature", `model ${Math.round(f.air)}&deg;`, `HRRR at the buoy: air ${f1(f.air)} F; ${runText(f.issue, f.lead)}, typically within ${f.airErr.toFixed(0)} F`);
  }
  if (!o || o.air_f == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b></td>`;
  return `<td class="${state}" title="Air ${f1(o.air_f)} F, ${ago(o.time)}${panelTitle(o)}"><b>${Math.round(o.air_f)}&deg;</b><small>${ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

export function pressureCell(d: StationData): string {
  const o = d.met?.last;
  const p = d.met?.pressure;
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f && Number.isFinite(f.pres)) {
      const back = forecastAt(d.meta.id, AT - 3 * HOUR);
      const tend = back && back.issue === f.issue && Number.isFinite(back.pres) ? `${signed(f.pres - back.pres)} in 3h, ` : "";
      return fcCell(f, `${f.pres.toFixed(0)}<small class="g"> mb</small>`, `Pressure ${f.pres.toFixed(1)} mbar`, `${tend}&plusmn;${(typicalError(d.meta.id, f.lead, "pressure_mae")).toFixed(0)}`);
    }
  }
  if (AT != null) {
    if (!Number.isFinite(p?.at(AT) ?? NaN)) {
      const f = standIn(d, AT);
      if (f && Number.isFinite(f.pres)) return standInCell("no reading", `No pressure at ${atLabel(AT)}`, `model ${f.pres.toFixed(0)} mb`, `HRRR at the buoy: pressure ${f.pres.toFixed(1)} mbar; ${runText(f.issue, f.lead)}`);
    }
    if (!p) return `<td class="na">&middot;</td>`;
    const v = p.at(AT);
    const tend = p.at(AT) - p.at(AT - 3 * HOUR);
    return atCell(v, `${v.toFixed(0)}<small class="g"> mb</small>`, `Pressure ${v.toFixed(1)} mbar`, "", Number.isFinite(tend) ? `${signed(tend)} in 3h` : "");
  }
  if (!o || o.pressure_mb == null || obsState({ time: o.time } as LastObs) === "offline") {
    const f = standIn(d, Date.now() / 1000);
    if (f && Number.isFinite(f.pres)) return standInCell("offline", "No recent pressure", `model ${f.pres.toFixed(0)} mb`, `HRRR at the buoy: pressure ${f.pres.toFixed(1)} mbar; ${runText(f.issue, f.lead)}`);
  }
  if (!o || o.pressure_mb == null) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: o.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b></td>`;
  const end = p ? p.lastValid() : NaN;
  const trend = p && Number.isFinite(end) ? p.at(end) - p.at(end - 3 * HOUR) : NaN;
  const tend = Number.isFinite(trend) ? `${signed(trend)} in 3h` : "";
  return `<td class="${state}" title="Pressure ${o.pressure_mb.toFixed(1)} mbar${tend ? `, ${tend}` : ""}; ${ago(o.time)}${panelTitle(o)}"><b>${o.pressure_mb.toFixed(0)}<small class="g"> mb</small></b><small>${tend || ago(o.time).replace(" ago", "")}${panelTag(o)}</small></td>`;
}

/** NOAA's predicted water level at a time (ft above MLLW), linear between its hourly values; NaN outside them. */
export function predictedLevel(d: StationData, t: number): number {
  const p = TIDES?.[d.meta.id]?.pred;
  if (!p) return NaN;
  const k = (t - Date.parse(p.t0) / 1000) / p.step, i = Math.floor(k);
  const a = p.ft[i], b = p.ft[i + 1];
  return a == null || b == null ? NaN : a + (b - a) * (k - i);
}

/** Shore station cells: the latest water level with a 7-day line (the tides), and the next predicted tide. */
export function levelCell(d: StationData): string {
  if (AT != null) {
    if (!d.level) return `<td class="na">&middot;</td>`;
    const v = d.level.at(AT);
    const dep = departure(d);
    const spark = dep ? sparklineOf(dep, M.palette().line, "ft against the prediction", 1) : "";
    const p = predictedLevel(d, AT);
    if (!Number.isFinite(v) && Number.isFinite(p))
      return `<td class="fcst" title="Water level ${feet(p)} ft above MLLW, NOAA's prediction">${spark}<b>${feet(p)}<small class="g"> ft</small></b><small>predicted</small></td>`;
    return atCell(v, `${feet(v)}<small class="g"> ft</small>`, `Water level ${feet(v)} ft above MLLW (preliminary)`, spark);
  }
  const lv = d.levelNow;
  if (!lv) return `<td class="na">&middot;</td>`;
  const state = obsState({ time: lv.time } as LastObs);
  if (state === "offline") return `<td class="offline"><b>--</b><small>no recent level</small></td>`;
  const dep = departure(d);
  const spark = dep ? sparklineOf(dep, M.palette().line, "ft against the prediction", 1) : "";
  return `<td class="${state}" title="Water level ${feet(lv.ft)} ft above MLLW (preliminary), ${ago(lv.time)}">${spark}<b>${feet(lv.ft)}<small class="g"> ft</small></b><small>${ago(lv.time).replace(" ago", "")}</small></td>`;
}

export function tideCell(d: StationData): string {
  // At the cursor's time: the next predicted tide after it (predictions reach a few days ahead).
  const e = AT != null ? d.tides.find((x) => Date.parse(x.t) > AT! * 1000) : nextTide(d);
  if (!e) return `<td class="na">&middot;</td>`;
  return `<td class="tide" title="Next predicted ${tideText(e)} above MLLW"><b>${e.type === "H" ? "High" : "Low"}</b><small>${fmtClock.format(new Date(e.t)).toLowerCase()} &middot; ${feet(e.ft)} ft</small></td>`;
}

/** A station's map pin: its latest readings, or its observations at the timeline cursor's time. */
export function stationPin(d: StationData): Pin {
  if (d.kind === "airport") return airportPin(d);
  const dep = d.depths.includes("SFC") ? "SFC" : d.depths[0];
  const kind = d.kind === "shore" ? ("shore" as const) : ("buoy" as const);
  const base = { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, kind };
  const k: VarKey = d.kind === "shore" || !isWater(M.view()) ? "temp" : M.view();
  if (M.view() === "tides" && d.kind === "shore") {
    if (AT == null) {
      const lv = d.levelNow;
      const dep = lastValue(departure(d));
      const hi = d.tides.find((e) => e.type === "H" && Date.parse(e.t) > Date.now());
      const label = [
        lv ? `Water ${feet(lv.ft)} ft, ${ago(lv.time)}` : "no recent level",
        Number.isFinite(dep) ? `${signedFt(dep)} ft against the prediction` : "",
        hi ? `next high ${hi.ft.toFixed(1)} ft ${fmtWhenMin.format(new Date(hi.t))}` : "",
      ].filter(Boolean).join("<br>");
      return { ...base, state: overallState(d), label, bar: dep };
    }
    const h = Math.floor(AT / HOUR) * HOUR;
    const dep = departure(d)?.at(h) ?? NaN;
    const lv = d.level?.at(h) ?? NaN;
    const label = Number.isFinite(lv)
      ? `Water ${feet(lv)} ft, ${Number.isFinite(dep) ? `${signedFt(dep)} ft against the prediction` : ""}<br>observed ${atLabel(AT)}`
      : `predicted ${feet(predictedHour(d.meta.id, h))} ft<br>${atLabel(AT)}`;
    return { ...base, state: overallState(d), label, bar: dep };
  }
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f) {
      const u = WIND_UNITS[WU].label;
      const label = `Forecast: wind ${windArrow(f.dir, f.spd < LIGHT_KT)}${compass(f.dir)} ${windFmt(f.spd)} ${u}, gusts ${windFmt(f.gust)}${Number.isFinite(f.air) ? `<br>air ${Math.round(f.air)}&deg;F` : ""}<br>HRRR, ${f.lead} h ahead, typically &plusmn;${windFmt(f.err)} ${u}<br>${atLabel(AT)}`;
      return { ...base, state: overallState(d), label };
    }
  }
  if (AT != null) {
    const water = valueAt(d, k, dep, AT);
    const wind = d.met?.wind?.at(AT) ?? NaN;
    const dir = d.met?.dir?.at(AT) ?? NaN;
    const parts = [
      Number.isFinite(water) ? `${d.kind === "shore" ? "Water" : DEPTH_LABEL[dep]} ${pinValue(k, water)}` : "",
      Number.isFinite(wind) ? `wind ${Number.isFinite(dir) ? windArrow(dir, wind < LIGHT_KT) + compass(dir) + " " : ""}${windFmt(wind)} ${WIND_UNITS[WU].label}` : "",
    ].filter(Boolean);
    // A buoy without its own wind at that hour: the model under the fault, marked as such.
    const f = !Number.isFinite(wind) ? standIn(d, AT) : null;
    const model = f ? `<i>Model, not measured: wind ${compass(f.dir)} ${windFmt(f.spd)} ${WIND_UNITS[WU].label} (HRRR)</i>` : "";
    const label = parts.length
      ? `${parts.join("<br>")}<br>observed ${atLabel(AT)}${model ? `<br>${model}` : ""}`
      : `no ${atFuture() ? "forecast" : "reading"} at ${atLabel(AT)}${model ? `<br>${model}` : ""}`;
    return { ...base, state: parts.length ? overallState(d) : "offline", label };
  }
  const o = d.obs[dep];
  const lv = o ? WATER_VARS[k].obs(o) : null;
  const state = overallState(d);
  const w = d.met?.last;
  const wind = w && w.wind_kt != null ? `wind ${w.dir_deg != null ? windArrow(w.dir_deg, w.wind_kt < LIGHT_KT) + compass(w.dir_deg) + " " : ""}${windFmt(w.wind_kt)} ${WIND_UNITS[WU].label}, ${ago(w.time)}` : "";
  const reading =
    state === "partial"
      ? `Weather live: ${wind}<br>Water quality offline${o ? ` since ${fmtDate.format(new Date(o.time))}` : ""}`
      : o && lv != null
        ? `${DEPTH_LABEL[dep]} ${pinValue(k, lv)}, ${ago(o.time)}${wind ? `<br>${wind}` : ""}`
        : "no reading";
  const waves = M.wavesText(d.meta.id, true);
  let label = waves ? `${reading}<br>Waves: ${waves}` : reading.replace(/^Surface /, d.kind === "shore" ? "Water " : "Surface ");
  if (d.kind === "buoy" && (!w || obsState({ time: w.time } as LastObs) === "offline")) {
    const f = standIn(d, Date.now() / 1000);
    const m = nwpsAt(d.meta.id, hourOf(Date.now() / 1000));
    const model = [
      f ? `wind ${compass(f.dir)} ${windFmt(f.spd)} ${WIND_UNITS[WU].label} (HRRR)` : "",
      m && M.waveSensor(d.meta.id)?.sensor ? `waves ${waveFmt(m.hs)} ${waveUnit().label} (NWPS)` : "",
    ].filter(Boolean);
    if (model.length) label += `<br><i>Model, not measured: ${model.join(", ")}</i>`;
  }
  const tide = d.kind === "shore" && nextTide(d) ? `<br>Next ${tideText(nextTide(d)!)}` : "";
  return { ...base, state, label: label + tide };
}

/** An airport's pin: its wind (measured, or HRRR ahead of now), in any view. */
export function airportPin(d: StationData): Pin {
  const base = { id: d.meta.id, name: d.meta.name, lat: d.meta.lat, lon: d.meta.lon, kind: "shore" as const };
  const u = WIND_UNITS[WU].label;
  if (AT != null && atFuture()) {
    const f = forecastAt(d.meta.id, AT);
    if (f) return { ...base, state: overallState(d), label: `Forecast: wind ${windArrow(f.dir, f.spd < LIGHT_KT)}${compass(f.dir)} ${windFmt(f.spd)} ${u}, gusts ${windFmt(f.gust)}<br>HRRR, ${f.lead} h ahead<br>${atLabel(AT)}` };
  }
  if (AT != null) {
    const wind = d.met?.wind?.at(AT) ?? NaN;
    const dir = d.met?.dir?.at(AT) ?? NaN;
    return Number.isFinite(wind)
      ? { ...base, state: overallState(d), label: `Airport wind ${Number.isFinite(dir) ? windArrow(dir, wind < LIGHT_KT) + compass(dir) + " " : ""}${windFmt(wind)} ${u}<br>observed ${atLabel(AT)}` }
      : { ...base, state: "offline", label: `no reading at ${atLabel(AT)}` };
  }
  const w = d.met?.last;
  const label = w && w.wind_kt != null
    ? `Airport wind ${w.dir_deg != null ? windArrow(w.dir_deg, w.wind_kt < LIGHT_KT) + compass(w.dir_deg) + " " : ""}${windFmt(w.wind_kt)} ${u}${w.gust_kt != null ? `, gusts ${windFmt(w.gust_kt)}` : ""}, ${ago(w.time)}${w.air_f != null ? `<br>air ${Math.round(w.air_f)}&deg;F` : ""}`
    : "no recent report";
  return { ...base, state: overallState(d), label };
}

/** The buoys' or the shore stations' table in the view's columns, with its tabs and key (the overview's status table
 * in every view but Rivers, Turbidity and Tides, which the page writes itself). */
export function stationTables(stations: StationData[], SG: string): string {
  const buoys = stations.filter((d) => d.kind === "buoy");
  const shore = stations.filter((d) => d.kind === "shore");
  const name = (d: StationData) => `<th scope="row"><a href="#${d.meta.id}"><i class="dot${d.kind === "shore" ? " shore" : ""} ${overallState(d)}"></i>${d.meta.name}</a></th>`;
  const wind = `wind (${WIND_UNITS[WU].label})`;
  const what = `${V().label.toLowerCase()} (${M.view() === "temp" ? "&deg;F" : unitName(M.view())})`;
  // Each view has its own columns: water views show the water; Wind and waves shows the weather and the sea.
  const head = (cols: string[]) => `<thead><tr><th></th>${cols.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead>`;
  const open = (g: string) => `<table class="status-grid" id="status-panel" role="tabpanel" aria-labelledby="stab-${g}">`;
  const air = "air (&deg;F), pressure (mbar)";
  const table =
    SG === "buoy"
      ? isWater(M.view())
        ? `${open("buoy")}<caption>${AT != null ? `${V().label} at ${atLabel(AT)}, west to east (${M.view() === "temp" ? "&deg;F" : unitName(M.view())})` : `Latest readings, west to east: ${what}`}</caption>${head(DEPTHS.map((d) => DEPTH_LABEL[d]))}
      <tbody>${buoys.map((d) => `<tr>${name(d)}${DEPTHS.map((dep) => cellHtml(d, dep)).join("")}</tr>`).join("")}</tbody></table>`
        : `${open("buoy")}<caption>${AT != null ? `${atFuture() ? "Forecast" : "Weather and waves"} at ${atLabel(AT)}` : "Latest readings"}, west to east: ${wind}, ${air} and waves (${waveUnit().label})${AT != null && atFuture() ? ` &middot; HRRR, raw${(() => { const f = stations.length ? forecastAt(stations[0].meta.id, hourOf(AT!)) : null; return f ? `, the ${fmtRun.format(new Date(f.issue * 1000))} run` : ""; })()} &middot; ${verTag(AT!, stations[0]?.meta.id)}` : ""}</caption>${head(["Wind", "Air", "Pressure", "Waves"])}
      <tbody>${buoys.map((d) => `<tr>${name(d)}${windCell(d)}${airCell(d)}${pressureCell(d)}${wavesCell(d)}</tr>`).join("")}</tbody></table>`
      : isWater(M.view())
        ? `${open("shore")}<caption>${AT != null ? `Water at ${atLabel(AT)}` : "Latest readings"}, west to east: ${M.view() === "temp" ? "water temperature (&deg;F)" : `water temperature only (no ${V().label.toLowerCase()} sensors)`} and water level</caption>${head(["Water", "Level", "Next tide"])}
      <tbody>${shore.map((d) => `<tr>${name(d)}${cellHtml(d, "SFC")}${levelCell(d)}${tideCell(d)}</tr>`).join("")}</tbody></table>`
        : `${open("shore")}<caption>${AT != null ? `${atFuture() ? "Forecast" : "Weather"} at ${atLabel(AT)}` : "Latest readings"}, west to east: ${wind}, ${air} and the next tide${AT != null && atFuture() ? ` &middot; HRRR, raw${(() => { const f = stations.length ? forecastAt(stations[0].meta.id, hourOf(AT!)) : null; return f ? `, the ${fmtRun.format(new Date(f.issue * 1000))} run` : ""; })()} &middot; ${verTag(AT!, stations[0]?.meta.id)}` : ""}</caption>${head(["Wind", "Air", "Pressure", "Next tide"])}
      <tbody>${shore.map((d) => `<tr>${name(d)}${windCell(d)}${airCell(d)}${pressureCell(d)}${tideCell(d)}</tr>`).join("")}</tbody></table>`;
  const tab = (g: string, label: string, n: number) =>
    `<button type="button" role="tab" class="stab" id="stab-${g}" data-group="${g}" aria-selected="${SG === g}" aria-controls="status-panel" tabindex="${SG === g ? 0 : -1}">${label}<small>${n}</small></button>`;
  const key =
    SG === "buoy"
      ? `<i class="dot live"></i>under ${DELAYED_HOURS}h old <i class="dot delayed"></i>under ${OFFLINE_HOURS}h <i class="dot partial"></i>weather only <i class="dot offline"></i>offline`
      : `<i class="dot shore live"></i>under ${DELAYED_HOURS}h old <i class="dot shore delayed"></i>under ${OFFLINE_HOURS}h <i class="dot shore offline"></i>offline &middot; levels in feet above mean lower low water, preliminary; tides are NOAA predictions`;
  return `
    ${shore.length ? `<div class="status-tabs" role="tablist" aria-label="Stations">${tab("buoy", "Buoys", buoys.length)}${tab("shore", "Shore stations", shore.length)}</div>` : ""}
    ${table}
    <p class="status-key">${key} &middot; lines: last 7 days, each stretched to its own range</p>`;
}
