/** A waterway's rivers: USGS stream gauges, their flow (hourly recent, daily from 1990), where a flow sits among the
 * date's percentiles and USGS's classes, and the Rivers view's sections (an all-rivers summary, then each gauge). */
import { Daily, HOUR, Hourly, type LastObs, type RiverHistory, type RiverLive } from "../series";
import type { Gauge, RiverData, StationData } from "./station-data";

/** Index of a time's Eastern calendar date in a leap year (0 to 365), for the day-of-year percentiles. */
const etMonthDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" });
export function dayOfYear(t: number): number {
  const p = Object.fromEntries(etMonthDay.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(2024, Number(p.month) - 1, Number(p.day)) - Date.UTC(2024, 0, 1)) / 86400000);
}

/** Flow at a time: the hourly window where it reaches, the daily means before it. */
export const riverFlow = (r: RiverData, id: string, t: number) => {
  const h = r.flow[id]?.at(t) ?? NaN;
  return Number.isFinite(h) ? h : (r.daily[id]?.at(t) ?? NaN);
};
export type Pct = "p5" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95";
export const pct = (r: RiverData, id: string, p: Pct, t: number) => r.normals[id]?.[p]?.[dayOfYear(t)] ?? NaN;

/**
 * Where a flow sits among the date's percentiles (5th to 95th), interpolated between them in log flow (flow
 * spreads by ratios). Below the 5th it reads 2.5 and above the 95th 97.5: beyond those the record says only
 * that the flow is rarer than one year in twenty for the date.
 */
const PCTS: [number, Pct][] = [[5, "p5"], [10, "p10"], [25, "p25"], [50, "p50"], [75, "p75"], [90, "p90"], [95, "p95"]];
export function percentileOf(r: RiverData, id: string, t: number, flow: number): number {
  if (!Number.isFinite(flow) || flow <= 0) return NaN;
  const pts = PCTS.map(([q, k]) => [q, pct(r, id, k, t)] as [number, number]).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (pts.length < 2) return NaN;
  if (flow <= pts[0][1]) return 2.5;
  if (flow >= pts[pts.length - 1][1]) return 97.5;
  for (let i = 1; i < pts.length; i++) {
    const [qa, va] = pts[i - 1];
    const [qb, vb] = pts[i];
    if (flow <= vb) return vb === va ? qb : qa + ((qb - qa) * Math.log(flow / va)) / Math.log(vb / va);
  }
  return NaN;
}

/** USGS's flow classes against the day-of-year percentiles of the gauge's approved record. */
export function riverClass(r: RiverData, id: string, t: number, flow: number): string {
  if (!Number.isFinite(flow)) return "";
  const at = (p: "p10" | "p25" | "p75" | "p90") => pct(r, id, p, t);
  if (!Number.isFinite(at("p25"))) return "";
  if (flow < at("p10")) return "much below normal";
  if (flow < at("p25")) return "below normal";
  if (flow <= at("p75")) return "normal";
  if (flow <= at("p90")) return "above normal";
  return "much above normal";
}
/** A percentile for a readout: beyond the 5th and 95th the record says only that it is rarer than that. */
export const pctText = (v: number) => (!Number.isFinite(v) ? "--" : v <= 2.5 ? "<5<small>th</small>" : v >= 97.5 ? "&gt;95<small>th</small>" : ordinal(v).replace(/(\D+)$/, "<small>$1</small>"));

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st... */
export const ordinal = (n: number) => {
  const r = Math.round(n);
  const s = r % 100 >= 11 && r % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[r % 10] ?? "th";
  return `${r}${s}`;
};
export const cfs = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "--");


/** The Rivers view's sections: an all-rivers summary (placed and described by the page), then one section per gauge. */
export function riverSections(rl: RiverLive, rh: RiverHistory, place: { at: [number, number]; note: (gauges: number, sqmi: number) => string }): StationData[] {
  // Largest gauged basin first: the order of the table, the sections and the all-rivers chart.
  const gauges = [...rh.meta.gauges].sort((a, b) => b.drainage_sqmi - a.drainage_sqmi);
  const river: RiverData = {
    gauges,
    flow: Object.fromEntries(gauges.map((g) => [g.id, Hourly.fromArray(rl.gauges[g.id]?.t0, rl.gauges[g.id]?.flow_cfs)])),
    daily: Object.fromEntries(gauges.map((g) => [g.id, Daily.fromArray(rh.daily[g.id]?.t0, rh.daily[g.id]?.flow_cfs)])),
    normals: rh.normals,
    // River turbidity: the gauge with a turbidity sensor.
    turb: (() => {
      const tg = gauges.find((g) => g.turbidity);
      return tg ? Hourly.fromArray(rl.gauges[tg.id]?.t0, rl.gauges[tg.id]?.turb_fnu) : null;
    })(),
    last: Object.fromEntries(gauges.map((g) => [g.id, rl.gauges[g.id]?.last_obs ?? null])),
  };
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const area = gauges.reduce((a, g) => a + g.drainage_sqmi, 0);
  const empty = { hourly: {}, m36: {}, chg: {}, delta: null, delta36: null };
  const obsOf = (g: Gauge): LastObs | null =>
    river.last[g.id] ? { time: river.last[g.id]!.time, depth_m: null, temperature_c: null, salinity: null, oxygen_mg_l: null } : null;
  const base = { ...empty, temp: empty, views: {}, live: true, now, anchor: now, met: null, level: null, tides: [], levelNow: null, waves: null, river };
  const summary: StationData = {
    ...base,
    kind: "rivers",
    meta: {
      id: "RIVERS", name: "All rivers", operator: "USGS", lat: place.at[0], lon: place.at[1], info_url: null, series: [],
      note: place.note(gauges.length, area),
    },
    depths: gauges.map((g) => g.id),
    obs: Object.fromEntries(gauges.map((g) => [g.id, obsOf(g)])),
  };
  const sections = gauges.map(
    (g): StationData => ({
      ...base,
      kind: "river",
      gauge: g,
      meta: {
        id: g.id, name: `${g.river} River`, operator: "USGS", lat: g.lat, lon: g.lon, info_url: `https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/`,
        note: [`${g.name}, draining ${g.drainage_sqmi.toLocaleString("en-US")} square miles; reaches the Sound at ${g.mouth}.`, g.status_note ?? "Values are provisional until USGS approves them."].join(" "),
        series: [{ key: g.id, depth: "SFC", label: "Flow", depth_m: [], record_start: g.record_start, hours: 0, sources: [], live: true, archived_last_obs: null }],
      },
      depths: ["SFC"],
      obs: { SFC: obsOf(g) },
    }),
  );
  return [summary, ...sections];
}

/** A river's daily mean flow, as a series for the year comparison (a value per day, the same at every hour). */
export const dailyFlow = (d: StationData): Daily | null => (d.gauge && d.river?.daily[d.gauge.id]) || null;
