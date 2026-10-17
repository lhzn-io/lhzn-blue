"""Command line: ``lhzn-blue-jobs {history,live,latest,fields,snapshot,forecast,forecast-backfill,import-verification,import-archive,import-waves,import-weather} --out <store>``.

``live`` and ``history`` also refresh the shore stations (``shore.json``, ``shore-history.json``) and the
rivers (``rivers.json``, ``rivers-history.json``) after the buoys; a failure there is logged and never stops
the buoy files from publishing.
"""

from __future__ import annotations

import argparse
import logging
import sys
import os
from pathlib import Path

from . import build, merlin, rivers, shore, tides, turbidity, usgs_tidal, waves, weather


def _main() -> None:
    parser = argparse.ArgumentParser(prog="lhzn-blue-jobs")
    parser.add_argument("command", choices=["history", "live", "latest", "fields", "snapshot", "forecast", "forecast-backfill", "import-verification", "import-archive", "import-waves", "import-weather"])
    parser.add_argument(
        "--out",
        default=os.environ.get("LHZN_BLUE_OUT", "out"),
        help="local directory or gs://bucket[/prefix] (env LHZN_BLUE_OUT)",
    )
    parser.add_argument(
        "--archive-dir",
        type=Path,
        help="import-archive, import-waves, import-weather: directory of <vintage>/<dataset>.h5; "
        "import-verification: directory of saved <DATASET>_MET.csv.gz",
    )
    parser.add_argument(
        "--to",
        default=os.environ.get("LHZN_BLUE_SNAPSHOTS"),
        help="snapshot: local directory or gs://bucket/prefix for the saved copies (env LHZN_BLUE_SNAPSHOTS)",
    )
    parser.add_argument(
        "--forecasts",
        default=os.environ.get("LHZN_BLUE_FORECASTS"),
        help="forecast: local directory or gs://bucket/prefix for the HRRR archive (env LHZN_BLUE_FORECASTS)",
    )
    parser.add_argument(
        "--nwps",
        default=os.environ.get("LHZN_BLUE_NWPS"),
        help="forecast: local directory or gs://bucket/prefix for the NWPS wave model archive (env LHZN_BLUE_NWPS)",
    )
    parser.add_argument("--start", help="forecast-backfill: first cycle, UTC (e.g. 2024-01-01T00)")
    parser.add_argument("--end", help="forecast-backfill: last cycle, UTC")
    parser.add_argument("--vintage", help="import-archive: fallback snapshot folder when stations.json names none")
    parser.add_argument("--full", action="store_true", help="live: refetch the whole 45-day window")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    merlin.set_budget(merlin.BUDGETS.get(args.command, merlin.DEFAULT_BUDGET))
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    store = build.Store(args.out)
    if args.command == "history":
        build.history(store)
        store.write_json("v1/history-waves.json", waves.history(store), max_age=3600)
        _shore(lambda: store.write_json("v1/history-met.json", weather.history(store), max_age=3600), "weather")
        _shore(lambda: _verify(store), "verification")
        _shore(lambda: store.write_json("v1/history-turbidity.json", turbidity.history(store), max_age=3600), "turbidity")
        _shore(lambda: store.write_json(
            "v1/shore-history.json", shore.history(store.read_json("v1/shore-history.json"), build.now_utc()), max_age=3600
        ))
        _shore(lambda: store.write_json("v1/shore-tides.json", tides.build(), max_age=3600), "tides")
        _shore(lambda: store.write_json(
            "v1/rivers-history.json", rivers.history(store.read_json("v1/rivers-history.json")), max_age=3600
        ), "rivers")
    elif args.command == "live":
        build.live(store, full=args.full)
        _shore(lambda: store.write_json(
            "v1/shore.json", shore.live(store.read_json("v1/shore.json"), build.now_utc(), full=args.full), max_age=300
        ))
        _shore(lambda: store.write_json("v1/rivers.json", rivers.live(store.read_json("v1/rivers.json")), max_age=300), "rivers")
        _shore(lambda: _usgs_fit(store), "usgs-tidal fit")  # monthly: only when the saved fit is a month old
        _shore(lambda: store.write_json("v1/usgs-tidal.json", usgs_tidal.live(
            store.read_json("v1/usgs-tidal.json"), store.read_json("v1/archive/usgs-tidal-pred.json")
        ), max_age=300), "usgs-tidal")
    elif args.command == "latest":
        # The 15-minute refresh between hourly runs: the buoys' water and weather only.
        build.live(store, quick=True)
    elif args.command == "fields":
        from . import fields  # forcingkit is needed only here

        _failed.extend(fields.publish(store))
    elif args.command == "forecast":
        from . import forecast  # forcingkit's HRRR reader is needed only here

        if not args.forecasts:
            parser.error("forecast needs --forecasts (or LHZN_BLUE_FORECASTS)")
        done = forecast.archive(store, args.forecasts)
        logging.getLogger("lhzn_blue_jobs.forecast").info("cycles archived: %s", done or "none new")
        _shore(lambda: __import__("lhzn_blue_jobs.hrrr_grid", fromlist=["publish"]).publish(store), "hrrr grid")
        _shore(lambda: __import__("lhzn_blue_jobs.model_grids", fromlist=["publish"]).publish(store), "model grids")
        _shore(lambda: __import__("lhzn_blue_jobs.nwps", fromlist=["publish"]).publish(store, args.nwps), "nwps")
    elif args.command == "forecast-backfill":
        from . import forecast

        if not (args.forecasts and args.start and args.end):
            parser.error("forecast-backfill needs --forecasts, --start and --end")
        task = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0))
        tasks = int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
        forecast.backfill(args.forecasts, args.start, args.end, task, tasks)
    elif args.command == "import-verification":
        from . import verify

        if not (args.forecasts and args.archive_dir):
            parser.error("import-verification needs --forecasts (a local copy of the archive) and --archive-dir")
        verify.seed(store, Path(args.forecasts), args.archive_dir)
        verify.update(store)
    elif args.command == "snapshot":
        from . import snapshot

        if not args.to:
            parser.error("snapshot needs --to (or LHZN_BLUE_SNAPSHOTS)")
        manifest = snapshot.snapshot(args.to)
        if manifest["failed"]:
            _failed.extend(f["dataset"] for f in manifest["failed"])
    elif args.command == "import-weather":
        if not args.archive_dir:
            parser.error("import-weather needs --archive-dir")
        weather.import_weather(store, args.archive_dir)
    elif args.command == "import-waves":
        if not args.archive_dir:
            parser.error("import-waves needs --archive-dir")
        waves.import_waves(store, args.archive_dir)
    else:
        if not args.archive_dir:
            parser.error("import-archive needs --archive-dir")
        build.import_archive(store, args.archive_dir, args.vintage)
    if _failed:  # the run shows as failed, though everything that could be written was
        sys.exit(1)


_failed: list[str] = []


def _verify(store: build.Store) -> None:
    from . import verify  # pandas only; kept out of the other jobs' imports

    verify.update(store)


def _usgs_fit(store: build.Store) -> None:
    """The USGS gauges' tide predictions, refitted monthly (see usgs_tidal)."""
    if usgs_tidal.fit_due(store.read_json("v1/archive/usgs-tidal-pred.json")):
        store.write_json("v1/archive/usgs-tidal-pred.json", usgs_tidal.fit(), max_age=3600)


def _shore(step, what: str = "shore") -> None:
    """Run a secondary step; on failure log it, carry on with the rest, and exit non-zero at the end."""
    try:
        step()
    except Exception:  # the buoy files are already written
        logging.getLogger(f"lhzn_blue_jobs.{what}").exception("%s not refreshed", what)
        _failed.append(what)


def main() -> None:
    """The jobs' entry point: the command, then a line with the run's requests to the LISICOS server."""
    try:
        _main()
    finally:
        logging.getLogger("lhzn_blue_jobs.merlin").warning(merlin.summary())


if __name__ == "__main__":
    main()
