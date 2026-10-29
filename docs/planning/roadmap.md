# Roadmap

What `longhorizon.blue` builds next, in rough order. Last revised 2026-10-27.

## Principles

- **Observations first.** Every value carries the time it was measured, its source, and the quality checks it
  passed. The site is not for navigation.
- **Complement the observing systems.** LISICOS (University of Connecticut) operates the buoys, NERACOOS publishes
  the regional Mariners' Dashboard, and NOAA and USGS operate the shore and river gauges. This site adds comparisons
  with earlier years, model context, and continuity during outages.
- **Keep the record.** Downloaded data is kept and shown with its provenance. A sensor that stops reporting is
  marked as missing.
- **Flag readings; do not drop them.** A reading that fails a check stays visible with the reason it failed.
- **Label estimates.** Model output and derived values are drawn differently from observations and state their
  method and measured error. They never enter the observed record or the numbers given to the AI prompt.

## Done

Long Island Sound page:

- [x] Four LISICOS buoys (Western Sound, Execution Rocks, ARTG, Central Sound): water temperature, salinity,
      dissolved oxygen with the Long Island Sound Partnership hypoxia and anoxia levels and EPA's growth criterion,
      turbidity with fouling flags, wind, air temperature, pressure and waves
- [x] This year against earlier years, 7-day change, seasonal percentiles, the water column, and stratification
- [x] NOAA CO-OPS shore stations at Kings Point, Bridgeport, New Haven and New London; USGS tidal gauges on the Sound;
      airport wind at Sikorsky and Tweed (NWS ASOS)
- [x] Rivers view: ten USGS gauges, flow against normal for the date, and a watershed map
- [x] Map layers: satellite sea surface temperature (NASA JPL MUR) with isotherms, chlorophyll-a and water clarity
      (NOAA CoastWatch VIIRS) with 90 days of history, NECOFS surface currents, HRRR 10 m wind with 14 days of
      history, NWPS waves, wind against tide, a small-craft comfort index with discomfort zones, and NWS advisory
      zones
- [x] One timeline that sets the time for the map, the charts, the overview table and the pins, with the tidal
      current's phase beneath it
- [x] Forecast verification: HRRR wind at the buoys since January 2024, scored by lead time, with the typical error
      shown on every forecast plot
- [x] Wind models compared: four models' 10 m wind for the next 48 hours on their own grids
- [x] Reading the tides: predictions, datums and the moon for the shore stations
- [x] About, References and Terms pages, including the use of AI
- [x] Collect: gather plots, readouts and the map, then ask your own AI or send a suggestion
- [x] Outage handling: every dataset retried hourly, saved copies of the source datasets three times a week, a
      transcribed record from the LISICOS station panels while the data server is down, and model stand-ins labelled
      as such
- [x] Phone layout, and an embed mode for one live figure
- [x] A page per station: each buoy, shore station and coastal airport with only the views it has, our own photos of
      three of the buoys, and earlier links to a station or one of its plots opening its page
- [x] Every waterway page built from one configurable page, so each feature below is built once for all of them

## Next

1. **Tidal currents beside the model.** NOAA tidal current predictions at The Race, Plum Gut and Hell Gate shown
   with the NECOFS surface currents, and the two compared at each station.
2. **Global models at longer leads.** ECMWF and GFS wind at the buoys, scored the same way as HRRR.
3. **Compact currents file.** The currents in the binary frame format the satellite history uses, about a third of
   today's size.
4. **Design notes.** The palette and the plot grammar documented, with their licence.
5. **Anomaly contours on the year comparison (prototype).** On the water "This year" plot, curved reference lines for
   the normal value on each date and set steps either side (1 and 2 °F for temperature), drawn from the earlier years
   on record. This year then reads as an anomaly while staying in its own units, and the earlier years' lines can be
   drawn fainter or left out. After Toph Tucker's warped gridlines (Observable, 2022), which bend the grid rather than
   the data.

## After that

1. **Fog.** Dew-point depression and the air-sea temperature difference at the buoys, visibility from the airport
   stations around the Sound, satellite fog products, and visibility forecasts scored against them.
2. **Tide-averaged flow at Middle Haddam.** USGS publishes only tidal flow below Thompsonville on the Connecticut
   River. A 25-hour mean of the Middle Haddam flow, published as a derived series without normals.
3. **Turbidity estimate.** A derived surface turbidity field from river discharge, wind, waves and currents, scored
   against the USGS river sensor and satellite turbidity.
4. **Weather percentiles at the shore stations**, from NOAA's records of their own weather.
5. **Quality control.** A flat-line test for every series, the IOOS QARTOD tests through `ioos_qc`, and the
   operators' own flags where they publish them.
6. **The eastern Sound.** The Race and Block Island Sound, from any further public buoy, NDBC or NERACOOS data.
7. **The tides diagram for any waterway.** The schematic in the Sound's tides view, drawn from a waterway's own
   outline and gauges.
8. **Documented data access.** A remote MCP server and documented data files that return the same numbers the page
   shows. The current data files serve this site's pages only.

## Later

- **Gap filling with labelled estimates.** A buoy's conditions estimated from its neighbours and its own seasonal
  relationships during an outage, scored by withholding known periods, and drawn dashed.
- **Derived maps.** Chlorophyll, dissolved oxygen and salinity fields across the Sound.
- **Vessel traffic summaries** from an AIS receiver: commercial traffic by vessel, recreational traffic in aggregate.
- **More waterways.** A new waterway page starts when a local group wants to curate it.
- **ERDDAP as the data backbone.** One reader for many ERDDAP servers, so new sources join as dataset names rather
  than new code.
