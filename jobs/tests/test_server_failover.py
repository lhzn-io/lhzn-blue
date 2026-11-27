"""The panels as failover for the LISICOS server, and the quick jobs' cap on server time (merlin.py)."""

from datetime import datetime, timezone

import pytest

from lhzn_blue_jobs import merlin, panels

END = datetime(2026, 11, 25, 3, 0, tzinfo=timezone.utc)


class _Resp:
    def __init__(self, newest: str):
        self.text = f"time\nUTC\n{newest}\n"


@pytest.fixture(autouse=True)
def _reset():
    yield
    merlin.set_job("tests")


def test_server_current_when_a_station_reading_is_fresh(monkeypatch):
    seen = []
    monkeypatch.setattr(merlin, "get", lambda url, **kw: seen.append(url) or _Resp("2026-11-25T01:45:00Z"))
    assert panels.server_current(END) == "2026-11-25T01:45:00Z"
    assert len(seen) == 1 and "WLIS_MET.csv?time&orderByMax" in seen[0]


def test_stale_or_silent_server_means_read_the_panels(monkeypatch):
    monkeypatch.setattr(merlin, "get", lambda url, **kw: _Resp("2026-11-24T23:00:00Z"))  # 4 h old everywhere
    assert panels.server_current(END) is None

    def down(url, **kw):
        raise merlin.ServerUnreachable("no connection", url)

    monkeypatch.setattr(merlin, "get", down)
    assert panels.server_current(END) is None


def test_one_station_failing_falls_through_to_the_next(monkeypatch):
    answers = iter([RuntimeError("HTTP 500"), None, _Resp("2026-11-25T02:00:00Z")])

    def get(url, **kw):
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    monkeypatch.setattr(merlin, "get", get)
    assert panels.server_current(END) == "2026-11-25T02:00:00Z"


def test_publish_reads_no_panel_and_writes_nothing_while_the_server_is_current(monkeypatch):
    monkeypatch.setattr(panels, "server_current", lambda end: "2026-11-25T02:45:00Z")

    class NoStore:
        def read_json(self, key):
            raise AssertionError("not read")

        def write_json(self, *a, **k):
            raise AssertionError("not written")

    assert panels.publish(NoStore(), None) == {"server_current": "2026-11-25T02:45:00Z"}


