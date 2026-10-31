"""NECOFS at every layer around the UNH buoy, for the 3D view on the (unlisted) /portsmouth-harbor/ page.

The view draws the model's currents in 3D over a 4.4 km box centred on the buoy, for a rolling window from
``WINDOW_BACK_DAYS`` before the buoy's latest record to ``WINDOW_AHEAD_HOURS`` after it (or around now when there is
no buoy record), so its hours always sit beside the buoy's own.

Published under ``v1/piscataqua-pane/`` (the view's data directory; see the view's README):

- ``window.bin``: gzipped; inside, ``LHZF``, a little-endian uint32 header length, a JSON header (the hours, where
  each came from, and the counts), then per hour the eastward and then the northward velocity at every layer centre
  of every element (layer, then element; surface layer first) as signed bytes in steps of ``UV_STEP_MM`` mm/s, and
  the surface elevation at every node as little-endian int16 mm.
- ``mesh.json``: the view's index: counts, hours, sigma levels, the element holding the buoy, the files, statistics.
- ``nodes.f32``, ``tri.u16``: the subset's nodes (east and north metres from the buoy, depth in metres) and
  triangles, written only when the subset changes.

The seabed (``dem.*``) and the particle tracks (``tracks.*``) are prepared and uploaded separately.

Hours come from SMAST's daily archive (the hindcast) where it holds them and from the rolling forecast after that.
An hour taken from the forecast is replaced once its archive day appears. Each run reads at most ``max_new_days``
archive days and keeps every other hour from the previous window, so a day's run reads one archive day and the
forecast (each read opens the model's whole mesh to find the box, several minutes from a slow server), and a new
window fills in over a few days, the forecast covering its latest hours meanwhile.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import struct
from datetime import datetime

import numpy as np
import pandas as pd

from .build import SCHEMA, Store, iso, now_utc
from .piscataqua_model import ARCHIVE  # SMAST's daily history file for a date

log = logging.getLogger(__name__)

PREFIX = "v1/piscataqua-pane/"
WINDOW_REL, MESH_REL, NODES_REL, TRI_REL = (PREFIX + f for f in ("window.bin", "mesh.json", "nodes.f32", "tri.u16"))
BUOY = (-70.7079, 43.0687)  # the UNH G-2000 buoy, the frame's origin
HALF_M = 2200.0  # the box: 4.4 km square centred on the buoy
EARTH_M = 6371000.0  # the frame: equirectangular about the buoy
WINDOW_BACK_DAYS = 5
WINDOW_AHEAD_HOURS = 48
UV_STEP_MM = 20  # 2 cm/s: within 1 cm/s of the model, to 2.54 m/s (the harbour peaks near 1.6 m/s)
MAGIC = b"LHZF"
SOURCE = "NECOFS FVCOM GOM7, UMass Dartmouth SMAST"


def bbox() -> list[float]:
    lon0, lat0 = BUOY
    dlat = math.degrees(HALF_M / EARTH_M)
    dlon = math.degrees(HALF_M / (EARTH_M * math.cos(math.radians(lat0))))
    return [lon0 - dlon, lat0 - dlat, lon0 + dlon, lat0 + dlat]


def east_north(lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lon0, lat0 = BUOY
    return (np.radians(np.asarray(lon) - lon0) * EARTH_M * math.cos(math.radians(lat0)),
            np.radians(np.asarray(lat) - lat0) * EARTH_M)


def window_hours(anchor: pd.Timestamp) -> pd.DatetimeIndex:
    """The window's hours (naive UTC) around an anchor time."""
    a = anchor.floor("h")
    return pd.date_range(a.normalize() - pd.Timedelta(days=WINDOW_BACK_DAYS), a + pd.Timedelta(hours=WINDOW_AHEAD_HOURS), freq="h")


