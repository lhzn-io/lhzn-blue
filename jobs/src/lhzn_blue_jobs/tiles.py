"""Tiles: model cells and their forecast as compact binary blobs, packed per run, in an R2 bucket (or a local folder).

Workers KV suits a few files a day; a field cut into hundreds of tiles does not (each tile a write, against the free
plan's 1,000 a day). Here each run writes one pack per model: its tiles' blobs one after another, each read by the
page with an HTTP range request, so a run costs a few writes however many tiles it holds. The packs are immutable and
named by run; `latest.json` (written last, cached for minutes) names the current run's files and indexes the tiles.

Blob layout (one gzip member, little-endian), shared by a tile and a whole-domain file:

    "LHZT", uint32 n, n bytes of JSON {nodes, elements, verts, steps, step_cms, index: "u16"|"u32"}, then
    float32 node lon, lat pairs (nodes * 2); the element node indices (elements * verts, uint16 or uint32);
    uint8 arrow level per element; then per time step one int8 per element east, then one north, in step_cms cm/s.

`step_cms` is chosen per blob so the fastest current in it fits int8 (2 cm/s for nearly all; more in the Bay of
Fundy's tidal races and the Gulf Stream's core), so nothing is clipped.

Tiles are Web Mercator z/x/y tiles holding the elements whose centers fall in them, split into their four children
while they hold more than MAX_TILE_ELEMENTS (down to MAX_ZOOM), so a tile stays small where a mesh is fine.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import struct
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

MAGIC = b"LHZT"
VALUES_MAGIC = b"LHZS"  # value-only blobs: scalar fields for the elements of the currents blob with the same key
BASE_ZOOM = 8
MAX_ZOOM = 13
MAX_TILE_ELEMENTS = 6000
DEFAULT_STEP_CMS = 2


# ---------------------------------------------------------------------------------------------
# Web Mercator tiles


def tile_xy(lon, lat, z: int) -> tuple[np.ndarray, np.ndarray]:
    """The z tile column and row holding each point."""
    n = 2**z
    lat_r = np.radians(np.clip(np.asarray(lat, dtype=np.float64), -85.0511, 85.0511))
    x = np.floor((np.asarray(lon, dtype=np.float64) + 180.0) / 360.0 * n)
    y = np.floor((1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / np.pi) / 2.0 * n)
    return np.clip(x, 0, n - 1).astype(np.int64), np.clip(y, 0, n - 1).astype(np.int64)


def pyramid(lon, lat, base: int = BASE_ZOOM, max_zoom: int = MAX_ZOOM, max_count: int = MAX_TILE_ELEMENTS) -> dict[str, np.ndarray]:
    """Leaf tiles ("z/x/y") and the indices of the points (element centers) in each: base-zoom tiles, split into their
    children while they hold more than max_count points and are above max_zoom. Every point is in exactly one leaf."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    out: dict[str, np.ndarray] = {}
    stack = [(base, np.arange(lon.size))]
    while stack:
        z, idx = stack.pop()
        x, y = tile_xy(lon[idx], lat[idx], z)
        key = x * (2**z) + y
        order = np.argsort(key, kind="stable")
        uniq, starts = np.unique(key[order], return_index=True)
        for k, s0, s1 in zip(uniq, starts, list(starts[1:]) + [order.size]):
            members = idx[order[s0:s1]]
            if members.size > max_count and z < max_zoom:
                stack.append((z + 1, members))
            else:
                out[f"{z}/{int(k) // (2**z)}/{int(k) % (2**z)}"] = members
    return out


# ---------------------------------------------------------------------------------------------
# Blobs


def step_cms(u_ms: np.ndarray, v_ms: np.ndarray) -> int:
    """The coarsest-needed int8 step, cm/s: 2, or more when the fastest current would not fit."""
    peak = float(np.nanmax(np.abs(np.concatenate([np.ravel(u_ms), np.ravel(v_ms)])), initial=0.0)) * 100.0
    return max(DEFAULT_STEP_CMS, int(np.ceil(peak / 127.0)))


