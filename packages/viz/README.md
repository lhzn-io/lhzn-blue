# @lhzn-io/viz

The charts (`chart`), the time track and play button (`time-axis`), the hourly and daily series helpers (`series`),
Eastern-time formatting (`dst`), wind arrows and compass points (`wind-dir`), moon phases (`moon`), the currents and
measured-speed colour ramps, and the theme tokens (`tokens.css`) of longhorizon.blue, for lhzn-blue's own pages and
for other sites built on them.

The package ships TypeScript source, not compiled JavaScript: it is meant for a Vite app, which compiles it with the
app's own code. With `"moduleResolution": "Bundler"` TypeScript resolves the exports to the `.ts` files directly.

```ts
import { renderLines, type Line } from "@lhzn-io/viz/chart";
import { timeTrack } from "@lhzn-io/viz/time-axis";
```

```css
@import "@lhzn-io/viz/tokens.css";
```

The charts read their colours from the tokens (`--chart-*`, `--now`, `--accent` and the rest), so a page that uses
them imports `tokens.css` or defines the same custom properties.

`currents-ramp.ts` is generated from the two CSV tables beside it by `scripts/build-currents-ramp.py` in lhzn-blue.

Within lhzn-blue, `apps/web` depends on this directory (`file:../../packages/viz`). Other sites install the tarball
attached to a `kit-v*` release of lhzn-blue by URL.
