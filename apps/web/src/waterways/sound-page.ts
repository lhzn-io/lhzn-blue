/** The Long Island Sound's own parts of its page: each station's About (its operator's sensors and panels, the rivers'
 * gauges and where they reach the Sound), and the USGS water-quality table under the overview (the shore sondes in
 * harbors, a pond and river mouths). The page includes them; another waterway brings its own. */
import { DO_LEVELS, Hourly, oxygenStatus, type MetaSeries } from "../series";
import { BUOY_SENSORS } from "../methods";
import { ago, escHtml, fmtDate, hourOf, hoursOld, sqmi } from "../waterway/format";
import { AT, atLabel, sparklineOf } from "../waterway/cursor";
import { DELAYED_HOURS, isWater, OFFLINE_HOURS, unitName, WATER_VARS, type StationData, type VarKey } from "../waterway/station-data";
import { atCell } from "../waterway/cells";
import { M } from "../waterway/models";
import { lastSeen, panelsOf, wavesOf, wavesText, type UsgsTidal } from "../adapters/sound";

const TIDES_PAGE = "/long-island-sound/tides/"; // "Reading the tides": unlinked until it returns
void TIDES_PAGE;
const WATER_PAGE = "/long-island-sound/tides/"; // "Reading the tides": unlinked until it returns
void WATER_PAGE;

const PROVISIONAL = "Values are provisional until USGS approves them.";

/** A buoy, shore station or the turbidity section's About: what it is, its record and every note, as labelled rows. */
export function stationAboutHtml(d: StationData, page: { recordLine(d: StationData, perDepth: string): string; isQuiet(d: StationData): boolean }): string {
  const st = d.meta;
  const row = (label: string, html: string) => `<dt>${label}</dt><dd>${html}</dd>`;
  const links = [
    st.info_url ? `<a href="${st.info_url}">${d.kind === "buoy" ? "about this buoy" : "station page"}</a>` : "",
    panelsOf(st.id).weather ? `<a href="${panelsOf(st.id).weather}">weather panel</a>` : "",
    panelsOf(st.id).water_quality ? `<a href="${panelsOf(st.id).water_quality}">water quality panel</a>` : "",
    panelsOf(st.id).waves ? `<a href="${panelsOf(st.id).waves}">wave panel</a>` : "",
  ].filter(Boolean);
  let rows = "";
  if (d.kind !== "turbidity") {
    rows += row(d.kind === "buoy" ? "Buoy" : "Station", `${escHtml(st.name)} (${st.id}), ${escHtml(st.operator)}; ${st.lat.toFixed(2)}&deg;N ${Math.abs(st.lon).toFixed(2)}&deg;W${links.length ? ` (${links.join(", ")})` : ""}.`);
  }
  const startOf = (s: MetaSeries) => (M.view() === "temp" ? s.record_start : s.vars?.[M.view()]?.record_start);
  const record = page.recordLine(d, st.series.map((s) => `${s.label.toLowerCase()} from ${startOf(s)?.slice(0, 4) ?? "--"}`).join(", "));
  rows += row("Record", `${record.replace(/^Record: (.)/, (_, c: string) => c.toUpperCase())}.`); // the row is already labelled
  if (st.note) rows += row("Notes", st.note); // our own text (it may carry a link)
  if (d.kind === "shore" && isWater(M.view()) && M.view() !== "temp") rows += row("Measures", `Water temperature only; ${WATER_VARS[M.view()].label.toLowerCase()} on this page comes from the buoys.`);
  const status = [
    !d.live && st.outage_note ? st.outage_note : "",
    page.isQuiet(d)
      ? `No reading since ${fmtDate.format(new Date(lastSeen(d) * 1000))}, so there is no line for this year and the recent charts are empty. ` +
        `The year charts show this time of year in the years we hold; Full record shows everything we have kept.` +
        (d.kind === "buoy" ? " For recent conditions, see the LISICOS panels (images on their site)." : "")
      : "",
  ].filter(Boolean);
  if (status.length) rows += row("Status", status.join(" "));
  if (d.kind === "buoy" && wavesOf(st.id)) rows += row("Waves", escHtml(wavesText(st.id).replace(/^Waves: /, "")).replace(/^./, (c) => c.toUpperCase()));
  const s = d.kind === "buoy" ? BUOY_SENSORS[st.id] : undefined;
  if (s) {
    const parts = [["Topside", s.topside], ["Surface", s.surface], ["Mid-depth", s.mid], ["Bottom", s.bottom]].filter(([, v]) => v);
    rows += row(
      "Sensors",
      `${escHtml(s.platform)}, as LISICOS lists its 2019 configuration (<a href="/references/#lisicos">reference</a>).` +
        `<ul class="about-sensors">${parts.map(([l, v]) => `<li><b>${l}:</b> ${escHtml(v!)}</li>`).join("")}</ul>`,
    );
  }
  return `<dl class="about-list">${rows}</dl><p class="about-foot">Times are stored in UTC and labelled in New York time. All data are provisional and may be revised.</p>`;
}

