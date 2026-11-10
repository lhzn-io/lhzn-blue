"""model_grids._Polite: on a failed connection to the primary host, the mirror for the rest of the run."""
import pytest
import requests

from lhzn_blue_jobs import model_grids as mg

PRIMARY, MIRROR = "https://primary.example", "https://mirror.example"


class _Resp:
    def __init__(self, status=200, content=b"grib"):
        self.status_code, self.content = status, content
        self.ok = status < 400


class _Session:
    """Fails to connect to the primary; the mirror answers 200 (or ``status``)."""

    def __init__(self, primary_up=False, status=200):
        self.calls, self.primary_up, self.status = [], primary_up, status

    def request(self, method, url, **kw):
        self.calls.append((method, url))
        if url.startswith(PRIMARY) and not self.primary_up:
            raise requests.ConnectTimeout("connect timeout=10")
        return _Resp(self.status)


@pytest.fixture
def polite(monkeypatch):
    monkeypatch.setattr(mg, "POLITE_GAP_S", 0.0)

    def make(mirror=(PRIMARY, MIRROR), **kw):
        p = mg._Polite(mg._Counter(), mirror=mirror)
        p.s = _Session(**kw)
        return p

    return make


def test_falls_back_and_stays_on_the_mirror(polite):
    p = polite()
    assert p.exists(f"{PRIMARY}/a/f048.grib2")
    assert p.get(f"{PRIMARY}/a/f003.grib2").content == b"grib"
    assert p.s.calls == [("HEAD", f"{PRIMARY}/a/f048.grib2"), ("HEAD", f"{MIRROR}/a/f048.grib2"), ("GET", f"{MIRROR}/a/f003.grib2")]
    assert p.n.bytes == 4


def test_primary_up_is_used(polite):
    p = polite(primary_up=True)
    assert p.exists(f"{PRIMARY}/a")
    assert p.s.calls == [("HEAD", f"{PRIMARY}/a")] and not p.on_mirror


def test_http_errors_do_not_switch(polite):
    p = polite(primary_up=True, status=404)
    assert not p.exists(f"{PRIMARY}/a")
    assert p.get(f"{PRIMARY}/a").status_code == 404
    assert not p.on_mirror


def test_without_a_mirror_a_failed_connection_is_not_published(polite):
    p = polite(mirror=None)
    assert not p.exists(f"{PRIMARY}/a")
    with pytest.raises(requests.ConnectionError):
        p.get(f"{PRIMARY}/a")


def test_mirror_down_too(polite):
    p = polite()

    def down(method, url, **kw):
        raise requests.ConnectTimeout("down")

    p.s.request = down
    assert not p.exists(f"{PRIMARY}/a")
    with pytest.raises(requests.ConnectionError):
        p.get(f"{PRIMARY}/b")
