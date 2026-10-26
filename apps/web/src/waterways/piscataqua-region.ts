/** The Piscataqua Region (/piscataqua-region/): Great Bay to the Isles of Shoals. Everything particular to it that
 * the page shows: its data, map box, views, the words on its cards and its method. The stations themselves come from
 * stations/piscataqua-region.json (shared with the jobs). */
import registry from "../../../../stations/piscataqua-region.json";
import type { WaterwayConfig } from "../waterway/config";

export type Theme = "water" | "tides" | "currents" | "rivers" | "weather";

export const PISCATAQUA_REGION: WaterwayConfig<Theme> = {
  id: "piscataqua-region",
  name: "Piscataqua Region",
  data: "/data/v1/piscataqua-region",
  map: { home: [[-70.95, 42.88], [-70.55, 43.2]], near: [[-71.3, 42.7], [-70.3, 43.45]] },
  // The region's stations differ more than the Sound's buoys, so the views are themes (what kind of station) rather
  // than variables; Water carries its own switch for the buoys' variables.
  themes: [
    { key: "water", label: "Water", layer: "sst" },
    { key: "tides", label: "Tides", layer: "currents" },
    { key: "currents", label: "Currents", layer: "currents" },
    { key: "rivers", label: "Rivers", layer: "none" },
    { key: "weather", label: "Weather", layer: "wind" },
  ],
  layers: [
    { kind: "none", label: "None" },
    { kind: "currents", label: "Currents (NECOFS)" },
    { kind: "wind", label: "Wind (HRRR)" },
    { kind: "sst", label: "Sea surface temperature" },
  ],
  storage: { view: "lhzn-blue-region-view", bview: "lhzn-blue-region-bview" },
  staleHours: { default: 3, gauge: 6, buoy: 4 },
  cadence: "observations hourly, model fields daily (currents, SST) and every three hours (wind).",
  text: {
    // Operators as the status table names them.
    "op:University of New Hampshire": "UNH",
    "op:NOAA CO-OPS": "NOAA",
    "op:NOAA CO-OPS (PORTS)": "NOAA PORTS",
    "op:NWS ASOS": "ASOS",
    "short:KPSM": "Pease",
    "notice:buoy": "UNH ",
    SEAV: "Kittery, ME. NOAA CO-OPS 8419870, the only NOAA water level gauge in the estuary.",
    "LV-MLLW:title": "Up the estuary",
    "LV-MLLW": "Hohonu tide gauges (Gulf of Maine Research Institute), ft above MLLW as each gauge publishes it.",
    "LV-NAVD:title": "Exeter, Hampton and York",
    "LV-NAVD": "Gauges that publish NAVD88 only (Hohonu; Onset at Hampton Harbor), ft above NAVD88: compare their swings, not their levels with the others.",
    meter: "NOAA PORTS current meter, buoy-mounted; hourly means of its 6-minute readings.",
    airport: "NWS ASOS through the Iowa Environmental Mesonet.",
    buoys: "This year in gold, earlier years in grey (the newest darkest); a year shows where it covers half the dates.",
  },
  method: [
    ["Area", "Great Bay, Little Bay, the Piscataqua, Portsmouth Harbor and the Hampton-Seabrook estuary, out to the Isles of Shoals (42.88 to 43.20 N, 70.95 to 70.55 W)."],
    ["Buoys", 'The University of New Hampshire\'s <a href="https://data.neracoos.org/erddap/tabledap/UNH_GBB.html">Great Bay buoy</a> and <a href="https://data.neracoos.org/erddap/tabledap/UNH_CML.html">Coastal Marine Laboratory</a> station, through the NERACOOS ERDDAP. Values the operator flags suspect or failed (QARTOD) are left out; that currently includes both stations\' wind direction. Hourly means; oxygen as each station reports it (percent saturation at the buoy, micromoles per kilogram at the lab).'],
    ["Water level", 'NOAA CO-OPS <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=8419870">Seavey Island (8419870)</a>, and the Gulf of Maine Research Institute\'s Hohonu gauges and Onset\'s Hampton Harbor gauge through NERACOOS. Gauges that publish a level above MLLW are shown so; the others above NAVD88. Tide predictions from NOAA CO-OPS.'],
    ["Currents", 'The NOAA PORTS current meter at <a href="https://tidesandcurrents.noaa.gov/cdata/StationInfo?id=pm0101">Gangway Rocks (pm0101)</a>, hourly means by components of its 6-minute readings; NOAA tidal current predictions for the harbour entrance (PIR0701) and the General Sullivan Bridge (PIR0710). On the map, the NECOFS model\'s surface currents (FVCOM GOM7, top layer), University of Massachusetts Dartmouth (SMAST), hourly.'],
    ["Rivers", "USGS streamflow, provisional. The percentile bands are USGS's day-of-year statistics of daily mean discharge for each gauge's record."],
    ["Wind and SST", "NOAA's HRRR 10 m wind (3 km), and the satellite sea surface temperature analysis (MUR, NASA JPL), each over the region's box. Pease airport (KPSM) through the Iowa Environmental Mesonet."],
    ["Colours", "Measurements are gold, predictions blue, the model teal; the selected time is purple and now a grey dash."],
  ],
  credits: registry.credits as string[],
};