def encode(nodes: np.ndarray, elements: np.ndarray, levels: np.ndarray, u_ms: np.ndarray, v_ms: np.ndarray) -> bytes:
    """One blob: nodes (n, 2) lon, lat; elements (m, verts) node indices; levels (m,) arrow levels; u, v (steps, m)
    in m/s (NaN as zero)."""
    nodes = np.asarray(nodes, dtype=np.float32).reshape(-1, 2)
    elements = np.asarray(elements, dtype=np.int64)
    steps, m = np.asarray(u_ms).shape
    if elements.shape[0] != m:
        raise ValueError(f"{elements.shape[0]} elements, {m} values per step")
    k = step_cms(u_ms, v_ms)
    big = nodes.shape[0] > 65535
    head = json.dumps(
        {"nodes": int(nodes.shape[0]), "elements": int(m), "verts": int(elements.shape[1]), "steps": int(steps), "step_cms": k, "index": "u32" if big else "u16"},
        separators=(",", ":"),
    ).encode()
    q = lambda a: np.clip(np.round(np.nan_to_num(np.asarray(a, dtype=np.float64)) * 100.0 / k), -127, 127).astype(np.int8)  # noqa: E731
    body = b"".join(
        [
            nodes.tobytes(),
            elements.astype(np.uint32 if big else np.uint16).tobytes(),
            np.asarray(levels, dtype=np.uint8).tobytes(),
            np.stack([q(u_ms), q(v_ms)], axis=1).tobytes(),  # (steps, 2, m)
        ]
    )
    return gzip.compress(MAGIC + struct.pack("<I", len(head)) + head + body, compresslevel=9, mtime=0)


def decode(blob: bytes) -> dict:
    """A blob back to arrays (u, v in m/s), for tests and checks."""
    raw = gzip.decompress(blob)
    if raw[:4] != MAGIC:
        raise ValueError("not a tile blob")
    (n,) = struct.unpack("<I", raw[4:8])
    h = json.loads(raw[8 : 8 + n])
    off = 8 + n
    nodes = np.frombuffer(raw, np.float32, h["nodes"] * 2, off).reshape(-1, 2)
    off += nodes.nbytes
    it = np.uint32 if h["index"] == "u32" else np.uint16
    elements = np.frombuffer(raw, it, h["elements"] * h["verts"], off).reshape(-1, h["verts"])
    off += elements.nbytes
    levels = np.frombuffer(raw, np.uint8, h["elements"], off)
    off += levels.nbytes
    q = np.frombuffer(raw, np.int8, h["steps"] * 2 * h["elements"], off).reshape(h["steps"], 2, h["elements"])
    k = h["step_cms"] / 100.0
    return {**h, "node_xy": nodes, "elements_ix": elements, "levels": levels, "u": q[:, 0] * k, "v": q[:, 1] * k}


def encode_values(fields: dict[str, np.ndarray]) -> bytes:
    """Scalar fields for the m elements of a currents blob, in its order, without geometry: gzip of "LHZS", a uint32
    header length, a JSON header {elements, steps, fields: [{name, offset, scale}], static: [...]}, then per field
    (name -> (steps, m)) one uint8 per step and element, value = offset + q * scale, 255 where there is none (NaN),
    then per static field (name -> (m,), such as the model's depth) one little-endian uint16 per element, 65535 where
    there is none. Each field's offset and scale span its own range in this blob, so a tile keeps fine steps; a
    static field's 16 bits keep a 5,000 m depth range to under 0.1 m. "static" is left out when there are none."""
    arrays = {k: np.asarray(a, dtype=np.float64) for k, a in fields.items()}
    still = {k: a for k, a in arrays.items() if a.ndim == 1}
    arrays = {k: a for k, a in arrays.items() if a.ndim == 2}
    steps, m = next(iter(arrays.values())).shape
    meta, body = [], []
    for name, a in arrays.items():
        ok = np.isfinite(a)
        lo = float(a[ok].min()) if ok.any() else 0.0
        hi = float(a[ok].max()) if ok.any() else 0.0
        scale = (hi - lo) / 254.0 if hi > lo else 1.0
        q = np.clip(np.round((np.where(ok, a, lo) - lo) / scale), 0, 254)
        meta.append({"name": name, "offset": lo, "scale": scale})
        body.append(np.where(ok, q, 255).astype(np.uint8).tobytes())
    static = []
    for name, a in still.items():
        if a.shape != (m,):
            raise ValueError(f"static field {name}: {a.shape} for {m} elements")
        ok = np.isfinite(a)
        lo = float(a[ok].min()) if ok.any() else 0.0
        hi = float(a[ok].max()) if ok.any() else 0.0
        scale = (hi - lo) / 65534.0 if hi > lo else 1.0
        q = np.clip(np.round((np.where(ok, a, lo) - lo) / scale), 0, 65534)
        static.append({"name": name, "offset": lo, "scale": scale})
        body.append(np.where(ok, q, 65535).astype("<u2").tobytes())
    header = {"elements": int(m), "steps": int(steps), "fields": meta, **({"static": static} if static else {})}
    head = json.dumps(header, separators=(",", ":")).encode()
    return gzip.compress(VALUES_MAGIC + struct.pack("<I", len(head)) + head + b"".join(body), compresslevel=9, mtime=0)


