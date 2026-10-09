"""Build the published JSON: hourly series per station and depth, a live window, and metadata.

Everything is binned in UTC. An hourly value is the mean of the observations that passed QC in
``[hour, hour + 1)``. Rolling means and comparisons are computed by the web page, not here.

Published layout (under ``<root>/v1/``):

- ``history.json``: metadata (stations, sources, record starts, QC rules) and the full hourly record
  of every series' water temperature in degrees F, rebuilt daily. The page's first view needs only this
  file and ``live.json``.
- ``history-salinity.json``, ``history-oxygen.json``: the same hourly record for salinity and dissolved
  oxygen (mg/L), rebuilt with it; the page loads them only when a reader switches to that variable.
- ``live.json``: the last 45 days, hourly, of every variable, plus the latest raw observation per series,
  the buoy weather and waves (100 days; see waves.py); refreshed hourly.
- ``archive/<STATION>_<DEPTH>.json``: hourly series converted once from our own snapshots of
  datasets the server no longer publishes under their original names. Read by the history build;
  not served to the page.
"""

from __future__ import annotations

import functools
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import numpy as np
import pandas as pd

from . import merlin

log = logging.getLogger(__name__)

SCHEMA = 1
LIVE_WINDOW_HOURS = 45 * 24
LIVE_FETCH_HOURS = 72
MET_WINDOW_HOURS = 100 * 24
# Water variables: published name, server column, unit, decimals. Temperature is converted to F; the
# others are published in their own units (salinity on the practical scale, oxygen in mg/L).
VARS = {
    "temp": ("sea_water_temperature", "degF", 1),
    "salinity": ("sea_water_salinity", "psu", 2),
    "oxygen": ("oxygen_concentration_in_sea_water", "mg/L", 2),
}
EXTRA_VARS = [v for v in VARS if v != "temp"]
# Gross-range QC (alpha). Values outside these bounds are dropped before averaging.
QC_RANGES = {
    "sea_water_temperature": (-2.0, 35.0),
    "sea_water_salinity": (5.0, 36.0),
    "oxygen_concentration_in_sea_water": (0.0, 20.0),
}
# Spike test (alpha): a reading is dropped when it departs from the median of its neighbours (13
# readings centred on it, about 3 hours at 15-minute sampling) by more than this. Excursions shorter
# than about 1.5 hours are removed; real step changes (fronts, turnover) pass, because the median
# follows a step within half the window.
SPIKE_WINDOW = 13
SPIKE_LIMITS = {
    "sea_water_temperature": 1.5,
    "sea_water_salinity": 1.5,
    "oxygen_concentration_in_sea_water": 2.0,
}
QC_DESCRIPTION = (
    "Gross-range checks (temperature -2 to 35 C, salinity 5 to 36, dissolved oxygen 0 to 20 mg/L), narrowed "
    "where the waterway sets its own range ({local}); a spike test (a reading more than 1.5 C, 1.5 salinity or "
    "2 mg/L from the median of the 13 readings around it, about 3 hours, is dropped); and a placeholder test (a "
    "run of whole-number readings across those 13 is dropped: real sensor values carry decimals, and the server "
    "has published day counts in a salinity column). Flat-line tests are not yet applied."
)
# Buoy weather (the *_MET datasets): named columns only (CLIS_MET fails when its dew point column is
# requested). Wind is in knots; air temperature in C; pressure in mbar. Gross-range checks only: a spike
# test would remove real gusts.
MET_COLUMNS = ["air_temperature", "barometric_pressure", "wind_gust", "wind_speed", "wind_direction"]
MET_RANGES = {
    "air_temperature": (-30.0, 45.0),
    "barometric_pressure": (900.0, 1080.0),
    "wind_gust": (0.0, 150.0),
    "wind_speed": (0.0, 100.0),
    "wind_direction": (0.0, 360.0),
}
# Every object the jobs may write. Anything else is refused (see Store.write_json).
WRITABLE = re.compile(
    r"v1/(history|history-salinity|history-oxygen|history-waves|live|shore|shore-history|rivers|rivers-history)\.json"
    r"|v1/archive/[A-Z]{3,5}_(SFC|MID|BTM|WAVE)\.json"
)
MAX_OBJECT_BYTES = 8 * 1024 * 1024
STATIONS_FILE = Path(
    os.environ.get("LHZN_BLUE_STATIONS", Path(__file__).resolve().parents[3] / "stations" / "stations.json")
)


