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
  "carry decimals, and the server has published day counts in a salinity column. Flat-line tests are not applied.";

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
  next48: {
    title: "The next 48 hours",
    shows:
      "Wind and gusts at the station: measured over the last day and a half, and forecast by NOAA's HRRR model for the " +
      "next two days. The stitched forecast (the bold blue line) takes each hour from the newest run that reaches it; the " +
      "lavender lines either side show how far such a forecast typically misses at that lead time; dots are gusts. Each " +
      "faint line is an earlier HRRR run: where they bunch together, the model has been consistent; where they spread " +
      "apart, it has not, and the timing or strength is less certain. The slider at the top left picks a run (so does " +
      "hovering its line) and draws it dashed, with the time it was issued; the expanded chart pans back through a week " +
      "of runs.",
    method:
      "HRRR (3 km, run every hour) is read at the station's nearest water cells [[dowell2022hrrr]]. Hourly runs reach 18 " +
      "hours ahead and the 00, 06, 12 and 18 UTC runs 48, so beyond 18 hours the stitched forecast comes from the latest " +
      "48-hour run, which can be up to 6 hours older than the newest. The plot keeps every run of the last day and the " +
      "48-hour runs of the last week. The typical error is the mean absolute difference between HRRR and the four buoys at " +
      "each lead time since January 2024; about 6 in 10 forecast hours fall within it.",
    caveats:
      "Uncorrected output of a single model; other models are not shown. Not a substitute for the National Weather " +
      "Service marine forecast. HRRR is used for its 3 km grid, run hourly, 18 to 48 hours ahead; global models such as " +
      "ECMWF and GFS run on grids of about 9 to 25 km, one or two cells across a Sound 5 to 34 km wide.",
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
      "and restarts after a gap. Where the station has no reading, a dashed line gives HRRR's last forecast before each hour (the run issued 1 hour before) at the station [[dowell2022hrrr]], from January 2024: the model's stand-in for the record, never a measurement. Against the four buoys over the 100 days to October 2026 it was within 2.4 to 2.8 kt on average (mean absolute error) with a bias under 1 kt.",
    caveats:
      "The plot shows the last 100 days. Speeds follow the Units switch. Directions are turned to true north: the server's " +
      "read about 14 degrees clockwise of NDBC's records of the same buoys, close to the local magnetic variation. Shading " +
      "marks the NWS marine advisories in force for the station's zone (see the Advisory readout's note).",
  },
  air: {
    title: "Air and water temperature",
    shows: "Hourly air temperature and surface water temperature. Where the station has no air reading, a dashed line gives HRRR's 2 m air temperature from its last forecast before each hour (a model, not a measurement) [[dowell2022hrrr]].",
    sources: "The station's weather sensors and its surface sensor; NOAA HRRR for the dashed stand-in.",
  },
  hilo: {
    title: "Highs and lows",
    shows: "Each high and low tide: NOAA's prediction (faint) and the water's (bold), against mean higher high water and the NWS minor flood level.",
    method: "The observed high or low is the highest or lowest hourly mean within 2 hours of the predicted time.",
    sources: "NOAA CO-OPS; flood levels from the National Weather Service.",
    caveats: "Observations are preliminary until NOAA verifies them.",
  },
  dep: {
    title: "Departure from prediction",
    shows: "Observed water level minus NOAA's prediction, hourly: what wind, pressure and river flow add to the tide.",
    method: "The prediction is averaged over the same hour as the observed hourly mean.",
    sources: "NOAA CO-OPS.",
    caveats: "Predictions use the 1983 to 2001 tidal epoch; sea level has risen about 0.3 ft since, so the departure sits above zero most weeks.",
  },
  tide: {
    title: "Departure from prediction",
    shows: "Observed water level minus NOAA's prediction, hourly: what wind, pressure and river flow add to the tide.",
    sources: "NOAA CO-OPS.",
    caveats:
      "Observations are preliminary until NOAA verifies them. Predictions are astronomical tide only; wind and pressure move " +
      "the observed level away from them.",
  },
  waves: {
    title: "Waves",
    shows: "Significant wave height each hour, and each hour's highest single wave (faint). Hovering gives the dominant period.",
    method:
      "Significant height is the mean of the highest third of the waves, close to what an observer reports. Ahead of the " +
      "last reading, and while the sensor is out, the NWS model line is the Nearshore Wave Prediction System (SWAN) at the " +
      "buoy's nearest water cell, each hour from the newest run that covers it (runs at 00 and 12 UTC) [[booij1999swan]].",
    caveats:
      "The wave datasets have been unpublished on the data server for long stretches; the record before an outage comes from " +
      "our saved downloads, and the page checks every hour. Heights follow the Units switch. Wave growth in the western Sound " +
      "is fetch-limited and larger under easterly winds [[shin2021waves]]. The NWS model line is a model, not a measurement.",
  },
  model: {
    title: "Model values while a buoy is out",
    shows:
      "While a buoy's sensor is out, the table, readouts and map show what a model gives at the buoy for the same hour, " +
      "under the fault and marked as a model. They are not measurements, and the outage stays shown as one.",
    method:
      "Wind, gusts, air temperature and pressure: the newest NOAA HRRR run (3 km) that covers the hour, read at the buoy; " +
      "now that is a run issued about an hour before. Waves: the newest run of the NWS Nearshore Wave Prediction System " +
      "(SWAN on a 1.8 km grid, run by NWS New York at 00 and 12 UTC) at the water cell nearest the buoy, at most 0.4 km away.",
    sources: "NOAA HRRR; NWS Nearshore Wave Prediction System (NOAA NOMADS). Every NWPS run is archived as published.",
    caveats:
      "HRRR's typical error at each lead is measured against the buoys' own records (the Forecast verification page). " +
      "NWPS is forced by the forecasters' wind grids rather than by observations and has not been verified against the " +
      "buoys' wave records, which are unavailable while their wave sensors are out.",
  },
  advisory: {
    title: "NWS marine advisories",
    shows:
      "The advisory or warning NWS New York has in force for the station's forecast zone, and (shaded behind the wind plot) " +
      "the ones in force over the plotted days: small craft advisories lighter, gale and stronger warnings darker.",
    method:
      "Each event is merged from the products that issued, extended or cancelled it, from its earliest start to its " +
      "latest end. Each station takes the marine zone that contains it, or the nearest (harbour gauges lie inside the " +
      "coastline). Before April 2021 the eastern Sound was one zone (ANZ330), and its events stand for both of today's.",
    sources: "NWS New York (OKX) VTEC products, from the Iowa Environmental Mesonet archive (2005 on); zone outlines from api.weather.gov.",
    caveats:
      "An advisory is a forecast decision for a whole zone, not a measurement at the station. Two archive rows (one 2012 " +
      "event whose end the archive lost) are left out.",
  },
  pressure: {
    title: "Pressure tendency",
    shows: "How fast the barometer is changing: the change over 3 hours, observed and then forecast by HRRR (dashed). A falling barometer comes before wind; the faster it falls, the more.",
    method: "Observed: the station's hourly mean minus that of 3 hours before. Forecast: the same from HRRR's sea-level pressure at the station. Shaded bands follow the UK shipping forecast's terms: steady to falling slowly under 1.6 mb in 3 hours, quickly 3.6 to 6, very rapidly beyond 6.",
    caveats: "The buoy barometer and HRRR's sea-level pressure differ by up to about 1 mb, so the dashed line can start a little off the observed one. Where the station has no reading, a fainter dashed line gives the same change from HRRR's last forecast before each hour (a model stand-in, not a measurement).",
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
      "drops it back in one step. The fouling flag is a provisional rule and has not been reconciled with LISICOS servicing records. Turbidity " +
      "in the Sound's bays and harbors is measured by Save the Sound's Unified Water Study [[sts_monitoring]].",
  },
  "map-sst": {
    title: "Sea surface temperature",
    shows: "Sea surface temperature at 0.01° (about 1 km), for the day shown.",
    method:
      "The MUR multi-sensor analysis, which fills gaps between satellite passes [[chin2017mur]] [[jpl2015mur]]. Every layer " +
      "covers one box (40.45 to 41.45°N, 73.9 to 71.8°W) and is cut to the currents model's water, so all layers share one coastline.",
    caveats:
      "The skin of the water; buoy sensors sit about 1 m down. One fixed colour scale all year: even steps from 1.5 to " +
      "25.5 °C (about the 0.5th to 99.5th percentile of 2022 to 2026 over this box), compressed beyond out to -2 and " +
      "28 °C, in cmocean thermal hues [[thyng2016cmocean]]; on the dark theme the coldest colours are lifted so cold " +
      "water stays visible. A typical day spans only about 2 °C across the box, so lines every 1 °C mark the fronts that " +
      "colour alone would hide, with fainter half-degree lines from April to November, when the spread is narrowest.",
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
    method:
      "The NECOFS FVCOM forecast (UMass Dartmouth), every 2 hours [[chen2003fvcom]] [[chen2006fvcom]]. Colours follow one " +
      "fixed scale on a logarithmic speed axis, from 0.02 to 3.1 m/s, with knots from 2026 NOAA CO-OPS current predictions " +
      "(0.494 m/s, the median daily maximum across Long Island and Block Island Sound; 2.418 and 3.097 m/s, the median and " +
      "annual daily maxima at Little Gull Island in the Race). The scale runs pale aqua to teal to deep blue-green, after " +
      "cmocean [[thyng2016cmocean]], so faster water is darker; its hues stay clear of a chart's buff land and green drying " +
      "ground. The dark theme uses a twin scale on the same speeds, deep blue-teal to pale seafoam, so faster water is lighter there.",
    caveats: "A model forecast, not a measurement. Speeds follow the Units switch.",
  },
  "map-waves": {
    title: "Waves (NWS model)",
    shows:
      "Forecast significant wave height on the model's own 1.8 km cells, shaded by height, with arrows in the direction the " +
      "waves travel; 24 hours back to 72 hours ahead.",
    method:
      "The NWS Nearshore Wave Prediction System, which runs the SWAN spectral wave model [[booij1999swan]], from the New York " +
      "forecast office at 00 and 12 UTC on its CG1 grid, forced by the office's forecast winds. Each hour comes from the " +
      "newest run that covers it. Colours: an ordered ramp after cmocean [[thyng2016cmocean]].",
    caveats: "A model forecast, not a measurement. The runs exclude currents; steepening where the tide opposes the waves is not represented.",
  },
  "map-wat": {
    title: "Wind against tide",
    shows:
      "Where the tidal current runs against the waves and steepens them, on the wave model's 1.8 km cells, every 2 hours from " +
      "24 hours back to 72 hours ahead, in four levels: the current steepening the waves; steep, short seas likely; breaking " +
      "seas likely; and the waves blocked by the current (they break at its edge). Arrows show where the opposing current runs. " +
      "Clicking a cell gives the current, the waves and how much steeper they get. It is an overlay: the layer menu lays it " +
      "over the wind, waves or currents layer (their arrows then stand for the overlay's), or shows it on its own.",
    method:
      "The waves (height, peak period and direction) are the NWS NWPS forecast (SWAN [[booij1999swan]]); the current is the " +
      "NECOFS FVCOM surface layer [[chen2006fvcom]] averaged over each wave cell. With r the current along the waves' direction divided by their deep-water speed (gT/2\u03c0), " +
      "conservation of wave action gives how much closer together (wavelength) and higher the crests get while the period " +
      "holds [[longuet1961currents]]; the waves stop where " +
      "r reaches -0.25. Levels: steepening when the current makes the waves 20 percent steeper or more; steep at 60 percent, or at " +
      "20 percent when the waves reach a steepness of 1/25; breaking at r of -0.20, or at 60 percent with a steepness of 1/15; " +
      "blocked at -0.25. Each level is what the current adds: wind waves in the Sound are often steep in slack water. Breaking " +
      "and blocked need waves of 0.4 m (1.3 ft) or more. Nothing is shown where the current is under 0.3 m/s (0.6 kt) or the waves under 0.2 m. Drawn as " +
      "tide-rip hatching, after the chart symbol for rips and overfalls [[noaa2019chart1]]: finer rows for the lower levels, the densest and " +
      "heaviest kept for blocking. The patterns are fixed and do not rescale with the hours shown.",
    caveats:
      "A model-derived index: not an observation and not an NWS product; NWS advisories take precedence. Linear, " +
      "deep-water theory for waves entering the current from slack water. Excludes shoals, rips and overfalls finer than the " +
      "cells (the Race, Plum Gut and Hell Gate in detail), boat wakes and wave groups. The thresholds are provisional and " +
      "have not been validated against wave observations.",
  },
  "map-wind": {
    title: "Wind (HRRR)",
    shows:
      "Forecast wind 10 m above the surface on the model's own 3 km cells, shaded by speed, with arrows in the direction " +
      "the wind blows toward; 14 days back to 48 hours ahead. The hours before the last 24 are a separate file, loaded " +
      "when the time bar first goes back past them.",
    method:
      "NOAA's High-Resolution Rapid Refresh (HRRR) [[dowell2022hrrr]], read through forcingkit. Each hour comes from the newest run that covers " +
      "it: hourly runs reach 18 hours ahead, the 00, 06, 12 and 18 UTC runs 48 hours; a past hour comes from the run issued " +
      "1 hour before it (2 or 3 hours where that run is missing), and is kept for 14 days. Values are raw: no smoothing between " +
      "cells. Cells HRRR counts as land are drawn fainter inland; land cells touching water (harbours, coves, the shore) are drawn like water, and a click there says it is a land cell.",
    caveats: "A model forecast, not a measurement; the past hours are short-lead forecasts, not observations. Speeds follow the Units switch.",
  },
};

