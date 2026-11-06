"""Fetch observations from the UConn LISICOS ERDDAP server (Merlin), through one insitukit ``Erddap`` client.

The server is plain HTTP on port 8080 and returns occasional 503s, so every request retries with
backoff. A 404 whose body says "no matching results" means an empty time window, not a missing
dataset.

Load on the server is bounded in this module, the only path the jobs use to reach it: requests run one
at a time, at least MIN_INTERVAL apart; every attempt (retries included) counts against the job's budget
(BUDGETS, set by the command line), and a job that reaches it stops asking; a 503 or 429 with Retry-After
is waited out (up to 60 s); each run logs its requests and bytes (summary()).

When the server cannot be reached at all (no connection within CONNECT_TIMEOUT, on every retry), the
rest of the run's requests fail at once with ServerUnreachable instead of each waiting through its own
retries: on 2026-10-15 an outage made every live run wait out its task timeout before writing anything,
which also froze the shore stations and rivers published after the buoys.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import pandas as pd
import requests
from insitukit import erddap

BASE_URL = "http://merlin.dms.uconn.edu:8080/erddap"
USER_AGENT = "lhzn-blue-ingest/0.2 (+https://longhorizon.blue; hello@longhorizon.blue)"
OBS_COLUMNS = ["sea_water_temperature", "sea_water_salinity", "oxygen_concentration_in_sea_water"]

log = logging.getLogger(__name__)

CONNECT_TIMEOUT = 10  # seconds to open a connection; a large response may take the read timeout to arrive
MIN_INTERVAL = 1.0  # seconds between the starts of two requests
# Requests (attempts) a job may make. Normal runs: latest about 13, live about 30, history about 250,
# snapshot about 230. Jobs that do not read the server get 0, so a stray call fails instead of sending.
BUDGETS = {"latest": 40, "live": 80, "history": 800, "snapshot": 800, "import-archive": 0, "import-waves": 0,
           "import-weather": 400, "import-verification": 0, "fields": 0, "forecast": 0, "forecast-backfill": 0}
DEFAULT_BUDGET = 50

# The client's own exceptions, under the names the jobs and outages.is_outage use.
DatasetMissing = erddap.DatasetMissing
ServerUnreachable = erddap.Unreachable
RequestBudgetExceeded = erddap.BudgetExceeded

_server = erddap.Erddap(BASE_URL, budget=DEFAULT_BUDGET, min_interval=MIN_INTERVAL, connect_timeout=CONNECT_TIMEOUT,
                        user_agent=USER_AGENT, retries=4, timeout=120)


def set_budget(n: int) -> None:
    _server.budget = n


def summary() -> str:
    return f"server requests this run: {_server.requests} of a budget of {_server.budget}, {_server.bytes / 1e6:.1f} MB"


def get(url: str, retries: int | None = None) -> requests.Response | None:
    """GET any URL on the server under the job's budget and pacing; None for an empty result window."""
    return _server.get(url, retries=retries)


def variables(dataset_id: str) -> list[str]:
    """Variable names the dataset publishes."""
    return _server.variables(dataset_id)


def fetch(dataset_id: str, start: datetime, end: datetime, columns: list[str]) -> pd.DataFrame:
    """Rows for ``start <= time < end`` with a UTC ``time`` column, ``depth`` and the requested columns."""
    return _server.fetch(dataset_id, start, end, ["depth", *columns])


def fetch_years(dataset_id: str, first_year: int, end: datetime, columns: list[str]) -> pd.DataFrame:
    """Fetch from ``first_year`` to ``end`` in calendar-year requests, to keep each response small."""
    frames = []
    for year in range(first_year, end.year + 1):
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        stop = min(datetime(year + 1, 1, 1, tzinfo=timezone.utc), end)
        if start >= stop:
            break
        df = fetch(dataset_id, start, stop, columns)
        log.info("%s %d: %d rows", dataset_id, year, len(df))
        if not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame(columns=["time", "depth", *columns])
    return pd.concat(frames, ignore_index=True)
