"""Fetch observations from the UConn LISICOS ERDDAP server (Merlin).

The server is plain HTTP on port 8080 and returns occasional 503s, so every request retries with
backoff. A 404 whose body says "no matching results" means an empty time window, not a missing
dataset.
"""

from __future__ import annotations

import io
import logging
import time
from datetime import datetime, timezone

import pandas as pd
import requests

BASE_URL = "http://merlin.dms.uconn.edu:8080/erddap"
USER_AGENT = "lhzn-blue-ingest/0.1 (+https://longhorizon.blue)"
OBS_COLUMNS = ["sea_water_temperature", "sea_water_salinity", "oxygen_concentration_in_sea_water"]

log = logging.getLogger(__name__)
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


class DatasetMissing(RuntimeError):
    """The dataset id is not published on the server."""


def _get(url: str, retries: int = 4, timeout: int = 120) -> requests.Response | None:
    """GET with retries; return None for an empty result window."""
    delay = 5.0
    for attempt in range(1, retries + 1):
        try:
            resp = _session.get(url, timeout=timeout)
        except requests.RequestException as exc:
            log.warning("request failed (%s), attempt %d: %s", exc.__class__.__name__, attempt, url)
        else:
            if resp.status_code == 200:
                return resp
            if resp.status_code == 404 and "no matching results" in resp.text.lower():
                return None
            if resp.status_code == 404:
                raise DatasetMissing(url)
            log.warning("HTTP %d, attempt %d: %s", resp.status_code, attempt, url)
        if attempt < retries:
            time.sleep(delay)
            delay *= 2
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
