"""Telling a data outage from a fault.

A source going quiet (a server down or refusing, a request timing out, a satellite product with no new pass, a model
run not yet posted) is expected: the step keeps its previous file, says so in the log, and the job still succeeds. A
fault (a bug, a changed format, our own request budget reached) fails the job, so it shows in Cloud Run.
"""

from __future__ import annotations

import logging

import requests

from . import coops, erddap, merlin

# Messages the sources' clients (and forcingkit's fetchers) use when the data are simply not there.
OUTAGE_PHRASES = (
    "no valid data",  # forcingkit: a satellite composite or model window with nothing in it
    "no matching results",  # ERDDAP: an empty time window
    "no data was found",  # NOAA CO-OPS
    "giving up after",  # our clients: retries exhausted against a failing server
    "unreachable",  # our clients: no connection at all
    "dap failure",  # netCDF over OPeNDAP (NECOFS, THREDDS): the server dropped the request
    "timed out",
    "temporarily unavailable",
)


def is_outage(exc: BaseException) -> bool:
    """Whether an exception means the source had no data for us, rather than that our code is wrong."""
    if isinstance(exc, (merlin.RequestBudgetExceeded, erddap.BudgetExceeded)):
        return False  # our own guard: a fault worth seeing
    if isinstance(exc, (requests.RequestException, TimeoutError, ConnectionError, merlin.ServerUnreachable,
                        erddap.Unreachable, coops.CoopsError)):
        return True
    text = str(exc).lower()
    return any(p in text for p in OUTAGE_PHRASES)


def record(failed: list, name: str, exc: BaseException, log: logging.Logger) -> None:
    """After a step raised: an outage is a warning (the previous file stays); anything else is added to ``failed``,
    which fails the job."""
    if is_outage(exc):
        log.warning("%s not refreshed: source unavailable, previous file kept (%s: %s)", name, exc.__class__.__name__, str(exc)[:200])
    else:
        log.error("%s not refreshed", name, exc_info=exc)
        failed.append(name)
