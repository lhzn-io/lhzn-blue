# Long Island Sound, 3D pane

A self-contained three.js pane (no build step) for the `/long-island-sound/currents-3d/` page: NECOFS (FVCOM GOM7)
currents on the model's own mesh, with the model's profile at the Groton current meter (NOAA CO-OPS nl0101, Thames
River, 41.39180 N, 72.09230 W), the frames' origin. The page mounts one place at a time:

| Place | Box | Data (`/data/...`) | What it holds |
| :--- | :--- | :--- | :--- |
| Whole Sound | the map's box, `[-73.9, 40.45, -71.8, 41.45]`: 16,010 elements, 10,392 nodes | `v1/lis-pane/sound/` | the surface and the bottom layer of every element; every layer of the 202 elements along the Sound's axis (`section.bin`) |
| Eastern Sound | `[-72.20, 41.15, -71.95, 41.40]`, 21 by 28 km: 1,303 elements, 862 nodes | `v1/lis-pane/` | every layer of every element |

Window: hourly NECOFS records from 5 days before the meter's latest record to 48 hours after it, rewritten daily by
the site's jobs (`jobs/src/lhzn_blue_jobs/lis_pane.py`). On longhorizon.blue the Worker serves the files from Workers
KV:

| File | Contents |
| :--- | :--- |
| `pane.js` | the module (ES module; lazy-loads three.js r170, camera-controls 3.1.2 and [vantagekit](https://github.com/lhzn-io/vantagekit) 0.8.1 from jsDelivr) |
| `ramp.js` | the teal currents speed ramps (light and dark), generated from the site's ramp CSVs |
| `mesh.json` | counts, record times (epoch s), sigma levels (`siglev` for drawing, `model_siglev` the model's, `layer_index` the layers held), the element holding the meter (`buoy_element`), the section's geometry, file names, statistics |
| `nodes.f32` | per node: east, north (m from the meter), h (m, positive down), float32 |
| `tri.u16` | per element: three node indices, uint16, counter-clockwise |
| `window.bin` | per hour: eastward and northward velocity (layer, element; surface layer first) as int8 in steps of 2 cm/s, then surface elevation per node as int16 mm; gzipped, after "LHZF", a uint32 header length and a JSON header |
| `section.bin` | the whole Sound only: the same layout for the section's elements at every layer, with no nodes |

## Contract

```js
import { mountPane } from './pane.js';

const pane = mountPane(el, {
  dataBase: '/data/v1/lis-pane/sound/',
  title: false,                    // no heading (the page names the view)
  place: { allLayers: false, exag: 100, exagMax: 200, view: {...}, curtains: {...}, curtainNote, boxNote },
  onReady: ({ t0, t1 }) => {},     // the model's first and last hours, once the data load
});
pane.setTime(t);       // t: epoch seconds UTC; the page owns the clock
pane.setTheme(light);  // true for the light theme
pane.setUnits(u);      // 'kt', 'mph' or 'ms'
pane.dispose();
```

`place` (all optional) gives the place's curtains, default and largest exaggeration, camera (`bearing` from the box's
middle, `horiz` and `height` in metres, `far` clip, `narrow` zoom-out on a narrow pane), whether "All layers" is
offered, and two sentences for the notes. `dem`, `tracks` and `measured` (or `buoy`, a profile's records) turn on a
survey seabed, particle tracks and a measured profile; none is published for the Sound yet, so the seabed is the
model's own.

## Curtains

- Eastern Sound: named lines through a point, coloured by the current toward a flood bearing (`CURTAINS` in
  `pane.js`): across The Race (a line at 19 deg through 41.2350 N, 72.0600 W, flow toward 289 deg) and along the
  Thames (337 deg through the meter). Each flood bearing is the principal axis of the model's depth-mean flow over the
  first window's hours at the line's middle element, rounded to a degree (2026-10-28 to 11-04: 289 deg at the Race,
  standard deviations 0.84 m/s along and 0.04 across; 337 deg at the meter).
- Whole Sound: the section along the Sound's axis (Throgs Neck, Execution Rocks, the western, central and eastern
  basins, The Race), each element's stretch of the line drawn at every layer, its surface and bed interpolated from
  the element's nodes, coloured by the current along the stretch, positive toward Throgs Neck (flood).

The scale is +-1.25 m/s, just above the 1.21 m/s 99th percentile of the flow through the Race section (56 elements
within 400 m of the line; its maximum 2.25 m/s); along the whole axis the 99th percentile of speed is 1.29 m/s.

## Navigation

vantagekit 0.8.1, orbit only: a drag turns the view, a right drag or two fingers pan along the ground, the wheel or a
pinch zooms (stopping 400 m from the orbit point), and the keys and a gamepad work while the view has focus. A
double-click or double-tap on the water's surface or the bed turns the view about that point, marked by a ring while
the view moves. Changing the exaggeration keeps the orbit point on the surface or bed it was at.

## Scale

- Whole Sound: vertical exaggeration 100x by default (1 to 200), the camera steeply from the south-south-east.
- Eastern Sound: 40x by default (1 to 80; typical 40 m depths stand about 1.6 km in a 25 km box), the camera from the
  west-north-west at about 31 km, looking across the Race's line.
- Profile arrows 2,500 m per m/s.

## Caveats

- Element sides are about 160 m in the Thames and at the Race's edges and 1 to 1.5 km in open water, so the Race's
  jets and eddies are resolved only coarsely.
- The whole Sound draws only the surface layer's top face and the bed (coloured by the bottom layer); "All layers" is
  for the eastern Sound. An hour without a section (a read that failed, filled on a later run) draws no curtain.
- Velocities are stored in steps of 2 cm/s and stop at 2.54 m/s; `mesh.json`'s `stats` gives each window's maximum.
- NECOFS bed and surface are relative to the model's own mean sea level.
- three.js (jsDelivr's `+esm` build), camera-controls and vantagekit load from jsDelivr, so a site Content Security Policy must allow cdn.jsdelivr.net.
