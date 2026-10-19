# AGENTS.md

Context for AI developer agents working in `lhzn-io/lhzn-blue`. Human entry point: `README.md`.

## Architecture

- `stations/`: the registries. `stations.json` (buoys: datasets per depth, archive sources), `shore.json` (NOAA
  CO-OPS stations and their products), `rivers.json` (USGS gauges). Both the jobs and the page read them; add a
  station or a series here first.
- `jobs/src/lhzn_blue_jobs/`:
  - `merlin.py` (LISICOS ERDDAP client with retries; a 404 with "no matching results" is an empty window),
    `coops.py` (NOAA CO-OPS; an HTTP 200 with an error body or "No data was found" is an empty result),
    `rivers.py` (USGS Water Data APIs; `USGS_API_KEY` optional).
  - `build.py` (QC, UTC hourly means, the buoy files, storage backends and the `WRITABLE` allow-list),
    `shore.py`, `waves.py`, `weather.py` (buoy weather history for the seasonal %iles), `turbidity.py` (with
    fouling flags).
  - `fields.py` (satellite rasters and NECOFS surface currents via forcingkit), `forecast.py` (HRRR at the buoys
    and shore stations via forcingkit `hrrr_points`: a create-only archive per cycle plus the last 48 h to KV).
  - `snapshot.py` (saved copies of the server's datasets), `archive.py` (reads saved downloads for the imports),
    `cli.py`.
- `apps/web/src/`:
  - `lis.ts`: the page. Views (`WATER_VARS`: temp, salinity, oxygen, wind, turbidity, rivers), the overview table
    and pins, readouts per station, one builder per chart in `FIGS` used both inline and in the zoom dialog, and
    the prompt (`promptData`).
  - `series.ts` (all derived values: rolling means, change, year mapping, coverage rule, stratification),
    `trends.ts` (direction and seasonal percentile of a readout), `chart.ts` (SVG line charts with tooltips).
  - `map.ts` (MapLibre locator map, pins, river basins; loaded on demand), `fields.ts` (map layers: colour bar,
    rasters, currents), `timeline.ts` (the one time cursor for the map, the charts, the table and the pins).
  - `methods.ts` (the text behind every (i) and the method notes in the prompt; `[[key]]` cites
    `docs/references.bib`), `collect.ts` and `snapshot.ts` (Collect: the tray, the "Ask your AI" prompt, one PNG
    of the collected items), `hints.ts`, `suggest.ts`, `site.css` (design tokens).
- `apps/web/` pages: `/` (landing), `/long-island-sound/`, `/references/`, `/terms/`. `public/` holds
  `basins.geojson`, `references.bib`, `_headers`, `robots.txt` and `sitemap.xml`.
- `worker/src/index.ts`: static assets plus the files listed in `FILES` under `/data/v1/`, from the `DATA` KV
  binding, same-origin (no CORS) and throttled per client by the `LIMITER` binding. It does no data processing.
  There is no public API yet: do not add CORS, new data routes, or links to the data files without a decision. A
  new data file needs an entry in both `build.WRITABLE` and the Worker's `FILES`.

## Rules

- **Public repository.** Describe any ocean model generically ("a downstream ocean model"). Do not reference
  unannounced projects, internal run names, or private infrastructure; keep project ids, account ids beyond what
  `wrangler.toml` needs, and tokens in `~/.config/lhzn-blue/env` or Secret Manager.
- **Cost guards.** `build.Store.write_json` writes only the allow-listed object names (`WRITABLE`) under a size cap.
  Keep it that way: no per-run or timestamped object names in KV. (The forecast archive's per-cycle files go to its
  own create-only store, not KV.)
- **Numbers as text.** The AI prompt is built from the same values the charts use (`lis.ts`, `promptData`, and the
  Collect prompt in `collect.ts`); the template is `configs/prompts/visitor_prompt.txt`. The Collect image is for
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
```
