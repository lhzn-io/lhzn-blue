"""The map's HRRR wind history (hrrr_grid.history and hrrr_grid.backfill), without network access."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from lhzn_blue_jobs import build, hrrr_grid as hg

NX, NY = 3, 2
NOW = pd.Timestamp("2026-10-20T12:00")


def vk(t: pd.Timestamp) -> str:
    return f"{t:%Y-%m-%dT%H:%MZ}"


def frame(t: pd.Timestamp, lead: int = 1) -> dict:
    c = t - pd.Timedelta(hours=lead)
    return {"valid_time": vk(t), "cycle": f"{c:%Y-%m-%dT%HZ}", "lead": lead, "u": "AAAAAAAA", "v": "AAAAAAAA"}


def main_file(first: pd.Timestamp, last: pd.Timestamp, version: int = hg.MESH_VERSION) -> dict:
    return {
        "box": list(hg.BOX),
        "encoding": {"type": "int8 base64", "step": hg.STEP},
        "mesh": {"version": version, "nx": NX, "ny": NY, "block": {"row0": 10, "col0": 20}, "centre_lon": [-73.0] * (NX * NY)},
        "frames": [frame(t) for t in pd.date_range(first, last, freq="h")],
    }


def times(doc: dict) -> list[str]:
    return [f["valid_time"] for f in doc["frames"]]


def test_frames_leaving_the_main_window_move_into_history():
    prev_main = main_file(NOW - pd.Timedelta(hours=25), NOW + pd.Timedelta(hours=47))
    new_main = main_file(NOW - pd.Timedelta(hours=24), NOW + pd.Timedelta(hours=48))
    h = hg.history(None, prev_main, new_main, end=NOW)
    assert times(h) == [vk(NOW - pd.Timedelta(hours=25))]
    assert h["mesh"] == {"version": hg.MESH_VERSION, "nx": NX, "ny": NY, "block": {"row0": 10, "col0": 20}}
    assert "corner_lon" not in h["mesh"] and h["box"] == list(hg.BOX) and h["encoding"]["step"] == hg.STEP
    assert h["cycles"] == [frame(NOW - pd.Timedelta(hours=25))["cycle"]]
    # The next run keeps it and adds the next hour; nothing overlaps the main file.
    newer = main_file(NOW - pd.Timedelta(hours=23), NOW + pd.Timedelta(hours=49))
    h2 = hg.history(h, new_main, newer, end=NOW + pd.Timedelta(hours=1))
    assert times(h2) == [vk(NOW - pd.Timedelta(hours=25)), vk(NOW - pd.Timedelta(hours=24))]
    assert max(times(h2)) < newer["frames"][0]["valid_time"]


def test_history_prunes_beyond_its_days_and_drops_another_grid():
    old = [frame(NOW - pd.Timedelta(days=14, hours=1)), frame(NOW - pd.Timedelta(days=14)), frame(NOW - pd.Timedelta(days=3))]
    prev = {**main_file(NOW, NOW), "frames": old}
    prev["mesh"] = {k: prev["mesh"][k] for k in ("version", "nx", "ny", "block")}
    main = main_file(NOW - pd.Timedelta(hours=24), NOW + pd.Timedelta(hours=48))
    h = hg.history(prev, None, main, end=NOW)
    assert times(h) == [vk(NOW - pd.Timedelta(days=14)), vk(NOW - pd.Timedelta(days=3))]
    # A new mesh version (the main file started over): the old frames do not carry over.
    moved = main_file(NOW - pd.Timedelta(hours=24), NOW + pd.Timedelta(hours=48), version=hg.MESH_VERSION + 1)
    assert hg.history(prev, None, moved, end=NOW)["frames"] == []


def test_backfill_skips_hours_present_and_falls_back_to_older_cycles(tmp_path, monkeypatch):
    store = build.Store(str(tmp_path))
    main = main_file(NOW - pd.Timedelta(hours=24), NOW + pd.Timedelta(hours=48))
    store.write_json(hg.KEY, main, max_age=600)
    first = NOW - pd.Timedelta(hours=24)
    present = [first - pd.Timedelta(hours=h) for h in (1, 2, 5)]
    store.write_json(hg.HISTORY_KEY, hg.history({**main, "frames": [frame(t, lead=2) for t in present]}, None, main, end=NOW), max_age=3600)

    calls: list[tuple[pd.Timestamp, int]] = []
    gap = first - pd.Timedelta(hours=10) - pd.Timedelta(hours=1)  # the lead-1 cycle for 10 hours before the main file

    def fake_fetch(cycle, lead, block, land, workdir):
        calls.append((cycle + pd.Timedelta(hours=lead), lead))
        assert block == (slice(10, 10 + NY), slice(20, 20 + NX)) and not land
        if cycle == gap:
            return None, 0  # not published: the backfill tries the cycle before
        a = SimpleNamespace(values=np.full((NY, NX), 2.0), attrs={"GRIB_uvRelativeToGrid": 0})
        return {"u10": a, "v10": a}, 100

    monkeypatch.setattr(hg, "_fetch", fake_fetch)
    monkeypatch.setattr(hg, "BACKFILL_FLUSH_HOURS", 5)
    s = hg.backfill(store, days=2, end=NOW)
    asked = {vk(t) for t, _ in calls}
    assert not asked & {vk(t) for t in present}  # hours present are not read again
    assert s["hours_read"] == 24 - len(present) and s["not_published"] == []
    h = store.read_json(hg.HISTORY_KEY)
    assert times(h) == [vk(t) for t in pd.date_range(NOW - pd.Timedelta(days=2), first - pd.Timedelta(hours=1), freq="h")]
    fell_back = next(f for f in h["frames"] if f["valid_time"] == vk(first - pd.Timedelta(hours=10)))
    assert fell_back["lead"] == 2
    assert np.allclose(hg.decode(h["frames"][0]["u"]), 2.0)
    # A second run (as after a timeout) reads nothing.
    calls.clear()
    assert hg.backfill(store, days=2, end=NOW)["hours_read"] == 0 and calls == []


def test_backfill_needs_the_main_file(tmp_path):
    with pytest.raises(RuntimeError):
        hg.backfill(build.Store(str(tmp_path)), days=1, end=NOW)


def test_writable_accepts_the_history_key():
    assert build.WRITABLE.fullmatch(hg.HISTORY_KEY)
    assert build.WRITABLE.fullmatch(hg.KEY)
    assert not build.WRITABLE.fullmatch("v1/fields/hrrr-wind-history-2026-10-20.json")
