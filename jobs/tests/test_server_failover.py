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
