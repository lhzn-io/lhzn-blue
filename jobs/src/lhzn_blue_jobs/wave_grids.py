"""Waves over the Sound for the next 72 hours on two models' own grids, for the "Models compared" page's Waves view.

Frames every ``FRAME_H`` hours from the current 3-hourly hour to ``HOURS_AHEAD`` ahead. For each model, every frame
comes from the newest run that reaches it, with no regridding:

- NWPS (NWS Nearshore Wave Prediction System, SWAN on WFO New York's grid CG1, about 1.8 km): taken from
  ``v1/fields/nwps-waves.json``, which the ``nwps`` step writes just before this one in the same run (its cells,
  newest run per hour). No download here. Its period is the peak period.
- NECOFS (UMass Dartmouth SMAST, on the GOM7 mesh's nodes): ``forcingkit.fetchers.necofs.read_waves`` over the map's
  box. Each value belongs to its node's median dual cell, which the page builds from the triangles. Its period is
  the mean period T0m1 (the file's ``tpeak``), not a peak period. Its ``wdir`` is the direction the waves come
  from: turned around, it matches NWPS's direction of travel within about 10 degrees (median over 287 hour-points
  in the open Sound and the New York Bight, 2026-11-25), so it is stored as the direction of travel, like NWPS's.
  The file's title names WAVEWATCH III; which wave model it is, SMAST does not say in the file.

NECOFS publishes one forecast a day, so the server is asked only between ``NECOFS_CHECK_UTC`` hours (after its
morning run), or when the frames held reach less than ``NECOFS_MIN_REACH_H`` hours ahead; otherwise its frames are
kept from the previous file. The file is written only when a model has a newer run: NWPS twice a day, NECOFS once,
so 2 to 3 Workers KV writes a day.

Published layout (``v1/fields/wave-grids.json``): ``{schema, generated_at, box, encoding, times, models}``. Each
model: ``{id, label, grid_label, spacing_km, source, attribution, period, run, grid, frames}``. ``grid`` is
``{type: "quads", nx, ny, lon, lat, land}`` (NWPS: cell corners, (ny+1) x (nx+1), row-major from the south-west, and a
land flag per cell) or ``{type: "nodes", n, lon, lat, tri}`` (NECOFS: node coordinates and the triangles as node
indices, 3 per triangle). ``frames``: ``{valid_time, issue_time, lead_h, hs, dir, tp}``, each field one byte per
cell or node in base64: ``hs`` in steps of ``encoding.hs_step`` m, ``dir`` (direction of travel, degrees clockwise
from north) in steps of ``encoding.dir_step``, ``tp`` in steps of ``encoding.tp_step`` s; ``encoding.none`` where
there is no value. NECOFS frames carry no issue time or lead (the file does not give its run's start); its ``run``
is the last hour its forecast reaches.
"""

from __future__ import annotations

import base64
import logging
import time
from datetime import datetime

import numpy as np
import pandas as pd

from . import nwps
from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

KEY = "v1/fields/wave-grids.json"
BOX = nwps.FIELD_BOX
FRAME_H = 3
HOURS_AHEAD = 72
READ_AHEAD_H = 120  # NECOFS hours asked for: past its end, so the read shows where its forecast stops
HS_STEP = 0.05  # m per unit (to 12.7 m; this week reached 6.7 m in the New York Bight)
DIR_STEP = 360 / 256  # degrees per unit
TP_STEP = 0.125  # s per unit (to 31.75 s)
NONE = 255
NECOFS_CHECK_UTC = range(11, 17)  # its daily forecast is posted by about 12:30 UTC
NECOFS_MIN_REACH_H = 60
NECOFS_SOURCE = "NECOFS/UMASSD wave forecast (UMass Dartmouth SMAST), on the GOM7 mesh's nodes"
NWPS_SOURCE = "NWS Nearshore Wave Prediction System (SWAN), WFO New York grid CG1, on the model's own 1.8 km cells"