# ---------------------------------------------------------------------------------------------
# Storage: a local directory, Cloudflare Workers KV (kv://<account_id>/<namespace_id>, token in
# CLOUDFLARE_API_TOKEN), or a gs:// prefix.

KV_API = "https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{ns}/values/{key}"


class Store:
    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self._bucket = None
        self._kv = None
        if self.root.startswith("kv://"):
            import requests

            account, _, ns = self.root[5:].partition("/")
            token = os.environ["CLOUDFLARE_API_TOKEN"].strip()
            self._kv = (account, ns, requests.Session())
            self._kv[2].headers["Authorization"] = f"Bearer {token}"
        elif self.root.startswith("gs://"):
            from google.cloud import storage

            bucket, _, prefix = self.root[5:].partition("/")
            self._bucket = storage.Client().bucket(bucket)
            self._prefix = prefix

    def _blob(self, rel: str):
        name = f"{self._prefix}/{rel}" if self._prefix else rel
        return self._bucket.blob(name)

    def _kv_url(self, rel: str) -> str:
        account, ns, _ = self._kv
        return KV_API.format(account=account, ns=ns, key=quote(rel, safe=""))

    def read_json(self, rel: str) -> dict | None:
        if self._kv is not None:
            resp = self._kv[2].get(self._kv_url(rel), timeout=60)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
        if self._bucket is not None:
            blob = self._blob(rel)
            return json.loads(blob.download_as_text()) if blob.exists() else None
        path = Path(self.root) / rel
        return json.loads(path.read_text()) if path.exists() else None

    def write_json(self, rel: str, obj: dict, max_age: int) -> None:
        # Cost guard: only a fixed set of object names, each bounded in size, so a misbehaving loop can
        # rewrite the same few objects but never multiply them.
        if not WRITABLE.fullmatch(rel):
            raise ValueError(f"refusing to write unexpected object name: {rel}")
        text = json.dumps(obj, separators=(",", ":"), allow_nan=False)
        if len(text) > MAX_OBJECT_BYTES:
            raise ValueError(f"refusing to write {rel}: {len(text)} bytes exceeds {MAX_OBJECT_BYTES}")
        if self._kv is not None:
            resp = self._kv[2].put(
                self._kv_url(rel), data=text.encode(), headers={"Content-Type": "application/json"}, timeout=120
            )
            resp.raise_for_status()
        elif self._bucket is not None:
            blob = self._blob(rel)
            blob.cache_control = f"public, max-age={max_age}"
            blob.upload_from_string(text, content_type="application/json")
        else:
            path = Path(self.root) / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        log.info("wrote %s/%s (%d bytes)", self.root, rel, len(text))


# ---------------------------------------------------------------------------------------------
# Helpers


def load_stations() -> dict:
    return json.loads(STATIONS_FILE.read_text())


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(ts: datetime | pd.Timestamp) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


@functools.lru_cache(maxsize=1)
def local_ranges() -> dict[str, tuple[float, float]]:
    """The waterway's own ranges (stations.json ``waterway.qc_ranges``), where narrower than the gross ones."""
    return {k: (float(lo), float(hi)) for k, (lo, hi) in load_stations()["waterway"].get("qc_ranges", {}).items()}


def qc_description() -> str:
    local = "; ".join(f"{k.replace('sea_water_', '').replace('_', ' ')} {lo:g} to {hi:g}" for k, (lo, hi) in local_ranges().items())
    return QC_DESCRIPTION.format(local=local or "none")


def qc(df: pd.DataFrame) -> pd.DataFrame:
    """Range tests, a rolling-median spike test and a placeholder test, per variable (failures become NaN)."""
    df = df.sort_values("time").drop_duplicates("time").reset_index(drop=True)
    local = local_ranges()
    for col, (lo, hi) in QC_RANGES.items():
        if col not in df.columns:
            continue
        lo, hi = local.get(col, (lo, hi))
        x = pd.to_numeric(df[col], errors="coerce")
        x[(x < lo) | (x > hi)] = np.nan
        # Placeholders: every reading in the window a whole number.
        whole = (x == x.round()).astype(float).where(x.notna())
        x[whole.rolling(SPIKE_WINDOW, center=True, min_periods=5).min() == 1] = np.nan
        med = x.rolling(SPIKE_WINDOW, center=True, min_periods=5).median()
        x[(x - med).abs() > SPIKE_LIMITS[col]] = np.nan
        df[col] = x
    return df


