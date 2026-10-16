#!/usr/bin/env python3
"""Build the schematic outline of Long Island Sound that the Tides view draws in place of the map.

The Tides view shows water level at a handful of gauges, which are points; a basemap would invite the eye to read
the water between them, which is not measured. So the view draws the Sound as a diagram instead: two shores in line
work, north up, at true scale, with the gauges at their true positions and nothing drawn between them.

The shores are induced from the Census Bureau's TIGER areal hydrography (public domain): its water polygons, of which
the Sound's own (connected to mid-Sound) are kept. Smoothed at a chosen scale:

1. Rasterise the water on a 100 m grid in km east and north of Kings Point.
2. Keep the Sound alone: islands become water; the Sound is the open water connected to mid-Sound, cut at the East
   River (west of Throgs Neck) and by a line south-east from Orient Point (the Peconic and Gardiners Bay stay out).
3. Gaussian-blur that water with width SIGMA and take its 0.5 contour: inlets and islands smaller than about SIGMA
   go, the basins, bays, necks and headlands keep their proportions. A neck the smoothing would cut loose from its
   isthmus (Eatons Neck on Asharoken) keeps the isthmus as a narrow spit. Cut the contour into the two shores; the Long
   Island shore stops just short of Orient Point, so the North Fork is not drawn.
4. The islands at the mouth (Plum, Fishers) are drawn only as their north shores, the side that faces the Sound.
5. Rivers: the channels up the Byram, Mianus, Rippowam, Norwalk, Saugatuck, Housatonic, Quinnipiac, Connecticut and
   Thames, and the Nissequogue and Mattituck Creek on Long Island, as centre lines from where each
   leaves the smoothed shore to as far as RIVER_KM.
6. A finer outline (SIGMA_FINE) for close zoom, made the same way.

The water polygons come from TIGERweb's Hydro service (layer 1, Areal Hydrography), saved once as GeoJSON:

    python3 ~/.cache/lhzn-blue/schematic/tiger_water.py   # or any GeoJSON of the same features

Writes apps/web/public/schematic-lis.json (committed, so the site build needs no Python). Run when the water or
the gauges change, with the jobs' environment (numpy, scipy, matplotlib, contourpy):

    jobs/.venv/bin/python scripts/build-schematic.py tiger_areawater.geojson [sigma km]
"""

import json
import math
import sys
from pathlib import Path

import contourpy
import numpy as np
from matplotlib.path import Path as Polygon
from scipy import ndimage

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "apps" / "web" / "public" / "schematic-lis.json"
SIGMA_FINE = 0.3  # km: the outline for close zoom
CLOSE_KM = 0.3  # water gaps under twice this are closed (see the closing below)
SIGMA = 0.75  # km: the big necks stay (Lloyd, Eatons) and both shores read at one level of detail

H = 0.05  # grid spacing, km: fine enough that a beach like Asharoken (about 150 m) stays land
X0, X1, Y0, Y1 = -14.0, 160.0, -15.0, 80.0

KPTN = (-73.7649, 40.8103)
NLON = (-72.09556, 41.371666)
ORIENT = (-72.2400, 41.1620)
KX = 111.32 * math.cos(math.radians(41.0))  # km per degree of longitude
KY = 110.95

# Rivers drawn as hairlines, from the mouth (approximate) upstream.
RIVERS = [
    {"name": "Byram River", "lon": -73.6560, "lat": 40.9930, "from": "N", "search_km": 3.0},
    {"name": "Mianus River", "lon": -73.5900, "lat": 41.0230, "from": "N", "search_km": 3.0},
    {"name": "Rippowam River", "lon": -73.5380, "lat": 41.0400, "from": "N", "search_km": 3.0},
    {"name": "Norwalk River", "lon": -73.4130, "lat": 41.0900, "from": "N", "search_km": 3.0},
    {"name": "Saugatuck River", "lon": -73.3700, "lat": 41.1030, "from": "N", "search_km": 3.0},
    {"name": "Housatonic River", "lon": -73.1050, "lat": 41.1800, "from": "N"},
    {"name": "Quinnipiac River", "lon": -72.9050, "lat": 41.2900, "from": "N"},
    {"name": "Connecticut River", "lon": -72.3480, "lat": 41.2780, "from": "N"},
    {"name": "Thames River", "lon": -72.0900, "lat": 41.3350, "from": "N"},
    {"name": "Nissequogue River", "lon": -73.2250, "lat": 40.9120, "from": "S"},
    {"name": "Mattituck Creek", "lon": -72.5630, "lat": 41.0150, "from": "S", "search_km": 3.0},
]
RIVER_KM = 40.0

