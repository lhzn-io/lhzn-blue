/** Long Island Sound (/long-island-sound/): what is particular to it on its page, as the engine's config. Its stations
 * come from stations/stations.json, shore.json and asos.json (shared with the jobs) through the Sound's adapter
 * (adapters/sound.ts). */
import type { StationDataWaterway } from "../waterway/config";

export const LONG_ISLAND_SOUND: StationDataWaterway = {
  id: "long-island-sound",
  name: "Long Island Sound",
  data: "/data/v1",
  called: "the Sound",
  operator: "LISICOS",
  oxygenAuthority: "Long Island Sound Partnership",
  forecastPage: "/long-island-sound/forecast/",
  zones: ["ANZ335", "ANZ331", "ANZ332"],
  // An embed opens on Western Sound; the outlook on Execution Rocks until a reader picks another row; the tides view
  // falls back to Kings Point.
  defaults: { embedStation: "WLIS", outlookStation: "EXRX", tideStation: "KPTN" },
  groups: {
    buoy: "Buoys, LISICOS",
    shore: "Shore stations, NOAA and USGS tide gauges",
    airport: "Coastal airports, NWS weather stations",
    rivers: "Rivers into the Sound, USGS stream gauges",
    turbidity: "Turbidity, point observations",
  },
  rivers: {
    at: [41.5, -72.6],
    note: (n, area) =>
      `${n} USGS stream gauges draining ${Math.round(area).toLocaleString("en-US")} square miles, about three quarters of it the Connecticut River above Thompsonville. ` +
      `On Long Island most fresh water reaches the Sound as groundwater, which stream gauges do not measure, so the north shore is under-represented here.`,
  },
  turbidityNote:
      `Point observations from the optical turbidity channel of each buoy's surface sensor, a Sea-Bird <a href="https://www.seabird.com/eco-fluorometer/product-details?id=60429374754">ECO FLNTU</a> ` +
      "(chlorophyll fluorescence and turbidity) at about 1 m, in the buoys' 2019 configuration as LISICOS describes it. In warm water the sensor's window fouls within weeks: a film of algae, then barnacles, " +
      "scatters light back into the sensor, so the reading climbs steadily (from 1 to 2 NTU after servicing to tens of NTU by late summer) " +
      "though the water has not changed, and servicing drops it back to baseline in one step. Readings that repeat one value for 2 hours or more " +
      "are dropped as stuck. A day whose quietest tenth of readings sits above 5 NTU is flagged as likely fouling and drawn faintly: clean open " +
      "water in the Sound sits near 1 NTU between storms, and a storm stirring up the bottom leaves a day's quietest readings low, while a fouled " +
      "window lifts them all. This is a working rule, to be checked against the operator's servicing dates; early in a fouling climb it can " +
      "miss days. The river input beside it, the USGS sensor on the Connecticut River, is serviced and reviewed. NTU (these buoys) and FNU (the USGS " +
      "sensor) are close but not identical units. This view will carry the turbidity field as it comes: a surface map first, then a modelled field. " +
      `Nearshore, in the Sound's bays and harbors, <a href="/references/#sts_monitoring">Save the Sound</a>'s Unified Water Study measures turbidity, oxygen and chlorophyll.`,
  outage: {
    // What UConn reported about the outage (by email, Oct 16, 2026); shown only while the server is unreachable.
    operator: "UConn reports its data server is being upgraded, expected back by mid-November 2026; the Western Sound buoy has a hardware fault awaiting ship time (as of Oct 16).",
    transcribed: "Readings since then are transcribed from the LISICOS station panels (provisional).",
  },
  collect: {
    credit: "Long Horizon Observatory \u00b7 longhorizon.blue \u00b7 CC BY-NC 4.0 \u00b7 data: LISICOS (UConn), NOAA, USGS, NASA; map \u00a9 OpenStreetMap contributors",
    mailTo: "long-island-sound@longhorizon.blue",
  },
  stationPages: {
    views: { buoy: ["temp", "salinity", "oxygen", "wind"], shore: ["tides", "temp", "wind"], airport: ["wind"] },
    chips: ["buoy"],
    menu: [
      { title: "Shore stations", kinds: ["shore"] },
      { title: "Coastal airports", kinds: ["airport"] },
    ],
  },
  photos: {
    EXRX: {
      src: "/photos/long-island-sound/exrx.jpg",
      alt: "The Execution Rocks buoy, a yellow LISICOS buoy with two weather sensors on its mast, the Manhattan skyline on the horizon",
      when: "April 2025",
    },
    ARTG: {
      src: "/photos/long-island-sound/artg.jpg",
      alt: "The ARTG buoy, a yellow LISICOS buoy numbered 2, with the shore low on the horizon",
      when: "June 2026",
    },
    WLIS: {
      src: "/photos/long-island-sound/wlis.jpg",
      alt: "The Western Sound buoy, a yellow LISICOS buoy numbered 1, with two gulls on its deck and hills behind",
      when: "September 2026",
    },
  },
};
