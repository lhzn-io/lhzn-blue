"""scripts/fetch-marine-names.py: which gazetteer records become names on the shelf page."""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("fetch_marine_names", Path(__file__).parents[2] / "scripts" / "fetch-marine-names.py")
mn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mn)

ACUF = "US BGN Advisory Committee on Undersea Features (ACUF)"
GEBCO = "IHO-IOC GEBCO Gazetteer of Undersea Feature Names"


def rec(name, kind="Canyon(s)", lon=-69.6, lat=39.87, src=ACUF, mrgid=1, status="standard", accepted=None):
    return {"MRGID": mrgid, "preferredGazetteerName": name, "placeType": kind, "longitude": lon, "latitude": lat,
            "gazetteerSource": src, "status": status, "accepted": mrgid if accepted is None else accepted}


def test_inside_the_bounds_only():
    got = mn.name_features([rec("Veatch Canyon"), rec("Far Canyon", lon=-10.0, lat=50.0, mrgid=2)])
    assert [f["properties"]["name"] for f in got] == ["Veatch Canyon"]


def test_unwanted_types_and_non_standard_names_dropped():
    got = mn.name_features([
        rec("Some Town", kind="Town", mrgid=2),
        rec("Old Name Canyon", status="deleted", mrgid=3),
        rec("Variant Canyon", mrgid=4, accepted=5),
        rec("Veatch Canyon", mrgid=6),
    ])
    assert [f["properties"]["name"] for f in got] == ["Veatch Canyon"]


def test_acuf_wins_a_duplicate_over_gebco():
    got = mn.name_features([rec("Oceanographer Canyon", src=GEBCO, mrgid=2), rec("Oceanographer Canyon", src=ACUF, mrgid=3)])
    assert len(got) == 1 and got[0]["properties"]["src"] == "ACUF" and got[0]["properties"]["mrgid"] == 3


def test_ranks_labels_and_order():
    got = mn.name_features([
        rec("Cox Ledge", kind="Ledge(s)", lon=-71.1, lat=41.0, mrgid=2),
        rec("Veatch Canyon", mrgid=3),
        rec("Georges Bank", kind="Bank", lon=-67.5, lat=41.3, mrgid=4),
    ])
    props = [f["properties"] for f in got]
    assert [(p["name"], p["rank"], p["kind"]) for p in props] == [
        ("Georges Bank", 1, "Bank"),
        ("Veatch Canyon", 2, "Canyon"),
        ("Cox Ledge", 3, "Ledge"),
    ]
    assert got[1]["geometry"] == {"type": "Point", "coordinates": [-69.6, 39.87]}


def test_other_references_left_out_and_canadian_names_kept():
    got = mn.name_features([
        rec("Jordan Basin", kind="Basin", lon=-67.8, lat=43.5, src="Canadian Geographical Names Database (CGND)", mrgid=2),
        rec("Some Pinnacle", kind="Pinnacle", lon=-69.0, lat=43.0, src="Wikipedia", mrgid=3),
    ])
    assert [(f["properties"]["name"], f["properties"]["src"], f["properties"]["rank"]) for f in got] == [("Jordan Basin", "CGNDB", 1)]


def test_simplify_drops_collapsed_rings_and_keeps_shapes():
    square = [[0, 0], [0.0001, 0.00001], [1, 0], [1, 1], [0, 1], [0, 0]]
    assert mn.simplify(square) == [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    sliver = [[0, 0], [0.0002, 0], [0.0002, 0.0002], [0.0001, 0.0003], [0, 0]]
    assert mn.simplify(sliver) == []
    g = mn.simplify_geometry({"type": "Polygon", "coordinates": [square, sliver]})
    assert g == {"type": "MultiPolygon", "coordinates": [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]]}
