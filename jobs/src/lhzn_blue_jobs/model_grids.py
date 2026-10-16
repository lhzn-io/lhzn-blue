"""10 m wind over the Sound for the next 48 hours on four models' own grids, for the "Wind models compared" page.

Frames every ``FRAME_H`` hours from the next 3-hourly hour out to ``HOURS_AHEAD`` hours ahead. For each model, every
frame comes from the newest run that reaches it, with no regridding:

- HRRR (NOAA, 3 km Lambert grid): taken from ``v1/fields/hrrr-wind.json``, which the HRRR grid job writes just
  before this one in the same run (its cells, newest cycle per hour, and the same int8 encoding). No download here.
- ICON (DWD, global R03B07, about 13 km triangles; CC BY 4.0): the 10 m wind files from opendata.dwd.de, each a
  bzip2 GRIB2 of the whole globe on the unstructured grid. The cells over the box, and their triangles, come from
  ``stations/icon-lis-cells.json`` (cut once from DWD's grid file ``icon_grid_0026_R03B07_G.nc``).
- ECMWF IFS open data (0.25 degree; CC BY 4.0): the newest 00 or 12 UTC run, the ``10u``/``10v`` messages by byte
  range from data.ecmwf.int.
- GFS (NOAA, 0.25 degree): ``pgrb2.0p25`` from ``noaa-gfs-bdp-pds`` by byte range.

Requests to data.ecmwf.int and opendata.dwd.de go one at a time, at least ``POLITE_GAP_S`` apart. The newest run of
a model is the newest whose file for the last frame is published (HEAD or exists checks only), so a run still being
posted is not used. The previous file is read back: a frame is downloaded only when it is new to the window or a
newer run is available. When nothing is new, nothing is downloaded or written.

Published layout (``v1/fields/model-grids.json``): ``{schema, generated_at, box, encoding, times, models}``. Each
model: ``{id, label, grid_label, spacing_km, source, attribution, grid, frames}``. ``grid`` is
``{type: "quads", nx, ny, lon, lat}`` (cell corners, (ny+1) x (nx+1), row-major from the south-west) or
``{type: "tri", n, tri}`` (per cell its three vertices as lon, lat: 6 numbers). ``frames``:
``{valid_time, issue_time, lead_h, u, v}``, with ``u`` and ``v`` (east and north, m/s) per cell as int8 in steps of
``encoding.step``, base64.
"""

from __future__ import annotations

import base64
import bz2
import json
import logging
import os
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

KEY = "v1/fields/model-grids.json"
HRRR_KEY = "v1/fields/hrrr-wind.json"
BOX = (-74.4, 40.3, -71.4, 41.7)  # lon_min, lat_min, lon_max, lat_max
FRAME_H = 3
HOURS_AHEAD = 48
STEP = 0.25  # m/s per int8 unit

UA = {"User-Agent": "lhzn-blue-ingest/0.2 (+https://longhorizon.blue; hello@longhorizon.blue)"}
TIMEOUT = (10, 60)
POLITE_GAP_S = 1.0
ECMWF_BASE = "https://data.ecmwf.int/forecasts"
ICON_BASE = "https://opendata.dwd.de/weather/nwp/icon/grib"
GFS_BUCKET = "noaa-gfs-bdp-pds"

ICON_CELLS = Path(
    os.environ.get(
        "LHZN_BLUE_ICON_CELLS",
        Path(os.environ.get("LHZN_BLUE_STATIONS", Path(__file__).resolve().parents[3] / "stations" / "stations.json")).parent
        / "icon-lis-cells.json",
    )
)

META = {
    "hrrr": {"label": "HRRR", "grid_label": "3 km", "spacing_km": 3, "attribution": "NOAA", "source": "NOAA HRRR (noaa-hrrr-bdp-pds), native 3 km grid"},
    "icon": {
        "label": "ICON",
        "grid_label": "13 km (triangles)",
        "spacing_km": 13,
        "attribution": "Deutscher Wetterdienst (DWD), ICON, CC BY 4.0",
        "source": "DWD ICON global, native R03B07 icosahedral grid (opendata.dwd.de)",
    },
    "ecmwf": {
        "label": "ECMWF",
        "grid_label": "0.25° (open data)",
        "spacing_km": 25,
        "attribution": "ECMWF open data, CC BY 4.0",
        "source": "ECMWF IFS open data, 0.25 degree (data.ecmwf.int)",
    },
    "gfs": {"label": "GFS", "grid_label": "0.25° (27 km)", "spacing_km": 27, "attribution": "NOAA", "source": "NOAA GFS 0.25 degree (noaa-gfs-bdp-pds)"},
}
ORDER = ["hrrr", "icon", "ecmwf", "gfs"]


# ---------- Helpers ----------