# Shores stated where the test by position cannot tell (the Sound's narrow west end).
SIDE = {"KPTN": "S"}
MIN_ISLAND_KM2 = 0.5  # Plum and Fishers; the Gulls and the islets along the shore are left out

# Gauges drawn on the outline: NOAA's (stations/shore.json) and the USGS tidal gauges with a level
# (stations/usgs-tidal.json), each placed on its shore.
USGS_FILE = REPO / "stations" / "usgs-tidal.json"


def world(lon, lat):
    return (np.asarray(lon) - KPTN[0]) * KX, (np.asarray(lat) - KPTN[1]) * KY


def soften(pts: np.ndarray, k: int = 2) -> np.ndarray:
    """A short Gaussian along the line (sigma k points): the grid's steps go, the shape stays."""
    w = np.exp(-0.5 * (np.arange(-3 * k, 3 * k + 1) / k) ** 2)
    out = np.empty_like(pts)
    for c in range(2):
        padded = np.pad(pts[:, c], 3 * k, mode="edge")
        out[:, c] = np.convolve(padded, w / w.sum(), mode="valid")
    return out


def main() -> None:
    global SIGMA
    if len(sys.argv) > 2:
        SIGMA = float(sys.argv[2])
    feats = json.loads(Path(sys.argv[1]).read_text())["features"]
    gx, gy = np.arange(X0, X1, H), np.arange(Y0, Y1, H)
    water = np.zeros((gy.size, gx.size), dtype=bool)
    kept = 0
    for f in feats:
        # Every class: TIGER's are not reliable here (a piece of the open Sound off Lloyd Neck is coded as a lake),
        # and the flood fill from mid-Sound leaves inland water out anyway.
        if not f.get("geometry"):
            continue
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        # Even-odd over all the rings: a cell is water when an odd number of rings contain it, so holes and outer
        # rings work whatever order the service gives them in.
        for rings in polys:
            rs = [np.c_[world(*np.array(r).T)] for r in rings]
            allp = np.vstack(rs)
            if allp[:, 0].max() < X0 or allp[:, 0].min() > X1 or allp[:, 1].max() < Y0 or allp[:, 1].min() > Y1:
                continue
            i0, i1 = max(0, int((allp[:, 0].min() - X0) / H)), min(gx.size, int((allp[:, 0].max() - X0) / H) + 2)
            j0, j1 = max(0, int((allp[:, 1].min() - Y0) / H)), min(gy.size, int((allp[:, 1].max() - Y0) / H) + 2)
            if i1 <= i0 or j1 <= j0:
                continue
            sx, sy = np.meshgrid(gx[i0:i1], gy[j0:j1])
            cells = np.c_[sx.ravel(), sy.ravel()]
            inside = np.zeros(len(cells), dtype=bool)
            for r in rs:
                inside ^= Polygon(r).contains_points(cells)
            water[j0:j1, i0:i1] |= inside.reshape(sx.shape)
            kept += 1
    print(f"{kept} water polygons rasterised")

    # Water gaps narrower than about 0.6 km are closed (a morphological closing of the land, radius 0.3 km): the necks
    # keep their isthmuses (Asharoken, the Lloyd Neck causeway), and creeks through thin land (to the Peconic behind
    # the North Fork) no longer join waters that are apart.
    raw_water = water.copy()  # rivers are traced on this: the closing fills channels narrower than the gap
    r = int(round(CLOSE_KM / H))
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    water &= ~ndimage.binary_closing(~water, structure=(xx * xx + yy * yy) <= r * r)

    # Small islands, and the islands at the mouth (drawn separately by their north shores), become water; larger land
    # in the Sound stays land.
    lab, n_land = ndimage.label(~water)
    edge = set(np.unique(np.r_[lab[0], lab[-1], lab[:, 0], lab[:, -1]])) - {0}
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(n_land + 1)) * H * H
    cxs = ndimage.mean(np.broadcast_to(gx, lab.shape), lab, index=np.arange(n_land + 1))
    drop = [k for k in range(1, n_land + 1) if k not in edge and (sizes[k] < 1.0 or cxs[k] >= 120)]
    open_water = water | np.isin(lab, drop)
    mainland = np.isin(lab, list(edge))  # land joined to the frame: Long Island, Connecticut, Westchester

    # The Sound: connected to mid-Sound, east of the East River cut, north of the line south-east from Orient Point.
    west_cut = -2.0
    ox, oy = (float(v) for v in world(*ORIENT))
    GX, GY = np.meshgrid(gx, gy)
    allowed = open_water & (GX >= west_cut) & ~((GX >= ox - 0.5) & (GY < oy - (GX - ox) * 0.45))
    lab2, _ = ndimage.label(allowed)
    seed = lab2[int((40 - Y0) / H), int((70 - X0) / H)]
    if seed == 0:
        raise SystemExit("the mid-Sound seed is not in the water")
    sound = lab2 == seed

    def outline(sigma):
        soft = ndimage.gaussian_filter(sound.astype(float), sigma / H, mode="constant")
        # Necks keep their isthmuses: smoothing erases a narrow beach with water on both sides (Asharoken under
        # Eatons Neck), leaving the neck an island. Land the raw coastline joins to the mainland but the smoothing cut
        # loose gets its connecting land back, widened to about 0.3 km so it reads as a spit.
        landb = soft < 0.5
        labb, nb = ndimage.label(landb)
        edgeb = set(np.unique(np.r_[labb[0], labb[-1], labb[:, 0], labb[:, -1]])) - {0}
        lost = ndimage.binary_dilation(mainland & ~landb, iterations=max(1, int(round(0.15 / H))))
        for k in range(1, nb + 1):
            if k in edgeb:
                continue
            comp = labb == k
            if comp.sum() * H * H < 0.3 or not (comp & mainland).any():
                continue
            near = ndimage.binary_dilation(comp, iterations=int(round(3.0 / H)))
            soft = np.where(lost & near, np.minimum(soft, 0.3), soft)
        loop = max(contourpy.contour_generator(gx, gy, soft).lines(0.5), key=len)
        cap = (loop[:, 0] < west_cut + 0.3) | (loop[:, 0] > X1 - 0.6) | (loop[:, 1] < Y0 + 0.6)
        pieces, cur = [], []
        for p, c in zip(loop, cap):
            if c:
                if len(cur) > 10:
                    pieces.append(np.array(cur))
                cur = []
            else:
                cur.append(p)
        if len(cur) > 10:
            pieces.append(np.array(cur))
        pieces = sorted((pc if pc[0, 0] < pc[-1, 0] else pc[::-1] for pc in pieces), key=len, reverse=True)[:2]
        north, south = sorted(pieces, key=lambda pc: pc[:, 1].mean(), reverse=True)  # the northern piece first
        cut = int(np.argmax(south[:, 0] >= ox - 1.5))
        south = south[: cut or len(south)]
        return soften(north[::2]), soften(south[::2]), soft

    north, south, soft = outline(SIGMA)
    fine_north, fine_south, _ = outline(SIGMA_FINE)

    def snap(curve, lon, lat):
        x, y = (float(v) for v in world(lon, lat))
        i = int(np.argmin((curve[:, 0] - x) ** 2 + (curve[:, 1] - y) ** 2))
        return [round(float(curve[i, 0]), 2), round(float(curve[i, 1]), 2)]

    # The islands at the mouth, as their north shores: for each column, the island's top edge.
    islands = []
    for k in range(1, n_land + 1):
        if k in edge:
            continue
        rows, cols = np.nonzero(lab == k)
        if rows.size * H * H < MIN_ISLAND_KM2:
            continue
        cx, cy = gx[cols].mean(), gy[rows].mean()
        if cx < 120 or cy < oy - (cx - ox) * 0.45:  # only the mouth, on the Sound's side of the Orient Point line
            continue
        top = {}
        for r, c in zip(rows, cols):
            top[c] = max(top.get(c, r), r)
        cs = sorted(top)
        edge_line = np.array([[gx[c], gy[top[c]] + H / 2] for c in cs])
        if len(edge_line) >= 4:
            islands.append(soften(edge_line, 2))

    # Rivers: the channel water outside the smoothed Sound, walked upstream from where it leaves the shore; the line
    # is the centre of the channel at each 0.3 km of distance along it.
    from collections import deque
    channel = raw_water & (soft < 0.5)
    sound_edge = ndimage.binary_dilation(soft >= 0.5)
    chan_lab, _ = ndimage.label(channel, structure=np.ones((3, 3)))  # corner-joined cells count: narrow inlets
    rivers = []
    for rv in RIVERS:
        mx_, my_ = (float(v) for v in world(rv["lon"], rv["lat"]))
        i0, j0 = int((mx_ - X0) / H), int((my_ - Y0) / H)
        # Wide estuaries are part of the outline, so a river's channel may leave it well upstream (15 km); a small
        # creek gets a short radius, so a larger water body nearby is not taken for it.
        win = int(round(rv.get("search_km", 15.0) / H))
        js, is_ = np.nonzero(channel[max(0, j0 - win) : j0 + win, max(0, i0 - win) : i0 + win] & sound_edge[max(0, j0 - win) : j0 + win, max(0, i0 - win) : i0 + win])
        js, is_ = js + max(0, j0 - win), is_ + max(0, i0 - win)
        # Each river on its own side of the Sound (not a bay across it): Connecticut's from the north, Long Island's
        # from the south.
        own_side = gy[js] >= my_ - 1.0 if rv["from"] == "N" else gy[js] <= my_ + 1.0
        js, is_ = js[own_side], is_[own_side]
        if js.size == 0:
            print(f"{rv['name']}: no channel found")
            continue
        comps = chan_lab[js, is_]
        sizes = {c: int((chan_lab == c).sum()) for c in set(comps.tolist())}
        best = max(sizes, key=sizes.get)  # the river: the largest channel touching the water near its mouth
        dist = np.full(channel.shape, -1, dtype=int)
        q = deque()
        for j, i, c in zip(js, is_, comps):
            if c == best:
                dist[j, i] = 0
                q.append((j, i))
        limit = int(RIVER_KM / H)
        while q:
            j, i = q.popleft()
            if dist[j, i] >= limit:
                continue
            for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                a2, b2 = j + dj, i + di
                if 0 <= a2 < channel.shape[0] and 0 <= b2 < channel.shape[1] and channel[a2, b2] and dist[a2, b2] < 0:
                    dist[a2, b2] = dist[j, i] + 1
                    q.append((a2, b2))
        line, step = [], 3
        for d0 in range(0, limit, step):
            jj, ii = np.nonzero((dist >= d0) & (dist < d0 + step))
            if jj.size == 0:
                break
            line.append([float(gx[ii].mean()), float(gy[jj].mean())])
        if len(line) >= 4:
            rivers.append({"name": rv["name"], "line": soften(np.array(line), 2)})
            print(f"{rv['name']}: {len(line) * step * H:.1f} km")
        else:
            print(f"{rv['name']}: no line ({len(q) if False else int((dist == 0).sum())} sources, channel of {sizes[best]} cells, {len(line)} steps)")

    shore = json.loads((REPO / "stations" / "shore.json").read_text())["stations"]
    gauges = []
    for s in shore:
        x, y = (float(v) for v in world(s["lon"], s["lat"]))
        side = SIDE.get(s["id"]) or ("S" if y < np.interp(x, south[:, 0], south[:, 1]) + 3 else "N")
        gauges.append({"id": s["id"], "name": s["name"], "side": side, "kind": "site", "at": snap(north if side == "N" else south, s["lon"], s["lat"])})
    for g in json.loads(USGS_FILE.read_text())["gauges"]:
        if "level" not in g["parameters"]:
            continue
        gauges.append({"id": g["id"], "name": g["short"], "side": g["side"], "kind": "site", "operator": "USGS",
                       "at": snap(north if g["side"] == "N" else south, g["lon"], g["lat"])})
    gauges.sort(key=lambda q: q["at"][0])

    rnd = lambda c: [[round(float(a), 2), round(float(b), 2)] for a, b in c]
    OUT.write_text(json.dumps({
        "schema": 1,
        "about": "Long Island Sound in outline, km east (x) and north (y) of Kings Point, north up: Census TIGER "
                 f"areal hydrography, Gaussian-smoothed at {SIGMA:g} km (scripts/build-schematic.py)",
        "source": "US Census Bureau, TIGER/Line areal hydrography (public domain)",
        "sigma_km": SIGMA,
        "north": rnd(north),
        "south": rnd(south),
        "islands": [rnd(i) for i in islands],
        "rivers": [{"name": r["name"], "line": rnd(r["line"])} for r in rivers],
        "fine": {"sigma_km": SIGMA_FINE, "north": rnd(fine_north), "south": rnd(fine_south)},
        "gauges": gauges,
    }, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(REPO)}: north {len(north)} pts, south {len(south)} pts, {len(gauges)} gauges, "
          f"{len(islands)} islands, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
