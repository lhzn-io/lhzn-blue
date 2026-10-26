/**
 * The Piscataqua Region (/piscataqua-region/): Great Bay to the Isles of Shoals. A slimmer page than the
 * Sound's, built on the shared map (map.ts), surface fields (fields.ts), time bar (timeline.ts) and charts (chart.ts).
 *
 * Data: v1/piscataqua-region/live.json hourly (jobs: region.py), history.json daily (the rivers' record), and the
 * field files under the same prefix. The station list comes from stations/piscataqua-region.json at build time.
 * Renderers that the Sound page also has (river percentiles, readouts) are written here for now; they move to shared
 * modules later, one at a time.
 */
import "./site.css";
import "./away-links";
import "./forecast-page.css";
import "./region.css";
import registry from "../../../stations/piscataqua-region.json";
import { cssVar, markAsOf, renderLines, type Area, type Line } from "./chart";
import type { Pin } from "./map";
import type { FieldControls, FieldData, FieldKind, RasterHistory } from "./fields";
import { compass, LIGHT_KT, windArrow, windGlyphs } from "./wind-dir";
import { chainButton, navigateTo, revealLinked, wireLinks } from "./links";
import { BUOY_VIEWS, buoyCardsHtml, buoyViewSwitchHtml, drawBuoyFigures, type BuoyCtx, type BuoyView } from "./buoy-views";

const DATA = "/data/v1/piscataqua-region";
const TZ = "America/New_York";
const HOUR = 3600;
const DAY = 86400;
const CHART_BACK = 7 * DAY; // the station charts: a week back
const CHART_AHEAD = 2 * DAY; // and two days ahead (predictions)
const STALE_H = { default: 3, rivers: 6, buoys: 4 };

const $ = (id: string) => document.getElementById(id)!;
const now = () => Date.now() / 1000;
const sec = (iso: string) => Date.parse(iso) / 1000;
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const light = () => document.documentElement.dataset.theme === "light";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function ago(t: number): string {
  const s = Math.max(0, now() - t);
  if (s < HOUR) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * HOUR) return `${Math.round(s / HOUR)} h ago`;
  return `${Math.round(s / DAY)} days ago`;
}

// ---------- Data shapes (region.py) ----------

interface Frame { t0: string | null; step: number; [col: string]: unknown }
interface Status { last_ok?: string; last_error?: string }
interface ShoreSt extends Frame { last_obs: Record<string, number | string | null> | null; tides: { t: string; ft: number; type: "H" | "L" }[]; datum: string; coops_id: string }
interface Level extends Frame { datum: string; last_obs: { time: string; level_ft: number } | null; status: Status }
interface Buoy extends Frame { depth_m: number; oxygen_unit: string; last_obs: Record<string, number | string | null> | null; status: Status }
interface Meter extends Frame { last_obs: { time: string; spd_cms: number; dir_deg: number } | null; status: Status }
interface Prediction { id: string; name: string; flood_dir: number; ebb_dir: number; depth_m: number; t0: string; step: number; v: (number | null)[]; events: { t: string; type: string; v: number }[] }
interface RiverG extends Frame { last_obs: { time: string; flow_cfs: number } | null; usgs_id: string }
interface Live {
  generated_at: string;
  shore?: { stations: Record<string, ShoreSt> };
  levels?: Record<string, Level>;
  buoys?: Record<string, Buoy>;
  current_meters?: Record<string, Meter>;
  current_predictions?: Record<string, Prediction>;
  rivers?: { gauges: Record<string, RiverG> };
  asos?: { stations: Record<string, Frame & { last_obs: Record<string, number | string | null> | null }> };
}
interface RiverHist {
  rivers?: { daily: Record<string, { t0: string; flow_cfs: (number | null)[] }>; normals: Record<string, Record<string, (number | null)[]> | null> };
  buoys?: Record<string, Frame>; // each buoy's daily record (region.py buoy_history)
}

/** The value of an hourly (or regular) column at time t: the nearest step, within half a step. */
function at(f: Frame | undefined, col: string, t: number): number | null {
  const v = f?.[col] as (number | null)[] | undefined;
  if (!f?.t0 || !v?.length) return null;
  const i = Math.round((t - sec(f.t0)) / f.step);
  return i >= 0 && i < v.length && v[i] != null ? (v[i] as number) : null;
}
/** A column on the chart's grid, NaN for gaps. */
const series = (f: Frame | undefined, col: string, xs: number[], scale = 1) => xs.map((t) => { const v = at(f, col, t); return v == null ? NaN : v * scale; });

// ---------- Units (the site's saved choice) ----------

const UNITS = {
  kt: { perCms: 0.0194384, perKt: 1, label: "kt", digits: 1 },
  mph: { perCms: 0.0223694, perKt: 1.150779, label: "mph", digits: 1 },
  ms: { perCms: 0.01, perKt: 0.514444, label: "m/s", digits: 2 },
} as const;
type Unit = keyof typeof UNITS;
let U: Unit = "kt";
try {
  const saved = localStorage.getItem("lhzn-blue-wind-unit");
  if (saved && saved in UNITS) U = saved as Unit;
} catch {
  /* private mode: knots */
}
const UL = () => UNITS[U].label;
const cur = (cms: number, digits: number = UNITS[U].digits) => `${(cms * UNITS[U].perCms).toFixed(digits)} ${UL()}`;
const wind = (kt: number) => `${(kt * UNITS[U].perKt).toFixed(U === "ms" ? 1 : 0)} ${UL()}`;

// ---------- State ----------