class _Counter:
    def __init__(self):
        self.bytes = 0


def _naive(ts) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    return t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t


def _key(t: pd.Timestamp) -> str:
    return f"{t:%Y-%m-%dT%H:%MZ}"


def _parse(k: str) -> pd.Timestamp:
    k = k.replace("Z", "")
    return pd.Timestamp(k + ":00" if len(k) == 13 else k)  # "2026-10-16T00" (HRRR cycle keys) or "...T00:00"


def frame_times(now: pd.Timestamp) -> list[pd.Timestamp]:
    """Every FRAME_H hours from the next FRAME_H-hourly hour after `now` to HOURS_AHEAD hours ahead."""
    t = now.floor(f"{FRAME_H}h") + pd.Timedelta(hours=FRAME_H)
    out = []
    while t <= now + pd.Timedelta(hours=HOURS_AHEAD):
        out.append(t)
        t += pd.Timedelta(hours=FRAME_H)
    return out


def _hours(a: pd.Timestamp, b: pd.Timestamp) -> int:
    return int((a - b) / pd.Timedelta(hours=1))


def _encode(a) -> str:
    a = np.asarray(a, dtype=float).ravel()
    q = np.clip(np.round(np.where(np.isfinite(a), a, 0.0) / STEP), -127, 127).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode()


def _r4(a) -> list:
    return np.round(np.asarray(a, dtype=float), 4).ravel().tolist()


def _regular(lon1d, lat1d, u2d, v2d, spacing: float) -> tuple[dict, np.ndarray, np.ndarray]:
    """The cells of a regular lat-lon grid that touch BOX, south-west first: (grid, u, v)."""
    lon = ((np.asarray(lon1d, dtype=float) + 180.0) % 360.0) - 180.0
    lat = np.asarray(lat1d, dtype=float)
    h = spacing / 2 + 1e-6
    x0, y0, x1, y1 = BOX
    ci = np.flatnonzero((lon >= x0 - h) & (lon <= x1 + h))
    ri = np.flatnonzero((lat >= y0 - h) & (lat <= y1 + h))
    ci = ci[np.argsort(lon[ci])]
    ri = ri[np.argsort(lat[ri])]
    u = np.asarray(u2d, dtype=float)[np.ix_(ri, ci)]
    v = np.asarray(v2d, dtype=float)[np.ix_(ri, ci)]
    clon = np.concatenate([lon[ci] - spacing / 2, [lon[ci][-1] + spacing / 2]])
    clat = np.concatenate([lat[ri] - spacing / 2, [lat[ri][-1] + spacing / 2]])
    glon, glat = np.meshgrid(clon, clat)
    grid = {"type": "quads", "nx": len(ci), "ny": len(ri), "lon": _r4(glon), "lat": _r4(glat)}
    return grid, u, v


def _read_grib(path: str):
    from forcingkit.fetchers.hrrr_atmosphere import _read_message

    return _read_message(path)


class _Polite:
    """One HTTP host, politely: one request at a time, at least POLITE_GAP_S apart."""

    def __init__(self, n: _Counter):
        self.s = requests.Session()
        self.s.headers.update(UA)
        self.last = 0.0
        self.n = n

    def _wait(self):
        dt = time.monotonic() - self.last
        if dt < POLITE_GAP_S:
            time.sleep(POLITE_GAP_S - dt)

    def get(self, url: str, **kw) -> requests.Response:
        self._wait()
        try:
            r = self.s.get(url, timeout=TIMEOUT, **kw)
        finally:
            self.last = time.monotonic()
        if r.ok:
            self.n.bytes += len(r.content)
        return r

    def exists(self, url: str) -> bool:
        self._wait()
        try:
            r = self.s.head(url, timeout=TIMEOUT, allow_redirects=True)
        except requests.RequestException as exc:
            log.warning("model grids: HEAD %s failed: %s", url, exc)
            return False
        finally:
            self.last = time.monotonic()
        return r.status_code == 200


def _newest(candidates: list[pd.Timestamp], published) -> pd.Timestamp | None:
    for c in candidates:
        if published(c):
            return c
    return None


# ---------- ECMWF ----------


def _ecmwf_url(run: pd.Timestamp, step: int, ext: str) -> str:
    return f"{ECMWF_BASE}/{run:%Y%m%d}/{run:%H}z/ifs/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc.{ext}"


