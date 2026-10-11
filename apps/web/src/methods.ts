/**
 * What each plot and map layer shows, how it is computed, and where it comes from: the text behind every (i) on the
 * page, and (with Collect) the method notes in the "Ask your AI" prompt, so the two never drift apart.
 *
 * Text conventions: `[[key]]` marks a citation of an entry on /references/ (numbered per dialog, in order of first
 * use); `{variable}` and `{station}` are filled in from the page.
 */

export interface Method {
  title: string;
  shows: string;
  method?: string;
  sensors?: string;
  sources?: string;
  caveats?: string;
  /** Variable-specific additions, appended to the caveats in that view. */
  byVariable?: Partial<Record<"temp" | "salinity" | "oxygen", string>>;
}

const QC =
  "Gross-range checks (temperature -2 to 35 °C, salinity 5 to 36, dissolved oxygen 0 to 20 mg/L), narrowed where the " +
  "waterway sets its own range. A spike test drops a reading more than 1.5 °C, 1.5 salinity or 2 mg/L from the median of " +
  "the 13 readings around it (about 3 hours). A placeholder test drops a run of whole-number readings; real sensor values " +
  "carry decimals, and the server has published day counts in a salinity column. Flat-line tests are not yet applied.";

const OXYGEN_LEVELS =
  "Shading marks reference levels: under 1 mg/L anoxic and under 3 mg/L hypoxic, as the Long Island Sound Partnership " +
  "defines them [[lisp2024hypoxia]]; under 4.8 mg/L, EPA's criterion for continuous exposure that protects growth from Cape " +
  "Cod to Cape Hatteras. These are levels for reading the plot, not a regulatory assessment. Summer hypoxia and its history " +
  "in the western Sound: [[epa_roe_hypoxia]] [[wilson2008hypoxia]] [[anderson2001pulses]].";

const UNITS = {
  temp: "",
  salinity: "Salinity is on the practical salinity scale, which has no unit.",
  oxygen: "Dissolved oxygen in mg/L.",
};