let L: Live = { generated_at: "" };
let H: RiverHist = {};
let T: number | null = null; // the time bar's time (null: now)
const tNow = () => T ?? now();
type Layer = FieldKind | "none";
const LINK = new URLSearchParams(location.search);
/* The page's views, as the Sound page's view switch: one chip sets the map layer, the status table and the station
   sections together. The region's stations differ more than the Sound's buoys, so the views are themes (what kind of
   station) rather than variables; Water carries its own switch for the buoys' variables. */
type Theme = "water" | "tides" | "currents" | "rivers" | "weather";
const THEMES: { key: Theme; label: string; layer: Layer }[] = [
  { key: "water", label: "Water", layer: "sst" },
  { key: "tides", label: "Tides", layer: "currents" },
  { key: "currents", label: "Currents", layer: "currents" },
  { key: "rivers", label: "Rivers", layer: "none" },
  { key: "weather", label: "Weather", layer: "wind" },
];
const WATER_VIEWS = BUOY_VIEWS.filter(([k]) => k !== "weather"); // the buoys' weather is under Weather
let theme: Theme = "water";
let bview: BuoyView = "temp";
try {
  const t = LINK.get("view") ?? localStorage.getItem("lhzn-blue-region-view");
  if (t && THEMES.some((x) => x.key === t)) theme = t as Theme;
  const v = LINK.get("var") ?? localStorage.getItem("lhzn-blue-region-bview");
  if (v && WATER_VIEWS.some(([k]) => k === v)) bview = v as BuoyView;
} catch {
  /* private mode */
}
const themeLayer = () => THEMES.find((x) => x.key === theme)!.layer;
let layer: Layer = themeLayer();

const reg = registry as typeof registry & { levels: { id: string; name: string; place: string; operator: string; lat: number; lon: number; datum: string }[] };
const SHORE = reg.shore.stations;
const LEVELS = reg.levels;
const BUOYS = reg.buoys;
const METERS = reg.currents.meters;
const PREDS = reg.currents.predictions;
const GAUGES = reg.rivers.gauges;
const AIRPORTS = reg.asos.stations;

// ---------- Freshness ----------

function stateOf(t: string | null | undefined, staleH = STALE_H.default): Pin["state"] {
  if (!t) return "offline";
  const age = (now() - sec(t)) / HOUR;
  return age <= staleH ? "live" : age <= 48 ? "delayed" : "offline";
}

function drawNotice(): void {
  const quiet: string[] = [];
  for (const b of BUOYS) if (stateOf(L.buoys?.[b.id]?.last_obs?.time as string | undefined, STALE_H.buoys) !== "live") quiet.push(`UNH ${b.name}`);
  for (const g of LEVELS) if (stateOf(L.levels?.[g.id]?.last_obs?.time) !== "live") quiet.push(g.name);
  for (const g of GAUGES) if (stateOf(L.rivers?.gauges[g.id]?.last_obs?.time, STALE_H.rivers) !== "live") quiet.push(`${g.river} River gauge`);
  const note = quiet.length ? `Not reporting in the last hours: ${quiet.join(", ")}. Their charts show their last records.` : "";
  const text = [note, `Updated ${L.generated_at ? ago(sec(L.generated_at)) : "never"}; observations hourly, model fields daily (currents, SST) and every three hours (wind).`].filter(Boolean).join(" ");
  $("outage-pop").textContent = text;
  $("outage-dialog-text").textContent = text;
  $("outage-label").textContent = note ? "Station data" : "Data";
  $("outage-icon").classList.toggle("rg-notice-calm", !note);
  $("outage-icon").hidden = false;
}