/** A river section's About: the gauge (or, for All rivers, every gauge) from rivers.json, as labelled rows. */
export function gaugeAboutHtml(d: StationData): string {
  const row = (label: string, html: string) => `<dt>${label}</dt><dd>${html}</dd>`;
  const gauges = d.river?.gauges ?? [];
  let rows: string;
  if (d.kind === "rivers") {
    const area = gauges.reduce((a, g) => a + g.drainage_sqmi, 0);
    const conn = gauges.find((g) => g.id === "CONN");
    rows =
      row("Gauges", `${gauges.length} USGS stream gauges, largest basin first:<ul class="about-sensors">${gauges
        .map((g) => `<li><a href="#${g.id}">${escHtml(g.river)}</a>: ${sqmi(g.drainage_sqmi)}${g.discontinued ? " (no flow published since " + escHtml(fmtDate.format(new Date(`${g.discontinued}T12:00:00Z`))) + ")" : ""}</li>`)
        .join("")}</ul>`) +
      row("Drains", `${sqmi(Math.round(area))} in all${conn ? `, about ${Math.round((100 * conn.drainage_sqmi) / area / 5) * 5}% of it the Connecticut River above Thompsonville` : ""}. The Naugatuck joins the Housatonic below the Stevenson gauge, so the two add without double counting.`) +
      row("Not measured", "On Long Island most fresh water reaches the Sound as groundwater, which stream gauges do not measure, so the north shore is under-represented here.") +
      row("Caveats", PROVISIONAL);
  } else {
    const g = d.gauge!;
    const note = g.status_note ?? "";
    rows =
      row("Gauge", `${escHtml(g.name)}, USGS ${g.usgs_id} (<a href="https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/">gauge page</a>)`) +
      row("Drains", sqmi(g.drainage_sqmi)) +
      row("Reaches the Sound", `At ${escHtml(g.mouth)}.`) +
      row("Record", g.discontinued
        ? `Daily mean flow from ${g.record_start ? g.record_start.slice(0, 4) : "1990"} to ${fmtDate.format(new Date(`${g.discontinued}T12:00:00Z`))}.`
        : `Daily mean flow from ${g.record_start ? g.record_start.slice(0, 4) : "1990"}; recent flow hourly, from 15-minute readings.`) +
      (note ? row(g.discontinued ? "Status" : "Notes", escHtml(note.replace(PROVISIONAL, "").trim())) : "") +
      row("Caveats", PROVISIONAL);
  }
  return `<dl class="about-list">${rows}</dl><p class="about-foot">Times are stored in UTC and labelled in New York time. All data are provisional and may be revised.</p>`;
}

