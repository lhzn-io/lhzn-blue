/** The Long Island Sound's data, read into the station model (waterway/station-data.ts): the LISICOS buoys with their
 * water and weather, the shore stations (NOAA CO-OPS, and the USGS tidal gauges as shore stations), the coastal
 * airports, the rivers' sections and the buoys' turbidity, each from its file under the Sound's data prefix. A
 * variable's history loads on first use. */
import registry from "../../../../stations/stations.json";
import shoreRegistry from "../../../../stations/shore.json";
import asosRegistry from "../../../../stations/asos.json";
import {
  Daily, getJson, HOUR, Hourly, fToC,
  type Encoded, type History, type LastObs, type Live, type Meta, type MetaSeries, type MetaStation, type MetHistory, type MetWindow,
  type RiverHistory, type RiverLive, type ShoreFrame, type ShoreMetaStation, type TideEvent, type TurbFrame, type TurbHistory, type VarHistory,
  type WaveFrame, type WaveHistory, type WaveLive, type WaveObs,
} from "../series";
import { fmtDate, hoursOld } from "../waterway/format";
import { DEPTHS, OFFLINE_HOURS, WATER_VARS, type Met, type StationData, type TurbData, type VarKey, type VarView, type Waves } from "../waterway/station-data";
import { DATA } from "../waterway/data";
import { addFittedTides, loadTides } from "../waterway/tides";
import { riverSections } from "../waterway/rivers";
import { LONG_ISLAND_SOUND as LIS } from "../waterways/long-island-sound";

export let RIVER_SECTIONS: StationData[] = [];
export let TURB_SECTION: StationData | null = null;

function wavesFrom(hist: WaveFrame | undefined, live: WaveFrame | undefined): Waves | null {
  const col = (k: "hs_m" | "hmax_m" | "tp_s") => Hourly.merge(Hourly.fromArray(hist?.t0, hist?.[k]), Hourly.fromArray(live?.t0, live?.[k]));
  const w = { hs: col("hs_m"), hmax: col("hmax_m"), tp: col("tp_s") };
  return w.hs || w.hmax ? w : null;
}

/** Wave status per buoy: the hourly check in live.json, and the full record's metadata once loaded. */
export let WAVE_LIVE: Record<string, WaveLive> = {};
export let WAVE_META: WaveHistory["meta"] = {};

function metOf(w: MetWindow | undefined): Met | null {
  if (!w || !w.t0) return null;
  return {
    wind: Hourly.fromArray(w.t0, w.wind_kt),
    gust: Hourly.fromArray(w.t0, w.gust_kt),
    dir: Hourly.fromArray(w.t0, w.dir_deg),
    air: Hourly.fromArray(w.t0, w.air_f),
    pressure: Hourly.fromArray(w.t0, w.pressure_mb),
    last: w.last_obs,
  };
}



/** A variable's views for one station: history overlaid with the live window, then the derived series. */
function viewOf(st: MetaStation, hist: Record<string, Encoded>, live: Record<string, Encoded> | undefined): VarView {
  const hourly: Record<string, Hourly | null> = {};
  const m36: Record<string, Hourly | null> = {};
  const chg: Record<string, Hourly | null> = {};
  for (const s of st.series) {
    const h = Hourly.merge(Hourly.decode(hist[s.key]), Hourly.decode(live?.[s.key]));
    hourly[s.depth] = h;
    m36[s.depth] = h ? h.rolling(36, 24) : null;
    chg[s.depth] = m36[s.depth]?.change(168) ?? null;
  }
  const delta = hourly.SFC && hourly.BTM ? hourly.SFC.minus(hourly.BTM) : null;
  return { hourly, m36, chg, delta, delta36: delta ? delta.rolling(36, 24) : null };
}

/** Show a variable: its views become the station's current series. */
export function useVar(d: StationData, k: VarKey): void {
  const v = d.views[k] ?? (k === "temp" ? d.temp : { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null });
  Object.assign(d, { hourly: v.hourly, m36: v.m36, chg: v.chg, delta: v.delta, delta36: v.delta36 });
}