def _naive(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t


# ---- the window file ----

def encode(header: dict, hours: dict[pd.Timestamp, dict]) -> bytes:
    """hours: {time: {"u": int8 (L, E), "v": int8 (L, E), "zeta": int16 (N,), "from": "hindcast" | "forecast"}}."""
    ts = sorted(hours)
    head = dict(header, times=[int(t.timestamp()) for t in (pd.Timestamp(x).tz_localize("UTC") for x in ts)],
                sources=[hours[t]["from"] for t in ts], uv_step_mm_s=UV_STEP_MM, zeta_unit="mm",
                order="per hour: u int8 (layer, element), v int8 (layer, element), zeta int16 (node)")
    body = b"".join(hours[t]["u"].astype(np.int8).tobytes() + hours[t]["v"].astype(np.int8).tobytes()
                    + hours[t]["zeta"].astype("<i2").tobytes() for t in ts)
    blob = json.dumps(head, separators=(",", ":")).encode()
    return gzip.compress(MAGIC + struct.pack("<I", len(blob)) + blob + body, compresslevel=9, mtime=0)


def decode(blob: bytes | None) -> tuple[dict, dict[pd.Timestamp, dict]]:
    if not blob:
        return {}, {}
    raw = gzip.decompress(blob)
    if raw[:4] != MAGIC:
        raise ValueError("not a window file")
    (n,) = struct.unpack("<I", raw[4:8])
    head = json.loads(raw[8 : 8 + n])
    L, E, N = head["layers"], head["elements"], head["nodes"]
    per = 2 * L * E + 2 * N
    body = memoryview(raw)[8 + n :]
    hours = {}
    for i, (t, src) in enumerate(zip(head["times"], head["sources"])):
        chunk = body[i * per : (i + 1) * per]
        hours[pd.Timestamp(t, unit="s")] = {
            "u": np.frombuffer(chunk[: L * E], dtype=np.int8).reshape(L, E).copy(),
            "v": np.frombuffer(chunk[L * E : 2 * L * E], dtype=np.int8).reshape(L, E).copy(),
            "zeta": np.frombuffer(chunk[2 * L * E :], dtype="<i2").copy(),
            "from": src,
        }
    return head, hours


def quantise_uv(a: np.ndarray) -> np.ndarray:
    """m/s to int8 steps of UV_STEP_MM mm/s (NaN, a dry or missing value, to 0)."""
    mm = np.where(np.isfinite(a), np.asarray(a, dtype=np.float64) * 1000.0, 0.0)
    return np.clip(np.round(mm / UV_STEP_MM), -127, 127).astype(np.int8)


def quantise_zeta(a: np.ndarray) -> np.ndarray:
    return np.clip(np.round(np.where(np.isfinite(a), a, 0.0) * 1000.0), -32767, 32767).astype("<i2")


def _hours_from(ds, source: str) -> dict[pd.Timestamp, dict]:
    out = {}
    for i, t in enumerate(pd.DatetimeIndex(ds["time"].values)):
        out[_naive(t)] = {"u": quantise_uv(ds["u"].values[i]), "v": quantise_uv(ds["v"].values[i]),
                          "zeta": quantise_zeta(ds["zeta"].values[i]), "from": source}
    return out


# ---- the subset ----

def subset_files(ds) -> tuple[dict, bytes, bytes]:
    """The subset's description for mesh.json, nodes.f32 and tri.u16."""
    e, n = east_north(ds["node_lon"].values, ds["node_lat"].values)
    nodes = np.stack([e, n, ds["h"].values], axis=1).astype("<f4")
    tri = ds["triangles"].values.astype("<u2")
    ec, nc = east_north(ds["lonc"].values, ds["latc"].values)
    siglay = np.asarray(ds["siglay"].values)  # (layer, node), surface first
    siglev = np.asarray(ds["siglev"].values)
    uniform = bool(np.allclose(siglay, siglay[:, :1]) and np.allclose(siglev, siglev[:, :1]))
    if not uniform:
        raise ValueError("sigma levels vary across the subset; the 3D view expects uniform sigma here")
    # The element holding the buoy (the frame's origin), for the model's profile at the buoy.
    held = -1
    for k, (a, b, c) in enumerate(tri):
        d = (n[b] - n[c]) * (e[a] - e[c]) + (e[c] - e[b]) * (n[a] - n[c])
        w1 = ((n[b] - n[c]) * (0 - e[c]) + (e[c] - e[b]) * (0 - n[c])) / d
        w2 = ((n[c] - n[a]) * (0 - e[c]) + (e[a] - e[c]) * (0 - n[c])) / d
        if w1 >= 0 and w2 >= 0 and 1 - w1 - w2 >= 0:
            held = k
            break
    info = {
        "elements": int(tri.shape[0]), "nodes": int(nodes.shape[0]), "layers": int(siglay.shape[0]),
        "sigma_uniform": True,
        "siglev": [round(float(x), 6) for x in siglev[:, 0]],
        "siglay": [round(float(x), 6) for x in siglay[:, 0]],
        "buoy_element": held,
        "buoy_element_id": int(ds["element_id"].values[held]) if held >= 0 else None,
        "buoy_element_centroid_en_m": [round(float(ec[held]), 1), round(float(nc[held]), 1)] if held >= 0 else None,
        "element_ids": [int(x) for x in ds["element_id"].values],
        "h_m": [round(float(np.nanmin(ds["h"].values)), 2), round(float(np.nanmax(ds["h"].values)), 2)],
    }
    return info, nodes.tobytes(), tri.tobytes()


def stats(hours: dict[pd.Timestamp, dict]) -> dict:
    sp = np.concatenate([np.hypot(h["u"].astype(np.float64), h["v"].astype(np.float64)).ravel() for h in hours.values()]) * UV_STEP_MM / 1000
    z = np.concatenate([h["zeta"].astype(np.float64) for h in hours.values()]) / 1000
    return {"speed_m_s_max": round(float(sp.max()), 3), "speed_m_s_p99": round(float(np.percentile(sp, 99)), 3),
            "zeta_m": [round(float(z.min()), 3), round(float(z.max()), 3)]}


# ---- the run ----

def anchor_time(store: Store, now: datetime) -> pd.Timestamp:
    """The buoy's latest record (from the page's own file), or now."""
    doc = store.read_json("v1/piscataqua.json") or {}
    last = (doc.get("buoy") or {}).get("last")
    return _naive(last) if last else _naive(now)


def update(store: Store, end: datetime | None = None, max_new_days: int = 2, reader=None) -> dict:
    """Bring the window up to date and publish it; returns a summary. `reader` (read_volume's signature) is for tests."""
    from forcingkit.fetchers import necofs

    read = reader or necofs.read_volume
    end = end or now_utc()
    now = _naive(end)
    box = bbox()
    want = window_hours(anchor_time(store, end))
    head, hours = decode(store.read_bytes(WINDOW_REL))
    hours = {t: h for t, h in hours.items() if t in want}
    mesh_prev = store.read_json(MESH_REL) or {}
    ids = mesh_prev.get("element_ids")
    sub = None  # the newest dataset read, for the subset's description

    def same_subset(ds) -> None:
        """Note the subset a read selected; if it is not the window's, the window starts again."""
        nonlocal sub, ids, hours
        got = [int(x) for x in ds["element_id"].values]
        if ids is not None and got != ids:
            log.warning("piscataqua pane: the subset changed (%d elements, was %d); starting the window again", len(got), len(ids))
            hours = {}
        ids, sub = got, ds

    # The hindcast: archive days that would replace forecast hours or fill missing ones, newest first (the newest
    # may not be published yet; a day not read is tried again next run).
    days = sorted({necofs.necofs_archive_file_date(t) for t in want if t <= now and hours.get(t, {}).get("from") != "hindcast"}, reverse=True)
    added = []
    for day in days:
        if len(added) >= max_new_days:
            break
        in_day = [t for t in want if necofs.necofs_archive_file_date(t) == day]
        try:  # the archive file itself: a day not published yet fails here (never the forecast in its place)
            ds = read(box, in_day[0], len(in_day), dap_url=ARCHIVE.format(d=day.strftime("%Y_%m_%d")))
        except Exception as exc:
            log.info("piscataqua pane: archive day %s not read (%s)", day.date(), exc)
            continue
        if ds.sizes.get("time", 0):
            same_subset(ds)
            hours.update(_hours_from(ds, "hindcast"))
            added.append(str(day.date()))
    # The forecast for every hour of the window the hindcast does not hold.
    rest = [t for t in want if hours.get(t, {}).get("from") != "hindcast"]
    if rest:
        try:
            ds = read(box, rest[0], int((rest[-1] - rest[0]) / pd.Timedelta(hours=1)) + 1)
            if ds.sizes.get("time", 0):
                same_subset(ds)
                hours.update({t: h for t, h in _hours_from(ds, "forecast").items() if t in rest})
        except Exception as exc:
            log.warning("piscataqua pane: forecast not read (%s)", exc)
    hours = {t: h for t, h in hours.items() if t in want}
    if not hours:
        return {"hours": 0, "added_days": added}

    if sub is not None:
        info, nodes_b, tri_b = subset_files(sub)
        if info["element_ids"] != mesh_prev.get("element_ids"):
            store.write_bytes(NODES_REL, nodes_b, max_age=86400)
            store.write_bytes(TRI_REL, tri_b, max_age=86400)
    else:
        info = {k: mesh_prev[k] for k in ("elements", "nodes", "layers", "sigma_uniform", "siglev", "siglay", "buoy_element",
                                          "buoy_element_id", "buoy_element_centroid_en_m", "element_ids", "h_m")}
    header = {"schema": SCHEMA, "source": SOURCE, "elements": info["elements"], "nodes": info["nodes"], "layers": info["layers"]}
    blob = encode(header, hours)
    ts = sorted(hours)
    mesh = {
        "schema": SCHEMA,
        "source": f"{SOURCE}: daily history archive, then the rolling forecast",
        "generated_at": iso(end),
        **{k: info[k] for k in ("elements", "nodes", "layers", "sigma_uniform", "siglev", "siglay", "buoy_element",
                                "buoy_element_id", "buoy_element_centroid_en_m", "element_ids")},
        "times": [int(pd.Timestamp(t).tz_localize("UTC").timestamp()) for t in ts],
        "forecast_from": next((int(pd.Timestamp(t).tz_localize("UTC").timestamp()) for t in ts if hours[t]["from"] == "forecast"), None),
        "files": {"nodes": "nodes.f32", "tri": "tri.u16", "window": "window.bin", "siglev": None},
        "stats": {"h_m": info["h_m"], **stats(hours)},
        "frame": "east and north metres from the UNH buoy (43.06870 N, 70.70790 W); z up, metres",
    }
    store.write_bytes(WINDOW_REL, blob, max_age=3600)
    store.write_json(MESH_REL, mesh, max_age=3600)
    return {"hours": len(hours), "from": iso(pd.Timestamp(ts[0]).tz_localize("UTC")), "to": iso(pd.Timestamp(ts[-1]).tz_localize("UTC")),
            "hindcast": sum(h["from"] == "hindcast" for h in hours.values()), "added_days": added, "bytes": len(blob)}
