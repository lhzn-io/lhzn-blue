"""HRDPS 10 m wind and gust at the stations, archived with both times, for scoring against the buoys before the page
shows it.

Environment and Climate Change Canada's HRDPS (High Resolution Deterministic Prediction System) runs at 00, 06, 12
and 18 UTC to 48 h on a 2.5 km rotated latitude-longitude grid that covers the Sound. forcingkit reads it from the
MSC Datamart (`forcingkit.fetchers.hrdps`): one GRIB2 file per field and lead, winds rotated to east and north, and
each station's value an inverse-distance-squared mean of its nearest water cells within forecast.MAX_KM, as for HRRR.
The Datamart keeps 30 days, so the record exists only from when collection starts; `backfill` takes what is still
there.

Each run is kept twice, as HRRR's and GFS's are:

- ``<archive>/hrdps/YYYY/MM/cycle=YYYYMMDDHH.csv.gz``: every row (leads 0 to 48), create-only, never overwritten.
- ``v1/forecast-hrdps.json`` (KV): every lead of the runs of the last KEEP_FULL_HOURS, and the verification leads of
  those of the last KEEP_DAYS, for the daily verification (`verify`), which reads only this file. The page does not
  read it yet: HRDPS is shown once its misses at the buoys are known.

Rows are (issue_time, valid_time, lead_h, point, field, value) in m/s. Data Source: Environment and Climate Change
Canada (Data Server End-use Licence).
"""

from __future__ import annotations

import logging
from datetime import datetime

import pandas as pd

from . import forecast
from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

CYCLE_HOURS = 6
LEADS = list(range(0, 49))
FIELDS = ("u10", "v10", "gust")
WIND = ("u10", "v10")  # the backfill's: verification scores the wind
VERIFY_LEADS = forecast.BACKFILL_LEADS  # HRRR's, so the two models' misses compare lead for lead
LOOKBACK_CYCLES = 4  # a day of runs is tried each hour; a run's 48 h files are posted about 3 h after it starts
KEEP_FULL_HOURS = 30
KEEP_DAYS = 4  # runs kept at the verification leads: their 48 h leads have passed, with two days spare
KV_KEY = "v1/forecast-hrdps.json"
SOURCE = (
    "ECCC HRDPS 2.5 km (MSC Datamart), read at the stations from its nearest water cells. "
    "Data Source: Environment and Climate Change Canada"
)


def complete(cycle: pd.Timestamp) -> bool:
    """Whether a run's 48 h wind and gust files are all posted (a run's last lead is posted last)."""
    from forcingkit.fetchers import hrdps

    try:
        return hrdps.newest_cycle(cycle, FIELDS, lookback=1) == cycle
    except Exception as exc:  # treat as not yet
        log.warning("HRDPS %s: could not check completeness: %s", cycle, exc)
        return False


def fetch_cycle(cycle: pd.Timestamp, leads: list[int], pts: dict[str, tuple[float, float]], fields=FIELDS) -> pd.DataFrame:
    """One run's rows at the stations; leads not posted are left out."""
    from forcingkit.fetchers import hrdps

    return hrdps.fetch_points([cycle], leads, pts, fields, max_km=forecast.MAX_KM)


