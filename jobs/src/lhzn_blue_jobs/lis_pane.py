"""NECOFS in 3D over Long Island Sound, for the /long-island-sound/currents-3d/ page: two places, each a rolling
window from ``WINDOW_BACK_DAYS`` before the Groton current meter's latest record (NOAA CO-OPS nl0101, Thames River) to
``WINDOW_AHEAD_HOURS`` after it (or around now when there is none), hourly. Both frames are east and north metres
from the meter.

- ``east``, the eastern Sound (21 by 28 km, New London to The Race and Plum Gut): every layer of every element,
  under ``v1/lis-pane/``.
- ``sound``, the whole Sound (the map's box, Throgs Neck to Block Island Sound): the surface and the bottom layer of
  every element, and every layer of the elements along the Sound's axis (``AXIS``, Throgs Neck to The Race), under
  ``v1/lis-pane/sound/``. All 45 layers over the whole Sound would be about 85 MB a week gzipped; this is about 8.

The model is coarser here than in its harbour grids (element sides about 160 m in the Thames and the Race's edges,
1 to 1.5 km in open water), hence reaches rather than one harbour.

Each place publishes:

- ``window.bin``: gzipped; inside, ``LHZF``, a little-endian uint32 header length, a JSON header (the hours, where
  each came from, and the counts), then per hour the eastward and then the northward velocity at the window's layers
  of every element (layer, then element; surface first) as signed bytes in steps of ``UV_STEP_MM`` mm/s, and the
  surface elevation at every node as little-endian int16 mm.
- ``section.bin`` (``sound`` only): the same layout for the axis elements at every layer, with no nodes.
- ``mesh.json``: the view's index: counts, hours, sigma levels, the element holding the meter, the section's geometry,
  the files, statistics.
- ``nodes.f32``, ``tri.u16``: the subset's nodes (east and north metres from the meter, depth in metres) and
  triangles, written only when the subset changes.

Hours come from SMAST's daily archive (the hindcast) where it holds them and from the rolling forecast after that.
An hour taken from the forecast is replaced once its archive day appears. Each run reads at most ``max_new_days``
archive days and keeps every other hour from the previous window, so a day's run reads one archive day and the
forecast, and a new window fills in over a few days, the forecast covering its latest hours meanwhile. Reads ask for
u, v and zeta only (forcingkit's selection), at the place's layers.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import struct
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd

from .build import SCHEMA, Store, iso, now_utc
ARCHIVE = "http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Archive/necofs_history/NECOFS_GOM7_{d}.nc"  # a day's history

log = logging.getLogger(__name__)

ORIGIN = (-72.0923, 41.3918)  # the Groton current meter (GRTN, CO-OPS nl0101), the frames' origin
METER = "GRTN"
EARTH_M = 6371000.0  # the frame: equirectangular about the meter
WINDOW_BACK_DAYS = 5
WINDOW_AHEAD_HOURS = 48
FORECAST_HOURS_PER_READ = 24  # as an archive day, which the server reads well within its timeout
UV_STEP_MM = 20  # 2 cm/s: within 1 cm/s of the model, to 2.54 m/s (see stats: the Race in the model stays below)
VARIABLES = ("u", "v", "zeta")  # what the view draws; forcingkit reads nothing else
MAGIC = b"LHZF"
SOURCE = "NECOFS FVCOM GOM7, UMass Dartmouth SMAST"
# The Sound's axis, west to east (lon, lat): Throgs Neck, Execution Rocks, the western, central and eastern basins,
# The Race. The section follows it through the deep water.
AXIS = ((-73.79, 40.805), (-73.73, 40.88), (-73.55, 40.975), (-73.25, 41.03), (-72.95, 41.08), (-72.66, 41.13),
        (-72.35, 41.17), (-72.15, 41.215), (-72.06, 41.235), (-71.98, 41.25))
SECTION_STEP_M = 50.0  # samples along the axis, to find the elements it crosses


@dataclass(frozen=True)
class Place:
    key: str
    name: str
    prefix: str
    bbox: tuple[float, float, float, float]
    layers: tuple[int, ...] | None  # None: every layer
    axis: tuple[tuple[float, float], ...] | None = None  # a section along this line, every layer

    def rel(self, name: str) -> str:
        return self.prefix + name


EAST = Place("east", "Eastern Sound", "v1/lis-pane/", (-72.20, 41.15, -71.95, 41.40), None)
SOUND = Place("sound", "Whole Sound", "v1/lis-pane/sound/", (-73.9, 40.45, -71.8, 41.45), (0, -1), AXIS)
PLACES = (SOUND, EAST)
# Kept for callers and tests of the first place.
PREFIX = EAST.prefix
BBOX = list(EAST.bbox)
WINDOW_REL, MESH_REL, NODES_REL, TRI_REL = (EAST.rel(f) for f in ("window.bin", "mesh.json", "nodes.f32", "tri.u16"))


def east_north(lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lon0, lat0 = ORIGIN
    return (np.radians(np.asarray(lon) - lon0) * EARTH_M * math.cos(math.radians(lat0)),
            np.radians(np.asarray(lat) - lat0) * EARTH_M)


def window_hours(anchor: pd.Timestamp) -> pd.DatetimeIndex:
    """The window's hours (naive UTC) around an anchor time."""
    a = anchor.floor("h")
    return pd.date_range(a.normalize() - pd.Timedelta(days=WINDOW_BACK_DAYS), a + pd.Timedelta(hours=WINDOW_AHEAD_HOURS), freq="h")


