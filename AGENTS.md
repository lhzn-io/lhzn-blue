# AGENTS.md

Context for AI developer agents working in `lhzn-io/lhzn-blue`. Human entry point: `README.md`.

## Architecture

- `stations/stations.json`: the single station registry (datasets per depth, archive sources). Both the jobs and the
  page read it; add a station or a series here first.
- `jobs/src/lhzn_blue_jobs/`: `merlin.py` (ERDDAP client with retries; a 404 with "no matching results" is an empty
  window), `build.py` (QC, UTC hourly means, published JSON, storage backends), `archive.py` (reads saved HDF5
  snapshots for `import-archive`), `cli.py`.
- `apps/web/src/`: `series.ts` (all derived values: rolling means, change, year mapping, coverage rule,
  stratification), `chart.ts` (SVG line charts with tooltips), `lis.ts` (the page, one builder per chart in
  `FIGS` used both inline and in the zoom dialog, and the prompt), `site.css` (design tokens).
- `worker/src/index.ts`: static assets plus `/data/v1/live.json` and `/data/v1/history.json` from the `DATA` KV
  binding, same-origin (no CORS) and throttled per client by the `LIMITER` binding. It does no data processing.
  There is no public API yet: do not add CORS, new data routes, or links to the data files without a decision.

## Rules

- **Public repository.** Describe any ocean model generically ("a downstream ocean model"). Do not reference
  unannounced projects, internal run names, or private infrastructure; keep project ids, account ids beyond what
  `wrangler.toml` needs, and tokens in `~/.config/lhzn-blue/env` or Secret Manager.
- **Cost guards.** `build.Store.write_json` writes only the allow-listed object names (`WRITABLE`) under a size cap.
  Keep it that way: no per-run or timestamped object names.
- **Numbers as text.** The AI prompt is built from the same values the charts use (`lis.ts`, `promptData`); the
  template is `configs/prompts/visitor_prompt.txt`. Never send chart images as the source of numbers.
- **Thresholds are fixed in code and stated on the page** (`series.ts`, `STRAT`, `COVERAGE_MIN`); they are never
  inferred by a model.
- **Merlin etiquette.** Hourly live fetches of the last 72 hours only; full rebuilds daily.
- Style: no emojis, no em-dashes, plain technical language. Organization name: Long Horizon Observatory.

## Commands

```bash
cd jobs && uv run lhzn-blue-jobs {history|live} --out ../out     # local run
scripts/seed-kv.sh out                                           # push local output to KV (wrangler login)
scripts/deploy-web.sh                                            # build site and deploy the Worker
scripts/setup-gcp.sh && scripts/deploy-jobs.sh && scripts/schedule-jobs.sh
```
