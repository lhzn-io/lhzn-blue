"""Fetch observations from the UConn LISICOS ERDDAP server (Merlin), through one insitukit ``Erddap`` client.

The server answers on HTTPS (port 8080 now redirects there) and returns occasional 503s, so every request
retries with backoff. A 404 whose body says "no matching results" means an empty time window, not a missing
dataset.

Load on the server is bounded in this module, the only path the jobs use to reach it: requests run one
at a time, at least MIN_INTERVAL apart; every attempt (retries included) counts against the job's budget
(BUDGETS, set by the command line), and a job that reaches it stops asking; a 503 or 429 with Retry-After
is waited out (up to 60 s); each run logs its requests and bytes (summary()).

When the server cannot be reached at all (no connection within CONNECT_TIMEOUT, on every retry), the
rest of the run's requests fail at once with ServerUnreachable instead of each waiting through its own
retries: on 2026-10-15 an outage made every live run wait out its task timeout before writing anything,
which also froze the shore stations and rivers published after the buoys.

A server that connects but then stalls is bounded too: the quick jobs (SERVER_SECONDS) stop asking once their
requests have taken that long in all, and the rest fail at once with ServerUnreachable, as above. On 2026-11-16 and
17 a stalled server held 42 live runs to their 20-minute task timeout and 128 latest runs to their 5-minute one.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import pandas as pd
import requests
from insitukit import erddap

BASE_URL = "https://merlin.dms.uconn.edu/erddap"
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
# Seconds of server time a quick job may spend in all (normal runs: latest about 20, live about 45), and the read
# timeout of each of its attempts. Jobs not listed keep the client's 120 s read timeout and no cap: history and
# snapshot fetch whole years and are not time-critical.
SERVER_SECONDS = {"latest": 90, "live": 180, "panels": 30}
QUICK_READ_TIMEOUT = 30
READ_TIMEOUT = 120

# The client's own exceptions, under the names the jobs and outages.is_outage use.
DatasetMissing = erddap.DatasetMissing
ServerUnreachable = erddap.Unreachable
RequestBudgetExceeded = erddap.BudgetExceeded

_server = erddap.Erddap(BASE_URL, budget=DEFAULT_BUDGET, min_interval=MIN_INTERVAL, connect_timeout=CONNECT_TIMEOUT,
                        user_agent=USER_AGENT, retries=4, timeout=READ_TIMEOUT)


_spent = 0.0  # seconds this run's requests have taken
_cap: float | None = None


def set_budget(n: int) -> None:
    _server.budget = n


def set_job(command: str) -> None:
    """The command's server-time cap and read timeout (SERVER_SECONDS); none for the others."""
    global _cap, _spent
    _cap, _spent = SERVER_SECONDS.get(command), 0.0
    _server.timeout = QUICK_READ_TIMEOUT if _cap is not None else READ_TIMEOUT


def _timed(fn, *args, **kwargs):
    """Run one client call under the run's cap: refused once the cap is spent, its own time added after."""
    global _spent
    if _cap is not None and _spent >= _cap:
        raise ServerUnreachable(f"this run's server time ({_spent:.0f} s of {_cap:.0f} s) is spent; the server is stalling", BASE_URL)
    t0 = time.monotonic()
    try:
        return fn(*args, **kwargs)
    finally:
        _spent += time.monotonic() - t0


def summary() -> str:
    return (f"server requests this run: {_server.requests} of a budget of {_server.budget}, {_server.bytes / 1e6:.1f} MB, "
            f"{_spent:.0f} s")


def get(url: str, retries: int | None = None, timeout: float | None = None) -> requests.Response | None:
    """GET any URL on the server under the job's budget, pacing and time cap; None for an empty result window."""
    return _timed(_server.get, url, retries=retries, timeout=timeout)


def variables(dataset_id: str) -> list[str]:
    """Variable names the dataset publishes."""
    return _timed(_server.variables, dataset_id)


def fetch(dataset_id: str, start: datetime, end: datetime, columns: list[str]) -> pd.DataFrame:
    """Rows for ``start <= time < end`` with a UTC ``time`` column, ``depth`` and the requested columns."""
    return _timed(_server.fetch, dataset_id, start, end, ["depth", *columns])


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