def _ecmwf_frame(ec: _Polite, run: pd.Timestamp, valid: pd.Timestamp, workdir: str):
    step = _hours(valid, run)
    r = ec.get(_ecmwf_url(run, step, "index"))
    if r.status_code == 404:
        return None
    r.raise_for_status()
    entries = {}
    for line in r.text.splitlines():
        if line.strip():
            e = json.loads(line)
            if e.get("param") in ("10u", "10v") and e.get("levtype", "sfc") == "sfc":
                entries[e["param"]] = e
    if set(entries) != {"10u", "10v"}:
        raise FileNotFoundError(f"ECMWF {run} step {step}: 10u/10v not in the index")
    url = _ecmwf_url(run, step, "grib2")
    da = {}
    for p, e in entries.items():
        a, b = int(e["_offset"]), int(e["_offset"]) + int(e["_length"]) - 1
        g = ec.get(url, headers={"Range": f"bytes={a}-{b}"})
        g.raise_for_status()
        if len(g.content) != b - a + 1:
            raise OSError(f"ECMWF {url}: got {len(g.content)} bytes for a {b - a + 1}-byte range")
        path = os.path.join(workdir, f"ecmwf_{p}.grib2")
        Path(path).write_bytes(g.content)
        try:
            da[p] = _read_grib(path)
        finally:
            os.remove(path)
    u = da["10u"]
    return _regular(u["longitude"].values, u["latitude"].values, u.values, da["10v"].values, 0.25)


# ---------- GFS ----------


def _gfs_key(run: pd.Timestamp, lead: int) -> str:
    return f"{GFS_BUCKET}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{lead:03d}"


def _gfs_frame(n: _Counter, run: pd.Timestamp, valid: pd.Timestamp, workdir: str):
    from forcingkit.fetchers.hrrr import _fetch_s3_byte_ranges, _parse_idx, fs

    key = _gfs_key(run, _hours(valid, run))
    try:
        with fs.open(key + ".idx", "r") as f:
            idx = f.read()
    except FileNotFoundError:
        return None
    n.bytes += len(idx)
    da = {}
    for name, var in (("u", "UGRD"), ("v", "VGRD")):
        ranges = _parse_idx(idx, (f":{var}:10 m above ground:",))
        if len(ranges) != 1:
            raise FileNotFoundError(f"GFS s3://{key}: {len(ranges)} messages for {var}")
        path = os.path.join(workdir, f"gfs_{name}.grib2")
        _fetch_s3_byte_ranges(key, ranges, path)
        n.bytes += os.path.getsize(path)
        try:
            da[name] = _read_grib(path)
        finally:
            os.remove(path)
    u = da["u"]
    return _regular(u["longitude"].values, u["latitude"].values, u.values, da["v"].values, 0.25)


# ---------- ICON ----------


def _icon_url(run: pd.Timestamp, step: int, var: str) -> str:
    return f"{ICON_BASE}/{run:%H}/{var.lower()}/icon_global_icosahedral_single-level_{run:%Y%m%d%H}_{step:03d}_{var.upper()}.grib2.bz2"


_icon_cells: dict | None = None


def _icon_grid() -> dict:
    global _icon_cells
    if _icon_cells is None:
        _icon_cells = json.loads(ICON_CELLS.read_text())
    return _icon_cells


def _icon_frame(dw: _Polite, run: pd.Timestamp, valid: pd.Timestamp, workdir: str):
    cells = _icon_grid()
    idx = np.asarray(cells["index"], dtype=np.int64)
    step = _hours(valid, run)
    vals = {}
    for var in ("u_10m", "v_10m"):
        r = dw.get(_icon_url(run, step, var))
        if r.status_code == 404:
            return None
        r.raise_for_status()
        path = os.path.join(workdir, f"icon_{var}.grib2")
        Path(path).write_bytes(bz2.decompress(r.content))
        try:
            da = _read_grib(path)
        finally:
            os.remove(path)
        if da.size != cells["grid"]["ncells_global"]:
            raise ValueError(f"ICON {run} {var}: {da.size} points, the cell file expects {cells['grid']['ncells_global']}")
        vals[var] = np.asarray(da.values, dtype=float)[idx]
    grid = {"type": "tri", "n": len(idx), "tri": [x for t in cells["tri"] for x in t]}
    return grid, vals["u_10m"], vals["v_10m"]


# ---------- HRRR (from the HRRR grid job's file) ----------


def _hrrr(store: Store, times: list[pd.Timestamp]) -> dict | None:
    hw = store.read_json(HRRR_KEY)
    if not hw or hw.get("encoding", {}).get("step") != STEP:
        log.warning("model grids: %s missing or in another encoding; HRRR left out", HRRR_KEY)
        return None
    mesh = hw["mesh"]
    by_time = {f["valid_time"]: f for f in hw.get("frames", [])}
    frames = []
    for t in times:
        f = by_time.get(_key(t))
        if f:
            frames.append({"valid_time": _key(t), "issue_time": _key(_parse(f["cycle"])), "lead_h": int(f["lead"]), "u": f["u"], "v": f["v"]})
    grid = {"type": "quads", "nx": mesh["nx"], "ny": mesh["ny"], "lon": mesh["corner_lon"], "lat": mesh["corner_lat"]}
    return {"id": "hrrr", **META["hrrr"], "grid": grid, "frames": frames}


