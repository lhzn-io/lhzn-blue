"""Cut the chart around each current meter, for its plan on the station page (the "Seen from above" figure).

Writes stations/meter-charts.json: per meter in stations/shore.json, the features of NOAA's largest-scale Electronic
Navigational Chart (ENC) cell within HALF_M metres of it, in east and north metres from the meter: land (LNDARE),
shoreline constructions such as piers and wharves (SLCONS), depth contours (DEPCNT, metres), and the channel
(FAIRWY, with any dredged area, DRGARE). Also the charted faces near the meter, each with the bearing square to it out
into the water: a side-looking meter's beams most likely point that way off the face it is on (NOAA does not publish it).
Geometry is simplified to about SIMPLIFY_M. ENC data are public domain; not for navigation. Charts change by notice;
rerun when the cell's edition moves on (the file records the cell, edition and update date).
Run: python3 scripts/fetch-meter-charts.py, with pyogrio (its wheels carry GDAL's S-57 reader), shapely and numpy.
"""

import io
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

import pyogrio
import requests
from shapely import affinity, box, from_wkb, set_precision
from shapely.geometry import LineString, Point, mapping
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
SHORE = ROOT / "stations/shore.json"
OUT = ROOT / "stations/meter-charts.json"
CATALOG = "https://charts.noaa.gov/ENCs/ENCProdCat.xml"
UA = {"User-Agent": "longhorizon.blue (https://longhorizon.blue; dfry@lhzn.io)"}
HALF_M = 300
FACE_M = 10  # charted faces within this of the meter are candidates for the one it is on
SIMPLIFY_M = 0.5


def best_cell(lon: float, lat: float) -> dict:
    """The largest-scale (highest band) ENC cell whose coverage panel holds the point."""
    root = ET.fromstring(requests.get(CATALOG, headers=UA, timeout=120).content)
    best = None
    for c in root.iter("cell"):
        for panel in c.iter("panel"):
            pts = [(float(v.findtext("long")), float(v.findtext("lat"))) for v in panel.iter("vertex")]
            if pts and min(p[0] for p in pts) <= lon <= max(p[0] for p in pts) and min(p[1] for p in pts) <= lat <= max(p[1] for p in pts):
                cell = {"name": c.findtext("name"), "title": c.findtext("lname"), "scale": int(c.findtext("cscale")),
                        "edition": c.findtext("edtn"), "updated": c.findtext("uadt"), "url": c.findtext("zipfile_location")}
                if best is None or cell["scale"] < best["scale"]:
                    best = cell
                break
    if best is None:
        raise SystemExit(f"no ENC cell covers {lon}, {lat}")
    return best


def read(path: str, layer: str, win) -> list[tuple[object, dict]]:
    """A layer's features meeting the window, with their attributes; [] where the cell lacks the layer."""
    if layer not in {l[0] for l in pyogrio.list_layers(path)}:
        return []
    meta, _, geoms, fields = pyogrio.raw.read(path, layer=layer, bbox=win.bounds)
    names = list(meta["fields"])
    out = []
    for i, g in enumerate(geoms if geoms is not None else []):
        geom = from_wkb(g)
        if geom is not None and geom.intersects(win):
            out.append((geom, {n: fields[j][i] for j, n in enumerate(names)}))
    return out


def local(geom, lon: float, lat: float, win):
    """Clip to the window and move to east and north metres from the meter, simplified."""
    k = math.cos(math.radians(lat))
    g = geom.intersection(win)
    g = affinity.affine_transform(g, [111200 * k, 0, 0, 111200, -lon * 111200 * k, -lat * 111200])
    return set_precision(g.simplify(SIMPLIFY_M), 0.1)


def coords(g) -> list:
    m = mapping(g)
    return {"type": m["type"], "coordinates": m["coordinates"]}


def num(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)


def meter_chart(m: dict) -> dict:
    lon, lat = m["lon"], m["lat"]
    k = math.cos(math.radians(lat))
    dlon, dlat = HALF_M / (111200 * k), HALF_M / 111200
    win = box(lon - dlon, lat - dlat, lon + dlon, lat + dlat)
    cell = best_cell(lon, lat)
    with TemporaryDirectory() as tmp:
        zipfile.ZipFile(io.BytesIO(requests.get(cell["url"], headers=UA, timeout=120).content)).extractall(tmp)
        src = str(next(Path(tmp).rglob(f"{cell['name']}.000")))
        land = unary_union([g for g, _ in read(src, "LNDARE", win) if g.geom_type in ("Polygon", "MultiPolygon")])
        works = read(src, "SLCONS", win)
        depths = [(g, a) for g, a in read(src, "DEPCNT", win) if num(a.get("VALDCO")) is not None]
        channels = read(src, "FAIRWY", win) + read(src, "DRGARE", win)
    # The charted faces (straight edges of piers, wharves and land) within FACE_M of the meter, nearest first: each
    # face's bearing, and the bearing square to it that points away from land. A meter's published position is good to
    # several metres, so this lists the candidates; which one the meter is on is settled by its own readings (flow in
    # the nearest bin runs along the face) and recorded as beam_dir in stations/shore.json.
    here = Point(lon, lat)
    solid = unary_union([land] + [w for w, _ in works if w.geom_type in ("Polygon", "MultiPolygon")])
    faces = []
    for g, a in works:
        for part in getattr(g, "geoms", [g]):
            ring = part.exterior if part.geom_type == "Polygon" else part
            pts = list(ring.coords)
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                seg = LineString([(x0, y0), (x1, y1)])
                d_m = seg.distance(here) * 111200 * k
                if d_m > FACE_M:
                    continue
                along = math.degrees(math.atan2((x1 - x0) * k, y1 - y0)) % 180
                mid = seg.interpolate(0.5, normalized=True)
                out_dir = None
                for cand in ((along + 90) % 360, (along + 270) % 360):
                    probe = Point(mid.x + 10 / (111200 * k) * math.sin(math.radians(cand)), mid.y + 10 / 111200 * math.cos(math.radians(cand)))
                    if not solid.contains(probe):
                        out_dir = cand
                        break
                faces.append({"name": a.get("OBJNAM"), "distance_m": round(d_m, 1), "length_m": round(seg.length * 111200 * k, 1),
                              "along_deg": round(along), "out_deg": None if out_dir is None else round(out_dir)})
    faces.sort(key=lambda f: f["distance_m"])
    return {
        "cell": cell,
        "half_m": HALF_M,
        "land": [coords(local(land, lon, lat, win))] if not land.is_empty else [],
        "works": [coords(local(g, lon, lat, win)) for g, _ in works],
        "depths": [{"m": num(a["VALDCO"]), **coords(local(g, lon, lat, win))} for g, a in depths],
        "channels": [{"name": a.get("OBJNAM"), "depth_m": num(a.get("DRVAL1")), **coords(local(g, lon, lat, win))} for g, a in channels],
        "faces": faces,
    }


def main() -> None:
    meters = json.loads(SHORE.read_text()).get("meters") or []
    out = {
        "source": "NOAA Electronic Navigational Charts (ENC), the largest-scale cell at each meter; public domain. Not for navigation.",
        "units": "east and north metres from the meter; depth contours in metres below chart datum (MLLW)",
        "meters": {m["id"]: meter_chart(m) for m in meters},
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    for mid, c in out["meters"].items():
        print(mid, c["cell"]["name"], c["cell"]["scale"], "bytes", len(json.dumps(c)))
        for f in c["faces"]:
            print("   face", f)


if __name__ == "__main__":
    main()
