/** The readouts at the top of a station's section: the big figures for the view (water at each depth, surface minus
 * bottom, wind, waves, pressure, air, the water level against the tide), each with its trend and seasonal %ile, the
 * reading's age, and a model's value under a fault, marked as a model. */
import { compass, LIGHT_KT, windArrow } from "../wind-dir";
import { HOUR, oxygenStatus, stratStatus, type Hourly, type LastObs } from "../series";
import { classify, percentileText, SEASONS, seasonalPercentile, trend, trendText, TRENDS, veerText } from "../trends";
import { ago, cToF, f1, fmtDate, fmtWhenMin, hourOf, lastValue, signed, signedFt, tideText } from "./format";
import { waveFmt, waveUnit, WIND_UNITS, windFmt, WU } from "./units";
import { nextTide, obsState, stationState, type FcValue, type StationData } from "./station-data";
import { runText } from "./cells";
import { M } from "./models";
import { departure, TIDES } from "./tides";
import { FCST, forecastChange, loadForecast, standIn } from "./forecast";
import { loadNwps, NWPS, nwpsAt } from "./nwps";

export function stratNow(d: StationData): { deltaC: number; status: string } {
  const delta = d.temp.delta;
  const end = delta ? delta.lastValid() : NaN;
  const deltaC = delta && Number.isFinite(end) ? (delta.mean(end - 23 * HOUR, end) * 5) / 9 : NaN;
  return { deltaC, status: stratStatus(deltaC) };
}

/** One readout: the big figure, its label (which opens the plot's explanation) and a line of small print. */
export function readoutHtml(num: string, label: string, about: string, sub: string, state = "", context = ""): string {
  return `<div class="readout"><div class="num">${num}</div><span class="lab"><button type="button" class="ro-about" data-about="${about}" title="About: ${label}">${label}</button></span>${context ? `<span class="trend">${context}</span>` : ""}<span class="sub${state ? ` ${state}` : ""}">${sub}</span></div>`;
}

/** Direction over the quantity's window, then the seasonal %ile (from `season.long` when the series has a longer
 * record than its recent window): "↗ +0.6°F in 24h · 74th %ile". */
export function contextLine(s: Hourly | null | undefined, trendKey: string, fmt: (v: number) => string, season?: { key: string; what?: string; long?: Hourly | null }): string {
  const spec = TRENDS[trendKey];
  const parts = [trendText(trend(s, spec), spec, fmt)];
  if (season) parts.push(percentileText(seasonalPercentile(season.long ?? s, SEASONS[season.key]), season.what));
  return parts.filter(Boolean).join(" &middot; ");
}

/** HRRR's change at the station over the quantity's window ahead, as a companion to the readings' change over the
 * window behind: "HRRR ↘ −4 kt over the next 3 h". Only beside a current reading (from a delayed one, the two windows
 * would leave a gap between them); empty until the runs load, or where none reaches the station. */
function forecastLine(d: StationData, state: string, trendKey: string, pick: (f: FcValue) => number, fmt: (v: number) => string): string {
  if (state !== "live") return "";
  if (!FCST) {
    void loadForecast();
    return "";
  }
  const spec = TRENDS[trendKey];
  const delta = forecastChange(d.meta.id, spec.window, pick);
  return Number.isFinite(delta) ? trendText(classify(delta, spec), spec, fmt, "HRRR") : "";
}

/** The change in the view's water variable, in display units. */
const waterDelta = (v: number) => (M.view() === "temp" ? `${v.toFixed(1)}&deg;F` : M.view() === "salinity" ? v.toFixed(2) : `${v.toFixed(1)} mg/L`);

