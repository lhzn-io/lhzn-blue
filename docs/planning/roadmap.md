# Roadmap

What `longhorizon.blue` does next, in rough order. Status as of 2026-10-09.

## Principles

- **Observations first, with their age and source.** Every value says when it was measured, where it came from, and
  what quality control it passed. Not for navigation.
- **Complement the observing systems, do not replace them.** LISICOS (University of Connecticut) runs the buoys;
  NERACOOS runs the Mariners' Dashboard; NOAA and USGS run the shore and river gauges. We add depth, comparisons with
  earlier years, and continuity during outages.
- **Keep the record.** Data that leaves a public server is not lost to the public: we keep what we have downloaded,
  show it with its provenance, and say plainly when a sensor is not reporting.
- **Availability is not reliability.** A series can be published and still be wrong (a fouled sensor, a placeholder
  column). We say which readings fail a check, and why, rather than drop them silently.
- **Estimates are labelled as estimates.** Anything not directly observed is drawn differently, carries its method
  and validation error, and is never mixed into the observed record or the AI prompt's numbers.

## Done

- [x] Long Island Sound page: Western Sound, Execution Rocks, ARTG, Central Sound
- [x] This year against earlier years, 7-day change, water column, surface minus bottom, stratification status
- [x] Full record view per chart, with coverage and provenance; zoom view with tooltips
- [x] Hourly and daily ingest with range, spike and placeholder tests; a per-waterway salinity range
- [x] Outage handling: every listed dataset is retried hourly and picked up again if it returns; the daily build
      never drops an hour it already holds
- [x] "Copy prompt + data" for visitors' own AI assistants
- [x] Custom domains (longhorizon.blue, lhzn.blue) and a contact address per waterway
- [x] Salinity and dissolved oxygen, with oxygen reference levels (Long Island Sound Partnership hypoxia and anoxia,
      EPA's growth criterion)
- [x] Shore stations: NOAA CO-OPS at Kings Point, Bridgeport, New Haven and New London (water and air temperature,
      wind, pressure, water level, tide predictions)
- [x] Wind and waves view: wind, air, pressure tendency, and waves from our saved downloads, with the wave datasets
      checked hourly so they return on their own
- [x] Rivers view: nine USGS gauges, flow against normal for the date, year comparisons, and a watershed map
- [x] Turbidity view: the buoys' point observations with a stuck-value test and a fouling flag, the biofouling
      explained, and the Connecticut River's serviced USGS sensor as the river input
- [x] Surface fields on the map, chosen from a layers control: satellite sea surface temperature (NASA JPL MUR),
      chlorophyll-a and water clarity (Kd490, NOAA CoastWatch VIIRS, merged across sensors with each pixel's age), and
      modelled surface currents (NECOFS FVCOM, UMass Dartmouth) on the model's own triangles, 24h back to 72h ahead;
      fetched through `forcingkit` by a daily job that keeps no cache
- [x] A page timeline (24h back to 72h ahead) that moves the currents and a rule on every chart; values shown on the
      chart lines at the cursor

## Next

1. **Satellite history as a movie.** Play the recent past of SST, chlorophyll-a and Kd490 on the map, with the page
   timeline stretched to weeks (30 to 90 days) in a history mode. One frame a day: SST as published (gap-free);
   chlorophyll and Kd490 as rolling 7-day composites with each pixel's age, so clouds do not blank the frames, or the
   gap-filled 2 km DINEOF products once their archive depth is checked. Published as one fixed rolling-window file per
   field, overwritten daily, so storage cannot grow; the daily job adds one day and drops the oldest, after a one-off
   backfill. Needs a compact binary frame format (8-bit values on the field's scale plus 1 byte of age per pixel,
   about 30 to 60 KB a frame) in place of today's JSON integers, and the same format for the currents.
2. **Station values at the timeline's time.** Map pins and the overview table follow the timeline cursor, marked
   observed or forecast, with "--" where nothing covers the time.
3. **Tide-averaged flow at Middle Haddam.** The lowest Connecticut River gauge with a tide-free record is
   Thompsonville, above Hartford (about 86% of the watershed). Below it USGS publishes only tidal flow at Middle
   Haddam, which reverses with the tide. Add a 25-hour mean of that flow as our own derived series, labelled as such,
   without normals (USGS publishes none for it).
4. **Mobile formatting.** A pass over the phone layout: masthead, map height, status grid, chart heights, legend
   wrapping, zoom view controls, and tap targets (the page is wider than a phone screen today).
5. **Rate limiting** on the data files at the edge, then retire the `workers.dev` address.

## After that

1. **Currents, continued.** Tidal current predictions at the CO-OPS current stations (The Race, Plum Gut, Hell Gate)
   beside the modelled field, and the modelled currents checked against them. Higher-resolution model runs of our own
   later.
2. **Forecast against observed.** Wind (and later waves) from GFS or ECMWF over the observed record at each station,
   with the forecast's running error.
3. **Turbidity field.** A modelled turbidity field and short forecast from river discharge, wind and waves, and
   currents, first at the surface and then through the water column, validated against the USGS river sensor and
   satellite turbidity rather than the fouling buoy sensors.
4. **Weather history.** The full record of buoy weather (the server holds it from 2021 at Execution Rocks), and year
   comparisons for wind and air temperature.
5. **Quality control.** Flat-line test; evaluate IOOS `ioos_qc` (QARTOD) for all tests; use the operator's own QC
   flags where published.
6. **Expand east.** The eastern Sound, The Race, and Block Island Sound, from any further buoy data on the LISICOS
   server, the NERACOOS data servers, NDBC, or other public servers.
7. **Remote MCP server and documented data files**, so AI clients and the boat-side assistant can query the same
   numbers the page shows. Until then the data files serve this site only.

## Later

- **Gap filling with labelled estimates.** During outages, estimate a buoy's conditions from its neighbours and its
  own seasonal relationships (for example Central Sound from ARTG and Execution Rocks by season and depth), validated
  by withholding known periods and publishing the error. Drawn dashed, never merged with observations.
- **Derived maps.** Chlorophyll, dissolved oxygen, and salinity fields across the Sound.
- **Vessel traffic summaries** from a contributed AIS receiver: commercial traffic individually, recreational boats
  only in aggregate.
- **More waterways**, each when a local partner wants to curate one.

## Partnerships

- **LISICOS:** credit on every view; restoring the series missing from the public server (Central Sound water
  quality, the ARTG surface sensor, the wave datasets); correcting the 2023 placeholder values in the Western Sound
  mid-depth salinity column; servicing dates for the ECO FLNTU turbidity sensors, to mark fouling honestly; the
  current profiler (ADCP) records from the buoys' surface packages, for the currents view; and operational help
  getting the full historical record into public catalogs.
- **NERACOOS:** regional context and the Mariners' Dashboard.
- **USGS:** the Nissequogue River gauge, discontinued in October 2022 after a record from 1943.
- **Open Waters:** tides, chart tiles, and AIS contribution.