# ---------- Build ----------


def build(store: Store, prev: dict | None, end=None) -> tuple[dict | None, dict]:
    """The new file, or None when nothing is new. Returns (file or None, summary)."""
    from forcingkit.fetchers.hrrr import fs

    t0 = time.monotonic()
    end = end or now_utc()
    now = _naive(end)
    times = frame_times(now)
    last = times[-1]
    keys = [_key(t) for t in times]
    n = _Counter()
    ec, dw = _Polite(n), _Polite(n)
    if prev and (prev.get("box") != list(BOX) or prev.get("encoding", {}).get("step") != STEP):
        prev = None
    old = {m["id"]: m for m in (prev or {}).get("models", [])}

    def gfs_ok(c):
        try:
            return fs.exists(_gfs_key(c, _hours(last, c)) + ".idx")
        except Exception as exc:  # treat as not yet
            log.warning("GFS %s: could not check: %s", c, exc)
            return False

    # The newest run of each model whose file for the last frame is published.
    runs = {
        "icon": _newest([now.floor("6h") - pd.Timedelta(hours=6 * i) for i in range(4)], lambda c: dw.exists(_icon_url(c, _hours(last, c), "u_10m"))),
        "ecmwf": _newest([now.floor("12h") - pd.Timedelta(hours=12 * i) for i in range(3)], lambda c: ec.exists(_ecmwf_url(c, _hours(last, c), "index"))),
        "gfs": _newest([now.floor("6h") - pd.Timedelta(hours=6 * i) for i in range(5)], gfs_ok),
    }
    fetchers = {
        "icon": lambda r, t, w: _icon_frame(dw, r, t, w),
        "ecmwf": lambda r, t, w: _ecmwf_frame(ec, r, t, w),
        "gfs": lambda r, t, w: _gfs_frame(n, r, t, w),
    }

    models, fetched = [], {}
    hr = _hrrr(store, times)
    if hr:
        models.append(hr)
    with tempfile.TemporaryDirectory() as workdir:
        for mid, run in runs.items():
            before = old.get(mid)
            if mid == "icon" and before and before.get("grid", {}).get("n") != len(_icon_grid()["index"]):
                before = None  # the cell file changed: read the frames again
            kept = {f["valid_time"]: f for f in (before or {}).get("frames", []) if f["valid_time"] in keys}
            grid = (before or {}).get("grid")
            if run is None:
                log.warning("model grids: no %s run found reaching %s; keeping what is stored", mid, _key(last))
            else:
                fetched[mid] = 0
                for t in times:
                    have = kept.get(_key(t))
                    if have and _parse(have["issue_time"]) >= run:
                        continue
                    try:
                        got = fetchers[mid](run, t, workdir)
                    except Exception as exc:  # one frame failing leaves the rest
                        log.warning("model grids: %s %s for %s failed: %s", mid, _key(run), _key(t), exc)
                        continue
                    if got is None:
                        continue
                    grid, u, v = got
                    kept[_key(t)] = {"valid_time": _key(t), "issue_time": _key(run), "lead_h": _hours(t, run), "u": _encode(u), "v": _encode(v)}
                    fetched[mid] += 1
            if grid and kept:
                models.append({"id": mid, **META[mid], "grid": grid, "frames": [kept[k] for k in keys if k in kept]})
    models.sort(key=lambda m: ORDER.index(m["id"]))

    summary = {
        "runs": {k: (_key(v) if v is not None else None) for k, v in runs.items()},
        "frames_fetched": fetched,
        "mb": round(n.bytes / 1e6, 1),
        "seconds": round(time.monotonic() - t0, 1),
    }
    if not models:
        return None, summary | {"error": "no model read"}
    out = {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "box": list(BOX),
        "units": "m/s",
        "encoding": {"type": "int8 base64", "step": STEP, "clip": round(127 * STEP, 2)},
        "times": keys,
        "models": models,
    }

    def body(f):
        return [(m["id"], [(x["valid_time"], x["issue_time"], x["u"], x["v"]) for x in m["frames"]]) for m in f.get("models", [])]

    if prev and prev.get("times") == keys and body(prev) == body(out):
        return None, summary | {"current": True}
    return out, summary


def publish(store: Store) -> None:
    """Refresh the wind model comparison when a frame is new to the window or a newer run is published."""
    out, summary = build(store, store.read_json(KEY))
    log.info("model grids: %s", summary)
    if out is None:
        return
    store.write_json(KEY, out, max_age=3600)


__all__ = ["build", "frame_times", "publish"]