/** A reading at one depth, or why there is none. */
function depthReadout(d: StationData, depth: string, value: (o: LastObs) => number | null | undefined, fmt: (v: number) => string, labelFor: (depthLabel: string) => string, about: string, extra?: (o: LastObs, v: number) => string, context?: string): string {
  const o = d.obs[depth];
  const depthLabel = d.meta.series.find((s) => s.depth === depth)?.label ?? depth;
  const label = labelFor(depthLabel);
  const v = o ? value(o) : null;
  if (!o || v == null || !Number.isFinite(v)) return readoutHtml("--", label, about, "no recent reading");
  const state = obsState(o);
  // An old reading is not a current condition: keep it out of the big figure.
  if (state === "offline") return readoutHtml("--", label, about, `no current reading &middot; last ${fmt(v).replace(/<[^>]+>/g, " ")}, ${fmtDate.format(new Date(o.time))}`, "offline");
  return readoutHtml(fmt(v), label, about, `${o.depth_m ?? "--"} m &middot; ${extra ? extra(o, v) + " &middot; " : ""}${ago(o.time)}${o.source === "panel" ? " &middot; transcribed from the LISICOS panel" : ""}`, state, context);
}

/** Direction and %ile of the view's water variable at one depth, from its 36h mean. */
const waterContext = (d: StationData, depth: string) => contextLine(d.m36[depth], M.view(), waterDelta, { key: "water" });

/** Surface minus bottom of the view's variable, as its latest 36h mean. */
function deltaReadout(d: StationData, fmt: (v: number) => string): string {
  const offline = stationState(d) === "offline";
  if (M.view() === "temp") {
    const sb = stratNow(d);
    if (!Number.isFinite(sb.deltaC)) return readoutHtml("--", "Surface minus bottom", "sb", "no recent reading");
    return offline
      ? readoutHtml("--", "Surface minus bottom", "sb", `no current reading &middot; last ${signed(sb.deltaC, 2)}&deg;C, ${sb.status}`, "offline")
      : readoutHtml(`${signed(sb.deltaC, 2)}&deg;C`, "Surface minus bottom", "sb", `${sb.status} (alpha definition) &middot; 24h mean`, "", stratContext(d));
  }
  const s = d.delta36;
  const end = s ? s.lastValid() : NaN;
  if (!s || !Number.isFinite(end)) return readoutHtml("--", "Surface minus bottom", "sb", "no recent reading");
  const v = s.at(end);
  return offline
    ? readoutHtml("--", "Surface minus bottom", "sb", `no current reading &middot; last ${fmt(v)}`, "offline")
    : readoutHtml(fmt(v), "Surface minus bottom", "sb", "36h mean", "", contextLine(s, M.view(), waterDelta));
}

/** Stratifying or mixing: the size of the last day's mean surface-bottom temperature difference against the day
 * before's (sizes of the means, so hours flipping sign around zero do not read as layering). */
function stratContext(d: StationData): string {
  const s = d.temp.delta;
  const end = s ? s.lastValid() : NaN;
  if (!s || !Number.isFinite(end)) return "";
  const spec = TRENDS.stratification;
  const w = spec.window * HOUR;
  const now = Math.abs(s.mean(end - w + HOUR, end));
  const before = Math.abs(s.mean(end - 2 * w + HOUR, end - w));
  if (!Number.isFinite(now) || !Number.isFinite(before)) return "";
  return trendText(classify(now - before, spec), spec, (v) => `${((v * 5) / 9).toFixed(2)}&deg;C`);
}

const fmtTempF = (c: number) => `${f1(cToF(c))}&deg;F<small>${c.toFixed(1)}&deg;C</small>`;
const fmtSal = (v: number) => v.toFixed(2);
const fmtDo = (v: number) => `${v.toFixed(1)}<small>mg/L</small>`;