export const METHODS: Record<string, Method> = {
  yoy: {
    title: "This year against earlier years",
    shows:
      "{variable} at the selected depth, this year against every earlier year on the same calendar dates, from 96 days back " +
      "to 14 days ahead. This year is the bold line; earlier years run from the most recent to the oldest.",
    method:
      "Each line is a trailing 36-hour mean of hourly means, with at least 24 of the 36 hours present; gaps stay gaps. A year " +
      "is drawn only when at least 80% of the window has data. Full record draws every year end to end.",
    sources: "{station}, LISICOS, University of Connecticut [[lisicos]], with our own saved downloads where the server no longer publishes the early record.",
    caveats: "Years with less than 80% coverage are listed under the plot, not drawn.",
    byVariable: { salinity: UNITS.salinity, oxygen: UNITS.oxygen },
  },
  chg: {
    title: "7-day change",
    shows:
      "The change in the 36-hour mean of {variable} at the selected depth over the past week, this year against earlier " +
      "years, over the last 60 days. Zero is no change.",
    method: "The 36-hour mean now minus the same mean 168 hours earlier; year and coverage rules as for the year comparison.",
    sources: "{station}, LISICOS [[lisicos]].",
    byVariable: { salinity: UNITS.salinity, oxygen: UNITS.oxygen },
  },
  col: {
    title: "Water column",
    shows: "{variable} at each depth the station measures, recent weeks. Faint lines are hourly means; bold lines are 36-hour means.",
    method: `Hourly means of the readings that pass quality control; 36-hour means as for the year comparison. Quality control: ${QC}`,
    sources: "{station}, LISICOS [[lisicos]].",
    byVariable: { salinity: UNITS.salinity, oxygen: `${UNITS.oxygen} ${OXYGEN_LEVELS}` },
  },
  sb: {
    title: "Surface minus bottom",
    shows: "Surface {variable} minus bottom {variable}, hourly and as a 36-hour mean.",
    method:
      "For temperature, a working definition of stratification over the last 24 hours: mixed under 0.3 °C, weakly " +
      "stratified to 1.0 °C, stratified above. Salinity and oxygen are drawn without thresholds.",
    caveats:
      "The thresholds are a working definition, not a published standard. The Sound's stratification and mixing: " +
      "[[odonnell2013physical]] [[torgersen1997mixing]].",
    sources: "{station}, LISICOS [[lisicos]].",
  },
  wind: {
    title: "Wind",
    shows:
      "Wind speed at the station: a smoothed line, the hourly wind (faint) and each day's strongest gust (dots). Hovering " +
      "gives the direction it blows from.",
    method:
      "The bold line is hourly for the last two days, then smoothed more the older it is: a two-sided exponential moving " +
      "average whose half-life widens from 1 hour two days back to 6 hours two weeks back and a day a month back, so recent " +
      "hours keep their detail and earlier weeks read as a trend. The average runs forward and back so peaks are not delayed, " +
      "and restarts after a gap.",
    caveats: "Buoy weather is kept for the last 100 days so far. Speeds follow the Units switch.",
  },
  air: {
    title: "Air and water temperature",
    shows: "Hourly air temperature and surface water temperature.",
    sources: "The station's weather sensors and its surface sensor.",
  },
  tide: {
    title: "Water level",
    shows: "Observed water level each hour, and the predicted highs and lows, in feet above mean lower low water.",
    sources: "NOAA CO-OPS.",
    caveats:
      "Observations are preliminary until NOAA verifies them. Predictions are astronomical tide only; wind and pressure move " +
      "the observed level away from them.",
  },
  waves: {
    title: "Waves",
    shows: "Significant wave height each hour, and each hour's highest single wave (faint). Hovering gives the dominant period.",
    method: "Significant height is the mean of the highest third of the waves.",
    caveats:
      "The wave datasets have been unpublished on the data server for long stretches; the record before an outage comes from " +
      "our saved downloads, and the page checks every hour. Heights follow the Units switch. Wave growth in the western Sound " +
      "is fetch-limited and larger under easterly winds [[shin2021waves]].",
  },
  pressure: {
    title: "Pressure",
    shows: "Barometric pressure each hour at the station.",
    method: "The tendency is the change over the last 3 hours.",
  },
  flow: {
    title: "Flow against normal",
    shows:
      "A river's flow against what is usual for each date: the median (middle line), 25th to 75th percentile (darker band) " +
      "and 10th to 90th (lighter band).",
    method: "Percentiles of daily mean flow for each calendar date, from the gauge's approved record.",
    sources: "USGS Water Data for the Nation, {station}.",
    caveats: "Recent values are provisional until USGS approves them.",
  },
  share: {
    title: "All rivers against normal",
    shows: "Each river's flow as a percentile for its date, all rivers on one plot; 25 to 75 is normal.",
    method: "Percentiles of daily mean flow for each calendar date, per river, from approved USGS record.",
    sources: "USGS Water Data for the Nation.",
  },
  rpct: {
    title: "Percentile for the date",
    shows: "One river's flow as a percentile for its date, over time.",
    method: "Percentiles of daily mean flow for each calendar date, from the gauge's approved record.",
    sources: "USGS Water Data for the Nation, {station}.",
  },
  ryoy: {
    title: "This year against earlier years",
    shows: "Daily mean flow this year against earlier years on the same dates.",
    sources: "USGS Water Data for the Nation, {station}.",
  },
  rturb: {
    title: "River turbidity",
    shows: "Hourly river turbidity in formazin nephelometric units (FNU), from a USGS sensor that is serviced and reviewed.",
    sources: "USGS Water Data for the Nation.",
    caveats: "FNU and the buoys' NTU are close but not identical units.",
  },
  bturb: {
    title: "Turbidity at the buoys",
    shows: "Hourly median turbidity at about 1 m at each buoy, in NTU; faint where the day is flagged as likely sensor fouling.",
    method:
      "Readings that repeat one value for 2 hours or more are dropped as stuck. A day whose quietest tenth of readings sits " +
      "above 5 NTU is flagged as likely fouling. The axis stops at a cap; higher readings run along the top edge, with the " +
      "value on hover.",
    sensors: "The turbidity channel of the Sea-Bird ECO FLNTU (chlorophyll fluorescence and turbidity) at the surface of each buoy [[lisicos]].",
    caveats:
      "In warm water the optical window fouls within weeks and the reading climbs though the water has not changed; servicing " +
      "drops it back in one step. The fouling flag is a working rule, to be checked against LISICOS servicing dates. Turbidity " +
      "in the Sound's bays and harbors is measured by Save the Sound's Unified Water Study [[sts_monitoring]].",
  },
  "map-sst": {
    title: "Sea surface temperature",
    shows: "Sea surface temperature at 0.01° (about 1 km), for the day shown.",
    method:
      "The MUR multi-sensor analysis, which fills gaps between satellite passes [[chin2017mur]] [[jpl2015mur]]. Every layer " +
      "covers one box (40.45 to 41.45°N, 73.9 to 71.8°W) and is cut to the currents model's water, so all layers share one coastline.",
    caveats: "The skin of the water; buoy sensors sit about 1 m down.",
  },
  "map-chl": {
    title: "Chlorophyll-a",
    shows: "Surface chlorophyll-a in mg/m³ on a log scale, about 750 m pixels.",
    method:
      "For each pixel, the most recent clear view across the VIIRS sensors (S-NPP, NOAA-20, NOAA-21) within 7 days; older " +
      "pixels are fainter. A one-pixel band along the coast is dropped. Background: [[hu2012chlorophyll]].",
    caveats: "Biased high in turbid water and near the shore.",
  },
  "map-kd490": {
    title: "Water clarity (Kd490)",
    shows: "The diffuse attenuation coefficient at 490 nm, in m⁻¹; higher is murkier.",
    method: "As for chlorophyll-a. Background: [[wang2009kd490]].",
    caveats: "An optical proxy, not a turbidity reading in NTU.",
  },
  "map-currents": {
    title: "Surface currents",
    shows:
      "Modelled currents in the top layer, on the model's own triangles, shaded by speed, with arrows in the direction of flow; " +
      "24 hours back to 72 hours ahead.",
    method: "The NECOFS FVCOM forecast (UMass Dartmouth), every 2 hours [[chen2003fvcom]] [[chen2006fvcom]].",
    caveats: "A model forecast, not a measurement. Speeds follow the Units switch.",
  },
};