function wireNotice(): void {
  const dialog = $("outage-dialog") as HTMLDialogElement;
  $("outage-icon").addEventListener("click", () => {
    if (!matchMedia("(hover: hover)").matches) dialog.showModal();
  });
  $("outage-dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ---------- The status table (at the time bar's time) ----------

const f1 = (v: number | null, d = 1) => (v == null ? "--" : v.toFixed(d));
function lastAt<F extends Frame>(f: F | undefined, col: string, live: number | null | undefined): number | null {
  return T == null ? (live ?? at(f, col, now() - HOUR)) : at(f, col, T);
}

function statusHtml(): string {
  const rows: string[] = [];
  const row = (id: string, name: string, cells: string, state: Pin["state"]) =>
    rows.push(`<tr class="st-${state}" data-go="${id}"><th scope="row"><a href="#st-${id}">${esc(name)}</a></th>${cells}</tr>`);
  const group = (title: string) => rows.push(`<tr class="rg-group"><th colspan="3">${title}</th></tr>`);
  if (theme === "water") {
    group("Buoys");
    for (const b of BUOYS) {
      const d = L.buoys?.[b.id];
      const water = lastAt(d, "water_f", d?.last_obs?.water_f as number | null);
      const sal = lastAt(d, "salinity", d?.last_obs?.salinity as number | null);
      row(b.id, `${b.name} (UNH)`, `<td><b>${f1(water)} °F</b><small>water</small></td><td><b>${f1(sal)}</b><small>salinity</small></td>`, stateOf(d?.last_obs?.time as string, STALE_H.buoys));
    }
    group("Shore");
    const sv = L.shore?.stations.SEAV;
    row("SEAV", "Seavey Island (NOAA)", `<td><b>${f1(lastAt(sv, "water_f", sv?.last_obs?.water_f as number | null))} °F</b><small>water</small></td><td></td>`, stateOf(sv?.last_obs?.time as string));
  }
  if (theme === "tides") statusTides(row, group);
  if (theme === "currents") statusCurrents(row, group);
  if (theme === "rivers") statusRivers(row, group);
  if (theme === "weather") statusWeather(row, group);
  const when = T == null ? "latest readings" : `at ${fmtTime.format(new Date(T * 1000))}`;
  return `<table class="status-grid rg-grid"><caption>${THEMES.find((x) => x.key === theme)!.label}, ${when}</caption><tbody>${rows.join("")}</tbody></table>`;
}

type RowFn = (id: string, name: string, cells: string, state: Pin["state"]) => void;
type GroupFn = (title: string) => void;

function statusTides(row: RowFn, group: GroupFn): void {
  group("Tide and water level");
  const seav = L.shore?.stations.SEAV;
  row("SEAV", "Seavey Island (NOAA)", `<td><b>${f1(lastAt(seav, "level_ft", seav?.last_obs?.level_ft as number | null), 1)} ft</b><small>MLLW</small></td><td><b>${f1(lastAt(seav, "water_f", seav?.last_obs?.water_f as number | null))} °F</b><small>water</small></td>`, stateOf(seav?.last_obs?.time as string));
  for (const g of LEVELS) {
    const d = L.levels?.[g.id];
    row(g.id, g.name, `<td><b>${f1(lastAt(d, "level_ft", d?.last_obs?.level_ft), 1)} ft</b><small>${g.datum}</small></td><td><small>${esc(g.place)}</small></td>`, stateOf(d?.last_obs?.time));
  }
}

function statusCurrents(row: RowFn, group: GroupFn): void {
  group("Currents");
  for (const m of METERS) {
    const d = L.current_meters?.[m.id];
    const s = lastAt(d, "spd_cms", d?.last_obs?.spd_cms);
    const dir = lastAt(d, "dir_deg", d?.last_obs?.dir_deg);
    row(m.id, `${m.name} (NOAA PORTS)`, `<td><b>${s == null ? "--" : cur(s)}</b><small>measured</small></td><td><b>${dir == null ? "--" : `toward ${compass(dir)}`}</b><small>${dir == null ? "" : `${Math.round(dir)}°`}</small></td>`, stateOf(d?.last_obs?.time));
  }
  for (const p of PREDS) {
    const d = L.current_predictions?.[p.id];
    const v = d ? at({ t0: d.t0, step: d.step, v: d.v }, "v", tNow()) : null;
    row(p.id, p.name, `<td><b>${v == null ? "--" : cur(Math.abs(v))}</b><small>predicted</small></td><td><b>${v == null ? "" : v >= 0 ? "flood" : "ebb"}</b><small>NOAA</small></td>`, d ? "live" : "offline");
  }
}

function statusRivers(row: RowFn, group: GroupFn): void {
  group("Rivers");
  for (const g of GAUGES) {
    const d = L.rivers?.gauges[g.id];
    const q = lastAt(d, "flow_cfs", d?.last_obs?.flow_cfs);
    const pct = q == null ? null : percentileWord(g.id, q, tNow());
    row(g.id, `${g.river} River`, `<td><b>${q == null ? "--" : q < 10 ? q.toFixed(1) : Math.round(q)} cfs</b><small>flow</small></td><td><b>${pct ?? ""}</b><small>${pct ? "for the date" : ""}</small></td>`, stateOf(d?.last_obs?.time, STALE_H.rivers));
  }
}

function statusWeather(row: RowFn, group: GroupFn): void {
  group("Airport");
  for (const a of AIRPORTS) {
    const d = L.asos?.stations[a.id];
    const w = lastAt(d, "wind_kt", d?.last_obs?.wind_kt as number | null);
    const dir = lastAt(d, "dir_deg", d?.last_obs?.dir_deg as number | null);
    const air = lastAt(d, "air_f", d?.last_obs?.air_f as number | null);
    row(a.id, `${a.name.replace("Portsmouth International Airport at ", "")} (ASOS)`, `<td><b>${dir == null ? "" : windArrow(dir, w != null && w < LIGHT_KT)}${w == null ? "--" : wind(w)}</b><small>${dir == null ? "wind" : `from ${compass(dir)}`}</small></td><td><b>${f1(air)} °F</b><small>air</small></td>`, stateOf(d?.last_obs?.time as string));
  }
  group("Buoys");
  for (const b of BUOYS) {
    const d = L.buoys?.[b.id];
    const w = lastAt(d, "wind_kt", d?.last_obs?.wind_kt as number | null);
    const g = lastAt(d, "gust_kt", d?.last_obs?.gust_kt as number | null);
    row(b.id, `${b.name} (UNH)`, `<td><b>${w == null ? "--" : wind(w)}</b><small>wind</small></td><td><b>${g == null ? "--" : wind(g)}</b><small>gust</small></td>`, stateOf(d?.last_obs?.time as string, STALE_H.buoys));
  }
}

function drawStatus(): void {
  $("status").innerHTML = statusHtml();
}

// ---------- Rivers: the day-of-year percentiles (as on the Sound page) ----------

/** Index of a time's day in a leap year's 366 days (the normals' layout). */
function doy(t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric" }).formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(2024, Number(p.month) - 1, Number(p.day)) - Date.UTC(2024, 0, 1)) / 864e5);
}
function percentileWord(id: string, q: number, t: number): string | null {
  const n = H.rivers?.normals[id];
  if (!n) return null;
  const i = doy(t);
  const p = (k: string) => n[k]?.[i] ?? null;
  const [p10, p25, p75, p90] = [p("p10"), p("p25"), p("p75"), p("p90")];
  if (p10 == null || p25 == null || p75 == null || p90 == null) return null;
  return q < p10 ? "much below normal" : q < p25 ? "below normal" : q <= p75 ? "normal" : q <= p90 ? "above normal" : "much above normal";
}

// ---------- Station sections ----------

function card(id: string, title: string, sub: string, body: string): string {
  return `<article class="rg-card" id="st-${id}"><h3 class="rg-card-h">${esc(title)}${chainButton(`st-${id}`, esc(title))}</h3><p class="rg-card-sub">${sub}</p>${body}</article>`;
}
const plot = (id: string, label: string) => `<div class="plot rg-plot" id="pl-${id}"><svg role="img" aria-label="${esc(label)}"></svg><div class="plot-labels" aria-hidden="true"></div></div>`;
const legend = (items: [string, string][]) => `<div class="legend">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join("")}</div>`;

const MEASURED = () => cssVar("--now");
const PREDICTED = () => cssVar("--fc-mid") || "#4a7fae";
const MODEL = () => (light() ? "#1f7f86" : "#5fc3c4");
const SECOND = () => (light() ? "#7a6a3a" : "#c9b98a"); // a second measured line, beside the gold
const THIRD = () => (light() ? "#5c5f66" : "#a9afb8");
/** The charts' time rules: the selected time in purple, and "now" (a grey dash) where a chart runs past it (the
 * predictions); on a chart that ends at now the rule would sit on its edge. */
const MARKS = (ahead = false) => ({ asOfColor: cssVar("--rg-time"), ...(ahead ? { marker: { x: now(), label: "now", color: cssVar("--dim") } } : {}) });

function hourGrid(back = CHART_BACK, ahead = 0): number[] {
  const t1 = Math.ceil((now() + ahead) / HOUR) * HOUR;
  const xs: number[] = [];
  for (let t = t1 - back - ahead; t <= t1; t += HOUR) xs.push(t);
  return xs;
}

function renderStations(): void {
  const html: string[] = [];
  if (theme === "water") {
    html.push(`<section class="fc-sec" aria-labelledby="sec-water"><h2 class="fc-h" id="sec-water">Buoys</h2><div class="rg-viewbar">${buoyViewSwitchHtml(bview, WATER_VIEWS)}<p class="note">This year in gold, earlier years in grey (the newest darkest); a year shows where it covers half the dates.</p></div><div class="rg-cards rg-buoys">${buoyCardsHtml(buoyCtx(), bview)}</div></section>`);
  }
  if (theme === "tides") tidesHtml(html);
  if (theme === "currents") currentsHtml(html);
  if (theme === "rivers") riversHtml(html);
  if (theme === "weather") {
    html.push(`<section class="fc-sec" aria-labelledby="sec-air"><h2 class="fc-h" id="sec-air">Weather</h2><div class="rg-cards">`);
    for (const a of AIRPORTS) html.push(card(a.id, a.name, `${esc(a.note)} NWS ASOS through the Iowa Environmental Mesonet.`, plot(a.id, `Wind at ${a.name}`) + legend([[MEASURED(), `wind, ${UL()}`], [SECOND(), `gust, ${UL()}`]])));
    html.push(buoyCardsHtml(buoyCtx(), "weather"));
    html.push(`</div></section>`);
  }
  $("stations").innerHTML = html.join("");
  drawCharts();
}

function tidesHtml(html: string[]): void {
  html.push(`<section class="fc-sec" aria-labelledby="sec-tide"><h2 class="fc-h" id="sec-tide">Tide and water level</h2><div class="rg-cards">`);
  const seav = L.shore?.stations.SEAV;
  const next = (seav?.tides ?? []).filter((e) => sec(e.t) > now()).slice(0, 4);
  html.push(card("SEAV", "Seavey Island", `Kittery, ME. NOAA CO-OPS 8419870, the only NOAA water level gauge in the estuary. Next: ${next.map((e) => `${e.type === "H" ? "high" : "low"} ${fmtShort.format(new Date(sec(e.t) * 1000))} (${e.ft.toFixed(1)} ft)`).join(", ") || "no predictions"}.`,
    plot("SEAV", "Water level at Seavey Island") + legend([[MEASURED(), "observed, ft above MLLW"]])));
  html.push(card("LV-MLLW", "Up the estuary", "Hohonu tide gauges (Gulf of Maine Research Institute), ft above MLLW as each gauge publishes it.",
    plot("LV-MLLW", "Water level at the estuary's tide gauges") + legend(LEVELS.filter((g) => g.datum === "MLLW").map((g, i) => [[MEASURED(), SECOND(), THIRD()][i % 3], g.name]))));
  html.push(card("LV-NAVD", "Exeter, Hampton and York", "Gauges that publish NAVD88 only (Hohonu; Onset at Hampton Harbor), ft above NAVD88: compare their swings, not their levels with the others.",
    plot("LV-NAVD", "Water level at the NAVD88 gauges") + legend(LEVELS.filter((g) => g.datum !== "MLLW").map((g, i) => [[MEASURED(), SECOND(), THIRD()][i % 3], g.name]))));
  const preds = SHORE.filter((s) => s.products.length === 1);
  const rowsHtml = preds.map((s) => {
    const ev = (L.shore?.stations[s.id]?.tides ?? []).filter((e) => sec(e.t) > now()).slice(0, 2);
    return `<tr><th scope="row">${esc(s.name)}</th>${ev.map((e) => `<td>${e.type === "H" ? "High" : "Low"} ${fmtShort.format(new Date(sec(e.t) * 1000))}<br><small>${e.ft.toFixed(1)} ft</small></td>`).join("")}</tr>`;
  }).join("");
  html.push(card("TIDES", "Tide predictions", "NOAA CO-OPS, ft above MLLW.", `<table class="rg-tides"><tbody>${rowsHtml}</tbody></table>`));
  html.push(`</div></section>`);
}

function currentsHtml(html: string[]): void {
  html.push(`<section class="fc-sec" aria-labelledby="sec-cur"><h2 class="fc-h" id="sec-cur">Currents</h2><div class="rg-cards">`);
  for (const m of METERS) {
    html.push(card(m.id, `${m.name}`, `${esc(m.place)}. NOAA PORTS current meter, buoy-mounted; hourly means of its 6-minute readings.`,
      plot(m.id, `Measured current at ${m.name}`) + legend([[MEASURED(), `speed, ${UL()}`]])));
  }
  html.push(card("PRED", "Predicted tidal current", `NOAA predictions at ${PREDS.map((p) => p.name).join(" and ")}, ${UL()}, flood positive.`,
    plot("PRED", "Predicted tidal current") + legend(PREDS.map((p, i) => [[PREDICTED(), MODEL()][i % 2], p.name]))));
  html.push(`</div></section>`);
}

function riversHtml(html: string[]): void {
  html.push(`<section class="fc-sec" aria-labelledby="sec-riv"><h2 class="fc-h" id="sec-riv">Rivers</h2><p class="prose fc-say">Daily mean flow for the last 90 days against the gauge's record for each date: the band spans its middle half (25th to 75th percentile), the lighter band 10th to 90th.</p><div class="rg-cards rg-cards-3">`);
  for (const g of GAUGES) {
    const d = L.rivers?.gauges[g.id];
    html.push(card(g.id, `${g.river} River`, `${esc(g.name)}, USGS ${g.usgs_id}; ${g.drainage_sqmi} sq mi to ${esc(g.mouth)}. ${d?.last_obs ? `Latest ${d.last_obs.flow_cfs} cfs, ${ago(sec(d.last_obs.time))}.` : ""}`, plot(g.id, `Flow of the ${g.river} River`)));
  }
  html.push(`</div></section>`);
}

/** What the buoy views draw with: the page's data, units and colours. */
function buoyCtx(): BuoyCtx {
  return {
    buoys: BUOYS, live: L.buoys, hist: H.buoys, now: now(),
    wind: { label: UL(), perKt: UNITS[U].perKt, digits: U === "ms" ? 1 : 0 },
    colors: { measured: MEASURED(), second: SECOND(), dim: cssVar("--dim"), asOf: cssVar("--rg-time") },
  };
}

/** The view chips over the map: each sets the map's layer, the status table and the sections shown. */
function wireThemes(): void {
  const box = $("themes");
  const mark = () => box.querySelectorAll<HTMLButtonElement>("[data-theme-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeView === theme)));
  box.innerHTML = THEMES.map((t) => `<button type="button" class="rg-btn" data-theme-view="${t.key}" aria-pressed="false">${t.label}</button>`).join("");
  mark();
  box.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-view]");
    if (!btn || btn.dataset.themeView === theme) return;
    theme = btn.dataset.themeView as Theme;
    try {
      localStorage.setItem("lhzn-blue-region-view", theme);
    } catch {
      /* private mode */
    }
    mark();
    layer = themeLayer();
    drawStatus();
    renderStations();
    void syncField();
    writeLink();
  });
}

