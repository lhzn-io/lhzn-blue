# lhzn-blue

Public marine measurements at [longhorizon.blue](https://longhorizon.blue), one page per waterway, starting with
[Long Island Sound](https://longhorizon.blue/long-island-sound/). Each page shows what the water reads now, how that
compares with the same dates in every earlier year on record, and where every number comes from.

- Data: the moored buoys of [LISICOS](https://lisicos.uconn.edu/) (Department of Marine Sciences, University of
  Connecticut), read from their ERDDAP server. For the regional picture, see the
  [NERACOOS Mariners' Dashboard](https://mariners.neracoos.org/). This project is independent of both and is not
  endorsed by them; we credit them as the source and the inspiration.
- Status: **alpha**. Views, wording, and thresholds may change.
- **Not for navigation.** Observations with their age shown, not forecasts or safety advice.

## How it works

```
Cloud Scheduler -> Cloud Run jobs (jobs/)        hourly `live`, daily `history`
                     |  read LISICOS ERDDAP, QC, hourly means (UTC)
                     v
                   Cloudflare Workers KV         v1/history.json (daily), v1/live.json (hourly)
                     |
Cloudflare Worker (worker/) + static site (apps/web/)
                     /                       landing
                     /long-island-sound/     the page
                     /data/v1/*.json         the page's two data files (same-origin, throttled)
```

Stations: Western Sound (WLIS) and Execution Rocks (EXRX) at three depths, the ARTG buoy (bottom), and Central
Sound (CLIS), whose water quality the server stopped publishing in August 2024 and which is shown from our saved
download. A locator map (OpenFreeMap, OpenStreetMap data) and a status grid sit at the top of the page, and each buoy
shows its wind and air temperature beside the water. Readings pass gross-range and spike checks before averaging. A
dataset the server stops publishing is retried hourly, and the daily build never drops an hour we already hold.

The page computes the 36-hour means, the 7-day change, the year-over-year comparison, and the surface-minus-bottom
difference in the browser from the hourly series, so the charts and the "copy prompt + data" text use one
implementation. Any chart opens in a zoom view (scroll or pinch to zoom, drag to pan) with tooltips.

There is no public data API yet. The two data files serve this site's pages only; they are throttled per client
and may change without notice. For the underlying observations, use the
[LISICOS ERDDAP server](http://merlin.dms.uconn.edu:8080/erddap/) directly.

| Path | Contents |
| :--- | :--- |
| `stations/stations.json` | Station registry shared by the jobs and the page |
| `jobs/` | Python ingest: `lhzn-blue-jobs` with `history`, `live`, or `import-archive` |
| `apps/web/` | Vite and TypeScript site, "chart room" design |
| `worker/` | Cloudflare Worker: static assets and `/data/v1/*` from Workers KV |
| `configs/prompts/` | Prompt template behind the "copy prompt + data" button |
| `scripts/` | Setup and deploy scripts (settings from `~/.config/lhzn-blue/env`, never committed) |

What comes next: [docs/planning/roadmap.md](docs/planning/roadmap.md).

## Development

```bash
cd jobs && uv sync && uv run lhzn-blue-jobs history --out ../out && uv run lhzn-blue-jobs live --out ../out
cd ../apps/web && npm ci && npm run dev    # serves /data/v1/* from ../../out
```

## License

Code: MIT (see `LICENSE`). Data: LISICOS, University of Connecticut, passed on with credit under their terms; the
source dataset of every series is listed in `meta.json` and on the page.
