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

## Next

1. **Surface turbidity map.** The Turbidity view's first field: satellite turbidity (NOAA CoastWatch VIIRS) on the
   map, with the buoys and the river sensor as points over it, and clouds and gaps shown as gaps.
2. **Tide-averaged flow at Middle Haddam.** The lowest Connecticut River gauge with a tide-free record is
   Thompsonville, above Hartford (about 86% of the watershed). Below it USGS publishes only tidal flow at Middle
   Haddam, which reverses with the tide. Add a 25-hour mean of that flow as our own derived series, labelled as such,
   without normals (USGS publishes none for it).
3. **Mobile formatting.** A pass over the phone layout: masthead, map height, status grid, chart heights, legend
   wrapping, zoom view controls, and tap targets (the page is wider than a phone screen today).
4. **Rate limiting** on the data files at the edge, then retire the `workers.dev` address.

## After that

1. **Currents.** Modelled currents across the Sound (NECOFS, UMass Dartmouth) drawn on the map faithfully to the
   model's own unstructured grid, with tidal current predictions at the CO-OPS current stations (The Race, Plum Gut,
   Hell Gate). Higher-resolution model runs of our own later.
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