METHODS.trends = {
  title: "Trends and %iles",
  shows:
    "Under each reading, which way it is heading and how unusual it is for the time of year. The arrow's angle gives the " +
    "rate: flat for no change, a gentle slope for a slow change, 45 degrees for a steady one, steep for a sudden one; up for " +
    "rising, down for falling, with the signed change beside it. For wind, \u21bb is veering (the wind shifting clockwise) and " +
    "\u21ba backing (counterclockwise), with the degrees. The %ile ranks the value against the same dates in earlier years.",
  method:
    "Direction compares two adjacent windows sized to how fast each quantity moves: 3 hours for wind, waves and pressure " +
    "(the last 3 hours' mean against the 3 before for wind and waves); 24 hours for air and water. Thresholds (no change, then " +
    "slow, steady and sudden): wind 2, 5 and 10 kt; waves 0.1, 0.3 and 0.6 m; pressure 1, 2 and 3 mb; air 2, 6 and 12\u00b0F; " +
    "water temperature 0.2, 0.8 and 2\u00b0F; salinity 0.05, 0.2 and 0.6; oxygen 0.2, 0.8 and 2 mg/L. A wind shift is shown " +
    "when the mean direction of the last 3 hours differs from the 3 before by 20 degrees or more, in wind of 5 kt or more. " +
    "The %ile ranks the value (the 36-hour mean for water; the last 3 days' mean for wind and waves; the last day's for air) " +
    "against the same dates, a week either side, in every earlier year with data for at least half that fortnight.",
  caveats:
    "A %ile needs at least three earlier years. Buoy weather is kept for the last 100 days so far, so wind, air and pressure " +
    "show \"-- %ile\" until the full weather record is added.",
};