def _naive(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t


def _key(t: pd.Timestamp) -> str:
    return f"{t:%Y-%m-%dT%H:%MZ}"


def frame_times(now) -> list[pd.Timestamp]:
    t0 = _naive(now).floor(f"{FRAME_H}h")
    return [t0 + pd.Timedelta(hours=h) for h in range(0, HOURS_AHEAD + 1, FRAME_H)]


def _b64(q: np.ndarray) -> str:
    return base64.b64encode(np.asarray(q, dtype=np.uint8).ravel().tobytes()).decode()


def _bytes(a, step: float, mod: float | None = None) -> np.ndarray:
    """Values to one byte each, NONE where missing; `mod` wraps directions."""
    a = np.asarray(a, dtype=np.float64)
    ok = np.isfinite(a)
    if mod is not None:
        a = np.mod(a, mod)
        q = np.round(np.where(ok, a, 0) / step) % round(mod / step)
    else:
        q = np.clip(np.round(np.where(ok, a, 0) / step), 0, NONE - 1)
    return np.where(ok, q, NONE).astype(np.uint8)


def nwps_model(doc: dict, times: list[pd.Timestamp]) -> dict | None:
    """NWPS frames at `times` from the map layer's file (hs along the direction of travel as east and north int8)."""
    mesh, enc = doc.get("mesh"), doc.get("encoding", {})
    if not mesh or not doc.get("frames"):
        return None
    step, tp_step = float(enc["step"]), float(enc.get("tp_step", nwps.FIELD_TP_STEP))
    land = np.asarray(mesh["land"], dtype=bool)
    by = {f["valid_time"]: f for f in doc["frames"]}
    dec = lambda s, k: np.frombuffer(base64.b64decode(s), np.int8).astype(np.float64) * k  # noqa: E731
    frames = []
    for t in times:
        f = by.get(_key(t))
        if f is None:
            continue
        u, v = dec(f["u"], step), dec(f["v"], step)
        hs = np.where(land, np.nan, np.hypot(u, v))
        to = np.where(land | (hs <= 0), np.nan, np.degrees(np.arctan2(u, v)))
        tp = np.where(land, np.nan, dec(f["tp"], tp_step)) if "tp" in f else np.full(hs.size, np.nan)
        frames.append({"valid_time": _key(t), "issue_time": f["cycle"], "lead_h": f["lead"],
                       "hs": _b64(_bytes(hs, HS_STEP)), "dir": _b64(_bytes(to, DIR_STEP, 360.0)), "tp": _b64(_bytes(tp, TP_STEP))})
    if not frames:
        return None
    return {
        "id": "nwps", "label": "NWPS", "grid_label": "1.8 km cells", "spacing_km": 1.8,
        "source": NWPS_SOURCE, "attribution": "NWS NWPS (NOAA NOMADS)", "period": "peak period",
        "run": sorted({f["issue_time"] for f in frames})[-1],
        "grid": {"type": "quads", "nx": mesh["nx"], "ny": mesh["ny"], "lon": mesh["corner_lon"], "lat": mesh["corner_lat"],
                 "land": [int(x) for x in land]},
        "frames": frames,
    }


def necofs_model(ds, times: list[pd.Timestamp]) -> dict:
    """NECOFS frames at `times` from a read_waves dataset (hs, wdir coming from, tpeak as the mean period)."""
    held = pd.DatetimeIndex(ds.time.values)
    frames = []
    for t in times:
        if t not in held:
            continue
        k = held.get_loc(t)
        hs = ds["hs"].values[k].astype(np.float64)
        to = (ds["wdir"].values[k].astype(np.float64) + 180.0) % 360.0
        frames.append({"valid_time": _key(t), "issue_time": None, "lead_h": None, "hs": _b64(_bytes(hs, HS_STEP)),
                       "dir": _b64(_bytes(np.where(hs > 0, to, np.nan), DIR_STEP, 360.0)),
                       "tp": _b64(_bytes(ds["tpeak"].values[k], TP_STEP))})
    r4 = lambda a: np.round(np.asarray(a, dtype=np.float64), 4).tolist()  # noqa: E731
    return {
        "id": "necofs", "label": "NECOFS", "grid_label": "mesh nodes, 0.2 to 1.5 km", "spacing_km": None,
        "source": NECOFS_SOURCE, "attribution": "NECOFS/UMASSD", "period": "mean period (T0m1)",
        "run": _key(held[-1]),
        "grid": {"type": "nodes", "n": int(ds.sizes["node"]), "lon": r4(ds["node_lon"].values), "lat": r4(ds["node_lat"].values),
                 "tri": np.asarray(ds["triangles"].values, dtype=np.int64).ravel().tolist()},
        "frames": frames,
    }


def _read_necofs(start: pd.Timestamp):
    from forcingkit.fetchers import necofs

    return necofs.read_waves(list(BOX), start, READ_AHEAD_H, ("hs", "wdir", "tpeak"))


def _reach(model: dict | None) -> pd.Timestamp | None:
    if not model or not model.get("frames"):
        return None
    return pd.Timestamp(model["frames"][-1]["valid_time"].replace("Z", ""))


def build(prev: dict | None, nwps_doc: dict | None, end=None, read_necofs=_read_necofs) -> tuple[dict | None, dict]:
    """The new file, or None when neither model has a newer run; and a summary."""
    t_start = time.monotonic()
    now = _naive(end or now_utc())
    times = frame_times(now)
    wanted = {_key(t) for t in times}
    old = (prev or {}).get("models", {})
    models: dict[str, dict] = {}

    nw = nwps_model(nwps_doc, times) if nwps_doc else None
    if nw:
        models["nwps"] = nw
    elif old.get("nwps"):
        models["nwps"] = {**old["nwps"], "frames": [f for f in old["nwps"]["frames"] if f["valid_time"] in wanted]}

    reach = _reach(old.get("necofs"))
    ask = old.get("necofs") is None or now.hour in NECOFS_CHECK_UTC or reach is None or reach < now + pd.Timedelta(hours=NECOFS_MIN_REACH_H)
    if ask:
        try:
            models["necofs"] = necofs_model(read_necofs(times[0]), times)
        except Exception as exc:  # the previous frames stay; the page shows what they reach
            log.warning("wave grids: NECOFS read failed: %s", exc)
    if "necofs" not in models and old.get("necofs"):
        models["necofs"] = {**old["necofs"], "frames": [f for f in old["necofs"]["frames"] if f["valid_time"] in wanted]}

    runs = {k: m.get("run") for k, m in models.items()}
    before = {k: m.get("run") for k, m in old.items()}
    summary = {"runs": runs, "asked_necofs": ask, "seconds": round(time.monotonic() - t_start, 1)}
    if not models or runs == before:
        return None, summary
    out = {
        "schema": SCHEMA,
        "generated_at": iso(pd.Timestamp(now).tz_localize("UTC")),
        "box": list(BOX),
        "encoding": {"type": "uint8 base64", "hs_step": HS_STEP, "dir_step": DIR_STEP, "tp_step": TP_STEP, "none": NONE,
                     "dir": "direction of travel, degrees clockwise from north"},
        "times": sorted(wanted),
        "models": {k: models[k] for k in ("nwps", "necofs") if k in models},
    }
    return out, summary


def publish(store: Store, end: datetime | None = None) -> None:
    out, summary = build(store.read_json(KEY), store.read_json(nwps.FIELD_KEY), end)
    log.info("wave grids: %s", summary)
    if out is not None:
        store.write_json(KEY, out, max_age=3600)