def hourly(df: pd.DataFrame, col: str = "sea_water_temperature") -> pd.Series:
    """Hourly UTC means of ``col`` (left-labelled), after QC."""
    if df.empty or col not in df.columns:
        return pd.Series(dtype=float)
    s = qc(df).set_index("time")[col].dropna()
    if s.empty:
        return s
    return s.resample("h").mean().dropna()


def c_to_f(values: pd.Series) -> pd.Series:
    return values * 9.0 / 5.0 + 32.0


def encode(series_c: pd.Series, unit: str = "degF", decimals: int | None = None) -> dict:
    """Continuous hourly array from the first to the last valid hour; gaps are null. Temperatures arrive
    in C and are converted when ``unit`` is degF; other units are written as given."""
    if series_c.empty:
        return {"t0": None, "step": 3600, "unit": unit, "values": []}
    full = series_c.reindex(pd.date_range(series_c.index[0], series_c.index[-1], freq="h"))
    vals = c_to_f(full) if unit == "degF" else full
    places = decimals if decimals is not None else (1 if unit == "degF" else 3)
    out = [None if pd.isna(v) else round(float(v), places) for v in vals]
    return {"t0": iso(full.index[0]), "step": 3600, "unit": unit, "values": out}


def encode_var(series: pd.Series, var: str) -> dict:
    _, unit, places = VARS[var]
    return encode(series, unit=unit, decimals=places)


def decode(obj: dict | None, to_c: bool = True) -> pd.Series:
    if not obj or not obj.get("t0") or not obj.get("values"):
        return pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))
    idx = pd.date_range(pd.Timestamp(obj["t0"]), periods=len(obj["values"]), freq="h")
    s = pd.Series([np.nan if v is None else v for v in obj["values"]], index=idx, dtype=float)
    if to_c and obj.get("unit") == "degF":
        s = (s - 32.0) * 5.0 / 9.0
    return s.dropna()


def merlin_columns(dataset: str) -> list[str]:
    available = set(merlin.variables(dataset))
    return [c for c in merlin.OBS_COLUMNS if c in available]


def depths(df: pd.DataFrame) -> list[float]:
    if "depth" not in df.columns:
        return []
    return sorted({round(float(d), 2) for d in pd.to_numeric(df["depth"], errors="coerce").dropna().unique()})


# ---------------------------------------------------------------------------------------------
# Jobs