/** Load a variable's history (once) and build its views for every station; its sources go to the page's notes. */
const loaded = new Set<VarKey>(["temp"]);
export async function ensureVar(k: VarKey, live: Live, stations: StationData[], sources: (html: string) => void): Promise<void> {
  if (loaded.has(k)) return;
  if (k === "tides") {
    await loadTides();
    loaded.add(k);
    return;
  }
  if (k === "rivers") {
    const [rl, rh] = await Promise.all([getJson<RiverLive>(`${DATA}/rivers.json`), getJson<RiverHistory>(`${DATA}/${WATER_VARS.rivers.file}`)]);
    RIVER_SECTIONS = riverSections(rl, rh, LIS.rivers);
    sources(` Rivers: <a href="https://waterdata.usgs.gov/">USGS</a> stream gauges (${rh.meta.gauges.map((g) => `${g.name}, ${g.usgs_id}`).join("; ")}). ` +
        `Recent flow is hourly means of 15-minute readings; earlier flow is daily means; the ranges for each date are percentiles of daily mean ` +
        `flow over each gauge's approved record, computed by USGS. ${rh.meta.qc}`,
    );
    loaded.add(k);
    return;
  }
  if (k === "turbidity") {
    await ensureVar("rivers", live, stations, sources).catch(() => undefined); // the river input; the buoys show without it
    const th = await getJson<TurbHistory>(`${DATA}/${WATER_VARS.turbidity.file}`).catch(() => null); // the live 100 days still show
    TURB_SECTION = turbSection(stations, live, th);
    if (TURB_SECTION) TURB_SECTION.river = RIVER_SECTIONS[0]?.river;
    if (th) sources(` ${th.qc}`);
    loaded.add(k);
    return;
  }
  if (k === "wind") {
    const [hist, met] = await Promise.all([
      getJson<WaveHistory>(`${DATA}/${WATER_VARS.wind.file}`),
      getJson<MetHistory>(`${DATA}/history-met.json`).catch(() => null), // the %iles wait for it; the rest shows without
    ]);
    WAVE_META = hist.meta;
    for (const d of stations) if (d.kind === "buoy") d.waves = wavesFrom(hist.stations[d.meta.id], live.waves?.[d.meta.id]);
    if (met) {
      for (const d of stations) {
        const h = d.kind === "buoy" ? met.stations[d.meta.id] : undefined;
        if (!h?.t0) continue;
        const long = (vals: (number | null)[] | undefined, recent: Hourly | null | undefined) =>
          Hourly.merge(Daily.fromArray(h.t0, vals)?.toHourly() ?? null, recent ?? null);
        d.metLong = { wind: long(h.wind_kt, d.met?.wind), air: long(h.air_f, d.met?.air), pressure: long(h.pressure_mb, d.met?.pressure) };
      }
    }
    sources(` ${hist.qc}${met ? ` ${met.qc}` : ""}`);
    loaded.add(k);
    return;
  }
  const hist = await getJson<VarHistory>(`${DATA}/${WATER_VARS[k].file}`);
  const liveVar = k === "temp" ? live.series : live[k];
  for (const d of stations) d.views[k] = viewOf(d.meta, hist.series, liveVar);
  loaded.add(k);
}

export async function load(): Promise<{ meta: Meta; live: Live; stations: StationData[] }> {
  const [hist, live] = await Promise.all([getJson<History>(`${DATA}/history.json`), getJson<Live>(`${DATA}/live.json`)]);
  const meta = hist.meta;
  // West to east, everywhere: the status grid, the station sections, and the AI prompt.
  meta.stations.sort((a, b) => a.lon - b.lon);
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const stations = meta.stations.map((st) => {
    const temp = viewOf(st, hist.series, live.series);
    const obs: Record<string, LastObs | null> = {};
    for (const s of st.series) obs[s.depth] = live.series[s.key]?.last_obs ?? s.archived_last_obs ?? null;
    const isLive = st.series.some((s) => s.live);
    const lastData = Math.max(...Object.values(temp.hourly).map((h) => (h ? h.lastValid() : -Infinity)));
    return {
      kind: "buoy" as const,
      meta: st,
      depths: DEPTHS.filter((d) => st.series.some((s) => s.depth === d)),
      ...temp,
      temp,
      views: { temp },
      obs,
      live: isLive,
      now,
      anchor: isLive || !Number.isFinite(lastData) ? now : lastData,
      met: metOf(live.met?.[st.id]),
      level: null,
      tides: [],
      levelNow: null,
      waves: wavesFrom(undefined, live.waves?.[st.id]),
    };
  });
  WAVE_LIVE = live.waves ?? {};
  return { meta, live, stations };
}

/**
 * A shore station as a one-depth station: water temperature (history from shore-history.json once it
 * arrives, overlaid with the live window), the station's weather, and water level with tide predictions.
 */