/** Wind, waves, pressure and air at the station (the Wind and waves view). */
export function weatherReadouts(d: StationData): string[] {
  const out: string[] = [];
  const o = d.met?.last;
  const state = o ? obsState({ time: o.time } as LastObs) : "offline";
  const u = WIND_UNITS[WU].label;
  if (o?.wind_kt != null && state !== "offline") {
    const dir = o.dir_deg != null ? `from ${compass(o.dir_deg)}` : "";
    out.push(readoutHtml(`${o.dir_deg != null ? windArrow(o.dir_deg, o.wind_kt < LIGHT_KT) : ""}${windFmt(o.wind_kt)}<small>${u}</small>`, "Wind", "wind", `${dir}${dir ? " &middot; " : ""}gusts ${windFmt(o.gust_kt)} ${u} &middot; ${ago(o.time)}${o.source === "panel" ? " &middot; transcribed from the LISICOS panel" : ""}`, state,
      [contextLine(d.met?.wind, "wind", (v) => `${windFmt(v)} ${u}`), veerText(d.met?.dir, d.met?.wind), percentileText(seasonalPercentile(d.metLong?.wind ?? d.met?.wind, SEASONS.wind), "last 3 days")]
        .filter(Boolean)
        .join(" &middot; ") + forecastLine(d, state, "wind",(f) => f.spd, (v) => `${windFmt(v)} ${u}`)));
  } else {
    out.push(readoutHtml("--", "Wind", "wind", "no recent reading", "offline"));
    const f = standIn(d, Date.now() / 1000);
    if (f) out.push(readoutHtml(`<span class="model-num">${windFmt(f.spd)}</span><small>${u}</small>`, "Wind, model", "model", `HRRR at the buoy, from ${compass(f.dir)}, gusts ${windFmt(f.gust)} ${u} &middot; ${runText(f.issue, f.lead)} &middot; not a measurement`, "model"));
  }
  if (d.kind === "buoy" && M.waveSensor(d.meta.id)?.sensor) {
    const w = M.lastWave(d.meta.id);
    const live = (M.wavesPublished(d.meta.id) || w?.source === "panel") && w && obsState({ time: w.time } as LastObs) !== "offline";
    out.push(
      live
        ? readoutHtml(`${waveFmt(w!.hs_m)}<small>${waveUnit().label}</small>`, "Waves", "waves", `${w!.tp_s != null ? `${w!.tp_s.toFixed(0)} s period &middot; ` : ""}${ago(w!.time)}${w!.source === "panel" ? " &middot; transcribed from the LISICOS panel" : ""}`, "",
            contextLine(d.waves?.hs, "waves", (v) => `${waveFmt(v)} ${waveUnit().label}`, { key: "waves", what: "last 3 days" }))
        : readoutHtml("--", "Waves", "waves", M.wavesText(d.meta.id, true), "offline"),
    );
    if (!live) {
      if (!NWPS) void loadNwps();
      const m = nwpsAt(d.meta.id, hourOf(Date.now() / 1000));
      if (m) out.push(readoutHtml(`<span class="model-num">${waveFmt(m.hs)}</span><small>${waveUnit().label}</small>`, "Waves, model", "model", `NWS wave model (NWPS) at the buoy${Number.isFinite(m.tp) ? `, ${m.tp.toFixed(0)} s period` : ""} &middot; ${runText(m.issue, m.lead)} &middot; not a measurement`, "model"));
    }
  }
  if (o?.pressure_mb != null && state !== "offline") {
    const ctx = contextLine(d.met?.pressure, "pressure", (v) => `${v.toFixed(1)} mb`, { key: "pressure", what: "last day", long: d.metLong?.pressure }) +
      forecastLine(d, state, "pressure",(f) => f.pres, (v) => `${v.toFixed(1)} mb`);
    out.push(readoutHtml(`${o.pressure_mb.toFixed(0)}<small>mb</small>`, "Pressure", "pressure", ago(o.time), state, ctx));
  }
  if (o?.air_f != null && state !== "offline")
    out.push(readoutHtml(`${f1(o.air_f)}&deg;F`, "Air", "air", ago(o.time), state, contextLine(d.met?.air, "air", (v) => `${v.toFixed(0)}&deg;F`, { key: "air", what: "last day", long: d.metLong?.air })));
  return out;
}

function levelReadout(d: StationData): string {
  const e = nextTide(d);
  const lv = d.levelNow;
  return readoutHtml(`${lv ? lv.ft.toFixed(1) : "--"}<small>ft</small>`, "Water level", "tide", `above MLLW${lv ? ` &middot; ${ago(lv.time)}` : ""}${e ? ` &middot; next ${tideText(e)}` : ""}`);
}

