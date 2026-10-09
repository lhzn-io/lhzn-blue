#!/usr/bin/env python3
"""Fetch drainage basins for the river gauges from the USGS Network-Linked Data Index (NLDI) and write a
simplified GeoJSON for the page's watershed map.

    python3 scripts/fetch-basins.py [stations/rivers.json] [apps/web/public/basins.geojson]

Two shapes per river: the gauged basin (the area above the gauge, which is what its flow measures) and the
watershed of its river system down to the mouth on the Sound (traced downstream from the gauge along NHDPlus
flowlines to the last one, then the basin above that; a gauge's registry entry can name the outlet instead,
where tracing runs past the mouth). Gauges on one system share its watershed, for example the Naugatuck within
the Housatonic and the Shetucket, Yantic and Quinebaug within the Thames.

Basins do not change, so this runs by hand when a gauge is added, not in the scheduled jobs. Outlines are
simplified (Douglas-Peucker, scaled to each basin: 1 km for large ones, 200 m for small) and rounded to 4 decimals
(about 10 m) so the file stays small; they are for locating a watershed on a map, not for measuring it.
Standard library only.
"""

import json
import sys
import urllib.request
from pathlib import Path

NLDI = "https://api.water.usgs.gov/nldi/linked-data"
TOLERANCE = 0.01  # degrees, about 1 km


def get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "lhzn-blue/0.1 (+https://longhorizon.blue)"})
    return json.load(urllib.request.urlopen(req, timeout=120))


def simplify(points: list, tol: float) -> list:
    """Douglas-Peucker on one ring (iterative, so long rings do not hit the recursion limit)."""
    if len(points) < 5:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    # A closed ring starts and ends on the same point, so split it first at the point farthest from the start.
    x0, y0 = points[0]
    far = max(range(1, len(points) - 1), key=lambda i: (points[i][0] - x0) ** 2 + (points[i][1] - y0) ** 2)
    keep[far] = True
    stack = [(0, far), (far, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    out = [p for p, k in zip(points, keep) if k]
    return out if len(out) >= 4 else points


def shape(geom: dict) -> list:
    """Simplified outer rings as MultiPolygon coordinates. The tolerance follows the basin's size (a 200th of its
    extent, between 200 m and 1 km), so a small watershed keeps its shape and a large one stays light."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    pts = [p for poly in polys for p in poly[0]]
    extent = max(max(p[0] for p in pts) - min(p[0] for p in pts), max(p[1] for p in pts) - min(p[1] for p in pts))
    tol = min(TOLERANCE, max(TOLERANCE / 5, extent / 200))
    return [[[[round(x, 4), round(y, 4)] for x, y in simplify(poly[0], tol)]] for poly in polys]  # holes do not matter here


def outlet(usgs_id: str) -> int:
    """The NHDPlus flowline where the river below this gauge ends (the mouth): the one whose end starts no other."""
    lines = get(f"{NLDI}/nwissite/USGS-{usgs_id}/navigation/DM/flowlines?distance=400")["features"]
    def ends(f):
        c = f["geometry"]["coordinates"]
        pts = c if f["geometry"]["type"] == "LineString" else [p for line in c for p in line]
        return tuple(round(v, 5) for v in pts[0]), tuple(round(v, 5) for v in pts[-1])
    starts = {ends(f)[0] for f in lines}
    last = [f for f in lines if ends(f)[1] not in starts]
    if len(last) != 1:
        raise RuntimeError(f"{usgs_id}: expected one last flowline downstream, found {len(last)}")
    return int(last[0]["properties"]["nhdplus_comid"])


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    registry = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "stations" / "rivers.json"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "apps" / "web" / "public" / "basins.geojson"
    gauges = json.loads(registry.read_text())["gauges"]
    watersheds, gauged = {}, []
    for g in gauges:
        geom = get(f"{NLDI}/nwissite/USGS-{g['usgs_id']}/basin?simplified=true&splitCatchment=false")["features"][0]["geometry"]
        coords = shape(geom)
        system = g.get("system", g["river"])
        gauged.append(
            {
                "type": "Feature",
                "id": g["id"],
                "properties": {"id": g["id"], "kind": "gauged", "river": g["river"], "watershed": f"WS-{system}", "usgs_id": g["usgs_id"]},
                "geometry": {"type": "MultiPolygon", "coordinates": coords},
            }
        )
        print(f"{g['id']} {g['river']}: gauged basin, {sum(len(p[0]) for p in coords)} vertices")
        if system not in watersheds:
            # The registry can name the outlet where tracing would run past the river's mouth (see outlet_note).
            comid = g.get("outlet_comid") or outlet(g["usgs_id"])
            ws = get(f"{NLDI}/comid/{comid}/basin?simplified=true&splitCatchment=false")["features"][0]["geometry"]
            wcoords = shape(ws)
            watersheds[system] = {
                "type": "Feature",
                "id": f"WS-{system}",
                "properties": {"id": f"WS-{system}", "kind": "watershed", "system": system, "outlet_comid": comid},
                "geometry": {"type": "MultiPolygon", "coordinates": wcoords},
            }
            print(f"   {system} watershed to the mouth (NHDPlus {comid}): {sum(len(p[0]) for p in wcoords)} vertices")
    # Watersheds first, so the gauged basins draw on top of them.
    fc = {"type": "FeatureCollection", "source": "USGS NLDI basins, simplified", "features": list(watersheds.values()) + gauged}
    out.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
