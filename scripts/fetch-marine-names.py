#!/usr/bin/env python3
"""Fetch undersea feature names and marine protected areas for the Northeast Shelf page's optional overlays.

    python3 scripts/fetch-marine-names.py [apps/web/public/northeast-shelf] [--cache records.json]

Writes two files into the directory:

- names.geojson: points for undersea features (canyons, seamounts, banks, basins, ledges and the like) from the
  Marine Regions gazetteer (VLIZ; CC-BY 4.0). In US waters its records come from the US Board on Geographic
  Names Advisory Committee on Undersea Features (ACUF), which names the shelf-break canyons (Veatch,
  Hydrographer, Welker and others) that the IHO-IOC GEBCO Gazetteer lacks. Each point carries a rank, so the page
  shows the large features first and the small ones as it zooms in.
- mpa.geojson: every site in NOAA's Marine Protected Areas Inventory (public domain) with marine area inside the
  page's bounds, outlines simplified to about 100 m. The inventory is a catalog, not the regulatory boundaries.

Both sources change rarely, so this runs by hand, not in the scheduled jobs. The gazetteer has no bounding-box
query, so every record of each kept type is paged worldwide: about an hour. `--cache` keeps those records in a
local file and reuses it on the next run. Standard library only.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BOUNDS = (-76.5, 35.0, -64.5, 45.3)  # the shelf page's open view: Cape Hatteras to Nova Scotia
MR = "https://www.marineregions.org/rest"
MPA = "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_MPA_Inventory_2023/FeatureServer/0/query"
UA = {"User-Agent": "lhzn-blue/0.1 (+https://longhorizon.blue)"}

# Marine Regions place types kept, by rank: 1 shows at the opening zoom, 2 at the regional zoom, 3 close in.
RANKS: dict[str, int] = {
    **dict.fromkeys(["Abyssal Plain", "Plateau", "Seamount Chain", "Continental Rise"], 1),
    **dict.fromkeys(
        ["Canyon(s)", "Seamount(s)", "Bank", "Basin", "Rise", "Trough", "Guyot(s)", "Tablemount", "Valley",
         "Submarine valley(s)", "Shelf Channel", "Gap", "Ridge(s)", "Escarpment", "Fan", "Seachannel", "Channel", "Spur",
         "Saddle"],
        2,
    ),
    **dict.fromkeys(
        ["Shoal", "Ledge(s)", "Knoll(s)", "Hill(s)", "Sandbank", "Swale", "Hole", "Deep", "Pinnacle", "Peak", "Sill",
         "Terrace", "Moat", "Levee", "Apron", "Mound", "Sunker", "Shelf Edge"],
        3,
    ),
}
# Features that read as regions rather than places: shown from the opening zoom whatever their type.
PROMOTE = {"Georges Bank", "Browns Bank", "Nantucket Shoals", "Hudson Canyon", "Hudson Shelf Valley", "Jordan Basin",
           "Georges Basin", "Wilkinson Basin", "Northeast Channel", "Great South Channel"}
LABEL = {"Canyon(s)": "Canyon", "Seamount(s)": "Seamount", "Guyot(s)": "Guyot", "Ridge(s)": "Ridge", "Knoll(s)": "Knoll",
         "Hill(s)": "Hill", "Ledge(s)": "Ledge", "Submarine valley(s)": "Valley"}
# Gazetteers kept, by preference for a duplicate name; records from other references (papers, encyclopedias) are left out.
SOURCE = {"US BGN Advisory Committee on Undersea Features (ACUF)": "ACUF",
          "Canadian Geographical Names Database (CGND)": "CGNDB",
          "IHO-IOC GEBCO Gazetteer of Undersea Feature Names": "GEBCO"}
# Inventory sites inside the bounds that are not on the sea: the Great Lakes sanctuary at the box's northwest corner.
FRESHWATER = {"Lake Ontario National Marine Sanctuary"}
SIMPLIFY = 0.001  # degrees, about 100 m: protected-area outlines are for locating a site, not measuring it


def get(url: str, params: dict | None = None) -> object:
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                body = r.read()
            return json.loads(body) if body.strip() else []
        except urllib.error.HTTPError as e:
            if e.code == 404:  # Marine Regions answers 404 past a type's last page, or for a type with no records
                return []
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
        except (OSError, ValueError):
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    return []


def inside(lon: float, lat: float, b: tuple = BOUNDS) -> bool:
    return b[0] <= lon <= b[2] and b[1] <= lat <= b[3]


def gazetteer(place_type: str) -> list[dict]:
    """Every record of one type, worldwide (the API pages by 100 and has no bounding-box query)."""
    out: list[dict] = []
    offset = 0
    while True:
        page = get(f"{MR}/getGazetteerRecordsByType.json/{urllib.parse.quote(place_type)}/", {"offset": offset})
        if not isinstance(page, list) or not page:
            return out
        out += page
        offset += len(page)
        time.sleep(0.3)


def name_features(records: list[dict]) -> list[dict]:
    """Points inside the bounds, standard names only, one per name and type (ACUF first, then GEBCO)."""
    pref = {"ACUF": 0, "CGNDB": 1, "GEBCO": 2}
    best: dict[tuple[str, str], dict] = {}
    for r in records:
        lon, lat, kind = r.get("longitude"), r.get("latitude"), r.get("placeType")
        if lon is None or lat is None or kind not in RANKS or not inside(lon, lat):
            continue
        if r.get("status") != "standard" or r.get("accepted") not in (None, r.get("MRGID")):
            continue
        name = (r.get("preferredGazetteerName") or "").strip()
        if not name:
            continue
        src = SOURCE.get(r.get("gazetteerSource") or "")
        if src is None:
            continue
        key = (name, kind)
        if key in best and pref.get(best[key]["properties"]["src"], 9) <= pref.get(src, 9):
            continue
        best[key] = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
            "properties": {
                "name": name,
                "kind": LABEL.get(kind, kind),
                "rank": 1 if name in PROMOTE else RANKS[kind],
                "src": src,
                "mrgid": r.get("MRGID"),
            },
        }
    return sorted(best.values(), key=lambda f: (f["properties"]["rank"], f["properties"]["name"]))


def simplify(ring: list, tol: float = SIMPLIFY) -> list:
    """Douglas-Peucker on one closed ring, iterative; an empty list when the ring collapses below a triangle."""
    if len(ring) < 5:
        return ring if len(ring) >= 4 else []
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    x0, y0 = ring[0]
    far = max(range(1, len(ring) - 1), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    keep[far] = True
    stack = [(0, far), (far, len(ring) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = ring[a], ring[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            d = abs(dy * ring[i][0] - dx * ring[i][1] + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    out = [[round(x, 4), round(y, 4)] for (x, y), k in zip(ring, keep) if k]
    return out if len(out) >= 4 else []


def simplify_geometry(g: dict) -> dict | None:
    """A Polygon or MultiPolygon, simplified; polygons whose outer ring collapses are dropped, holes likewise."""
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    out = []
    for poly in polys:
        outer = simplify(poly[0])
        if outer:
            out.append([outer] + [h for h in (simplify(r) for r in poly[1:]) if h])
    return {"type": "MultiPolygon", "coordinates": out} if out else None


def mpa_features() -> list[dict]:
    """MPA Inventory sites with marine area, intersecting the bounds, simplified on the server (about 100 m)."""
    fields = "Site_Name,Design,Mgmt_Agen,Gov_Level,URL,AreaMar,Fish_Rstr"
    out: list[dict] = []
    offset = 0
    while True:
        page = get(MPA, {
            "where": "AreaMar > 0", "geometry": ",".join(map(str, BOUNDS)), "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": fields, "outSR": 4326,
            "maxAllowableOffset": SIMPLIFY / 2, "geometryPrecision": 5, "resultOffset": offset, "resultRecordCount": 200,
            "orderByFields": "FID", "f": "geojson",
        })
        feats = page.get("features", []) if isinstance(page, dict) else []
        for f in feats:
            p = f.get("properties") or {}
            if p.get("Site_Name") in FRESHWATER:
                continue
            geom = simplify_geometry(f["geometry"]) if f.get("geometry") else None
            if geom is None:
                continue
            out.append({
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "name": p.get("Site_Name"),
                    "design": p.get("Design"),
                    "agency": p.get("Mgmt_Agen"),
                    "level": p.get("Gov_Level"),
                    "fishing": p.get("Fish_Rstr"),
                    "km2": round(p.get("AreaMar") or 0, 1),
                    "url": p.get("URL") or None,
                },
            })
        if len(feats) < 200:
            break
        offset += len(feats)
    # Largest first, so the page draws the small sites on top and their outlines stay visible.
    return sorted(out, key=lambda f: -f["properties"]["km2"])


def write(path: Path, features: list[dict], sources: str) -> None:
    fc = {"type": "FeatureCollection", "sources": sources, "retrieved": time.strftime("%Y-%m-%d"), "features": features}
    path.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"{path}: {len(features)} features, {path.stat().st_size / 1024:.0f} KB")


def main() -> None:
    args = sys.argv[1:]
    cache = None
    if "--cache" in args:
        i = args.index("--cache")
        cache = Path(args[i + 1])
        del args[i : i + 2]
    out = Path(args[0] if args else "apps/web/public/northeast-shelf")
    out.mkdir(parents=True, exist_ok=True)
    if cache and cache.exists():
        records = json.loads(cache.read_text())
        print(f"{len(records)} gazetteer records from {cache}", file=sys.stderr)
    else:
        records = []
        for kind in RANKS:
            got = gazetteer(kind)
            records += got
            print(f"{kind}: {len(got)} worldwide", file=sys.stderr)
        if cache:
            cache.write_text(json.dumps(records))
    names = name_features(records)
    write(out / "names.geojson", names,
          "Marine Regions gazetteer (VLIZ, CC-BY 4.0), from the US BGN ACUF, the Canadian Geographical Names Database "
          "and the IHO-IOC GEBCO Gazetteer")
    write(out / "mpa.geojson", mpa_features(), "NOAA Marine Protected Areas Inventory 2023 (public domain)")


if __name__ == "__main__":
    main()
