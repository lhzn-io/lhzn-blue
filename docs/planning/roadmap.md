# Roadmap

What `longhorizon.blue` does next, in rough order. Status as of 2026-10-08.

## Principles

- **Observations first, with their age and source.** Every value says when it was measured, where it came from, and
  what quality control it passed. Not for navigation.
- **Complement the observing systems, do not replace them.** LISICOS (University of Connecticut) runs the buoys;
  NERACOOS runs the Mariners' Dashboard. We add depth, comparisons with earlier years, and continuity during outages.
- **Keep the record.** Data that leaves a public server is not lost to the public: we keep what we have downloaded,
  show it with its provenance, and say plainly when a sensor is not reporting.
- **Estimates are labelled as estimates.** Anything not directly observed is drawn differently, carries its method
  and validation error, and is never mixed into the observed record or the AI prompt's numbers.

## Alpha (in progress)

- [x] Long Island Sound page: Western Sound, Execution Rocks, ARTG, Central Sound
- [x] This year against earlier years, 7-day change, water column, surface minus bottom, stratification status
- [x] Full record view per chart, with coverage and provenance
- [x] Zoom view with tooltips; locator map and status grid
- [x] Hourly and daily ingest with gross-range and spike tests
- [x] "Copy prompt + data" for visitors' own AI assistants
- [x] Shared time axis across stations for each view; outages shown as empty, explained stretches with links to
      the operator's own panels
- [x] Outage handling: every listed dataset is retried hourly and picked up again if it returns; the daily build
      never drops an hour it already holds
- [x] Buoy weather: wind, gusts, direction, and air temperature in the status grid and a wind and air-and-water
      chart pair per buoy (last 100 days)
- [ ] Custom domain and per-client throttling on the data files

## Next release (planned 2026-10-09)

- **Dissolved oxygen and salinity.** Bottom dissolved oxygen with a hypoxia status (thresholds stated, sourced, and
  fixed in code) and salinity, as charts and readouts per buoy, with the same year comparison and full record.

## Next: before wider announcement

1. **Mobile formatting.** A pass over the phone layout: masthead, map height, status grid, chart heights, legend
   wrapping, zoom view controls, and tap targets.
2. **Waves.** A Waves view beside the water view, switched from the top of the page. History from our saved
   downloads of the wave datasets the server no longer publishes (Western Sound, Execution Rocks, Central Sound);
   recent waves shown as an explained empty stretch with a link to the operator's wave panel until the series are
   published again.

## After that

1. **Weather history.** The full record of buoy weather (the server holds it from 2021 at Execution Rocks), and
   year comparisons for wind and air temperature.
2. **Quality control.** Flat-line test; evaluate IOOS `ioos_qc` (QARTOD) for all tests; use the operator's own QC flags
   where published.
3. **Shore stations.** Water and air temperature, dissolved oxygen and salinity, and wind where recorded, from the
   shore stations around the Sound (for example NOAA CO-OPS water-level stations with meteorological sensors, and
   continuous water-quality stations), on the same map, status grid, and year comparisons as the buoys.
4. **Tides and currents view.** Water level at CO-OPS tide stations, tidal current predictions at CO-OPS current
   stations, and measured currents where the buoys carry current profilers.
5. **Expand east.** The eastern Sound, The Race, and Block Island Sound, from any further buoy data on the LISICOS
   server, the NERACOOS data servers, NDBC, or other public servers.
6. **Remote MCP server and documented data files**, so AI clients and the boat-side assistant can query the same
   numbers the page shows. Until then the data files serve this site only.

## Later

- **Gap filling with labelled estimates.** During outages, estimate a buoy's conditions from its neighbours and its
  own seasonal relationships (for example Central Sound from ARTG and Execution Rocks by season and depth), validated
  by withholding known periods and publishing the error. Drawn dashed, never merged with observations.
- **Derived maps.** Chlorophyll, dissolved oxygen, and salinity fields across the Sound.
- **Vessel traffic summaries** from a contributed AIS receiver: commercial traffic individually, recreational boats
  only in aggregate.
- **Forecasts** from a downstream ocean model, validated against these same observations.
- **More waterways**, each when a local partner wants to curate one.

## Partnerships

- **LISICOS:** credit on every view; restoring the series missing from the public server (Central Sound water
  quality, the ARTG surface sensor); and operational help getting the full historical record into public catalogs.
- **NERACOOS:** regional context and the Mariners' Dashboard.
- **Open Waters:** tides, chart tiles, and AIS contribution.