def met_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Hourly weather: mean wind, peak gust, speed-weighted mean direction, mean air temperature (F) and pressure."""
    cols = ["wind_kt", "gust_kt", "dir_deg", "air_f", "pressure_mb"]
    if df.empty:
        return pd.DataFrame(columns=cols, index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    df = df.sort_values("time").drop_duplicates("time").set_index("time")
    for col, (lo, hi) in MET_RANGES.items():
        if col in df.columns:
            x = pd.to_numeric(df[col], errors="coerce")
            df[col] = x.where((x >= lo) & (x <= hi))
    rad = np.deg2rad(df["wind_direction"])
    w = df["wind_speed"].fillna(0)
    east = (w * np.sin(rad)).resample("h").sum(min_count=1)
    north = (w * np.cos(rad)).resample("h").sum(min_count=1)
    out = pd.DataFrame(
        {
            "wind_kt": df["wind_speed"].resample("h").mean(),
            "gust_kt": df["wind_gust"].resample("h").max(),
            "dir_deg": (np.rad2deg(np.arctan2(east, north)) + 360) % 360,
            "air_f": c_to_f(df["air_temperature"].resample("h").mean()),
            "pressure_mb": df["barometric_pressure"].resample("h").mean(),
        }
    )
    return out.dropna(how="all")


def encode_frame(frame: pd.DataFrame, decimals: dict[str, int] | None = None) -> dict:
    """Several hourly columns on one continuous grid, rounded to 0.1 (or per column); gaps are null."""
    if frame.empty:
        return {"t0": None, "step": 3600}
    full = frame.reindex(pd.date_range(frame.index[0], frame.index[-1], freq="h"))
    out: dict = {"t0": iso(full.index[0]), "step": 3600}
    for col in full.columns:
        places = (decimals or {}).get(col, 1)
        out[col] = [None if pd.isna(v) else round(float(v), places) for v in full[col]]
    return out


def decode_frame(obj: dict | None) -> pd.DataFrame:
    if not obj or not obj.get("t0"):
        return pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    cols = [k for k, v in obj.items() if isinstance(v, list)]
    idx = pd.date_range(pd.Timestamp(obj["t0"]), periods=len(obj[cols[0]]), freq="h") if cols else []
    return pd.DataFrame({c: pd.to_numeric(pd.Series(obj[c], index=idx), errors="coerce") for c in cols}).dropna(how="all")


def last_observation(df: pd.DataFrame) -> dict | None:
    """The latest reading whose temperature passed QC, with its other variables."""
    good = qc(df).dropna(subset=["sea_water_temperature"]) if "sea_water_temperature" in df.columns else df.iloc[0:0]
    if good.empty:
        return None
    row = good.iloc[-1]
    return {
        "time": iso(row["time"]),
        "depth_m": None if pd.isna(row.get("depth")) else round(float(row["depth"]), 2),
        "temperature_c": _num(row.get("sea_water_temperature")),
        "salinity": _num(row.get("sea_water_salinity")),
        "oxygen_mg_l": _num(row.get("oxygen_concentration_in_sea_water")),
    }


def import_archive(store: Store, archive_dir: Path, vintage: str | None = None) -> None:
    """One-time: convert archived HDF5 snapshots for ``kind: archive`` sources into hourly JSON.

    Each source names its snapshot folder in stations.json (``snapshot``); ``vintage`` is the fallback.
    """
    from .archive import read_snapshot

    for st in load_stations()["stations"]:
        for ser in st["series"]:
            for src in ser["sources"]:
                if src["kind"] != "archive":
                    continue
                snap = src.get("snapshot") or vintage
                if not snap:
                    raise ValueError(f"no snapshot for {src['dataset']}; set it in stations.json or pass --vintage")
                df = read_snapshot(archive_dir / snap / f"{src['dataset']}.h5")
                obj = encode(hourly(df), unit="degC")
                # Salinity and oxygen ride along in the same file, one hourly array each.
                for var in EXTRA_VARS:
                    obj[var] = encode(hourly(df, VARS[var][0]), unit=VARS[var][1], decimals=3)
                obj.update(
                    {
                        "schema": SCHEMA,
                        "dataset": src["dataset"],
                        "snapshot": snap,
                        "depth_m": depths(df),
                        "first_obs": iso(df["time"].min()),
                        "last_obs": iso(df["time"].max()),
                        "last_values": last_observation(df),
                    }
                )
                store.write_json(f"v1/archive/{st['id']}_{ser['depth']}.json", obj, max_age=86400)


def history_file(var: str) -> str:
    return "v1/history.json" if var == "temp" else f"v1/history-{var}.json"


def history(store: Store, first_year: int = 2010) -> None:
    """Rebuild every series, for every water variable, from the server plus archived history."""
    end = now_utc()
    stations = load_stations()
    meta_stations = []
    out: dict[str, dict] = {var: {} for var in VARS}  # var -> key -> encoded series
    prev = store.read_json("v1/history.json") or {}
    prev_series = {"temp": prev.get("series", {})}
    for var in EXTRA_VARS:
        prev_series[var] = (store.read_json(history_file(var)) or {}).get("series", {})
    prev_meta = {s["key"]: s for st in prev.get("meta", {}).get("stations", []) for s in st.get("series", [])}
    prev_live = (store.read_json("v1/live.json") or {}).get("series", {})
    for st in stations["stations"]:
        meta_series = []
        for ser in st["series"]:
            key = f"{st['id']}_{ser['depth']}"
            parts: dict[str, list[pd.Series]] = {var: [] for var in VARS}  # source order; later sources win
            sources_meta = []
            depth_m: set[float] = set()
            archived_last = None
            published = False
            for src in ser["sources"]:
                if src["kind"] == "archive":
                    obj = store.read_json(f"v1/archive/{key}.json")
                    if obj is None:
                        log.warning("no archive file for %s; run import-archive first", key)
                        continue
                    parts["temp"].append(decode(obj))
                    for var in EXTRA_VARS:
                        parts[var].append(decode(obj.get(var)))
                    depth_m.update(obj.get("depth_m", []))
                    archived_last = obj.get("last_values")
                    sources_meta.append(
                        {
                            "kind": "archive",
                            "dataset": src["dataset"],
                            "first_obs": obj.get("first_obs"),
                            "last_obs": obj.get("last_obs"),
                            "note": src.get("note"),
                        }
                    )
                else:
                    # Keep asking for every listed dataset, so a series the server stops publishing is picked
                    # up again automatically if it returns.
                    try:
                        df = merlin.fetch_years(src["dataset"], first_year, end, merlin_columns(src["dataset"]))
                    except merlin.DatasetMissing:
                        log.warning("%s is not published on the server", src["dataset"])
                        sources_meta.append({"kind": "merlin", "dataset": src["dataset"], "published": False})
                        continue
                    except Exception as exc:  # server trouble: keep what we already hold (below)
                        log.warning("history fetch failed for %s: %s", src["dataset"], exc)
                        sources_meta.append({"kind": "merlin", "dataset": src["dataset"], "published": True, "error": str(exc)[:200]})
                        published = True
                        continue
                    published = True
                    for var, (col, _, _) in VARS.items():
                        parts[var].append(hourly(df, col))
                    depth_m.update(depths(df))
                    sources_meta.append(
                        {
                            "kind": "merlin",
                            "dataset": src["dataset"],
                            "published": True,
                            "first_obs": iso(df["time"].min()) if not df.empty else None,
                            "last_obs": iso(df["time"].max()) if not df.empty else None,
                        }
                    )
            var_meta = {}
            for var in VARS:
                combined = pd.Series(dtype=float)
                for part in parts[var]:
                    if part.empty:
                        continue
                    combined = part.combine_first(combined) if not combined.empty else part
                # Never lose an hour we already hold: what the server serves today wins, and anything it no
                # longer serves (a dropped or renamed dataset, a failed fetch) is kept from the previous build.
                before = decode(prev_series[var].get(key))
                if not before.empty:
                    combined = combined.combine_first(before) if not combined.empty else before
                enc = encode_var(combined.sort_index(), var)
                enc.update({"schema": SCHEMA, "station": st["id"], "depth": ser["depth"], "generated_at": iso(end)})
                out[var][key] = enc
                if var != "temp":
                    var_meta[var] = {"record_start": enc["t0"], "hours": len(enc["values"])}
            obj = out["temp"][key]
            # The last reading of a series that is not published now: from the live window if we saw it
            # there, else from the previous build or the archive.
            last_obs = None
            if not published:
                last_obs = (
                    (prev_live.get(key) or {}).get("last_obs")
                    or (prev_meta.get(key) or {}).get("archived_last_obs")
                    or archived_last
                )
            meta_series.append(
                {
                    "key": key,
                    "depth": ser["depth"],
                    "label": ser["label"],
                    "depth_m": sorted(depth_m | set((prev_meta.get(key) or {}).get("depth_m", []))),
                    "record_start": obj["t0"],
                    "hours": len(obj["values"]),
                    "sources": sources_meta,
                    "live": published,  # the server publishes this series now
                    "archived_last_obs": last_obs,
                    "vars": var_meta,  # record start and length of salinity and oxygen
                }
            )
        meta_stations.append(
            {k: st[k] for k in ("id", "name", "operator", "lat", "lon")}
            | {k: st.get(k) for k in ("note", "outage_note", "info_url")}
            | {"series": meta_series}
        )
    meta = {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "waterway": stations["waterway"],
        "stations": meta_stations,
        "qc": qc_description(),
        "server": merlin.BASE_URL,
    }
    # The variable files first: a reader who sees the new history.json can always load the matching ones.
    for var in EXTRA_VARS:
        _, unit, _ = VARS[var]
        store.write_json(
            history_file(var),
            {"schema": SCHEMA, "generated_at": iso(end), "var": var, "unit": unit, "series": out[var]},
            max_age=3600,
        )
    store.write_json("v1/history.json", {"schema": SCHEMA, "meta": meta, "series": out["temp"]}, max_age=3600)


def live(store: Store, full: bool = False) -> None:
    """Refresh the 45-day hourly window and the latest observation for every series with a server source.

    ``full`` refetches the whole window instead of the last 72 hours (use after a QC change).
    """
    end = now_utc()
    prev = {} if full else (store.read_json("v1/live.json") or {})
    prev_vars = {"temp": prev.get("series", {})} | {var: prev.get(var, {}) for var in EXTRA_VARS}
    prev_datasets = prev.get("datasets", {})
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=LIVE_WINDOW_HOURS)
    out_vars: dict[str, dict] = {var: {} for var in VARS}
    out_datasets: dict = {}
    for st in load_stations()["stations"]:
        for ser in st["series"]:
            key = f"{st['id']}_{ser['depth']}"
            server = [s for s in ser["sources"] if s["kind"] == "merlin"]
            if not server:  # archive only: nothing to refresh
                continue
            windows = {var: decode(prev_vars[var].get(key)) for var in VARS}
            last_obs = prev_vars["temp"].get(key, {}).get("last_obs")
            ds = server[-1]["dataset"]
            status = dict(prev_datasets.get(ds, {}))
            # The short fetch only when every variable already has a window (a new variable starts full).
            held = key in prev_vars["temp"] and all(key in prev_vars[var] for var in EXTRA_VARS)
            fetch_hours = LIVE_FETCH_HOURS if held else LIVE_WINDOW_HOURS
            try:
                cols = merlin_columns(ds)
                df = merlin.fetch(ds, end - timedelta(hours=fetch_hours), end + timedelta(hours=1), cols)
                for var, (col, _, _) in VARS.items():
                    fresh = hourly(df, col)
                    if not fresh.empty:
                        windows[var] = fresh.combine_first(windows[var]) if not windows[var].empty else fresh
                last_obs = last_observation(df) or last_obs
                status.update({"last_ok": iso(end), "rows": int(len(df))})
                status.pop("last_error", None)
            except Exception as exc:  # keep the last good values; record the failure
                log.warning("live fetch failed for %s: %s", ds, exc)
                status.update({"last_error": f"{iso(end)} {exc.__class__.__name__}: {str(exc)[:200]}"})
            for var, window in windows.items():
                window = window[window.index >= window_start]
                out_vars[var][key] = encode_var(window, var)
            out_vars["temp"][key].update({"last_obs": last_obs, "dataset": ds})
            out_datasets[ds] = status
    out_met = live_met(prev.get("met", {}), prev_datasets, out_datasets, end)
    from . import waves  # imported here: waves builds on this module

    out_waves = waves.live(prev.get("waves", {}), prev_datasets, out_datasets, end, store)
    store.write_json(
        "v1/live.json",
        {"schema": SCHEMA, "generated_at": iso(end), "series": out_vars["temp"]}
        | {var: out_vars[var] for var in EXTRA_VARS}
        | {"met": out_met, "waves": out_waves, "datasets": out_datasets},
        max_age=300,
    )


def live_met(prev_met: dict, prev_datasets: dict, out_datasets: dict, end) -> dict:
    """The hourly weather window per station (wind, gusts, direction, air temperature, pressure).

    It spans MET_WINDOW_HOURS, enough to share a time axis with the page's year comparison (96 days back).
    """
    out: dict = {}
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=MET_WINDOW_HOURS)
    for st in load_stations()["stations"]:
        ds = (st.get("met") or {}).get("dataset")
        if not ds:
            continue
        before = prev_met.get(st["id"], {})
        fetch_hours = LIVE_FETCH_HOURS if before.get("t0") else MET_WINDOW_HOURS
        window = decode_frame(before)
        last_obs = before.get("last_obs")
        status = dict(prev_datasets.get(ds, {}))
        try:
            df = merlin.fetch(ds, end - timedelta(hours=fetch_hours), end + timedelta(hours=1), MET_COLUMNS)
            fresh = met_hourly(df)
            window = fresh.combine_first(window) if not window.empty else fresh
            good = df.dropna(subset=["wind_speed"]) if not df.empty else df
            if not good.empty:
                row = good.sort_values("time").iloc[-1]
                last_obs = {
                    "time": iso(row["time"]),
                    "wind_kt": _num(row["wind_speed"]),
                    "gust_kt": _num(row["wind_gust"]),
                    "dir_deg": _num(row["wind_direction"]),
                    "air_f": _num(float(row["air_temperature"]) * 9 / 5 + 32) if pd.notna(row["air_temperature"]) else None,
                    "pressure_mb": _num(row["barometric_pressure"]),
                }
            status.update({"last_ok": iso(end), "rows": int(len(df))})
            status.pop("last_error", None)
        except Exception as exc:  # keep the last good values; record the failure
            log.warning("live weather fetch failed for %s: %s", ds, exc)
            status.update({"last_error": f"{iso(end)} {exc.__class__.__name__}: {str(exc)[:200]}"})
        if not window.empty:
            window = window[window.index >= window_start]
        obj = encode_frame(window)
        obj.update({"last_obs": last_obs, "dataset": ds})
        out[st["id"]] = obj
        out_datasets[ds] = status
    return out


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else round(f, 3)
