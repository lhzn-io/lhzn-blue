"""Saved copies of the server's datasets, in case they are withdrawn, renamed or rewritten.

The server has unpublished and renamed datasets before (the wave datasets for long stretches; the Execution
Rocks water-quality series in 2026), and it keeps only a few years of weather. Each run saves, under one
folder named for the download time:

- ``<DATASET>.csv.gz``: the dataset's whole record, exactly as the server's CSV returns it (requested a
  calendar year at a time over the dataset's own time range; one header row and one units row). Every
  column, except where the server fails on one (CLIS_MET's dew point): then the columns that work.
- ``<DATASET>.info.csv``: the dataset's metadata (variables, units, attributes).
- ``manifest.json``: per dataset the rows, time range, columns, size and SHA-256 (or why it is missing),
  plus the server's list of every dataset it publishes, so a rename or a withdrawal shows up between runs.

The datasets are every one stations.json names (published or not, so a return is caught) and every other
dataset the server lists for the same buoys. The writer only creates new objects in a new folder under its
own prefix and refuses to overwrite one; it never deletes.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from . import merlin
from .build import iso, load_stations, now_utc

log = logging.getLogger(__name__)

NAME = re.compile(r"[A-Za-z0-9_]{3,60}")
FILE = re.compile(r"[A-Za-z0-9_]{3,60}\.(csv\.gz|info\.csv)|manifest\.json")


def named_datasets() -> set[str]:
    """Every server dataset stations.json names."""
    names: set[str] = set()
    for st in load_stations()["stations"]:
        for ser in st.get("series", []):
            names.update(src["dataset"] for src in ser["sources"] if src.get("kind") == "merlin")
        for key in ("met", "turbidity", "waves"):
            ds = (st.get(key) or {}).get("dataset")
            if ds:
                names.add(ds)
    return names


def server_datasets() -> list[dict]:
    """The server's list: id, title and time range of every dataset it publishes."""
    resp = merlin._get(f"{merlin.BASE_URL}/tabledap/allDatasets.csv?datasetID,title,minTime,maxTime")
    df = pd.read_csv(io.StringIO(resp.text), skiprows=[1])
    return [r for r in json.loads(df.to_json(orient="records")) if r["datasetID"] != "allDatasets"]


def our_datasets(listed: list[dict]) -> list[str]:
    """Named datasets, plus every listed dataset for the same buoys (same prefix before the first underscore)."""
    named = named_datasets()
    prefixes = {n.split("_")[0] for n in named}
    extra = {d["datasetID"] for d in listed if d["datasetID"].split("_")[0] in prefixes}
    return sorted(n for n in named | extra if NAME.fullmatch(n))


class Sink:
    """Where a snapshot goes: a local directory, or a gs://bucket/prefix (create-only)."""

    def __init__(self, root: str, folder: str):
        if root.startswith("gs://"):
            from google.cloud import storage

            bucket, _, prefix = root[5:].partition("/")
            self.bucket = storage.Client().bucket(bucket)
            self.prefix = "/".join(p for p in (prefix.strip("/"), folder) if p)
            self.dir = None
        else:
            self.dir = Path(root) / folder
            self.dir.mkdir(parents=True, exist_ok=False)

    def put(self, name: str, data: bytes, content_type: str) -> None:
        if not FILE.fullmatch(name):
            raise ValueError(f"refusing to write {name}")
        if self.dir is not None:
            (self.dir / name).write_bytes(data)
            return
        blob = self.bucket.blob(f"{self.prefix}/{name}")
        blob.upload_from_string(data, content_type=content_type, if_generation_match=0)  # never overwrite


def _csv(ds: str, columns: list[str] | None, start: datetime, stop: datetime) -> str | None:
    query = ",".join(columns) if columns else ""
    url = f"{merlin.BASE_URL}/tabledap/{ds}.csv?{query}&time%3E={start:%Y-%m-%dT%H:%M:%SZ}&time%3C{stop:%Y-%m-%dT%H:%M:%SZ}"
    resp = merlin._get(url, retries=2)
    return resp.text if resp is not None else None