def _naive(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t


def _epoch(t) -> int:
    return int(pd.Timestamp(t).tz_localize("UTC").timestamp())


# ---- the window file ----

def encode(header: dict, hours: dict[pd.Timestamp, dict]) -> bytes:
    """hours: {time: {"u": int8 (L, E), "v": int8 (L, E), "zeta": int16 (N,), "from": "hindcast" | "forecast"}}."""
    ts = sorted(hours)
    head = dict(header, times=[_epoch(t) for t in ts],
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
        zeta = quantise_zeta(ds["zeta"].values[i]) if "zeta" in ds else np.zeros(0, "<i2")
        out[_naive(t)] = {"u": quantise_uv(ds["u"].values[i]), "v": quantise_uv(ds["v"].values[i]),
                          "zeta": zeta, "from": source}
    return out


# ---- the subset ----

def _barycentric(e: np.ndarray, n: np.ndarray, tri: np.ndarray, k: int, x: float, y: float) -> list[float]:
    a, b, c = tri[k]
    d = (n[b] - n[c]) * (e[a] - e[c]) + (e[c] - e[b]) * (n[a] - n[c])
    w1 = ((n[b] - n[c]) * (x - e[c]) + (e[c] - e[b]) * (y - n[c])) / d
    w2 = ((n[c] - n[a]) * (x - e[c]) + (e[a] - e[c]) * (y - n[c])) / d
    return [float(w1), float(w2), float(1 - w1 - w2)]


def subset_files(ds) -> tuple[dict, bytes, bytes]:
    """The subset's description for mesh.json, nodes.f32 and tri.u16."""
    e, n = east_north(ds["node_lon"].values, ds["node_lat"].values)
    nodes = np.stack([e, n, ds["h"].values], axis=1).astype("<f4")
    tri = ds["triangles"].values.astype("<u2")
    ec, nc = east_north(ds["lonc"].values, ds["latc"].values)
    siglay = np.asarray(ds["siglay"].values)  # (layer, node), surface first: the layers read
    siglev = np.asarray(ds["siglev"].values)  # every interface
    uniform = bool(np.allclose(siglay, siglay[:, :1]) and np.allclose(siglev, siglev[:, :1]))
    if not uniform:
        raise ValueError("sigma levels vary across the subset; the 3D view expects uniform sigma here")
    model_levels = [round(float(x), 6) for x in siglev[:, 0]]
    layer_index = [int(k) for k in ds["layer"].values] if "layer" in ds.coords else list(range(siglay.shape[0]))
    if len(layer_index) == len(model_levels) - 1:
        levels = model_levels
    else:  # the surface and the bottom layer: the surface layer's own interfaces, then the bed; the view draws the
        # surface layer's top face and colours the bed by the bottom layer, never the span between
        levels = [model_levels[0], model_levels[layer_index[0] + 1], model_levels[-1]]
    # The element holding the meter (the frame's origin), for the model's profile there.
    held = -1
    for k in range(tri.shape[0]):
        if min(_barycentric(e, n, tri, k, 0.0, 0.0)) >= 0:
            held = k
            break
    info = {
        "elements": int(tri.shape[0]), "nodes": int(nodes.shape[0]), "layers": int(siglay.shape[0]),
        "sigma_uniform": True,
        "siglev": levels,
        "siglay": [round(float(x), 6) for x in siglay[:, 0]],
        "layer_index": layer_index,
        "model_siglev": model_levels,
        "buoy_element": held,  # the pane's name for the origin's element
        "buoy_element_id": int(ds["element_id"].values[held]) if held >= 0 else None,
        "buoy_element_centroid_en_m": [round(float(ec[held]), 1), round(float(nc[held]), 1)] if held >= 0 else None,
        "element_ids": [int(x) for x in ds["element_id"].values],
        "h_m": [round(float(np.nanmin(ds["h"].values)), 2), round(float(np.nanmax(ds["h"].values)), 2)],
    }
    return info, nodes.tobytes(), tri.tobytes()


def section_geometry(ds, axis) -> dict:
    """The elements of a subset that a line (lon, lat vertices) crosses, in order along it, and where: one run per
    stretch of the line inside an element, with the stretch's two ends (east, north metres) and each end's three
    nodes (indices into the subset) and barycentric weights. `element_ids` (full-mesh indices, sorted, as
    read_volume returns them) are the elements to read; each run names its element by its place in that list."""
    from matplotlib.tri import Triangulation

    e, n = east_north(ds["node_lon"].values, ds["node_lat"].values)
    tri = np.asarray(ds["triangles"].values, dtype=np.int64)
    ae, an = east_north(np.array([p[0] for p in axis]), np.array([p[1] for p in axis]))
    xs, ys = [], []
    for i in range(len(ae) - 1):
        steps = max(1, int(math.hypot(ae[i + 1] - ae[i], an[i + 1] - an[i]) // SECTION_STEP_M))
        f = np.arange(steps) / steps
        xs.append(ae[i] + f * (ae[i + 1] - ae[i]))
        ys.append(an[i] + f * (an[i + 1] - an[i]))
    xs.append(ae[-1:])
    ys.append(an[-1:])
    x, y = np.concatenate(xs), np.concatenate(ys)
    found = Triangulation(e, n, tri).get_trifinder()(x, y)
    runs = []  # [subset element, first sample, last sample]
    for i, k in enumerate(found):
        if k < 0:
            continue
        if runs and runs[-1][0] == k and runs[-1][2] == i - 1:
            runs[-1][2] = i
        else:
            runs.append([int(k), i, i])
    runs = [r for r in runs if r[2] > r[1]]  # a lone sample is a corner clipped, not a stretch
    sub_ids = np.asarray(ds["element_id"].values, dtype=np.int64)
    ids = sorted({int(sub_ids[k]) for k, _, _ in runs})
    place = {g: j for j, g in enumerate(ids)}
    out = []
    for k, i0, i1 in runs:
        row = [place[int(sub_ids[k])]]
        for i in (i0, i1):
            row += [round(float(x[i]), 1), round(float(y[i]), 1), *[int(v) for v in tri[k]],
                    *[round(w, 4) for w in _barycentric(e, n, tri, k, float(x[i]), float(y[i]))]]
        out.append(row)
    return {"element_ids": ids, "runs": out,
            "run_layout": "section element, then for each end: east, north, three subset nodes, their three weights",
            "axis_en": [[round(float(a), 1), round(float(b), 1)] for a, b in zip(ae, an)]}


def stats(hours: dict[pd.Timestamp, dict]) -> dict:
    sp = np.concatenate([np.hypot(h["u"].astype(np.float64), h["v"].astype(np.float64)).ravel() for h in hours.values()]) * UV_STEP_MM / 1000
    z = np.concatenate([h["zeta"].astype(np.float64) for h in hours.values()]) / 1000
    out = {"speed_m_s_max": round(float(sp.max()), 3), "speed_m_s_p99": round(float(np.percentile(sp, 99)), 3)}
    if z.size:
        out["zeta_m"] = [round(float(z.min()), 3), round(float(z.max()), 3)]
    return out


# ---- the run ----

def anchor_time(store: Store, now: datetime) -> pd.Timestamp:
    """The meter's latest record (from v1/shore.json's meters), or now; never later than now."""
    doc = store.read_json("v1/shore.json") or {}
    last = (((doc.get("meters") or {}).get(METER) or {}).get("last_obs") or {}).get("time")
    return min(_naive(last), _naive(now)) if last else _naive(now)


def update(store: Store, end: datetime | None = None, max_new_days: int = 2, reader=None, places=PLACES) -> dict:
    """Bring every place's window up to date and publish it; returns a summary per place. A place that fails is
    logged and left as it was. `reader` (read_volume's signature) and `places` are for tests."""
    out = {}
    for place in places:
        try:
            out[place.key] = update_place(store, place, end, max_new_days, reader)
        except Exception as exc:
            log.warning("lis pane %s: not updated (%s)", place.key, exc)
            out[place.key] = {"error": f"{exc.__class__.__name__}: {str(exc)[:200]}"}
    return out


def update_place(store: Store, place: Place, end: datetime | None = None, max_new_days: int = 2, reader=None) -> dict:
    """One place's window, brought up to date and published."""
    from forcingkit.fetchers import necofs

    read = reader or necofs.read_volume
    sel = {"variables": list(VARIABLES)}
    if place.layers is not None:
        sel["layers"] = list(place.layers)
    end = end or now_utc()
    now = _naive(end)
    want = window_hours(anchor_time(store, end))
    _, hours = decode(store.read_bytes(place.rel("window.bin")))
    hours = {t: h for t, h in hours.items() if t in want}
    sec_hours: dict[pd.Timestamp, dict] = {}
    if place.axis:
        _, sec_hours = decode(store.read_bytes(place.rel("section.bin")))
        sec_hours = {t: h for t, h in sec_hours.items() if t in want}
    mesh_prev = store.read_json(place.rel("mesh.json")) or {}
    ids = mesh_prev.get("element_ids")
    section = mesh_prev.get("section") if place.axis else None
    sub = None  # the newest dataset read, for the subset's description

    def take(ds, source: str, url: str | None, keep=None) -> None:
        """A read's hours, and the section's for the same hours from the same file; if the subset is not the
        window's, the window starts again."""
        nonlocal sub, ids, hours, sec_hours, section
        got = [int(x) for x in ds["element_id"].values]
        if ids is not None and got != ids:
            log.warning("lis pane %s: the subset changed (%d elements, was %d); starting the window again", place.key, len(got), len(ids))
            hours, sec_hours, section = {}, {}, None
        ids, sub = got, ds
        new = {t: h for t, h in _hours_from(ds, source).items() if keep is None or t in keep}
        hours.update(new)
        if not place.axis or not new:
            return
        if section is None:
            section = section_geometry(ds, place.axis)
        ts = sorted(new)
        n = int((ts[-1] - ts[0]) / pd.Timedelta(hours=1)) + 1
        try:
            sds = read(None, ts[0], n, dap_url=url, variables=["u", "v"], elements=section["element_ids"])
        except Exception as exc:  # the section waits for a later run; the surface stands without it
            log.warning("lis pane %s: section from %s not read (%s)", place.key, ts[0], exc)
            return
        sec_hours.update({t: h for t, h in _hours_from(sds, source).items() if t in new})

    # The hindcast: archive days that would replace forecast hours or fill missing ones, newest first (the newest
    # may not be published yet; a day not read is tried again next run).
    days = sorted({necofs.necofs_archive_file_date(t) for t in want if t <= now and hours.get(t, {}).get("from") != "hindcast"}, reverse=True)
    added = []
    for day in days:
        if len(added) >= max_new_days:
            break
        in_day = [t for t in want if necofs.necofs_archive_file_date(t) == day]
        url = ARCHIVE.format(d=day.strftime("%Y_%m_%d"))
        try:  # the archive file itself: a day not published yet fails here (never the forecast in its place)
            ds = read(list(place.bbox), in_day[0], len(in_day), dap_url=url, **sel)
        except Exception as exc:
            log.info("lis pane %s: archive day %s not read (%s)", place.key, day.date(), exc)
            continue
        if ds.sizes.get("time", 0):
            take(ds, "hindcast", url)
            added.append(str(day.date()))
    # The forecast for the hours after the newest hindcast hour, a day per request: the server reads a request hour by
    # hour and layer by layer, and the whole window in one request outlasts its timeout. Older hours the hindcast
    # lacks wait for the archive days of later runs.
    last_hind = max((t for t, h in hours.items() if h["from"] == "hindcast"), default=None)
    rest = [t for t in want if last_hind is None or t > last_hind]
    for i in range(0, len(rest), FORECAST_HOURS_PER_READ):
        part = rest[i:i + FORECAST_HOURS_PER_READ]
        try:
            ds = read(list(place.bbox), part[0], len(part), **sel)
        except RuntimeError as exc:  # read_volume: the file holds none of these hours (before its start)
            if "none of" not in str(exc):
                raise
            continue
        except Exception as exc:
            log.warning("lis pane %s: forecast from %s not read (%s)", place.key, part[0], exc)
            break
        if ds.sizes.get("time", 0):
            take(ds, "forecast", None, set(part))
    hours = {t: h for t, h in hours.items() if t in want}
    sec_hours = {t: h for t, h in sec_hours.items() if t in hours}
    if not hours:
        return {"hours": 0, "added_days": added}

    keys = ("elements", "nodes", "layers", "sigma_uniform", "siglev", "siglay", "layer_index", "model_siglev",
            "buoy_element", "buoy_element_id", "buoy_element_centroid_en_m", "element_ids", "h_m")
    if sub is not None:
        info, nodes_b, tri_b = subset_files(sub)
        if info["element_ids"] != mesh_prev.get("element_ids"):
            store.write_bytes(place.rel("nodes.f32"), nodes_b, max_age=86400)
            store.write_bytes(place.rel("tri.u16"), tri_b, max_age=86400)
    else:
        info = {k: mesh_prev[k] for k in keys if k in mesh_prev}
    header = {"schema": SCHEMA, "source": SOURCE, "elements": info["elements"], "nodes": info["nodes"], "layers": info["layers"]}
    blob = encode(header, hours)
    ts = sorted(hours)
    files = {"nodes": "nodes.f32", "tri": "tri.u16", "window": "window.bin", "siglev": None}
    mesh = {
        "schema": SCHEMA,
        "place": {"key": place.key, "name": place.name},
        "source": f"{SOURCE}: daily history archive, then the rolling forecast",
        "generated_at": iso(end),
        **{k: info[k] for k in keys if k != "h_m" and k in info},
        "times": [_epoch(t) for t in ts],
        "forecast_from": next((_epoch(t) for t in ts if hours[t]["from"] == "forecast"), None),
        "files": files,
        "stats": {"h_m": info["h_m"], **stats(hours)},
        "frame": "east and north metres from the Groton current meter (41.39180 N, 72.09230 W); z up, metres",
        "bbox": list(place.bbox),
        "origin": {"id": METER, "name": "Groton current meter", "lon": ORIGIN[0], "lat": ORIGIN[1]},
    }
    sec_blob = None
    if place.axis and section is not None and sec_hours:
        L = len(info["model_siglev"]) - 1
        sec_blob = encode({"schema": SCHEMA, "source": SOURCE, "elements": len(section["element_ids"]), "nodes": 0,
                           "layers": L}, sec_hours)
        files["section"] = "section.bin"
        mesh["section"] = {**section, "layers": L, "times": [_epoch(t) for t in sorted(sec_hours)],
                           "stats": stats(sec_hours)}
        store.write_bytes(place.rel("section.bin"), sec_blob, max_age=3600)
    store.write_bytes(place.rel("window.bin"), blob, max_age=3600)
    store.write_json(place.rel("mesh.json"), mesh, max_age=3600)
    return {"hours": len(hours), "from": iso(pd.Timestamp(ts[0]).tz_localize("UTC")), "to": iso(pd.Timestamp(ts[-1]).tz_localize("UTC")),
            "hindcast": sum(h["from"] == "hindcast" for h in hours.values()), "added_days": added, "bytes": len(blob),
            "section_hours": len(sec_hours), "section_bytes": len(sec_blob) if sec_blob else 0}