export function shoreStation(st: ShoreMetaStation, frame: ShoreFrame | undefined, hist: Encoded | undefined): StationData {
  const series: MetaSeries = {
    key: st.id, depth: "SFC", label: "Water", depth_m: [], record_start: hist?.t0 ?? st.record_start,
    hours: hist?.values.length ?? 0, sources: [], live: true, archived_last_obs: null,
  };
  const meta: MetaStation = { id: st.id, name: st.name, operator: st.operator, lat: st.lat, lon: st.lon, note: st.note ?? null, info_url: st.info_url, series: [series] };
  const liveWater: Encoded | undefined = frame?.t0 ? { t0: frame.t0, step: 3600, unit: "degF", values: frame.water_f ?? [] } : undefined;
  const temp = viewOf(meta, hist ? { [st.id]: hist } : {}, liveWater ? { [st.id]: liveWater } : undefined);
  const o = frame?.last_obs ?? null;
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  return {
    kind: "shore",
    meta,
    depths: ["SFC"],
    ...temp,
    temp,
    views: { temp },
    obs: { SFC: o && o.water_f != null ? { time: o.time, depth_m: null, temperature_c: fToC(o.water_f), salinity: null, oxygen_mg_l: null } : null },
    live: true,
    now,
    anchor: now,
    met: frame ? metOf({ ...frame, last_obs: o, dataset: frame.coops_id } as MetWindow) : null,
    level: Hourly.fromArray(frame?.t0, frame?.level_ft),
    tides: frame?.tides ?? [],
    levelNow: o && o.level_ft != null ? { time: o.time, ft: o.level_ft } : null,
    waves: null,
  };
}

/** LISICOS panels (images on the operator's site) for a station: the only recent view of series the
 * data server does not publish. */
type Panels = { weather?: string; water_quality?: string; waves?: string };
export const panelsOf = (id: string): Panels =>
  ((registry.stations as { id: string; panels?: Panels }[]).find((s) => s.id === id)?.panels ?? {});

/** The latest reading we have seen for any depth of the station (epoch seconds). */
export function lastSeen(d: StationData): number {
  if (d.kind === "airport") return d.met?.last ? Date.parse(d.met.last.time) / 1000 : -Infinity;
  return Math.max(...d.depths.map((dep) => (d.obs[dep] ? Date.parse(d.obs[dep]!.time) / 1000 : -Infinity)));
}

/**
 * Waves, stated fairly per buoy: LISICOS lists wave data for Western Sound, Execution Rocks and Central
 * Sound only, so ARTG has no wave sensor rather than an outage. For the others the ingest asks the server
 * for the wave dataset every hour; the status comes from that check, and the date is the last wave reading
 * we hold (from the server or our saved downloads), so it is when the data stops, not when we looked.
 */
type WaveSensor = { sensor: boolean; dataset?: string };
export const wavesOf = (id: string): WaveSensor | null =>
  ((registry.stations as { id: string; waves?: WaveSensor }[]).find((s) => s.id === id)?.waves ?? null);

/** The last wave reading we hold for a buoy: the live window's, or the full record's once loaded. */
export const lastWave = (id: string): WaveObs | null => WAVE_LIVE[id]?.last_obs ?? WAVE_META[id]?.last_obs ?? null;

export function wavesText(id: string, short = false): string {
  const w = wavesOf(id);
  if (!w) return "";
  if (!w.sensor) return short ? "no sensor" : "Waves: no wave sensor on this buoy.";
  const status = WAVE_LIVE[id];
  const last = lastWave(id);
  const fresh = last && hoursOld(last.time) < OFFLINE_HOURS;
  if (status?.published && fresh) return short ? "published" : "Waves: published on the data server.";
  const when = last ? fmtDate.format(new Date(last.time)) : "";
  const where = status?.published ? "published but not updating" : "not published on the data server (checked hourly)";
  return short
    ? `offline${when ? `, last reading ${when.replace(/, \d{4}$/, "")}` : ""}`
    : `Waves: ${where}${when ? `; last reading ${when}` : ""}. LISICOS posts a wave panel as an image.`;
}

function turbSection(stations: StationData[], live: Live, hist: TurbHistory | null): StationData | null {
  const lt = live.turbidity ?? {};
  const buoys = stations.filter((d) => d.kind === "buoy" && lt[d.meta.id]).map((d) => ({ id: d.meta.id, name: d.meta.name }));
  if (!buoys.length) return null;
  const col = (f: TurbFrame | undefined, l: TurbFrame | undefined, k: "turb_ntu" | "suspect") =>
    Hourly.merge(Hourly.fromArray(f?.t0, f?.[k]), Hourly.fromArray(l?.t0, l?.[k]));
  const turb: TurbData = {
    buoys,
    ntu: Object.fromEntries(buoys.map((b) => [b.id, col(hist?.stations[b.id], lt[b.id], "turb_ntu")])),
    suspect: Object.fromEntries(buoys.map((b) => [b.id, col(hist?.stations[b.id], lt[b.id], "suspect")])),
    last: Object.fromEntries(buoys.map((b) => [b.id, lt[b.id]?.last_obs ?? null])),
    share30: Object.fromEntries(buoys.map((b) => [b.id, lt[b.id]?.suspect_30d ?? null])),
    qc: hist?.qc ?? "",
  };
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const empty = { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null };
  return {
    kind: "turbidity",
    meta: {
      id: "TURB", name: "Turbidity at the buoys", operator: "LISICOS", lat: 41, lon: -73, info_url: null, series: [],
      note: LIS.turbidityNote,
    },
    depths: buoys.map((b) => b.id),
    ...empty,
    temp: empty,
    views: {},
    obs: Object.fromEntries(buoys.map((b) => [b.id, turb.last[b.id] ? { time: turb.last[b.id]!.time, depth_m: 1, temperature_c: null, salinity: null, oxygen_mg_l: null } : null])),
    live: true,
    now,
    anchor: now,
    met: null,
    level: null,
    tides: [],
    levelNow: null,
    waves: null,
    turb,
  };
}

