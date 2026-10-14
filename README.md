# lhzn-blue

Public marine measurements at [longhorizon.blue](https://longhorizon.blue), one page per waterway, starting with
[Long Island Sound](https://longhorizon.blue/long-island-sound/). Each page shows what the water reads now, how that
compares with the same dates in every earlier year on record, and where every number comes from.

- Data: the moored buoys of [LISICOS](https://lisicos.uconn.edu/) (Department of Marine Sciences, University of
  Connecticut), read from their ERDDAP server; NOAA CO-OPS shore stations; USGS stream gauges on the rivers that
  feed the Sound; satellite surface fields from NOAA CoastWatch; and modelled surface currents from NECOFS (FVCOM).
  For the regional picture, see the [NERACOOS Mariners' Dashboard](https://mariners.neracoos.org/). This project is
  independent of all of these and is not endorsed by them; we credit them as the sources and the inspiration.
- Status: **alpha**. Views, wording, and thresholds may change.
- **Not for navigation.** Observations with their age shown, and model output labelled as such; not safety advice.

## How it works

```
Cloud Scheduler -> Cloud Run jobs (jobs/)        live hourly, latest every 15 min, history daily,
                     |                           fields daily, forecast hourly, snapshot 3x weekly
                     |  read ERDDAP, CO-OPS, USGS, CoastWatch, NECOFS, HRRR; QC; hourly means (UTC)
                     v
                   Cloudflare Workers KV         v1/*.json and v1/fields/* (allow-listed names)
                     |
Cloudflare Worker (worker/) + static site (apps/web/)
                     /                       landing
                     /long-island-sound/     the page
                     /references/            the sources cited on the page
                     /data/v1/*              the page's data files (same-origin, throttled)
```

Stations:

- **Buoys** (LISICOS): Western Sound (WLIS) and Execution Rocks (EXRX) at three depths, the ARTG buoy, and Central
  Sound (CLIS), whose water quality the server stopped publishing in August 2024 and which is shown from our saved
  download. Each buoy also shows its wind, air temperature, pressure and waves where published.
- **Shore stations** (NOAA CO-OPS): Kings Point, Bridgeport, New Haven and New London, with water temperature,
  weather, water level and the next predicted tide.
- **River gauges** (USGS): ten rivers, largest basin first, with flow against normal for the date and, on the
  Rivers view, each gauge's basin and the river's watershed on the map.

Views: water temperature, salinity, dissolved oxygen, wind and waves, turbidity (with the fouling of the optical
sensors flagged), and rivers. A locator map and an overview table sit at the top of the page; the map can show sea
surface temperature, chlorophyll-a and water clarity (Kd490) from satellite, with 90 days of history, and the
surface currents forecast. One timeline below the map sets the time for the map layers, the charts, and the
overview table and pins.

Readings pass gross-range and spike checks before averaging. A dataset the server stops publishing is retried
hourly, and the daily build never drops an hour we already hold. Saved copies of the server's datasets are kept in
case any are withdrawn or renamed.

The page computes the 36-hour means, the 7-day change, the year-over-year comparison, the seasonal percentiles and
the surface-minus-bottom difference in the browser from the hourly series, so the charts and the AI prompt use one
implementation. Any chart opens in a zoom view (scroll or pinch to zoom, drag to pan) with tooltips, and an (i)
beside each plot explains what it shows, how it is computed, and its sources.

**Collect.** The "+" beside each plot, readout row and the map adds it to a tray. From the tray a visitor can ask
their own AI about what they collected (one image plus a prompt with the same numbers as text and the method notes)
or send us a suggestion by email.

There is no public data API yet. The data files serve this site's pages only; they are throttled per client and
may change without notice. For the underlying observations, use the sources directly, starting with the
[LISICOS ERDDAP server](http://merlin.dms.uconn.edu:8080/erddap/).

| Path | Contents |
| :--- | :--- |
| `stations/` | Registries shared by the jobs and the page: `stations.json` (buoys), `shore.json`, `rivers.json` |
| `jobs/` | Python ingest: `lhzn-blue-jobs` with `history`, `live`, `latest`, `fields`, `forecast`, `snapshot`, and one-time imports |
| `apps/web/` | Vite and TypeScript site, "chart room" design |
| `worker/` | Cloudflare Worker: static assets and the allow-listed `/data/v1/*` files from Workers KV |
| `configs/prompts/` | Prompt template behind "Ask your AI" |
| `scripts/` | Setup and deploy scripts (settings from `~/.config/lhzn-blue/env`, never committed) |
| `docs/` | `references.bib` (the references page) and the public roadmap |

What comes next: [docs/planning/roadmap.md](docs/planning/roadmap.md).

## Development

```bash
cd jobs && uv sync && uv run lhzn-blue-jobs history --out ../out && uv run lhzn-blue-jobs live --out ../out
uv run lhzn-blue-jobs fields --out ../out                # optional: map layers
cd ../apps/web && npm ci && npm run dev                  # serves /data/v1/* from ../../out
```

## License

Code: MIT (see `LICENSE`). Data: passed on with credit under each source's terms (LISICOS, University of
Connecticut; NOAA; USGS; NECOFS); the source dataset of every series is listed in the data files and on the page.