function wireBuoyViews(): void {
  $("stations").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-bview]");
    if (!btn) return;
    bview = btn.dataset.bview as BuoyView;
    try {
      localStorage.setItem("lhzn-blue-region-bview", bview);
    } catch {
      /* private mode */
    }
    document.querySelectorAll<HTMLButtonElement>("[data-bview]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    document.querySelector(".rg-buoys")!.innerHTML = buoyCardsHtml(buoyCtx(), bview);
    drawBuoyFigures(buoyCtx(), bview);
    markAsOf(T);
    writeLink();
  });
}

/** A chart, where its card is in the view shown (each theme draws only its own sections). */
function draw(id: string, opts: Parameters<typeof renderLines>[1]): void {
  const el = document.getElementById(`pl-${id}`);
  if (el) renderLines(el, opts);
}

function drawCharts(): void {
  const xs = hourGrid();
  if (theme === "water") drawBuoyFigures(buoyCtx(), bview);
  if (theme === "weather") drawBuoyFigures(buoyCtx(), "weather");
  const seav = L.shore?.stations.SEAV;
  draw("SEAV", { xs, lines: [{ ys: series(seav, "level_ft", xs), color: MEASURED(), width: 1.6, label: "Observed", fmt: (v) => `${v.toFixed(2)} ft` }], unit: " ft", ...MARKS(), empty: "No readings this week." });
  for (const datum of ["MLLW", "NAVD"] as const) {
    const gs = LEVELS.filter((g) => (datum === "MLLW" ? g.datum === "MLLW" : g.datum !== "MLLW"));
    const lines: Line[] = gs.map((g, i) => ({ ys: series(L.levels?.[g.id], "level_ft", xs), color: [MEASURED(), SECOND(), THIRD()][i % 3], width: i ? 1.2 : 1.6, label: g.name, fmt: (v: number) => `${v.toFixed(2)} ft` }));
    draw(`LV-${datum}`, { xs, lines, unit: " ft", ...MARKS(), empty: "No readings this week." });
  }
  for (const m of METERS) {
    const d = L.current_meters?.[m.id];
    const dirs = series(d, "dir_deg", xs);
    draw(m.id, {
      xs, unit: ` ${UL()}`, ...MARKS(), empty: "No readings this week.",
      lines: [
        { ys: series(d, "spd_cms", xs, UNITS[U].perCms), color: MEASURED(), width: 1.6, label: "Speed", fmt: (v) => `${v.toFixed(UNITS[U].digits)} ${UL()}` },
        { ys: dirs, color: MEASURED(), label: "Toward", hidden: true, fmt: (v) => `${compass(v)} (${Math.round(v)}°)` },
      ],
    });
  }
  const pxs = hourGrid(2 * DAY, CHART_AHEAD).flatMap((t) => [t, t + 1800]);
  draw("PRED", {
    xs: pxs, unit: ` ${UL()}`, zero: true, ...MARKS(true), empty: "No predictions.",
    lines: PREDS.map((p, i) => {
      const d = L.current_predictions?.[p.id];
      return { ys: pxs.map((t) => { const v = d ? at({ t0: d.t0, step: d.step, v: d.v }, "v", t) : null; return v == null ? NaN : v * UNITS[U].perCms; }), color: [PREDICTED(), MODEL()][i % 2], width: 1.4, label: p.name, fmt: (v: number) => `${Math.abs(v).toFixed(UNITS[U].digits)} ${UL()} ${v >= 0 ? "flood" : "ebb"}` };
    }),
  });
  // Rivers: 90 days of daily means against the percentiles for each date.
  const dxs: number[] = [];
  const d1 = Math.floor(now() / DAY) * DAY;
  for (let t = d1 - 89 * DAY; t <= d1; t += DAY) dxs.push(t);
  for (const g of GAUGES) {
    const daily = H.rivers?.daily[g.id];
    const n = H.rivers?.normals[g.id];
    const q = dxs.map((t) => { if (!daily) return NaN; const i = Math.round((t - sec(daily.t0)) / DAY); const v = daily.flow_cfs[i]; return v == null ? NaN : v; });
    const live = L.rivers?.gauges[g.id];
    const recent = dxs.map((t, k) => (Number.isFinite(q[k]) ? q[k] : (() => { const vs = Array.from({ length: 24 }, (_, h) => at(live, "flow_cfs", t + h * HOUR)).filter((v): v is number => v != null); return vs.length ? vs.reduce((a, b) => a + b) / vs.length : NaN; })()));
    const band = (k: string) => dxs.map((t) => n?.[k]?.[doy(t)] ?? NaN);
    const areas: Area[] = n ? [{ lo: band("p10"), hi: band("p90"), fill: PREDICTED(), opacity: 0.1 }, { lo: band("p25"), hi: band("p75"), fill: PREDICTED(), opacity: 0.2 }] : [];
    draw(g.id, {
      xs: dxs, unit: " cfs", areas, ...MARKS(), empty: "No flow record.",
      lines: [{ ys: band("p50"), color: PREDICTED(), width: 1, dash: "3 3", label: "Median for the date", fmt: (v) => `${Math.round(v)} cfs` },
        { ys: recent, color: MEASURED(), width: 1.6, label: "Daily mean", fmt: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} cfs` }],
    });
  }
  for (const a of AIRPORTS) {
    const d = L.asos?.stations[a.id];
    draw(a.id, {
      xs, unit: ` ${UL()}`, ...MARKS(), empty: "No reports this week.",
      glyphs: windGlyphs(xs[0], xs[xs.length - 1], (t) => ({ from: at(d, "dir_deg", t) ?? NaN, kt: at(d, "wind_kt", t) ?? NaN, color: MEASURED() })),
      lines: [
        { ys: series(d, "gust_kt", xs, UNITS[U].perKt), color: SECOND(), width: 1, dots: true, label: "Gust", fmt: (v) => `${v.toFixed(0)} ${UL()}` },
        { ys: series(d, "wind_kt", xs, UNITS[U].perKt), color: MEASURED(), width: 1.6, label: "Wind", fmt: (v) => `${v.toFixed(U === "ms" ? 1 : 0)} ${UL()}` },
      ],
    });
  }
  markAsOf(T);
}

// ---------- The map: pins and the surface fields ----------

const HOME: [[number, number], [number, number]] = [[-70.95, 42.88], [-70.55, 43.2]];
const NEAR: [[number, number], [number, number]] = [[-71.3, 42.7], [-70.3, 43.45]];

function pins(): Pin[] {
  const out: Pin[] = [];
  for (const b of BUOYS) {
    const lo = L.buoys?.[b.id]?.last_obs;
    out.push({ id: b.id, name: `${b.name} (UNH)`, lat: b.lat, lon: b.lon, kind: "buoy", state: stateOf(lo?.time as string, STALE_H.buoys), label: lo ? `Water ${f1(lo.water_f as number | null)} °F, salinity ${f1(lo.salinity as number | null)}<br>${ago(sec(lo.time as string))}` : "No recent readings" });
  }
  const seav = L.shore?.stations.SEAV?.last_obs;
  const s0 = SHORE[0];
  out.push({ id: "SEAV", name: s0.name, lat: s0.lat, lon: s0.lon, kind: "shore", state: stateOf(seav?.time as string), label: seav ? `Water level ${f1(seav.level_ft as number | null, 2)} ft MLLW<br>${ago(sec(seav.time as string))}` : "No recent readings" });
  for (const g of LEVELS) {
    const lo = L.levels?.[g.id]?.last_obs;
    out.push({ id: g.id, name: g.name, lat: g.lat, lon: g.lon, kind: "shore", state: stateOf(lo?.time), label: lo ? `Water level ${lo.level_ft.toFixed(2)} ft ${g.datum}<br>${ago(sec(lo.time))}` : "No recent readings" });
  }
  for (const m of METERS) {
    const lo = L.current_meters?.[m.id]?.last_obs;
    out.push({ id: m.id, name: m.name, lat: m.lat, lon: m.lon, kind: "shore", state: stateOf(lo?.time), label: lo ? `Current ${cur(lo.spd_cms)} toward ${compass(lo.dir_deg)}<br>${ago(sec(lo.time))}` : "No recent readings" });
  }
  for (const g of GAUGES) {
    const lo = L.rivers?.gauges[g.id]?.last_obs;
    out.push({ id: g.id, name: `${g.river} River`, lat: g.lat, lon: g.lon, kind: "gauge", state: stateOf(lo?.time, STALE_H.rivers), label: lo ? `Flow ${lo.flow_cfs} cfs<br>${ago(sec(lo.time))}` : "No recent readings" });
  }
  for (const a of AIRPORTS) {
    const lo = L.asos?.stations[a.id]?.last_obs;
    out.push({ id: a.id, name: a.name, lat: a.lat, lon: a.lon, kind: "shore", state: stateOf(lo?.time as string), label: lo ? `Wind ${lo.dir_deg == null ? "" : windArrow(lo.dir_deg as number, lo.wind_kt != null && (lo.wind_kt as number) < LIGHT_KT)}${lo.wind_kt == null ? "--" : wind(lo.wind_kt as number)}${lo.dir_deg == null ? "" : ` from ${compass(lo.dir_deg as number)}`}<br>${ago(sec(lo.time as string))}` : "No recent reports" });
  }
  return out;
}

const fieldCache = new Map<string, Promise<FieldData>>();
function fieldData(kind: FieldKind): Promise<FieldData> {
  if (!fieldCache.has(kind)) {
    const get = <X,>(name: string) => fetch(`${DATA}/fields/${name}`, { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<X>) : Promise.reject(new Error(`${name}: HTTP ${r.status}`))));
    const load: Promise<FieldData> =
      kind === "currents" ? Promise.all([get<FieldData["mesh"]>("currents-mesh.json"), get<FieldData["currents"]>("currents.json")]).then(([mesh, currents]) => ({ mesh, currents }))
        : kind === "wind" ? get<FieldData["wind"]>("hrrr-wind.json").then((wind) => ({ wind }))
          : get<FieldData["raster"]>(`${kind}.json`).then((raster) => ({ raster }));
    fieldCache.set(kind, load.catch((err) => {
      fieldCache.delete(kind);
      throw err;
    }));
  }
  return fieldCache.get(kind)!;
}
let sstHistory: Promise<RasterHistory | null> | null = null;
function sstHistoryData(): Promise<RasterHistory | null> {
  sstHistory ??= fetch(`${DATA}/fields/sst-90d.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`sst history: HTTP ${r.status}`))))
    .then(async (buf) => (await import("./fields")).decodeHistory(buf))
    .catch(() => null);
  return sstHistory;
}