export interface UsgsTidal {
  generated_at: string;
  stations: Record<string, {
    name: string; short: string; usgs_id: string; lat: number; lon: number; side: string; caveat?: string;
    series: { t0: string | null; step: number; level_ft?: (number | null)[]; temperature_c?: (number | null)[];
      salinity?: (number | null)[]; oxygen_mg_l?: (number | null)[]; turbidity_fnu?: (number | null)[] };
    last: Record<string, { time: string; value: number }>;
    tides?: { pred: { t0: string; step: number; ft: (number | null)[] }; hilo: TideEvent[]; datums_ft: Record<string, number>; flood_ft: Record<string, number | null> };
  }>;
}

/** The USGS gauges with a level, as shore stations; their predictions join the tides (ours, fitted to each gauge's
 * own record and set on NOAA's footing; see the jobs' usgs_tidal). */
export function usgsShoreStations(u: UsgsTidal): StationData[] {
  const toF = (c: number | null | undefined) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
  const out: StationData[] = [];
  for (const [id, g] of Object.entries(u.stations)) {
    if (!g.series.level_ft) continue; // water quality only (Old Lyme): not a tide station
    const st: ShoreMetaStation = {
      id, name: g.short, operator: "USGS", lat: g.lat, lon: g.lon, coops_id: "",
      info_url: `https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/`,
      note: g.caveat ?? null, record_start: g.series.t0,
    };
    const lv = g.last.level_ft, wt = g.last.temperature_c;
    const frame = {
      t0: g.series.t0, step: 3600, level_ft: g.series.level_ft, water_f: g.series.temperature_c?.map(toF),
      last_obs: lv ? { time: lv.time, level_ft: lv.value, water_f: wt ? toF(wt.value) : null } : null,
      tides: g.tides?.hilo ?? [], datum: "MLLW", coops_id: "",
    } as unknown as ShoreFrame;
    out.push(shoreStation(st, frame, undefined));
    if (g.tides) addFittedTides(id, { pred: g.tides.pred, hilo: g.tides.hilo, datums_ft: g.tides.datums_ft, flood_ft: g.tides.flood_ft });
  }
  return out;
}

/* ---------- Coastal airports (NWS ASOS weather, through the Iowa Environmental Mesonet) ---------- */

interface AsosFrame { t0: string | null; step: number; air_f?: (number | null)[]; wind_kt?: (number | null)[]; gust_kt?: (number | null)[]; dir_deg?: (number | null)[]; pressure_mb?: (number | null)[]; last_obs: MetWindow["last_obs"] }
export interface AsosFile { generated_at: string; source: string; stations: Record<string, AsosFrame> }

/** The airports as stations of their own kind: weather only (no water, no tides), shown in the Wind & waves view. */
export function airportStations(a: AsosFile): StationData[] {
  const out: StationData[] = [];
  for (const st of asosRegistry.stations) {
    const f = a.stations[st.id];
    if (!f?.t0) continue;
    const meta = { id: st.id, name: `${st.name}, ${st.place}`, operator: st.operator, lat: st.lat, lon: st.lon, coops_id: "", info_url: st.info_url, note: st.note, record_start: f.t0 } as ShoreMetaStation;
    const frame = { ...f, tides: [], datum: "", coops_id: "" } as unknown as ShoreFrame;
    out.push({ ...shoreStation(meta, frame, undefined), kind: "airport", level: null, levelNow: null });
  }
  return out;
}

/** Shore stations from the registry, west to east (their record start years until the history arrives). */
export const SHORE: ShoreMetaStation[] = shoreRegistry.stations
  .map((s) => ({ ...s, note: (s as { note?: string }).note ?? null, record_start: `${s.record_start_year}-01-01T00:00:00Z` }))
  .sort((a, b) => a.lon - b.lon);
