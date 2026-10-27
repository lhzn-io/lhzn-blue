"""One run's watch on the CoastWatch ERDDAP servers.

forcingkit waits up to 180 s for each CoastWatch request and tries three times, and a satellite field takes many
requests, so a server that has stopped answering can hold a run for half an hour (region-daily, 2026-10-26: 29 min
55 s of a 30 min limit, almost all of it connection timeouts). Before its first request to a server a run asks that
server once, with a short timeout; a server that does not answer, or whose request has failed to connect, is skipped
for the rest of the run. Either is an outage (outages.py): the previous file stays and the job still succeeds.
"""

from __future__ import annotations

import logging

import requests

log = logging.getLogger(__name__)

PROBE_TIMEOUT = 15  # seconds for the one question to each server

_down: dict[str, str | None] = {}  # server -> None when it answered this run, else why it did not


class Unreachable(RuntimeError):
    """A CoastWatch server is not answering this run (an outage, not a fault)."""


def servers(product_ids: list[str]) -> list[str]:
    """The ERDDAP servers a quantity's products come from."""
    from forcingkit.fetchers import coastwatch

    return sorted({coastwatch.PRODUCTS[p].server for p in product_ids if p in coastwatch.PRODUCTS})


def require(product_ids: list[str]) -> None:
    """Raise Unreachable when a server these products come from is not answering this run (asked once per run)."""
    from forcingkit.fetchers import coastwatch

    for server in servers(product_ids):
        if server not in _down:
            try:
                requests.get(f"{server}/version", headers={"User-Agent": coastwatch.USER_AGENT}, timeout=PROBE_TIMEOUT).raise_for_status()
                _down[server] = None
            except requests.RequestException as exc:
                _down[server] = exc.__class__.__name__
                log.warning("CoastWatch server %s not answering (%s); its fields are skipped this run", server, _down[server])
        if _down[server]:
            raise Unreachable(f"CoastWatch server unreachable this run ({server}: {_down[server]})")


def failed(product_ids: list[str], exc: BaseException) -> None:
    """After a CoastWatch step raised: a failure to connect marks its servers down for the rest of the run (an empty
    window, "no valid data", does not: the server answered)."""
    if isinstance(exc, requests.RequestException) or "giving up after" in str(exc).lower():
        for server in servers(product_ids):
            _down[server] = exc.__class__.__name__


def reset() -> None:
    """Forget this run's answers (tests)."""
    _down.clear()