const CHOICES: FieldControls["choices"] = [
  { kind: "none", label: "None" },
  { kind: "currents", label: "Currents (NECOFS)" },
  { kind: "wind", label: "Wind (HRRR)" },
  { kind: "sst", label: "Sea surface temperature" },
];
let mapWide = false;
function controls(): FieldControls {
  return {
    choices: CHOICES,
    chosen: layer,
    onPick: (k) => {
      layer = k;
      writeLink();
      void syncField();
    },
    wide: mapWide,
    onWide: (w) => {
      mapWide = w;
      document.querySelector(".overview")?.classList.toggle("map-wide", w);
      void syncField();
    },
    speed: { label: UL(), perCms: UNITS[U].perCms, digits: UNITS[U].digits },
  };
}

async function syncField(): Promise<void> {
  const tl = await import("./timeline");
  let payload: FieldData = {};
  if (layer !== "none") {
    try {
      payload = await fieldData(layer);
    } catch (err) {
      console.error(err);
    }
  }
  const shown = layer !== "none" && (payload.raster || payload.currents || payload.wind) ? layer : null;
  if (shown !== "sst") tl.setScale("hours");
  tl.setFrame(...((shown === "sst" ? [24, 0] : shown ? [0.5, 0.5] : [0, 0]) as [number, number]));
  const fields = await import("./fields");
  await fields.showField(shown, payload, controls());
  if (shown === "sst") {
    const history = await sstHistoryData();
    if (history && layer === "sst") {
      tl.setScale("days");
      void fields.showField(shown, { ...payload, history }, controls());
    }
  }
}