def decode_values(blob: bytes) -> dict:
    """A value blob back to arrays (NaN where there is none), for tests and checks."""
    raw = gzip.decompress(blob)
    if raw[:4] != VALUES_MAGIC:
        raise ValueError("not a value blob")
    (n,) = struct.unpack("<I", raw[4:8])
    h = json.loads(raw[8 : 8 + n])
    off, out = 8 + n, {}
    size = h["steps"] * h["elements"]
    for f in h["fields"]:
        q = np.frombuffer(raw, np.uint8, size, off).reshape(h["steps"], h["elements"])
        off += size
        out[f["name"]] = np.where(q == 255, np.nan, f["offset"] + q * f["scale"])
    for f in h.get("static", []):
        q = np.frombuffer(raw, "<u2", h["elements"], off)
        off += 2 * h["elements"]
        out[f["name"]] = np.where(q == 65535, np.nan, f["offset"] + q * f["scale"])
    return {**h, **out}


def subset(nodes: np.ndarray, elements: np.ndarray, members: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The chosen elements with their own nodes, renumbered from zero."""
    el = np.asarray(elements)[members]
    used, local = np.unique(el, return_inverse=True)
    return np.asarray(nodes)[used], local.reshape(el.shape)


# ---------------------------------------------------------------------------------------------
# Storage: an R2 bucket (S3 API) or a local folder


class TileStore:
    """`r2://<bucket>/<prefix>` (TILES_R2_ENDPOINT, TILES_R2_ACCESS_KEY_ID, TILES_R2_SECRET_ACCESS_KEY from the environment) or a local
    folder."""

    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self._s3 = None
        if self.root.startswith("r2://"):
            import boto3
            from botocore.config import Config

            self.bucket, _, self.prefix = self.root[5:].partition("/")
            self._s3 = boto3.client(
                "s3",
                endpoint_url=os.environ["TILES_R2_ENDPOINT"].strip(),
                aws_access_key_id=os.environ["TILES_R2_ACCESS_KEY_ID"].strip(),
                aws_secret_access_key=os.environ["TILES_R2_SECRET_ACCESS_KEY"].strip(),
                region_name="auto",
                config=Config(retries={"max_attempts": 4, "mode": "standard"}),
            )

    def _key(self, rel: str) -> str:
        return f"{self.prefix}/{rel}" if self._s3 and self.prefix else rel

    def put(self, rel: str, data: bytes, max_age: int, content_type: str = "application/octet-stream", immutable: bool = False) -> None:
        cache = f"public, max-age={max_age}" + (", immutable" if immutable else "")
        if self._s3:
            self._s3.put_object(Bucket=self.bucket, Key=self._key(rel), Body=data, ContentType=content_type, CacheControl=cache)
        else:
            path = Path(self.root) / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def get(self, rel: str) -> bytes | None:
        if self._s3:
            try:
                return self._s3.get_object(Bucket=self.bucket, Key=self._key(rel))["Body"].read()
            except self._s3.exceptions.NoSuchKey:
                return None
        path = Path(self.root) / rel
        return path.read_bytes() if path.exists() else None

    def runs(self, under: str) -> list[str]:
        """The run folders under `under` (names only)."""
        if self._s3:
            names: set[str] = set()
            pages = self._s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=self._key(under.rstrip("/") + "/"), Delimiter="/")
            for page in pages:
                for p in page.get("CommonPrefixes", []):
                    names.add(p["Prefix"].rstrip("/").rsplit("/", 1)[-1])
            return sorted(names)
        path = Path(self.root) / under
        return sorted(p.name for p in path.iterdir() if p.is_dir()) if path.exists() else []

    def delete_run(self, under: str, run: str) -> None:
        if self._s3:
            pages = self._s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=self._key(f"{under.rstrip('/')}/{run}/"))
            for page in pages:
                keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                if keys:
                    self._s3.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})
        else:
            import shutil

            shutil.rmtree(Path(self.root) / under / run, ignore_errors=True)


def store_for(data_root: str) -> TileStore | None:
    """The tile store: LHZN_BLUE_TILES if set; beside a local data folder (<folder>/tiles) for local runs; else None
    (the cloud jobs before R2 is set up)."""
    root = os.environ.get("LHZN_BLUE_TILES", "").strip()
    if root:
        return TileStore(root)
    if "://" not in data_root:
        return TileStore(str(Path(data_root) / "tiles"))
    return None