/** Readout labels open the entry for the plot they summarise. */
export const READOUT_METHOD: Record<string, string> = { level: "tide", tendency: "pressure", stratification: "sb" };

/** Short labels for the references a dialog cites (full entries on /references/). */
export const REF_LABELS: Record<string, string> = {
  lisicos: "LISICOS, University of Connecticut",
  odonnell2013physical: "O'Donnell et al. (2013), The Physical Oceanography of Long Island Sound",
  torgersen1997mixing: "Torgersen, DeAngelo and O'Donnell (1997), mixing and the controls on western-Sound hypoxia",
  lisp2024hypoxia: "Long Island Sound Partnership, hypoxia indicator",
  epa_roe_hypoxia: "U.S. EPA (2023), Report on the Environment: hypoxia",
  wilson2008hypoxia: "Wilson, Swanson and Crowley (2008), long-term variation of western-Sound hypoxia",
  anderson2001pulses: "Anderson and Taylor (2001), nutrient pulses, blooms and seasonal hypoxia",
  shin2021waves: "Shin et al. (2021), Waves in Western Long Island Sound: A Fetch-Limited Coastal Basin",
  chin2017mur: "Chin, Vazquez-Cuervo and Armstrong (2017), the MUR analysis",
  jpl2015mur: "NASA/JPL (2015), MUR SST v4.1",
  hu2012chlorophyll: "Hu, Lee and Franz (2012), chlorophyll-a algorithms",
  wang2009kd490: "Wang, Son and Harding (2009), Kd(490) in turbid waters",
  chen2003fvcom: "Chen, Liu and Beardsley (2003), FVCOM",
  chen2006fvcom: "Chen, Beardsley and Cowles (2006), the FVCOM system",
  sts_monitoring: "Save the Sound, water quality monitoring programs",
};

/** Every sensor LISICOS lists for each buoy in its 2019 configuration (O'Donnell et al., "LIS NERACOOS Array"). */
export const BUOY_SENSORS: Record<string, { platform: string; topside: string; surface: string; mid?: string; bottom: string }> = {
  WLIS: {
    platform: "MSI 2.8 m buoy, 60 ft of water",
    topside: "RM Young anemometers (Marine and Heavy Duty); Campbell Scientific GPS16x-HVS; LI-COR 190R PAR",
    surface:
      "Sea-Bird SBE 37-SMP MicroCAT (CTD, DO); SBE ECO FLNTU; SBE SUNA V2 nitrate; SBE HydroCycle PO4; Teledyne RDI ADCP 300 kHz; " +
      "Neptune non-directional wave module",
    mid: "SBE 37-SMP MicroCAT (CTD, DO), 27 ft",
    bottom: "Two SBE 37 MicroCATs (CTD, DO), 48 ft; Sunburst SAMI pCO2",
  },
  EXRX: {
    platform: "MSI G-3000 buoy, 62 ft of water",
    topside: "RM Young anemometer (Marine); Campbell Scientific GPS16x-HVS; LI-COR 190R PAR",
    surface: "SBE 37-SMP MicroCAT (CTD, DO); SBE ECO FLNTU; SBE SUNA V2 nitrate; Teledyne RDI ADCP 600 kHz",
    mid: "SBE 37-SMP MicroCAT (CTD, DO), 25 ft",
    bottom: "SBE 37-SMP MicroCAT (CTD, DO), 50 ft; SBE HydroCAT-EP",
  },
  ARTG: {
    platform: "91 ft of water",
    topside: "RM Young anemometer (Marine); Campbell Scientific GPS16x-HVS; LI-COR 190R PAR",
    surface: "SBE 37-SMP MicroCAT (CTD, DO); SBE ECO FLNTU; SBE SUNA V2 nitrate",
    bottom: "Two SBE 37 MicroCATs (CTD, DO), 78 ft",
  },
  CLIS: {
    platform: "MSI G-5000 buoy, 90 ft of water",
    topside: "RM Young anemometers (Marine and Heavy Duty); Campbell Scientific GPS16x-HVS; LI-COR 190R PAR",
    surface:
      "SBE 37-SMP MicroCAT (CTD, DO); SBE ECO FLNTU; SBE SUNA V2 nitrate; Teledyne RDI ADCP 600 kHz; Triaxys directional wave sensor",
    bottom: "SBE 37-SMP MicroCAT (CTD, DO), 66 ft; SBE HydroCAT-EP (CTD, DO, pH); Sunburst SAMI pCO2",
  },
};