def test_failover_reads_the_panels_only_while_the_server_is_not_current(monkeypatch):
    calls = []
    monkeypatch.setattr(panels, "publish", lambda store, root, **kw: calls.append(kw) or {"ok": 1})
    monkeypatch.setattr(panels, "server_current", lambda end: "2026-11-25T02:45:00Z")
    monkeypatch.setattr(panels, "stale_panels", lambda store, end: {})
    assert panels.failover(None, None, END) is None and calls == []
    monkeypatch.setattr(panels, "server_current", lambda end: None)
    assert panels.failover(None, None, END) == {"ok": 1}
    assert calls == [{"run_index": int(END.timestamp() // 900), "check_server": False, "slow_every": 2}]


def test_quick_jobs_stop_asking_once_their_server_time_is_spent(monkeypatch):
    calls = []
    monkeypatch.setattr(merlin._server, "get", lambda url, **kw: calls.append(url))
    merlin.set_job("latest")
    assert merlin._server.timeout == merlin.QUICK_READ_TIMEOUT
    merlin.get("https://x/a")
    merlin._spent = merlin.SERVER_SECONDS["latest"]
    with pytest.raises(merlin.ServerUnreachable, match="stalling"):
        merlin.get("https://x/b")
    assert calls == ["https://x/a"]


def test_other_jobs_have_no_cap(monkeypatch):
    monkeypatch.setattr(merlin._server, "get", lambda url, **kw: "ok")
    merlin.set_job("history")
    merlin._spent = 10_000
    assert merlin.get("https://x/a") == "ok"


def test_the_server_is_asked_over_https():
    assert merlin.BASE_URL.startswith("https://") and ":8080" not in merlin.BASE_URL


class _LiveStore:
    def __init__(self, live: dict):
        self.live, self.written = live, []

    def read_json(self, key):
        return self.live if key == "v1/live.json" else None

    def write_json(self, key, doc, **kw):
        self.written.append(key)


def _live(**datasets):
    return {
        "met": {s: {"dataset": f"{s}_MET"} for s in ("WLIS", "CLIS", "EXRX")},
        "waves": {s: {"dataset": f"{s}_WAVE"} for s in ("WLIS", "CLIS", "EXRX")},
        "series": {"WLIS_SFC": {"dataset": "WLIS_WQ_SFC"}, "WLIS_BTM": {"dataset": "WLIS_WQ_BTM"},
                   "CLIS_SFC": {"dataset": "CLIS_WQ_SFC"}, "EXRX_MID": {"dataset": "XRX_WQ_MID"}},
        "datasets": datasets,
    }


GOOD = {"last_ok": "2026-11-25T02:45:00Z", "rows": 4}


def test_stale_panels_follow_each_station_dataset():
    ds = {f"{s}_MET": GOOD for s in ("WLIS", "CLIS", "EXRX")}
    ds |= {"CLIS_WAVE": GOOD, "WLIS_WQ_SFC": GOOD, "XRX_WQ_MID": GOOD}
    # The waves at WLIS as on 2026-11-26: a week of HTTP 400 after the last good read.
    ds["WLIS_WAVE"] = {"last_ok": "2026-11-17T19:21:43Z", "last_error": "2026-11-25T02:21:50Z Unavailable: HTTP 400"}
    # EXRX's waves read once in the window but failed since; CLIS's water quality is gone from the server.
    ds["EXRX_WAVE"] = {"last_ok": "2026-11-25T01:00:00Z", "last_error": "2026-11-25T02:00:00Z Unavailable: HTTP 400"}
    ds["CLIS_WQ_SFC"] = {"last_error": "2026-11-25T02:45:00Z DatasetMissing: dataset not found"}
    # One depth of WLIS water quality is enough (BTM missing from the log); ARTG has no datasets: left alone.
    assert panels.stale_panels(_LiveStore(_live(**ds)), END) == {"WLIS": {"wav"}, "EXRX": {"wav"}, "CLIS": {"wq"}}


def test_a_dataset_the_server_dropped_counts_as_stale():
    assert not panels._dataset_fresh({"last_ok": "2026-11-25T02:45:00Z", "published": False}, END)
    assert not panels._dataset_fresh({"last_ok": "2026-11-25T00:00:00Z"}, END)  # 3 h old
    assert panels._dataset_fresh(GOOD, END)


def test_failover_reads_only_the_stale_panels_while_the_server_is_current(monkeypatch):
    calls = []
    monkeypatch.setattr(panels, "publish", lambda store, root, **kw: calls.append(kw) or {"ok": 1})
    monkeypatch.setattr(panels, "server_current", lambda end: "2026-11-25T02:45:00Z")
    monkeypatch.setattr(panels, "stale_panels", lambda store, end: {"WLIS": {"wav"}})
    assert panels.failover(None, None, END) == {"ok": 1}
    assert calls == [{"run_index": int(END.timestamp() // 900), "check_server": False, "slow_every": 2,
                      "only": {"WLIS": {"wav"}}}]


def test_publish_with_only_fetches_just_those_and_skips_the_write_when_none_is_due(monkeypatch):
    fetched = []

    class Sess:
        def get(self, url, **kw):
            fetched.append(url)
            raise panels.requests.ConnectionError("offline in tests")

    monkeypatch.setattr(panels.requests, "Session", Sess)
    monkeypatch.setattr(panels.time, "sleep", lambda s: None)
    st = _LiveStore({})
    panels.publish(st, None, run_index=2, check_server=False, slow_every=2, only={"WLIS": {"wav"}})
    assert fetched == [f"{panels.BASE}/wlis_wav.png"] and st.written == [panels.KV_KEY]
    fetched.clear()
    st = _LiveStore({})
    panels.publish(st, None, run_index=3, check_server=False, slow_every=2, only={"WLIS": {"wav"}})
    assert fetched == [] and st.written == []