def _variables(info_text: str) -> list[str]:
    df = pd.read_csv(io.StringIO(info_text))
    return df.loc[df["Row Type"] == "variable", "Variable Name"].tolist()


def _working_columns(ds: str, variables: list[str], probe_end: datetime) -> list[str]:
    """The columns the server returns without error, each tried over one day."""
    start = probe_end - timedelta(days=1)
    ok = []
    for v in variables:
        try:
            _csv(ds, ["time", v] if v != "time" else ["time"], start, probe_end)
            ok.append(v)
        except Exception:
            log.warning("%s: the server fails on column %s; it is left out", ds, v)
    return ok


def _year_bounds(listed: dict | None, end: datetime) -> range:
    first = pd.Timestamp(listed["minTime"]).year if listed and listed.get("minTime") else 2004
    last = pd.Timestamp(listed["maxTime"]).year if listed and listed.get("maxTime") else end.year
    return range(first, min(last, end.year) + 1)


def save_dataset(sink: Sink, ds: str, listed: dict | None, end: datetime) -> dict:
    try:
        info = merlin._get(f"{merlin.BASE_URL}/info/{ds}/index.csv")
    except merlin.DatasetMissing:
        info = None
    if info is None:
        return {"dataset": ds, "published": False}
    sink.put(f"{ds}.info.csv", info.text.encode(), "text/csv")
    variables = _variables(info.text)
    columns: list[str] | None = None  # every column
    header: list[str] = []
    body = io.StringIO()
    rows = 0
    for year in _year_bounds(listed, end):
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        stop = min(datetime(year + 1, 1, 1, tzinfo=timezone.utc), end)
        try:
            text = _csv(ds, columns, start, stop)
        except RuntimeError:
            if columns is not None:
                raise
            probe_end = pd.Timestamp(listed["maxTime"]).to_pydatetime() if listed and listed.get("maxTime") else end
            columns = _working_columns(ds, variables, probe_end)
            text = _csv(ds, columns, start, stop)
        lines = (text or "").splitlines()
        if len(lines) <= 2:
            continue
        if not header:
            header = lines[:2]  # column names and units, once
        body.write("\n".join(lines[2:]) + "\n")
        rows += len(lines) - 2
    if not header:
        return {"dataset": ds, "published": True, "rows": 0}
    raw = ("\n".join(header) + "\n" + body.getvalue()).encode()
    packed = gzip.compress(raw, mtime=0)
    sink.put(f"{ds}.csv.gz", packed, "application/gzip")
    names = header[0].split(",")
    times = pd.read_csv(io.BytesIO(raw), skiprows=[1], usecols=["time"])["time"] if "time" in names else pd.Series([], dtype=str)
    log.info("%s: %d rows, %d bytes", ds, rows, len(packed))
    return {
        "dataset": ds,
        "published": True,
        "rows": rows,
        "first_time": times.min() if len(times) else None,
        "last_time": times.max() if len(times) else None,
        "columns": names,
        "left_out": [v for v in variables if columns is not None and v not in columns],
        "bytes": len(packed),
        "sha256": hashlib.sha256(packed).hexdigest(),
    }


def snapshot(root: str) -> dict:
    """Save every dataset under ``<root>/download_time=<UTC time>/`` and return the manifest."""
    end = now_utc()
    listed = server_datasets()
    by_id = {d["datasetID"]: d for d in listed}
    sink = Sink(root, f"download_time={end:%Y%m%d-%H%M%S}")
    files = []
    failed = []
    for ds in our_datasets(listed):
        try:
            files.append(save_dataset(sink, ds, by_id.get(ds), end))
        except Exception as exc:  # carry on with the rest; the manifest records the failure
            log.warning("snapshot of %s failed: %s", ds, exc)
            failed.append({"dataset": ds, "error": str(exc)[:200]})
    manifest = {"downloaded_at": iso(end), "server": merlin.BASE_URL, "files": files, "failed": failed, "server_datasets": listed}
    sink.put("manifest.json", json.dumps(manifest, indent=1).encode(), "application/json")
    return manifest
