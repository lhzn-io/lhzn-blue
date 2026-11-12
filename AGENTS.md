# AGENTS.md

Context for AI developer agents working in `lhzn-io/lhzn-blue`. Human entry point: `README.md`.

## Architecture

- `stations/`: the registries. `stations.json` (buoys: datasets per depth, archive sources), `shore.json` (NOAA
  CO-OPS stations and their products), `rivers.json` (USGS gauges). Both the jobs and the page read them; add a
  station or a series here first.
- `packages/` (public npm packages, MIT, built by `tsc` into `dist/`; keep them free of anything specific to one
  waterway or to this site):
  - `timecharts/` (`@lhzn-io/timecharts`): `chart.ts`, `time-axis.ts`, `zone.ts` (the time zone, America/New_York
    by default; `setTimeZone`, or a chart's or track's own `timeZone`), `series.ts`, `dst.ts`, `wind-dir.ts`,
    `moon.ts`, the currents and measured ramps, and `tokens.css` (the theme tokens).
  - `collect/` (`@lhzn-io/collect`): Collect (`collect.ts`: the tray and the "Ask your AI" prompt; `snapshot.ts`:
    one PNG of the collected items; `collect.css`). The page supplies a `CollectHost` and options (labels, terms
    link, suggestion panel, what the image leaves out); this site's are in `waterway/prompt.ts`.
  - `apps/web` depends on both as `file:` links and builds them before `dev`, `build` and `typecheck`; other sites
    install them from npm (`scripts/release-package.sh`).
- The jobs' NOAA CO-OPS and NERACOOS ERDDAP clients and the guarded store come from `insitukit` (PyPI,
  `lhzn-io/insitukit`); `lhzn_blue_jobs/__init__.py` identifies every request as this site. A change to those
  belongs in insitukit, released, then the pin here raised. Use insitukit's public functions only (no `coops._get`,
  `_stamp` or `_pace`); CO-OPS current speeds come back in m/s, and the files that publish cm/s convert back.
