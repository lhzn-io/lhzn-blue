"""Measured currents beside the shelf page's models: the OOI Coastal Pioneer Array's velocity profilers, per archived
day, into ``shelf/v1/days/<day>/obs.json`` (the R2 tile store) with an ``obs`` entry in the day's index.json.

Each profiler is screened (bins in the surface side-lobe band, speeds over MAX_SPEED, error velocity over EVL_MAX),
averaged to the models' hours (centered, +-30 min), and interpolated to the page's depths inside the range of its good
bins only. Each model's hourly values at each mooring come from the day's own model files (the cell holding the
mooring, as the page draws it) and are written beside the measurements, for the page's time series; the day's score,
per depth, is the vector RMS difference between each model and the moorings over the hours both hold.

The moorings live in stations/shelf-obs.json (LHZN_BLUE_SHELF_OBS): id, name, position and the span with data. A day
outside every span is skipped; a day the models have not archived is skipped too (``shelf-days`` first).
"""

from __future__ import annotations

import json
import logging
import math
import os
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from . import outages, shelf, tiles
from .build import Store

log = logging.getLogger(__name__)

ERDDAP_URL = "https://erddap.dataexplorer.oceanobservatories.org/erddap"
SOURCE = "Ocean Observatories Initiative (OOI), Coastal Pioneer Array, funded by the U.S. National Science Foundation"
COLUMNS = ["z", "eastward_sea_water_velocity", "northward_sea_water_velocity", "velprof_evl"]
DEPTHS = shelf.DEPTHS
MAX_SPEED = 2.5  # m/s: faster is a bad ensemble on this shelf
EVL_MAX = 0.15  # m/s error velocity (Aug 2022: p99 0.04 to 0.10 inshore, 0.27 to 0.29 offshore)
SIDELOBE = 0.06  # share of the instrument's depth lost under the surface (20 degree beams), plus one bin
MIN_PAIRS = 12  # hours a score needs, all moorings together
STEP = 3600


def moorings() -> list[dict]:
    path = os.environ.get("LHZN_BLUE_SHELF_OBS", Path(__file__).resolve().parents[3] / "stations" / "shelf-obs.json")
    return json.loads(Path(path).read_text())["moorings"]


def _server():
    from insitukit import erddap

    from .merlin import USER_AGENT

    return erddap.Erddap(ERDDAP_URL, budget=200, min_interval=1.0, connect_timeout=10, user_agent=USER_AGENT, retries=3, timeout=300)


