# @lhzn-io/timecharts

Time-series charts on one shared time axis: the charts (`chart`), the time track and play button (`time-axis`), the
time zone they are drawn in (`zone`), the hourly and daily series helpers (`series`), local time across the clock
changes (`dst`), wind arrows and compass points (`wind-dir`), moon phases (`moon`), the currents and measured-speed
colour ramps, and the theme tokens (`tokens.css`) of longhorizon.blue, for lhzn-blue's own pages and for other sites
built on them.

```bash
npm install @lhzn-io/timecharts
```

```ts
import { renderLines, type Line } from "@lhzn-io/timecharts/chart";
import { timeTrack } from "@lhzn-io/timecharts/time-axis";
```

```css
@import "@lhzn-io/timecharts/tokens.css";
@import "@lhzn-io/timecharts/charts.css";
```

`charts.css` lays out what `renderLines` and `timeTrack` draw: the plot (`.plot`, its SVG and `.plot-labels`), the
tooltip (`.tip`), the values at the cursor (`.cursor-vals`), and the time track (`.time-track`, `.tl-*`, the moons).
A plot is 190 px high by default; set a page's own heights after it.

The package ships ES modules with type declarations (built by `tsc` into `dist/`), for any bundler.

## Time zone

Axis rules, day labels, tooltips and day boundaries are drawn in America/New_York unless a page says otherwise. Set
the zone for the whole package once, before drawing:

```ts
import { setTimeZone } from "@lhzn-io/timecharts/zone";
setTimeZone("UTC"); // any IANA name; throws a RangeError for an unknown one
```

or for one chart or track: `renderLines(plot, { ...options, timeZone: "Europe/Lisbon" })`,
`timeTrack(input, timeOf, { timeZone: "Europe/Lisbon" })`. `zoned(formatter)` labels the repeated hour of a clock
change with the zone's abbreviation, in the formatter's own zone.

## Theme and data

The charts read their colours from the tokens (`--chart-*`, `--now`, `--accent` and the rest), so a page that uses
them imports `tokens.css` or defines the same custom properties. The series helpers read the JSON form written by
insitukit's `series` module (`t0`, `step` and values).

`currents-ramp.ts` is generated from the two CSV tables beside it by `scripts/build-currents-ramp.py` in lhzn-blue.

## In lhzn-blue

`apps/web` depends on this directory (`file:../../packages/timecharts`) and builds it before `dev`, `build` and
`typecheck`. Releases go to npm with `scripts/release-package.sh timecharts <version>`.

MIT License. Long Horizon Observatory.