async function drawMap(): Promise<void> {
  const map = await import("./map");
  map.configureMap({ home: HOME, near: NEAR });
  map.drawMap($("map"), pins(), (id) => navigateTo(`st-${id}`), light() ? "light" : "dark");
  const [tl, chart] = await Promise.all([import("./timeline"), import("./chart")]);
  tl.mountTimeline($("map-foot"));
  TL = tl;
  tl.onAsOf((t) => {
    T = t;
    chart.markAsOf(t);
    drawStatus();
    writeLink();
    import("./fields").then((f) => f.setFieldTime(t)).catch(() => undefined);
  });
  const h = Number(LINK.get("h"));
  if (Number.isFinite(h) && h !== 0) tl.setOffset(h);
  await syncField();
}

// ---------- The link: the layer and the time ----------

let TL: typeof import("./timeline") | null = null;

/** The page's address for what is on screen: view, buoy variable, layer, time, and optionally an anchor (a station's
 * card "st-SEAV", a plot "pl-GBB-temp-yoy"). */
function linkUrl(anchor?: string): string {
  const q: string[] = [];
  if (theme !== "water") q.push(`view=${theme}`);
  if (theme === "water" && bview !== "temp") q.push(`var=${bview}`);
  if (layer !== themeLayer()) q.push(`layer=${layer}`);
  const off = TL?.position().offset ?? 0;
  if (off) q.push(`h=${off}`);
  return location.pathname + (q.length ? `?${q.join("&")}` : "") + (anchor ? `#${anchor}` : "");
}