METHODS["current-phase"] = {
  title: "Current at a reference point",
  shows:
    "Under the time bar, the tidal current at one of four points along the Sound: the Race, the central Sound (Branford " +
    "Reef, 5 miles south), Execution Rocks and Throgs Neck. Above the line is flood, below it ebb. The filled band is the " +
    "NECOFS model's surface current (the light band); the fine line is NOAA's tidal current prediction; " +
    "the vertical line is the time bar's hour. The label reads the phase there and the next slack. Each point keeps a " +
    "fixed scale. Slack and strength differ by hours and knots along the Sound, so pick the point nearest your water; a " +
    "click on the map gives the local current.",
  method:
    "NOAA: CO-OPS tidal current predictions at harmonic stations LIS1001 (The Race), LIS1021 (Branford Reef), LIS1036 " +
    "(Execution Rocks) and LIS1038 (Throgs Neck Bridge), at the bin nearest the surface (6 to 14 ft), every 30 minutes, " +
    "with NOAA's slack and maximum times. NECOFS: the FVCOM surface current at the model element nearest each station " +
    "(within 1 km), projected onto NOAA's flood direction there, every 2 hours [[chen2006fvcom]]. Flood runs west through " +
    "the Race and the central Sound and east at Throgs Neck, so each point has its own axis.",
  caveats:
    "Both are predictions: NOAA's from the tides alone, without wind or river flow; NECOFS's from a model run with them. " +
    "Against NOAA over October 3 to 20, 2026, NECOFS kept time within about 10 minutes at the Race, the central Sound and " +
    "Throgs Neck (correlation 0.93 to 0.98) and ran about 40 minutes early at Execution Rocks, where the current is weak and " +
    "irregular (0.80). It reached about 65 percent of NOAA's strength at the Race and Throgs Neck (the jets are narrower " +
    "than the model's mesh resolves) and ran about a third stronger in the central Sound.",
};