/** The plots whose dialog lists the station's sensors. */
const WITH_SENSORS = new Set(["yoy", "chg", "col", "sb", "wind", "air", "waves", "pressure"]);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A dialog's HTML for one entry: citations numbered in order of first use, the station's sensors where relevant. */
export function methodHtml(key: string, ctx: { variable: string; varKey: string; station: string; stationId: string; kind: string }): string {
  const m = METHODS[key];
  if (!m) return "";
  const refs: string[] = [];
  const filled = (text: string) => {
    const t = text.replace(/\{variable\}/g, ctx.variable).replace(/\{station\}/g, ctx.station);
    return t.charAt(0).toUpperCase() + t.slice(1); // a variable name may open the sentence
  };
  const fill = (text: string) =>
    esc(filled(text)).replace(/\[\[([a-z0-9_]+)\]\]/g, (_, k: string) => {
      if (!refs.includes(k)) refs.push(k);
      return `<sup class="cite"><a href="/references/#${k}">${refs.indexOf(k) + 1}</a></sup>`;
    });
  const caveats = [m.caveats, m.byVariable?.[ctx.varKey as "temp" | "salinity" | "oxygen"]].filter(Boolean).join(" ");
  const rows: [string, string | undefined][] = [
    ["Shows", m.shows],
    ["Method", m.method],
    ["Sensors", m.sensors],
    ["Sources", m.sources],
    ["Caveats", caveats || undefined],
  ];
  let html = rows
    .filter(([, v]) => v)
    .map(([label, v]) => `<dt>${label}</dt><dd>${fill(v!)}</dd>`)
    .join("");
  const s = ctx.kind === "buoy" && WITH_SENSORS.has(key) ? BUOY_SENSORS[ctx.stationId] : undefined;
  if (s) {
    const parts = [
      ["Topside", s.topside],
      ["Surface", s.surface],
      ["Mid-depth", s.mid],
      ["Bottom", s.bottom],
    ].filter(([, v]) => v);
    html +=
      `<dt>Sensors at ${esc(ctx.station)}</dt><dd>${fill(`${s.platform}, as LISICOS lists its 2019 configuration [[lisicos]].`)}` +
      `<ul class="about-sensors">${parts.map(([l, v]) => `<li><b>${l}:</b> ${esc(v!)}</li>`).join("")}</ul></dd>`;
  }
  const refList = refs.length
    ? `<ol class="about-refs">${refs.map((k) => `<li><a href="/references/#${k}">${esc(REF_LABELS[k] ?? k)}</a></li>`).join("")}</ol>`
    : "";
  return `<dl class="about-list">${html}</dl>${refList}<p class="about-foot">Times are stored in UTC and labelled in New York time. All data are provisional and may be revised.</p>`;
}