- `jobs/src/lhzn_blue_jobs/`:
  - `merlin.py` (the LISICOS server through one insitukit `Erddap` client: per-job budget, retries, unreachable
    flag; a 404 with "no matching results" is an empty window),
    `rivers.py` (USGS Water Data APIs; `USGS_API_KEY` optional).
  - `build.py` (QC, UTC hourly means, the buoy files, the `WRITABLE` allow-list for insitukit's store),
    `shore.py`, `waves.py`, `weather.py` (buoy weather history for the seasonal %iles), `turbidity.py` (with
    fouling flags).
  - `fields.py` (satellite rasters and NECOFS surface currents via forcingkit), `forecast.py` (HRRR at the buoys
    and shore stations via forcingkit `hrrr_points`: a create-only archive per cycle plus the last 48 h to KV).
  - Map and forecast layers: `hrrr_grid.py` (HRRR wind on its own grid), `hrrr_history.py` (HRRR's last forecast
    before each hour), `model_grids.py` (the models compared page), `nwps.py` (NWS wave model runs), `wat.py` (wind
    against tide), `phase.py` (tidal current phase), `rips.py` (charted rips), `advisories.py` (NWS marine
    advisories), `verify.py` (HRRR scored against the buoys).
  - More stations: `asos.py` (airport weather), `usgs_tidal.py` (USGS tidal gauges), `tides.py` (tide predictions,
    datums and moon phases), `panels.py` (a transcribed record from the LISICOS station panels during outages).
  - `piscataqua.py` (NOAA's tidal current predictions for the Piscataqua Region page).
  - `snapshot.py` (saved copies of the server's datasets), `archive.py` (reads saved downloads for the imports),
    `cli.py`.
- `apps/web/src/`:
  - `lis.ts`: the page. Views (`WATER_VARS`: temp, salinity, oxygen, wind, turbidity, rivers), the overview table
    and pins, readouts per station, one builder per chart in `FIGS` used both inline and in the zoom dialog, and
    the prompt (`promptData`).
  - `@lhzn-io/timecharts/series` (all derived values: rolling means, change, year mapping, coverage rule,
    stratification), `trends.ts` (direction and seasonal percentile of a readout), `@lhzn-io/timecharts/chart`
    (SVG line charts with tooltips).
  - `map.ts` (MapLibre locator map, pins, river basins; loaded on demand), `fields.ts` (map layers: colour bar,
    rasters, currents), `timeline.ts` (the one time cursor for the map, the charts, the table and the pins).
  - `methods.ts` (the text behind every (i) and the method notes in the prompt; `[[key]]` cites
    `docs/references.bib`), `waterway/prompt.ts` (the prompt, and Collect wired to `@lhzn-io/collect`), `hints.ts`,
    `suggest.ts`, `site.css` (layout; imports the tokens and Collect's styles from the packages).
- `apps/web/` pages: `/` (landing), `/long-island-sound/` with `forecast/`, `models/` and `tides/`, `/about/`,
  `/references/`, `/terms/`, and unlisted pages (any page not in `public/sitemap.xml`). `public/` holds
  `basins.geojson`, `references.bib`, `_headers`, `robots.txt` and `sitemap.xml`.
- `worker/src/index.ts`: static assets plus the files listed in `FILES` under `/data/v1/`, from the `DATA` KV
  binding, same-origin (no CORS) and throttled per client by the `LIMITER` binding. It does no data processing.
  There is no public API yet: do not add CORS, new data routes, or links to the data files without a decision. A
  new data file needs an entry in both `build.WRITABLE` and the Worker's `FILES`.

## Rules

- **Public repository.** Name only the public sources and models the site uses. Do not reference unannounced
  projects, partners or plans, internal run names, or private infrastructure. Bucket names, project ids, account
  ids beyond what `wrangler.toml` needs, and tokens belong in `~/.config/lhzn-blue/env` or Secret Manager.
- **Unlisted pages** stay out of the sitemap, the navigation, the README and the roadmap, and send
  `X-Robots-Tag: noindex` (`public/_headers`).
- **Cost guards.** `build.Store.write_json` (insitukit's store, held to `WRITABLE`) writes only the allow-listed object
  names under a size cap.
  Keep it that way: no per-run or timestamped object names in KV. (The forecast archive's per-cycle files go to its
  own create-only store, not KV.)
- **Numbers as text.** The AI prompt is built from the same values the charts use (`lis.ts`, `promptData`, and the
  Collect prompt in `waterway/prompt.ts`); the template is `configs/prompts/visitor_prompt.txt`. The Collect image is for
  context; never make it the source of numbers.
- **One time for every surface.** When the timeline's cursor is set, the table, pins, readouts and prompts show
  values at that time: observed, or forecast where one exists, never blended; "--" otherwise.
- **Thresholds are fixed in code and stated on the page** (`series.ts`, `STRAT`, `COVERAGE_MIN`); they are never
  inferred by a model.
- **Source etiquette.** Merlin: hourly live fetches of the last 72 hours only (plus a quick 15-minute refresh of the
  buoys' water and weather); full rebuilds daily. Identify the client on every request.
- Style: no emojis, no em-dashes, plain technical language. Organization name: Long Horizon Observatory.
- **Commits.** Author and commit as the human contributor (`git config` user). Record the agent harness and model
  that helped as a plain-text line at the end of the body, for example `Collaborated with Claude Code (Opus 5.5).`
  Never a `Co-Authored-By:` trailer: GitHub parses those into the Contributors list, which is for people.

## Commands

```bash
cd jobs && uv run lhzn-blue-jobs {history|live|latest|fields} --out ../out       # local run
uv run lhzn-blue-jobs forecast --out ../out --forecasts ../out/hrrr               # HRRR archive (local)
scripts/seed-kv.sh out                                           # push local output to KV (wrangler login)
scripts/deploy-web.sh                                            # build site and deploy the Worker
scripts/setup-gcp.sh && scripts/deploy-jobs.sh && scripts/schedule-jobs.sh
cd jobs && uv run pytest                                          # job tests
scripts/release-package.sh timecharts 0.2.0                      # build and pack; --publish for npm (npm login)
```
