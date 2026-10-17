"""Fetch the NWS marine zone outlines for Long Island Sound and save them smoothed for the map.

Writes apps/web/public/nws-zones-lis.json: a GeoJSON FeatureCollection, one feature per zone (id, name). The zones'
shore edges follow every harbour and river mouth, which at the map's scale reads as a ragged line, so each zone is
rasterised (about 150 m cells), closed with a disk about 700 m across (inlets narrower than about 1.4 km seal over;
the straight seaward and zone-to-zone edges are unchanged), traced back out, and simplified to about 100 m. Pieces
under 0.5 km2 are dropped. NWS zone outlines are public domain and change rarely (the last change on the Sound: ANZ330
split into ANZ331 and ANZ332 in April 2021); rerun this when NWS revises them.
Run: jobs/.venv/bin/python scripts/fetch-zones.py (numpy, scipy, matplotlib, contourpy, requests).
"""

import json
import math
from pathlib import Path

import contourpy
import numpy as np
import requests
from matplotlib.path import Path as Polygon
from scipy import ndimage

ZONES = ["ANZ335", "ANZ331", "ANZ332"]
H_DEG = 0.0014  # grid cell (latitude), about 150 m
CLOSE_KM = 0.35  # closing disk radius
MIN_KM2 = 0.5
TOL_DEG = 0.001  # final simplification, about 100 m
UA = {"User-Agent": "longhorizon.blue (https://longhorizon.blue; dfry@lhzn.io)", "Accept": "application/geo+json"}
OUT = Path(__file__).resolve().parents[1] / "apps/web/public/nws-zones-lis.json"


def dp(points: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas-Peucker on a polyline (iterative)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def dp_ring(ring: list[list[float]], tol: float) -> list[list[float]]:
    """A closed ring: split at the point farthest from its start (the two ends coincide), simplify each half."""
    x0, y0 = ring[0]
    k = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    return dp(ring[: k + 1], tol)[:-1] + dp(ring[k:], tol)


def area_km2(ring: list[list[float]], lat: float) -> float:
    kx, ky = 111.2 * math.cos(math.radians(lat)), 111.2
    return abs(sum((ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]) for i in range(len(ring) - 1))) / 2 * kx * ky


def smooth(polys: list[list[list[list[float]]]]) -> list[list[list[list[float]]]]:
    """Rasterise the zone (outer rings, holes cut out), close it, and trace it back out as polygons."""
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    lat = (min(ys) + max(ys)) / 2
    hx = H_DEG / math.cos(math.radians(lat))
    pad = 6
    gx = np.arange(min(xs) - pad * hx, max(xs) + pad * hx, hx)
    gy = np.arange(min(ys) - pad * H_DEG, max(ys) + pad * H_DEG, H_DEG)
    X, Y = np.meshgrid(gx, gy)
    pts = np.column_stack([X.ravel(), Y.ravel()])
    inside = np.zeros(X.size, bool)
    for poly in polys:
        part = Polygon(poly[0]).contains_points(pts)
        for hole in poly[1:]:
            part &= ~Polygon(hole).contains_points(pts)
        inside |= part
    grid = inside.reshape(X.shape)
    r = max(1, round(CLOSE_KM / (H_DEG * 111.2)))
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    closed = ndimage.binary_closing(np.pad(grid, r + 1), structure=(xx * xx + yy * yy) <= r * r)[r + 1 : -(r + 1), r + 1 : -(r + 1)]
    loops = contourpy.contour_generator(gx, gy, closed.astype(float)).lines(0.5)
    out = []
    for loop in loops:
        ring = [[float(x), float(y)] for x, y in loop]
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        if len(ring) < 4 or area_km2(ring, lat) < MIN_KM2:
            continue
        s = dp_ring(ring, TOL_DEG)
        if len(s) >= 4:
            out.append([[[round(x, 4), round(y, 4)] for x, y in s]])
    return out


def main() -> None:
    feats = []
    for z in ZONES:
        r = requests.get(f"https://api.weather.gov/zones/marine/{z}", headers=UA, timeout=60)
        r.raise_for_status()
        j = r.json()
        g = j["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        out_polys = smooth(polys)
        feats.append({
            "type": "Feature",
            "id": z,
            "properties": {"id": z, "name": j["properties"]["name"]},
            "geometry": {"type": "MultiPolygon", "coordinates": out_polys},
        })
        print(f"{z}: {sum(len(p[0]) for p in polys)} points -> {sum(len(p[0]) for p in out_polys)} in {len(out_polys)} pieces")
    OUT.write_text(json.dumps({"type": "FeatureCollection", "source": "NWS marine zones (api.weather.gov), smoothed",
                               "features": feats}, separators=(",", ":")))
    print(OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