/** Keep the address bar current (no history entry); the anchor stays while what it names is on the page. */
let linkPending = 0;
function writeLink(): void {
  if (linkPending) return;
  linkPending = window.setTimeout(() => {
    linkPending = 0;
    const a = decodeURIComponent(location.hash.slice(1));
    history.replaceState(null, "", linkUrl(a && document.getElementById(a) ? a : undefined));
  }, 400);
}

// ---------- Units and theme ----------

function wireUnits(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-unit]");
  const mark = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === U)));
  mark();
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      U = (b.dataset.unit as Unit) in UNITS ? (b.dataset.unit as Unit) : "kt";
      try {
        localStorage.setItem("lhzn-blue-wind-unit", U);
      } catch {
        /* private mode */
      }
      mark();
      redraw();
      void syncField();
    }),
  );
}

function wireTheme(): void {
  const btn = $("theme-toggle");
  const MOON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const SUN = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const label = () => {
    btn.innerHTML = light() ? MOON : SUN;
    btn.setAttribute("aria-pressed", String(light()));
    btn.setAttribute("aria-label", light() ? "Switch to the dark theme" : "Switch to the light theme");
  };
  label();
  btn.addEventListener("click", async () => {
    const next = light() ? "dark" : "light";
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("lhzn-blue-theme", next);
    } catch {
      /* private mode */
    }
    label();
    redraw();
    (await import("./map")).setMapTheme(next);
  });
}

