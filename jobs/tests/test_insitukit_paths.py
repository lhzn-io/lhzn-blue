"""The readers that go through insitukit 0.2: tides, the Piscataqua current part and Merlin. Offline: insitukit's
HTTP calls are replaced."""

from datetime import datetime, timezone

import pytest
from insitukit import coops

from lhzn_blue_jobs import merlin, piscataqua, tides

START = datetime(2026, 11, 1, tzinfo=timezone.utc)
END = datetime(2026, 11, 2, tzinfo=timezone.utc)


def test_tides_station_in_feet_above_mllw(monkeypatch):
    asked = []

    def fake_get(params):
        asked.append(params)
        if params["interval"] == "h":
            return {"predictions": [{"t": "2026-11-01 00:00", "v": "1.234"}, {"t": "2026-11-01 02:00", "v": "2.0"}]}
        return {"predictions": [{"t": "2026-11-01 03:12", "v": "3.456", "type": "H"}]}

    def fake_md(path, params=None):
        if path.endswith("datums.json"):
            return {"epoch": "1983-2001", "datums": [{"name": "MLLW", "value": 3.5}, {"name": "MHHW", "value": 6.57}]}
        return {"nos_minor": 8.33, "nws_major": None}

    monkeypatch.setattr(coops, "_get", fake_get)
    monkeypatch.setattr(coops, "_md", fake_md)
    st = {"id": "NLON", "coops_id": "8461490", "name": "New London", "lat": 41.36, "lon": -72.09}
    out = tides.station(st, START, END)
    assert all(p["units"] == "english" and p["datum"] == "MLLW" for p in asked)
    assert out["pred"] == {"t0": "2026-11-01T00:00:00Z", "step": 3600, "ft": [1.23, None, 2.0]}
    assert out["hilo"] == [{"t": "2026-11-01T03:12:00Z", "ft": 3.46, "type": "H"}]
    assert out["datums_ft"] == {"MHHW": 3.07, "MLLW": 0.0} and out["epoch"] == "1983-2001"
    assert out["flood_ft"]["nos_minor"] == 4.83 and out["flood_ft"]["nws_major"] is None
    assert out["km"] == 160


CP = {"meanFloodDir": 342, "Bin": "12", "meanEbbDir": 194, "Depth": "2.4"}


def test_current_part_keeps_noaa_cm_per_s_and_whole_degree_directions(monkeypatch):
    def fake_get(params):
        if params["interval"] == "MAX_SLACK":
            rows = [{**CP, "Type": "ebb", "Time": "2026-11-01 00:18", "Velocity_Major": -85.7}]
        else:
            rows = [{**CP, "Time": "2026-11-01 00:00", "Velocity_Major": -84.2},
                    {**CP, "Time": "2026-11-01 00:30", "Velocity_Major": 55.3}]
        return {"current_predictions": {"units": "meters, cm/s", "cp": rows}}

    monkeypatch.setattr(coops, "_get", fake_get)
    out = piscataqua.current_part(START, END)
    assert out["units"] == "cm/s" and out["v"] == [-84.2, 55.3]
    assert out["flood_dir"] == 342 and isinstance(out["flood_dir"], int) and out["depth_m"] == 2.4
    assert out["events"] == [{"t": "2026-11-01T00:18:00Z", "type": "ebb", "v": -85.7}]


class FakeResponse:
    def __init__(self, status, text=""):
        self.status_code = status
        self.text = text
        self.content = text.encode()
        self.headers = {}


def test_merlin_reads_depth_and_keeps_its_budget(monkeypatch):
    csv = "time,depth,sea_water_temperature\nUTC,m,degree_C\n2026-11-01T00:00:00Z,1.0,12.5\n"
    monkeypatch.setattr(merlin._server, "min_interval", 0.0)
    monkeypatch.setattr(merlin._server, "requests", 0)
    monkeypatch.setattr(merlin._server._session, "get", lambda url, timeout=None: FakeResponse(200, csv))
    merlin.set_budget(1)
    try:
        df = merlin.fetch("WLIS", START, END, ["sea_water_temperature"])
        assert list(df.columns) == ["time", "depth", "sea_water_temperature"]
        assert df["sea_water_temperature"].iloc[0] == 12.5
        assert merlin.summary().startswith("server requests this run: 1 of a budget of 1")
        with pytest.raises(merlin.RequestBudgetExceeded):
            merlin.variables("WLIS")
    finally:
        merlin.set_budget(merlin.DEFAULT_BUDGET)


def test_merlin_missing_dataset_is_its_own_error(monkeypatch):
    monkeypatch.setattr(merlin._server, "min_interval", 0.0)
    monkeypatch.setattr(merlin._server, "requests", 0)
    monkeypatch.setattr(merlin._server._session, "get", lambda url, timeout=None: FakeResponse(404, "Not Found"))
    with pytest.raises(merlin.DatasetMissing):
        merlin.variables("NOPE")