/** The Tides view's readouts for a shore station: what is unusual first (the water against NOAA's prediction), then
 * the level, then the margin to minor flooding at the next high if the departure held. */
function tidesReadouts(d: StationData): string[] {
  const lv = d.levelNow;
  const state = lv ? obsState({ time: lv.time } as LastObs) : "offline";
  const dep = lastValue(departure(d));
  const out: string[] = [];
  out.push(Number.isFinite(dep) && state !== "offline"
    ? readoutHtml(`${signedFt(dep)}<small>ft</small>`, "Departure from prediction", "dep", `observed minus ${d.meta.operator === "USGS" ? "our fitted prediction" : "NOAA's prediction"}${lv ? ` &middot; ${ago(lv.time)}` : ""}`, state,
        contextLine(departure(d), "departure", (v) => `${v.toFixed(1)} ft`))
    : readoutHtml("--", "Departure from prediction", "dep", "no current reading", "offline"));
  out.push(readoutHtml(`${lv ? lv.ft.toFixed(1) : "--"}<small>ft</small>`, "Water level", "tide", `above MLLW${lv ? ` &middot; ${ago(lv.time)}` : ""}`, state));
  const hi = d.tides.find((e) => e.type === "H" && Date.parse(e.t) > Date.now());
  const minor = (TIDES?.[d.meta.id]?.flood_ft?.nws_minor ?? null);
  if (hi && minor != null) {
    const reach = hi.ft + (Number.isFinite(dep) ? dep : 0);
    out.push(readoutHtml(`${(minor - reach).toFixed(1)}<small>ft</small>`, "Below minor flood", "hilo",
      `next high ${hi.ft.toFixed(1)} ft predicted, ${fmtWhenMin.format(new Date(hi.t))}${Number.isFinite(dep) ? `, ${signedFt(dep)} ft departure` : ""} &middot; NWS minor ${minor.toFixed(1)} ft`));
  }
  return out;
}

/** The readouts at the top of a buoy or shore station section follow the view, mirroring the plots below them.
 * Mid-depth stays out: the water-column plot carries it. */
export function stationReadouts(d: StationData): string[] {
  const depths = d.depths.filter((dep) => dep !== "MID");
  if (d.kind === "airport") return weatherReadouts(d);
  if (d.kind === "shore") {
    if (M.view() === "wind") return [...weatherReadouts(d), levelReadout(d)];
    if (M.view() === "tides") return tidesReadouts(d);
    return [depthReadout(d, d.depths[0], (o) => o.temperature_c, fmtTempF, () => "Water temperature", "col", undefined, d.kind === "shore" ? contextLine(d.m36[d.depths[0]] ?? d.temp.m36[d.depths[0]], "temp", (v) => `${v.toFixed(1)}&deg;F`, { key: "water" }) : undefined), levelReadout(d)];
  }
  if (M.view() === "wind") return weatherReadouts(d);
  if (M.view() === "salinity") {
    const items = depths.map((dep) => depthReadout(d, dep, (o) => o.salinity, fmtSal, (l) => `${l} salinity`, "col", undefined, waterContext(d, dep)));
    return d.delta ? [...items, deltaReadout(d, (v) => signed(v, 2))] : items;
  }
  if (M.view() === "oxygen") {
    const bottomFirst = [...depths].reverse();
    const items = bottomFirst.map((dep) => depthReadout(d, dep, (o) => o.oxygen_mg_l, fmtDo, (l) => `${l} dissolved oxygen`, "col", (_o, v) => oxygenStatus(v), waterContext(d, dep)));
    return d.delta ? [...items, deltaReadout(d, (v) => `${signed(v, 1)}<small>mg/L</small>`)] : items;
  }
  const items = depths.map((dep) => depthReadout(d, dep, (o) => o.temperature_c, fmtTempF, (l) => l, "col", undefined, waterContext(d, dep)));
  return d.temp.delta ? [...items, deltaReadout(d, () => "")] : items;
}