function redraw(): void {
  drawStatus();
  renderStations();
}

// ---------- Method and credits ----------

function drawMethod(): void {
  const items: [string, string][] = [
    ["Area", "Great Bay, Little Bay, the Piscataqua, Portsmouth Harbor and the Hampton-Seabrook estuary, out to the Isles of Shoals (42.88 to 43.20 N, 70.95 to 70.55 W)."],
    ["Buoys", 'The University of New Hampshire\'s <a href="https://data.neracoos.org/erddap/tabledap/UNH_GBB.html">Great Bay buoy</a> and <a href="https://data.neracoos.org/erddap/tabledap/UNH_CML.html">Coastal Marine Laboratory</a> station, through the NERACOOS ERDDAP. Values the operator flags suspect or failed (QARTOD) are left out; that currently includes both stations\' wind direction. Hourly means; oxygen as each station reports it (percent saturation at the buoy, micromoles per kilogram at the lab).'],
    ["Water level", 'NOAA CO-OPS <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=8419870">Seavey Island (8419870)</a>, and the Gulf of Maine Research Institute\'s Hohonu gauges and Onset\'s Hampton Harbor gauge through NERACOOS. Gauges that publish a level above MLLW are shown so; the others above NAVD88. Tide predictions from NOAA CO-OPS.'],
    ["Currents", 'The NOAA PORTS current meter at <a href="https://tidesandcurrents.noaa.gov/cdata/StationInfo?id=pm0101">Gangway Rocks (pm0101)</a>, hourly means by components of its 6-minute readings; NOAA tidal current predictions for the harbour entrance (PIR0701) and the General Sullivan Bridge (PIR0710). On the map, the NECOFS model\'s surface currents (FVCOM GOM7, top layer), University of Massachusetts Dartmouth (SMAST), hourly.'],
    ["Rivers", "USGS streamflow, provisional. The percentile bands are USGS's day-of-year statistics of daily mean discharge for each gauge's record."],
    ["Wind and SST", "NOAA's HRRR 10 m wind (3 km), and the satellite sea surface temperature analysis (MUR, NASA JPL), each over the region's box. Pease airport (KPSM) through the Iowa Environmental Mesonet."],
    ["Colours", "Measurements are gold, predictions blue, the model teal; the selected time is purple and now a grey dash."],
  ];
  $("method").innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("credits").innerHTML = `<p><b>Data:</b> ${(registry.credits as string[]).map(esc).join("; ")}. Thank you to all of them.</p><p><b>Provisional data.</b> Not for navigation. <a href="/terms/">Terms</a>.</p><p>A <a href="/">longhorizon.blue</a> page by <a href="https://longhorizon.eco/observatory">Long Horizon Observatory</a>.</p>`;
}

// ---------- Boot ----------

async function main(): Promise<void> {
  const l = LINK.get("layer");
  if (l && CHOICES.some((c) => c.kind === l)) layer = l as Layer;
  wireUnits();
  wireTheme();
  wireNotice();
  wireThemes();
  wireBuoyViews();
  drawMethod();
  try {
    const r = await fetch(`${DATA}/live.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(String(r.status));
    L = (await r.json()) as Live;
  } catch {
    const e = $("load-error");
    e.hidden = false;
    e.innerHTML = "<b>The data could not be loaded.</b> Please try again in a few minutes.";
  }
  try {
    const r = await fetch(`${DATA}/history.json`, { cache: "no-cache" });
    if (r.ok) H = (await r.json()) as RiverHist;
  } catch {
    /* the rivers show without their percentiles */
  }
  drawNotice();
  drawStatus();
  renderStations();
  void drawMap().then(() => revealLinked()); // again once the map and time bar are in, which move the page
  // Jumps to a station or plot are history entries, and every plot and card has a chain button (links.ts); a row of
  // the status table goes to its station. A linked anchor is revealed once the sections draw.
  wireLinks(linkUrl, (e) => {
    const go = (e.target as HTMLElement).closest<HTMLElement>("tr[data-go]")?.dataset.go;
    return go ? `st-${go}` : null;
  });
  window.setTimeout(() => revealLinked(), 300);
  // The address names the view shown from the start (a remembered one included), so Back to it is not read as a
  // change of view.
  history.replaceState(null, "", linkUrl(decodeURIComponent(location.hash.slice(1)) || undefined));
  // Back and Forward: the browser restores the scroll; the time comes back from the address, and a different view or
  // variable reloads the page as linked.
  window.addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search);
    if ((p.get("view") ?? "water") !== theme || (theme === "water" && (p.get("var") ?? "temp") !== bview)) {
      location.reload();
      return;
    }
    TL?.setOffset(Number(p.get("h")) || 0);
  });
  let pending = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(drawCharts, 150);
  });
}

void main();
