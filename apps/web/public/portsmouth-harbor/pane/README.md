# Piscataqua River, 3D pane

A self-contained three.js pane (no build step) showing, over a 4.4 km box centred on the UNH buoy
(43.06870 N, 70.70790 W) at the mouth of the Piscataqua River, Portsmouth Harbor, NH:

- NECOFS (FVCOM GOM7) currents on their native unstructured mesh: one flat colour per element-layer
  prism, a surface skin by default, optionally one layer, all layers, or a curtain through the buoy;
- particle tracks computed offline with FVCOM's own offline Lagrangian method;
- 3 m topobathymetry (DEM) merged from NOAA, USACE and USGS surveys, switchable against the NECOFS faceted bed;
- current profiles at the buoy: measured (UNH buoy), model (NECOFS at the buoy's element), and their
  difference.

Window: 2026-09-28 00:00 to 2026-10-01 00:00 UTC (a spring tide; 73 hourly NECOFS records).

## Files

The data files are not kept in this repository. On longhorizon.blue the site's Worker serves them from Workers
KV at `/data/v1/piscataqua-pane/`, and `scripts/upload-pane-data.sh` uploads them.

| File | Contents |
| :--- | :--- |
| `pane.js` | the module (ES module; lazy-loads three.js r170 and OrbitControls from jsDelivr) |
| `ramp.js` | the teal currents speed ramps (light and dark), generated from the site's ramp CSVs |
| `data/mesh.json` | NECOFS mesh counts, record times (epoch s), sigma levels, file layout, statistics |
| `data/nodes.f32` | per node: east, north (m from the buoy), h (m, positive down), float32 |
| `data/tri.u16` | per element: three node indices, uint16, counter-clockwise |
| `data/zeta.i16` | surface elevation (time, node), mm, int16 |
| `data/u.i16`, `data/v.i16` | eastward and northward velocity (time, layer, element), mm/s, int16, surface layer first |
| `data/profile.json` | u, v at all 45 layer centres of the element holding the buoy, mm/s |
| `data/tracks.f32`, `data/tracks.json` | particle tracks (particle, record, 4: east, north, z, depth fraction), float32; layout and release times |
| `data/dem.bin`, `data/dem.json` | DEM, 800 x 800, int16 cm above local MSL, row 0 south; bounds and datum |
| `data/buoy.json` | UNH buoy records in the window: speed (cm/s), logged and true directions, flags, declination |

All coordinates are east and north metres from the buoy (an equirectangular projection about the
buoy), and heights are metres, positive up. The data files total about 17 MB.

## Contract

```js
import { mountPane, measuredColour } from './pane.js';

const pane = mountPane(el, {
  dataBase: './data/',
  title: true,                     // false: no heading (the page's caption names the view)
  controls: true,                  // false: no "Layers and view" panel
  onReady: ({ t0, t1 }) => {},     // optional: the model's first and last hours, once the data load
});
pane.setTime(t);       // t: epoch seconds UTC
pane.setTheme(light);  // true for the light theme
pane.timeRange();      // { t0, t1 }, or null before the data load
pane.dispose();        // frees GPU resources and removes the pane's DOM
```

- The page owns the clock. The pane has no time controls and never advances time; `setTime(t)`
  shows each source at its latest record at or before `t`, held until its next record, with no time
  interpolation: NECOFS hourly, the buoy every 10 minutes, tracks every 5 minutes. A status line
  names each record time; outside the window it says which days the data cover.
- The panel's text and controls take longhorizon.blue's colour tokens when the page defines them.
- `measuredColour(ms, light)` returns the measured (gold) ramp colour for a speed in m/s, linear
  from 0 to 0.5 m/s, matching the site's own.
- At 375 px the controls and legend collapse to buttons, and orbit works by touch. The theme tokens are
  longhorizon.blue's: dark by default, light after `setTheme(true)`.

## Sources and credits

Currents model: NECOFS (FVCOM GOM7), UMass Dartmouth SMAST. Buoy data: UNH. Bathymetry: NOAA,
USACE, USGS. Datums: NOAA CO-OPS. Magnetic declination: NOAA/BGS World Magnetic Model 2025.

The NECOFS files here (`mesh.json`, `nodes.f32`, `tri.u16`, `zeta.i16`, `u.i16`, `v.i16`,
`profile.json`, and the tracks computed from NECOFS) are a subset of the SMAST NECOFS archive. The
pane's credit line credits NECOFS to UMass Dartmouth SMAST.

## Caveats (also shown in the pane's collapsed notes)

- Heights: the DEM is raised 0.095 m from NAVD88 to local mean sea level (CO-OPS 8423898 Fort Point,
  epoch 1983 to 2001; 8419870 Seavey Island gives 0.077 m). NECOFS h and zeta are relative to the
  model's own mean sea level, which need not equal the tidal-epoch MSL.
- Vertical exaggeration applies to water and seabed; land above 2.5 m MSL is drawn at a tenth of it.
- Buoy directions are converted from magnetic to true with the WMM2025 declination at the buoy
  (-14.19 deg, 14.2 deg W); the logged values are inferred to be magnetic, not confirmed by UNH. The
  raw logged directions are kept in `buoy.json`.
- Buoy cell size is unconfirmed (about 1 m cells from a profiler near 0.35 m fits the data); cells 11
  to 20 look like noise at or below the seabed (10.2 m below NAVD88) and are hidden by default.
  Records flagged 3 (suspect, tilt over 20 deg) or 4 (fail) are faded and excluded from differences.
- Model profile: every third of the 45 layers is drawn, at the buoy, behind the measured stack.
- Difference: model minus measured at each buoy cell, paired with the model layer whose interfaces
  contain the cell's depth below the moving surface (no pair below the model bed), using the buoy
  record nearest each model hour within 5 minutes. The difference holds between model hours. Difference
  arrows are coloured rose to plum by |difference|, linear from 0 to 0.3 m/s, at 0.55 opacity.
- Tracers: released every 3 h at 1, 5 and 10 m depth on a 9 by 9 grid across the box, each tracked 9 h
  on a padded model subset (RK4, 30 s step, the fields linear in time between hourly records as
  FVCOM's offline method does). Tracks are drawn only at their 5-minute records.
- The curtain is coloured by the velocity component along its line on a fixed scale of +-0.8 m/s
  (just above the 0.73 m/s along-channel 99th percentile; stronger flow, mostly on the cross-channel
  line, clamps to the end colours). The curtain is drawn at 0.8 opacity.
- three.js loads from jsDelivr's `+esm` builds, so a site Content Security Policy must allow cdn.jsdelivr.net.