let USGS_WQ: UsgsTidal | null = null;
/** The USGS gauges' file, once it arrives (the adapter hands it over). */
export function setUsgsWq(u: UsgsTidal | null): void {
  USGS_WQ = u;
}
const USGS_VAR: Partial<Record<VarKey, { key: "temperature_c" | "salinity" | "oxygen_mg_l" | "turbidity_fnu"; unit: string; digits: number; f?: (v: number) => number }>> = {
  temp: { key: "temperature_c", unit: "&deg;F", digits: 1, f: (c) => (c * 9) / 5 + 32 },
  salinity: { key: "salinity", unit: "", digits: 1 },
  oxygen: { key: "oxygen_mg_l", unit: "", digits: 1 },
  turbidity: { key: "turbidity_fnu", unit: " FNU", digits: 1 },
};
// What each gauge's water is (so its numbers are read for what they are).
const USGS_SITE_NOTE: Record<string, string> = {
  WHOB: "West Harbor, Oyster Bay: a harbor off the western Sound",
  NORW: "the Norwalk River at the Maritime Aquarium: a river mouth, fresher and more turbid than the open Sound",
  FLAX: "Flax Pond: a tidal salt-marsh pond behind a narrow inlet, warmer and cooler than the Sound by turns",
  OLDL: "the Connecticut River at Old Lyme: the river's estuary, nearly fresh at most tides",
};

/** The USGS shore gauges' water quality for the view's variable, west to east: value, age, 7-day line. */
export function usgsWqHtml(): string {
  const spec = USGS_VAR[M.view()];
  if (!USGS_WQ || !spec) return "";
  const rows = Object.entries(USGS_WQ.stations)
    .filter(([, g]) => g.series[spec.key]?.length)
    .sort(([, a], [, b]) => a.lon - b.lon)
    .map(([id, g]) => {
      const vals = g.series[spec.key]!.map((v) => (v == null ? NaN : spec.f ? spec.f(v) : v));
      const h = new Hourly(Date.parse(g.series.t0!) / 1000, Float64Array.from(vals));
      const last = g.last[spec.key];
      const site = `${USGS_SITE_NOTE[id] ?? g.name}. USGS ${g.usgs_id}, provisional data`;
      const name = `<th scope="row"><a href="https://waterdata.usgs.gov/monitoring-location/USGS-${g.usgs_id}/" title="${site}"><i class="dot shore ${last && hoursOld(last.time) < DELAYED_HOURS ? "live" : last && hoursOld(last.time) < OFFLINE_HOURS ? "delayed" : "offline"}"></i>${g.short}</a></th>`;
      const spark = sparklineOf(h, M.palette().line, spec.unit.replace(/&deg;/, "°").trim() || unitName(M.view()), spec.digits);
      let cell: string;
      if (AT != null) {
        const v = h.at(hourOf(AT));
        cell = atCell(v, `${v.toFixed(spec.digits)}${spec.unit}`, `${g.short}: ${v.toFixed(spec.digits)}${spec.unit}`, spark);
      } else if (!last || hoursOld(last.time) >= OFFLINE_HOURS) {
        cell = `<td class="offline"><b>--</b><small>no recent reading</small></td>`;
      } else {
        const v = spec.f ? spec.f(last.value) : last.value;
        const low = M.view() === "oxygen" && v < DO_LEVELS.hypoxic;
        cell = `<td class="${hoursOld(last.time) < DELAYED_HOURS ? "live" : "delayed"}${low ? " low" : ""}" title="${g.short}: ${v.toFixed(spec.digits)}${spec.unit}, ${ago(last.time)}; ${site}">${spark}<b>${v.toFixed(spec.digits)}${spec.unit}</b><small>${low ? oxygenStatus(v) + " &middot; " : ""}${ago(last.time).replace(" ago", "")}</small></td>`;
      }
      return `<tr>${name}${cell}</tr>`;
    });
  if (!rows.length) return "";
  const what = M.view() === "turbidity" ? "turbidity (FNU, a different scale from the buoys' NTU)" : `${WATER_VARS[M.view()].label.toLowerCase()} (${M.view() === "temp" ? "&deg;F" : unitName(M.view())})`;
  return `<table class="status-grid usgs-wq"><caption>Shore gauges &middot; USGS, west to east: ${what}${AT != null ? ` at ${atLabel(AT)}` : ", latest"}</caption><tbody>${rows.join("")}</tbody></table>
    <p class="status-key">A separate source from the buoys: USGS water-quality sondes in harbors, a pond and river mouths, near the surface; provisional. Hover a name for what its water is.</p>`;
}