def page_file(prev: dict | None, new: pd.DataFrame, end: datetime) -> dict:
    """The runs of the last KEEP_FULL_HOURS at every lead, and those of the last KEEP_DAYS at VERIFY_LEADS, in the
    shape of HRRR's file: {cycles: {"YYYY-MM-DDTHHZ": {leads, points: {station: {field: [values by lead]}}}}}. The
    longer record builds up from the runs already in the file (the job cannot read its archive back)."""
    cycles: dict = {} if not prev else dict(prev.get("cycles", {}))
    for issue, g in new.groupby("issue_time"):
        leads = sorted(int(x) for x in g["lead_h"].unique())
        entry: dict = {"leads": leads, "points": {}}
        for (point, field), h in g.groupby(["point", "field"]):
            s = h.set_index("lead_h")["value"].reindex(leads)
            entry["points"].setdefault(point, {})[field] = [None if pd.isna(v) else round(float(v), 2) for v in s]
        cycles[pd.Timestamp(issue).strftime("%Y-%m-%dT%HZ")] = entry
    now = pd.Timestamp(end).tz_convert("UTC").tz_localize(None) if pd.Timestamp(end).tzinfo else pd.Timestamp(end)
    full, short = now - pd.Timedelta(hours=KEEP_FULL_HOURS), now - pd.Timedelta(days=KEEP_DAYS)
    newest = sorted(cycles)[-2:]  # the newest two keep every lead whatever their age (HRDPS late, or the job down)
    out = {}
    for k, c in sorted(cycles.items()):
        t = pd.Timestamp(k.replace("Z", ""))
        if t < short:
            continue
        if t < full and k not in newest:
            keep = [i for i, lead in enumerate(c["leads"]) if lead in VERIFY_LEADS]
            c = {"leads": [c["leads"][i] for i in keep],
                 "points": {p: {f: [vals[i] for i in keep] for f, vals in fs.items()} for p, fs in c["points"].items()}}
        out[k] = c
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": SOURCE,
        "license": "https://eccc-msc.github.io/open-data/licence/readme_en/",
        "units": {"u10": "m/s", "v10": "m/s", "gust": "m/s"},
        "cycles": out,
    }


def archive(store: Store, root: str, lookback: int = LOOKBACK_CYCLES) -> list[str]:
    """Archive the recent complete runs not yet kept; refresh the verification's file. Returns the runs written."""
    end = now_utc()
    arch = forecast.Archive(_hrdps_root(root))
    prev = store.read_json(KV_KEY)
    kept = set((prev or {}).get("cycles", {}))
    now = pd.Timestamp(end).tz_localize(None).floor(f"{CYCLE_HOURS}h")
    recent = [now - pd.Timedelta(hours=CYCLE_HOURS * i) for i in range(lookback, -1, -1)]
    todo = [c for c in recent if f"{c:%Y-%m-%dT%HZ}" not in kept and not arch.has(c) and complete(c)]
    pts = forecast.points()
    frames = []
    for cycle in todo:
        df = fetch_cycle(cycle, LEADS, pts)
        if df.empty:
            log.warning("HRDPS %s: no rows", cycle)
            continue
        log.info("HRDPS %s: %d rows, %s", cycle, len(df), "archived" if arch.put(cycle, forecast.to_csv_gz(df)) else "already archived")
        frames.append(df)
    if frames:
        store.write_json(KV_KEY, page_file(prev, pd.concat(frames), end), max_age=1800)
    return [f"{c:%Y-%m-%d %HZ}" for c in todo]


def backfill(root: str, start: str, end: str, task: int = 0, tasks: int = 1) -> dict[str, int]:
    """Archive past runs from start to end (UTC, inclusive) at VERIFY_LEADS, wind only, while the Datamart still has
    them (30 days): this task taking every `tasks`-th run from `task` (Cloud Run's task index and count). Create-only;
    a run that fails is logged and left for a rerun. The verification's file is not touched."""
    arch = forecast.Archive(_hrdps_root(root))
    pts = forecast.points()
    cycles = list(pd.date_range(start, end, freq=f"{CYCLE_HOURS}h"))[task::tasks]
    counts = {"cycles": len(cycles), "archived": 0, "already": 0, "empty": 0, "failed": 0}
    for cycle in cycles:
        try:
            if arch.has(cycle):
                counts["already"] += 1
                continue
            df = fetch_cycle(cycle, VERIFY_LEADS, pts, WIND)
            counts["empty" if df.empty else "archived" if arch.put(cycle, forecast.to_csv_gz(df)) else "already"] += 1
        except Exception as exc:
            counts["failed"] += 1
            log.warning("HRDPS %s: failed: %s", cycle, exc)
    log.info("HRDPS backfill task %d of %d: %s", task + 1, tasks, counts)
    return counts


def _hrdps_root(root: str) -> str:
    """HRDPS's runs beside HRRR's in the forecast archive, under hrdps/."""
    return f"{root.rstrip('/')}/hrdps"


__all__ = ["archive", "backfill", "complete", "fetch_cycle", "page_file"]