def fetch(server, id_: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """One profiler's rows for start <= time < end: time, depth (positive down), u, v, evl."""
    df = server.fetch(f"ooi-{id_}", start.to_pydatetime(), end.to_pydatetime(), COLUMNS)
    return pd.DataFrame({"time": df["time"], "depth": -df["z"], "u": df["eastward_sea_water_velocity"],
                         "v": df["northward_sea_water_velocity"], "evl": df["velprof_evl"]})


def screen(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """The rows kept, and how many each screen removed. The instrument sits about one bin below its deepest good
    bin; bins shallower than SIDELOBE of that depth plus one bin are lost to the surface reflection."""
    ok = df["u"].notna() & df["v"].notna()
    counts = {"rows": int(len(df)), "missing": int((~ok).sum())}
    if not ok.any():
        return df[ok], counts
    first = df.loc[ok, "time"].iloc[0]
    bins = np.sort(df.loc[ok & (df["time"] == first), "depth"].to_numpy())
    dz = float(np.median(np.diff(bins))) if bins.size > 1 else 1.0
    top = SIDELOBE * (float(df.loc[ok, "depth"].max()) + dz) + dz
    shallow = ok & (df["depth"] < top)
    fast = ok & ~shallow & (np.hypot(df["u"], df["v"]) > MAX_SPEED)
    noisy = ok & ~shallow & ~fast & (df["evl"].abs() > EVL_MAX)
    counts.update(top_m=round(top, 1), near_surface=int(shallow.sum()), too_fast=int(fast.sum()), error_velocity=int(noisy.sum()))
    keep = ok & ~shallow & ~fast & ~noisy
    counts["kept"] = int(keep.sum())
    return df[keep], counts


def at_depths(df: pd.DataFrame, start: pd.Timestamp, hours: int = 24) -> dict[int, np.ndarray]:
    """(hours, 2) u, v per page depth, NaN where the hour has no profile or the depth lies outside its good bins."""
    out = {k: np.full((hours, 2), np.nan) for k in DEPTHS}
    if df.empty:
        return out
    hour = ((df["time"] + pd.Timedelta(minutes=30)).dt.floor("h") - start) // pd.Timedelta(hours=1)
    df = df.assign(j=hour)[(hour >= 0) & (hour < hours)]
    for j, p in df.groupby("j"):
        g = p.groupby("depth")[["u", "v"]].mean()
        z = g.index.to_numpy()
        if z.size < 2:
            continue
        for k in DEPTHS:
            if z[0] <= k <= z[-1]:
                out[k][int(j)] = np.interp(k, z, g["u"]), np.interp(k, z, g["v"])
    return out


def _tile_xy(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def _element(blob: dict, lon: float, lat: float) -> int:
    """The element containing the point (a four-node element as two triangles), or -1."""
    xy, el = blob["node_xy"].astype(np.float64), blob["elements_ix"].astype(np.int64)
    p = np.array([lon, lat])
    for tri in ((el[:, [0, 1, 2]], el[:, [0, 2, 3]]) if el.shape[1] == 4 else (el,)):
        a, b, c = xy[tri[:, 0]], xy[tri[:, 1]], xy[tri[:, 2]]
        v0, v1, v2 = c - a, b - a, p - a
        d00, d01, d02, d11, d12 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v0 * v2).sum(1), (v1 * v1).sum(1), (v1 * v2).sum(1)
        den = d00 * d11 - d01 * d01
        with np.errstate(divide="ignore", invalid="ignore"):
            s, t = (d11 * d02 - d01 * d12) / den, (d00 * d12 - d01 * d02) / den
        hit = np.flatnonzero((den != 0) & (s >= 0) & (t >= 0) & (s + t <= 1))
        if hit.size:
            return int(hit[0])
    return -1


def model_at(ts: tiles.TileStore, entry: dict, lon: float, lat: float) -> np.ndarray | None:
    """(steps, 2) u, v of the model cell holding the point, from a day's entry for one layer: the native tile pack
    when there is one (NECOFS), else the wide file (DOPPIO's own cells). The page draws the same files."""
    if "pack" in entry and "tiles" in entry:
        pack = None
        for key, (off, length, _) in entry["tiles"].items():
            z, x, y = (int(s) for s in key.split("/"))
            if (x, y) != _tile_xy(lon, lat, z):
                continue
            pack = pack if pack is not None else ts.get(f"{shelf.BASE}/{entry['pack']}")
            if pack is None:
                return None
            blob = tiles.decode(pack[off : off + length])
            i = _element(blob, lon, lat)
            if i >= 0:
                return np.stack([blob["u"][:, i], blob["v"][:, i]], axis=1)
        return None
    raw = ts.get(f"{shelf.BASE}/{entry['wide']}")
    if raw is None:
        return None
    blob = tiles.decode(raw)
    i = _element(blob, lon, lat)
    return np.stack([blob["u"][:, i], blob["v"][:, i]], axis=1) if i >= 0 else None


def scores(measured: dict[str, dict[int, np.ndarray]], modeled: dict[str, dict[str, dict[int, np.ndarray]]]) -> dict:
    """Per depth and model, the vector RMS difference (m/s) over every mooring hour both hold."""
    out: dict = {}
    for k in DEPTHS:
        row: dict = {}
        for model, by_id in modeled.items():
            d = [m[k] - measured[i][k] for i, m in by_id.items() if k in m and k in measured.get(i, {})]
            if not d:
                continue
            d = np.concatenate(d)
            d = d[np.isfinite(d).all(axis=1)]
            if len(d) >= MIN_PAIRS:
                row[model] = {"rms": round(float(np.sqrt((d**2).sum(axis=1).mean())), 3), "n": int(len(d))}
        if row:
            row["moorings"] = sum(1 for i in measured if np.isfinite(measured[i][k]).all(axis=1).any())
            out[str(k)] = row
    return out


def _r(a: np.ndarray) -> list:
    return [None if not np.isfinite(r).all() else [round(float(r[0]), 3), round(float(r[1]), 3)] for r in a]


def publish_day(ts: tiles.TileStore, day: pd.Timestamp, frames: dict[str, pd.DataFrame], stations: dict[str, dict]) -> bool:
    """One archived day's obs.json and its index entry; False when the day is not archived or holds no measurement."""
    rel = f"days/{day:%Y-%m-%d}"
    raw = ts.get(f"{shelf.BASE}/{rel}/index.json")
    if raw is None:
        return False
    index = json.loads(raw)
    measured = {i: at_depths(df[(df["time"] >= day - timedelta(minutes=30)) & (df["time"] < day + timedelta(hours=24, minutes=30))], day)
                for i, df in frames.items()}
    measured = {i: m for i, m in measured.items() if any(np.isfinite(a).any() for a in m.values())}
    if not measured:
        return False
    modeled: dict = {}
    for model in ("necofs", "doppio"):
        ent = index.get("models", {}).get(model, {})
        for k in DEPTHS:
            layer = ent.get("depths", {}).get(str(k))
            if not layer or layer.get("steps") != 24:
                continue
            for i in measured:
                if not np.isfinite(measured[i][k]).any():
                    continue
                s = stations[i]
                got = model_at(ts, layer, s["lon"], s["lat"])
                if got is not None and len(got) == 24:
                    modeled.setdefault(model, {}).setdefault(i, {})[k] = got
    doc = {
        "schema": 1,
        "day": f"{day:%Y-%m-%d}",
        "t0": f"{day:%Y-%m-%dT%H:%M:%SZ}",
        "step": STEP,
        "source": SOURCE,
        "url": ERDDAP_URL,
        "moorings": [
            {"id": i.upper(), "name": stations[i]["name"], "lon": stations[i]["lon"], "lat": stations[i]["lat"],
             "uv": {str(k): _r(a) for k, a in m.items() if np.isfinite(a).any()},
             "models": {model: {str(k): _r(a) for k, a in sorted(by_id[i].items())} for model, by_id in modeled.items() if i in by_id}}
            for i, m in measured.items()
        ],
        "scores": scores(measured, modeled),
    }
    ts.put(f"{shelf.BASE}/{rel}/obs.json", json.dumps(doc, separators=(",", ":")).encode(), shelf.DAY_S, "application/json")
    for m in doc["moorings"]:
        if not m["models"]:
            del m["models"]
    held = sorted({int(k) for m in doc["moorings"] for k in m["uv"]})
    index["obs"] = {"file": f"{rel}/obs.json", "source": SOURCE, "moorings": len(doc["moorings"]), "depths": held}
    ts.put(f"{shelf.BASE}/{rel}/index.json", json.dumps(index, separators=(",", ":")).encode(), shelf.LATEST_S, "application/json")
    return True


def backfill(store: Store, first: str, last: str, ts: tiles.TileStore | None = None, server=None) -> list[str]:
    """Measured currents for archived days `first` to `last` (inclusive, at most shelf.BACKFILL_MAX_DAYS)."""
    ts = ts or tiles.store_for(store.root)
    if ts is None:
        return ["shelf obs: no tile store configured (LHZN_BLUE_TILES)"]
    a, b = pd.Timestamp(first, tz="UTC"), pd.Timestamp(last, tz="UTC")
    if b < a or (b - a).days + 1 > shelf.BACKFILL_MAX_DAYS:
        raise ValueError(f"shelf obs: {first} to {last} is not 1 to {shelf.BACKFILL_MAX_DAYS} days")
    stations = {m["id"]: m for m in moorings()}
    server = server or _server()
    failed: list[str] = []
    frames: dict[str, pd.DataFrame] = {}
    for i, s in stations.items():
        lo, hi = max(a, pd.Timestamp(s["first"], tz="UTC")), min(b + pd.Timedelta(days=1), pd.Timestamp(s["last"], tz="UTC"))
        if hi <= lo:
            continue
        try:
            kept, counts = screen(fetch(server, i, lo - pd.Timedelta(minutes=30), hi + pd.Timedelta(minutes=30)))
            log.info("shelf obs %s: %s", i, counts)
            frames[i] = kept
        except Exception as exc:
            outages.record(failed, f"shelf obs {i}", exc, log)
    written = 0
    for day in pd.date_range(a, b, freq="D"):
        try:
            written += publish_day(ts, day, frames, stations)
        except Exception as exc:
            outages.record(failed, f"shelf obs {day:%Y-%m-%d}", exc, log)
    log.info("shelf obs: %d of %d days written", written, (b - a).days + 1)
    return failed