METHODS.comfort = {
  title: "Comfort for small craft",
  // No Shows row: the readout and the charts below say it, and the modal fits without scrolling.
  shows: "",
  method:
    "The worst factor below for your boat, from HRRR wind, NWPS waves, the wave-current level and (kayaks) NECOFS " +
    "current. Steps follow Beaufort, WMO sea states and the NWS small craft advisory; the 30% rule, post-Fastnet (1979) " +
    "capsize tests.",
  caveats:
    "An indicative index derived from forecasts, not a determination of whether to go. Excludes gusts, visibility and " +
    "thunderstorms. More than 24 hours back it rests on wind alone. The thresholds are judgements for typical boats of each length, not a standard; the code is open " +
    "source (github.com/lhzn-io/lhzn-blue), so anyone can set their own and build an index on the same method.",
};

METHODS["map-comfort"] = {
  title: "Comfort index (map)",
  shows: "",
  method:
    "The comfort index of a click's readout, for every NWPS wave cell (1.8 km) at the time bar's hour: HRRR wind from the " +
    "nearest HRRR cell, NWPS waves, the wind-against-tide level and, for kayaks, the NECOFS current, by the steps for " +
    "the boat set in the byline; cold water raises a level. Shore cells (harbours, coves) carry wind only. Shown as a " +
    "score from 0 to 7: each factor runs linearly between its steps, so 1 is the Moderate step, 2 Uncomfortable and 3 " +
    "Discomfort; past Discomfort it gains a point for each half of that step again (for a center console, 30, 40 and " +
    "50 kt of wind, or 1.5, 2 and 2.5 m of waves), and the worst factor sets the score. The shading runs from clear at 0 " +
    "through pale pink to rose at 3, then raspberry and plum toward 7 (on the dark map, from dim plum to pale pink). " +
    "NWS advisories keep their brick outline, apart from this scale. The Discomfort zones overlay marks where the score reaches 3, " +
    "crosshatched within a fine outline, over this field or over wind, waves or currents.",
  caveats:
    "The score places a cell between fixed thresholds; it is not a probability, and its fractions are as much a judgement " +
    "as the steps. The shading excludes NWS advisories, which the masthead and the zone lines show and a click's readout includes. " +
    "No shading beyond HRRR's 48-hour forecast. The map reaches 14 days back once the HRRR history loads (on the first " +
    "step back past 24 hours); the wave, wind-against-tide and current models keep 24 hours back, so before that the " +
    "score rests on HRRR wind alone and the key says so. Excludes gusts and tide rips.",
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
    "The %ile ranks the value (the 36-hour mean for water; the last 3 days' mean for wind and waves; the last day's for air " +
    "and pressure) against the same dates, a week either side, in every earlier year with data for at least half that " +
    "fortnight. Weather %iles use daily means: from the NDBC archives of the same buoys (Western and Central Sound from 2004, " +
    "Execution Rocks from 2005), then the buoys' own records.",
  caveats:
    "A %ile needs at least three earlier years; where a station has fewer it reads \"-- %ile\" (the Stamford buoy's " +
    "weather starts in 2024).",
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
  dowell2022hrrr: "Dowell et al. (2022), the High-Resolution Rapid Refresh (HRRR)",
  booij1999swan: "Booij, Ris and Holthuijsen (1999), the SWAN wave model",
  noaa2019chart1: "NOAA and NGA (2019), U.S. Chart No. 1",
  thyng2016cmocean: "Thyng et al. (2016), cmocean: colormaps for oceanography",
  longuet1961currents: "Longuet-Higgins and Stewart (1961), short gravity waves on steady non-uniform currents",
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
