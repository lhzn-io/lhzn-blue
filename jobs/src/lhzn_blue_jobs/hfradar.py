"""The Sound's HF radar surface currents, kept beyond the public server's rolling window.

The Western Long Island Sound HF radar sites are operated by the University of Connecticut (LISICOS); the NOAA IOOS HF
Radar National Network (HFRNet) combines their radials into hourly total vectors, which NOAA NDBC serves for about 92
days. forcingkit's ``hfradar`` fetcher reads them and writes the archive: one NetCDF-4 file per UTC day and grid, values
as stored on the server, with the credit in ``source_credit`` (see its documentation for the layout). This module only
says which box and where: the Sound's box, into a local directory (by default forcingkit's own cache,
``FORCINGKIT_CACHE_DIR/hfradar``) or a gs://bucket/prefix the job may create objects in but neither read, overwrite
nor delete. The snapshot job runs it three times a week; ``hfradar --start all`` takes every day the server holds.
"""

from __future__ import annotations

import requests
from forcingkit.fetchers import hfradar

from .merlin import USER_AGENT

# The Sound from the East River to past New London: [min_lon, min_lat, max_lon, max_lat].
BBOX = [-73.8, 40.85, -71.8, 41.3]


class Bucket:
    """A gs://bucket/prefix, create-only: the job cannot read the bucket, so `has` is always False and `put` refuses
    an existing object."""

    def __init__(self, root: str):
        from google.cloud import storage

        bucket, _, prefix = root[5:].partition("/")
        self.bucket = storage.Client().bucket(bucket)
        self.prefix = prefix.strip("/")

    def has(self, name: str) -> bool:
        return False

    def put(self, name: str, data: bytes) -> bool:
        from google.api_core.exceptions import PreconditionFailed

        if not hfradar.NAME.fullmatch(name):
            raise ValueError(f"refusing to write {name}")
        path = f"{self.prefix}/{name}" if self.prefix else name
        try:
            self.bucket.blob(path).upload_from_string(data, content_type="application/x-netcdf", if_generation_match=0)
        except PreconditionFailed:
            return False
        return True


def store(root: str | None):
    """The archive: a bucket for gs://, else a directory (forcingkit's cache when ``root`` is None)."""
    if root and root.startswith("gs://"):
        return Bucket(root)
    return hfradar.LocalStore(root)


def archive(root: str | None, start: str | None = None, end: str | None = None) -> dict[str, list[str]]:
    """Keep every ready day of the Sound's box not yet kept, at 1 km and 2 km (forcingkit ``hfradar.archive``)."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    return hfradar.archive(BBOX, start, end, store=store(root), session=session)
