"""Fetch observations from the UConn LISICOS ERDDAP server (Merlin).

The server is plain HTTP on port 8080 and returns occasional 503s, so every request retries with
backoff. A 404 whose body says "no matching results" means an empty time window, not a missing
dataset.

Load on the server is bounded in this module, the only path the jobs use to reach it: requests run one
at a time, at least MIN_INTERVAL apart; every attempt (retries included) counts against the job's budget
(BUDGETS, set by the command line), and a job that reaches it stops asking; a 503 or 429 with Retry-After
is waited out (up to MAX_RETRY_AFTER); each run logs its requests and bytes (summary()).

When the server cannot be reached at all (no connection within CONNECT_TIMEOUT, on every retry), the
rest of the run's requests fail at once with ServerUnreachable instead of each waiting through its own
retries: on 2026-10-15 an outage made every live run wait out its task timeout before writing anything,
which also froze the shore stations and rivers published after the buoys.
"""

from __future__ import annotations

import io
import logging
import time
from datetime import datetime, timezone

import pandas as pd
import requests

BASE_URL = "http://merlin.dms.uconn.edu:8080/erddap"
USER_AGENT = "lhzn-blue-ingest/0.2 (+https://longhorizon.blue; hello@longhorizon.blue)"
OBS_COLUMNS = ["sea_water_temperature", "sea_water_salinity", "oxygen_concentration_in_sea_water"]

log = logging.getLogger(__name__)
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


CONNECT_TIMEOUT = 10  # seconds to open a connection; a large response may take the read timeout to arrive
MIN_INTERVAL = 1.0  # seconds between the starts of two requests
MAX_RETRY_AFTER = 60.0
# Requests (attempts) a job may make. Normal runs: latest about 13, live about 30, history about 250,
# snapshot about 230. Jobs that do not read the server get 0, so a stray call fails instead of sending.
BUDGETS = {"latest": 40, "live": 80, "history": 800, "snapshot": 800, "import-archive": 0, "import-waves": 0,
           "import-weather": 400, "import-verification": 0, "fields": 0, "forecast": 0, "forecast-backfill": 0}
DEFAULT_BUDGET = 50


class DatasetMissing(RuntimeError):
    """The dataset id is not published on the server."""


class ServerUnreachable(RuntimeError):
    """The server did not accept a connection on any retry earlier in this run."""


class RequestBudgetExceeded(RuntimeError):
    """The job has made as many requests as its budget allows."""


_unreachable: str | None = None  # set by the first request that could not connect on any retry
_budget = DEFAULT_BUDGET
_requests = 0
_bytes = 0
_last_start = 0.0


def set_budget(n: int) -> None:
    global _budget
    _budget = n


def summary() -> str:
    return f"server requests this run: {_requests} of a budget of {_budget}, {_bytes / 1e6:.1f} MB"


def _attempt(url: str, timeout: int) -> requests.Response:
    """One request, within the budget and the spacing."""
    global _requests, _bytes, _last_start
    if _requests >= _budget:
        raise RequestBudgetExceeded(f"{_requests} requests reached this job's budget; not sent: {url}")
    wait = _last_start + MIN_INTERVAL - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_start = time.monotonic()
    _requests += 1
    resp = _session.get(url, timeout=(CONNECT_TIMEOUT, timeout))
    _bytes += len(resp.content)
    return resp


def _get(url: str, retries: int = 4, timeout: int = 120) -> requests.Response | None:
    """GET with retries; return None for an empty result window."""
    global _unreachable
    if _unreachable:
        raise ServerUnreachable(f"server unreachable since {_unreachable}; not tried: {url}")
    delay = 5.0
    connect_failures = 0
    for attempt in range(1, retries + 1):
        try:
            resp = _attempt(url, timeout)
        except requests.RequestException as exc:
            if isinstance(exc, (requests.ConnectTimeout, requests.ConnectionError)) and not isinstance(exc, requests.ReadTimeout):
                connect_failures += 1
            log.warning("request failed (%s), attempt %d: %s", exc.__class__.__name__, attempt, url)
        else:
            if resp.status_code == 200:
                return resp
            if resp.status_code == 404 and "no matching results" in resp.text.lower():
                return None
            if resp.status_code == 404:
                raise DatasetMissing(url)
            log.warning("HTTP %d, attempt %d: %s", resp.status_code, attempt, url)
            if resp.status_code in (429, 503) and attempt < retries:
                try:
                    delay = max(delay, min(MAX_RETRY_AFTER, float(resp.headers.get("Retry-After", ""))))
                except ValueError:
                    pass
        if attempt < retries:
            time.sleep(delay)
            delay *= 2
    if connect_failures == retries:
        _unreachable = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        log.warning("server unreachable: skipping its remaining requests this run")
        raise ServerUnreachable(f"no connection after {retries} attempts: {url}")
    raise RuntimeError(f"giving up after {retries} attempts: {url}")


def variables(dataset_id: str) -> list[str]:
    """Variable names the dataset publishes."""
    resp = _get(f"{BASE_URL}/info/{dataset_id}/index.csv")
    if resp is None:
        raise DatasetMissing(dataset_id)
    info = pd.read_csv(io.StringIO(resp.text))
    return info.loc[info["Row Type"] == "variable", "Variable Name"].tolist()


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(dataset_id: str, start: datetime, end: datetime, columns: list[str]) -> pd.DataFrame:
    """Rows for ``start <= time < end`` with a UTC ``time`` column and the requested columns."""
    query = ",".join(["time", "depth", *columns])
    url = f"{BASE_URL}/tabledap/{dataset_id}.csv?{query}&time%3E={_iso(start)}&time%3C{_iso(end)}"
    resp = _get(url)
    if resp is None:
        return pd.DataFrame(columns=["time", "depth", *columns])
    # Row 2 of an ERDDAP CSV holds units.
    df = pd.read_csv(io.StringIO(resp.text), skiprows=[1])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df


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
