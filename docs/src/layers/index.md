# What the pages show

A waterway page has a map, station plots, a status table and readouts. The timeline under the map sets one time for
all of them. Each surface shows the observed value, or a forecast where one exists, never a blend; "--" means
neither exists.

## Long Island Sound views

- **Water temperature, Salinity, Dissolved oxygen:** buoy records by depth; satellite sea surface temperature on the
  map.
- **Wind and waves:** station wind, gusts and waves; HRRR wind and NWPS waves on the map.
- **Currents:** map only. NECOFS surface currents as streamlines; HF radar currents as an option.
- **Waves:** map only. NWPS waves as crests; wave buoy measurements as gold rings.
- **Turbidity, Rivers, Tides:** buoy turbidity with fouling flags; USGS river flow against normal; water level
  against NOAA's tide prediction.

## Layer and plot notes

A script collects the site's (i) notes from `apps/web/src/methods.ts`, the site's own source, into two pages:

- [Map layers](map.md)
- [Station plots and readouts](plots.md)

[Drawing flow and waves](drawing-flow.md) covers streamlines and crests. The comfort index formula, with a worked
example: [How the comfort index is computed](https://longhorizon.blue/about/comfort-index/).
