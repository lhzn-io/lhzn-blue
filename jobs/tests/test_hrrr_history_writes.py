"""HRRR history: each file written only when due (the recent file every 3 hours, the full one daily), and nothing
lost between; the seed reads HRRR's cycles, not GFS's beside them."""

import gzip
from datetime import datetime, timedelta, timezone

import pandas as pd

from lhzn_blue_jobs import forecast, hrrr_history
from lhzn_blue_jobs.build import Store, decode_frame

T0 = datetime(2026, 10, 31, 12, 40, tzinfo=timezone.utc)


def page(cycle: str, kt: float) -> dict:
    ms = kt / hrrr_history.MS_KT
    pts = {sid: {"u10": [ms] * 3, "v10": [0.0] * 3, "gust": [ms] * 3, "t2m": [283.15] * 3, "mslp": [101500.0] * 3} for sid in ("EXRX", "WLIS")}
    return {"cycles": {cycle: {"leads": [1, 2, 3], "points": pts}}}


class Counting(Store):
    def __init__(self, root):
        super().__init__(root)
        self.writes: list[str] = []

    def write_json(self, rel, obj, max_age):
        self.writes.append(rel)
        super().write_json(rel, obj, max_age)


def run(store, monkeypatch, at, cycle, kt=10.0):
    store.write_json(forecast.KV_KEY, page(cycle, kt), max_age=600)
    store.writes.clear()
    monkeypatch.setattr(hrrr_history, "now_utc", lambda: at)
    return hrrr_history.update(store)


def test_writes_follow_their_cadence(tmp_path, monkeypatch):
    store = Counting(str(tmp_path))
    run(store, monkeypatch, T0, "2026-10-31T11Z")
    assert sorted(store.writes) == sorted(hrrr_history.key(s, r) for s in ("EXRX", "WLIS") for r in (False, True))
    run(store, monkeypatch, T0 + timedelta(hours=1), "2026-10-31T12Z")
    assert store.writes == []  # nothing due an hour on
    run(store, monkeypatch, T0 + timedelta(hours=3), "2026-10-31T14Z")
    assert sorted(store.writes) == sorted(hrrr_history.key(s, True) for s in ("EXRX", "WLIS"))  # recent only
    run(store, monkeypatch, T0 + timedelta(hours=24), "2026-11-01T11Z")
    assert len(store.writes) == 4  # a day on: both files again


def test_the_recent_file_keeps_hours_the_full_file_has_not_caught_up_with(tmp_path, monkeypatch):
    store = Counting(str(tmp_path))
    run(store, monkeypatch, T0, "2026-10-31T11Z", kt=10)
    run(store, monkeypatch, T0 + timedelta(hours=3), "2026-10-31T14Z", kt=20)  # recent only
    # The page file has moved on (its 11Z cycle gone); the 15Z and 18Z hours must still come from the recent file.
    run(store, monkeypatch, T0 + timedelta(hours=6), "2026-10-31T17Z", kt=30)
    recent = decode_frame(store.read_json(hrrr_history.key("EXRX", recent=True)))
    at = lambda h: round(float(recent["wind_kt"].loc[pd.Timestamp(h, tz="UTC")]), 1)  # noqa: E731
    assert at("2026-10-31T12") == 10 and at("2026-10-31T15") == 20 and at("2026-10-31T18") == 30


def write_cycle(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(rows, columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])
    path.write_bytes(gzip.compress(df.to_csv(index=False).encode()))


def test_seed_reads_hrrr_cycles_only(tmp_path, monkeypatch):
    arch = tmp_path / "archive"
    rows = lambda v: [("2026-10-31T00:00Z", "2026-10-31T03:00Z", 3, "EXRX", f, v) for f in ("u10", "v10")]  # noqa: E731
    write_cycle(arch / "2026/10/cycle=2026103100.csv.gz", rows(5.0))
    write_cycle(arch / "gfs/2026/10/cycle=2026103100.csv.gz", rows(50.0))  # GFS's lead 3, which must not count
    store = Store(str(tmp_path / "out"))
    monkeypatch.setattr(hrrr_history, "now_utc", lambda: T0)
    hrrr_history.seed(store, str(arch))
    full = decode_frame(store.read_json(hrrr_history.key("EXRX")))
    assert len(full) == 1 and round(float(full["wind_kt"].iloc[0]), 1) == round(5.0 * 2**0.5 * hrrr_history.MS_KT, 1)
