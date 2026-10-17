"""Read the LISICOS station panels (images) while the data server is down: a stopgap, transcribed record.

LISICOS (UConn) draws each buoy's latest readings as images, updated every few minutes even while its ERDDAP server is
unreachable: weather (``<stn>_wx.png``), waves (``<stn>_wav.png``) and water quality (``<stn>_wq.png``) on
clydebank.dms.uconn.edu. Every value sits in its own box at a fixed place, in a fixed font, so each box is read on its
own with Tesseract (one line, upscaled, darkest channel) and checked before it is kept:

- units: most values are printed twice or three times (kt, mph and m/s; F and C; inHg and mbar; ft and m); a pair
  that disagrees beyond the printed rounding is read again with other preprocessing, and rejected if it still does;
- ranges: each field has a plausible range; a reading outside it is rejected;
- times: the panel's own time (local time on the header, "EST" on the water-quality sensor reads, taken literally as
  UTC-5 until the server's back-filled record settles it; the raw text is kept) must not run ahead of the fetch, and a
  panel whose time has not moved for 3 hours is stale;
- layout: boxes are found on each image and matched to the field map (images drawn larger are scaled to the reference
  size first); a field with no box is a sensor the buoy does not carry, not an error.

Requests are polite: one at a time, a few seconds apart, with a User-Agent naming the site and a contact; weather every
run (every 10 minutes), waves and water quality every third run; a panel that fails is skipped for a growing number of
runs; a 403 or 429 stops all panel fetching for a day. Each image is archived as fetched (create-only, private; never
served by the site) so the record can be re-read; ``v1/panels.json`` (KV) holds the last 10 days of readings and each
panel's health. Values from here are LISICOS's observations as transcribed by us: provisional, credited to LISICOS,
and replaced by the server's own record once it returns.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import requests

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

KV_KEY = "v1/panels.json"
BASE = "https://clydebank.dms.uconn.edu"
UA = {"User-Agent": "longhorizon.blue panel reader (+https://longhorizon.blue; dfry@lhzn.io)"}
NY = ZoneInfo("America/New_York")
EST = timezone(timedelta(hours=-5))
KEEP_DAYS = 10
STALE_HOURS = 3
SPACING_S = 3.0
# Which panels to read: ARTG has no weather panel (404); EXRX's weather panel stopped updating in June 2026 and is read
# only to notice if it starts again.
PANELS = {"WLIS": ("wx", "wav", "wq"), "EXRX": ("wx", "wav", "wq"), "ARTG": ("wav", "wq"), "CLIS": ("wx", "wav", "wq")}
EVERY_RUN = {"wx"}  # the rest every third run (their sensors report every 30 minutes or so)

# Field maps, in each panel type's reference pixels: name -> (x, y, w, h). Found on the 2026-10-17 captures.
REF_SIZE = {"wx": (579, 434), "wav": (579, 434), "wq": (640, 480)}
FIELDS: dict[str, dict[str, tuple[int, int, int, int]]] = {
    "wx": {
        "time": (89, 56, 179, 16),
        "air_f": (370, 152, 57, 19), "air_c": (370, 199, 57, 17),
        "wind_kt": (19, 278, 39, 18), "gust_kt": (104, 278, 39, 18),
        "dir_deg": (208, 287, 52, 19),
        "rh": (354, 290, 54, 19), "dew_f": (454, 289, 47, 19), "dew_c": (507, 290, 44, 17),
        "wind_mph": (19, 301, 39, 17), "gust_mph": (104, 300, 39, 17),
        "wind_ms": (19, 323, 39, 17), "gust_ms": (104, 321, 39, 17),
        "pres_inhg": (353, 374, 54, 19), "pres_mb": (421, 375, 65, 17),
    },
    "wav": {
        "time": (89, 59, 179, 16),
        "tp_avg_s": (432, 175, 57, 18), "tp_dom_s": (433, 226, 57, 17),
        "dir_deg": (262, 289, 53, 19),
        "hs_ft": (60, 297, 41, 17), "hmax_ft": (151, 297, 41, 17), "hs_m": (60, 318, 41, 17), "hmax_m": (151, 318, 41, 17),
    },
    "wq": {
        "time": (98, 62, 199, 18),
        "par": (25, 142, 110, 19), "fl_ugl": (414, 142, 99, 19), "ntu": (518, 142, 99, 19),
        **{f"{name}_{d}": (x, y, 52, h) for d, x in (("SFC", 32), ("MID", 189), ("BTM1", 345), ("BTM2", 502))
           for name, y, h in (("temp_f", 238, 21), ("temp_c", 267, 21), ("cond_sm", 301, 21), ("dbar", 331, 19), ("do_mgl", 361, 19), ("psu", 390, 19))},
        **{f"read_{d}": (x - 3, 437, 113, 18) for d, x in (("SFC", 32), ("MID", 189), ("BTM1", 345), ("BTM2", 502))},
    },
}
NUM = re.compile(r"^-?\d[\d,]*(?:\.\d+)?")
# Plausible ranges (a reading outside is rejected).
RANGES = {
    "air_f": (-15, 105), "air_c": (-26, 41), "dew_f": (-30, 90), "dew_c": (-35, 33), "rh": (0, 100),
    "wind_kt": (0, 80), "gust_kt": (0, 100), "wind_mph": (0, 92), "gust_mph": (0, 115), "wind_ms": (0, 41), "gust_ms": (0, 52),
    "dir_deg": (0, 360), "pres_inhg": (28.0, 31.3), "pres_mb": (950, 1060),
    "tp_avg_s": (0.5, 20), "tp_dom_s": (0.5, 25), "hs_ft": (0, 25), "hmax_ft": (0, 45), "hs_m": (0, 7.6), "hmax_m": (0, 14),
    "par": (0, 3000), "fl_ugl": (0, 500), "ntu": (0, 3000),
    "temp_f": (28, 90), "temp_c": (-2.5, 32), "cond_sm": (0, 7), "dbar": (0, 40), "do_mgl": (0, 20), "psu": (0, 36),
}
# Unit pairs: (a, b, factor, offset): b = a * factor + offset. Where the panel itself disagrees (both read the same
# under every preprocessing), the site's unit is kept: kt, F, ft, and mbar for pressure.
KEEP_ON_PANEL_MISMATCH = {"pres_inhg": "pres_mb"}
PAIRS = {
    "wx": [("wind_kt", "wind_mph", 1.150779, 0), ("wind_kt", "wind_ms", 0.514444, 0), ("gust_kt", "gust_mph", 1.150779, 0),
           ("gust_kt", "gust_ms", 0.514444, 0), ("air_f", "air_c", 5 / 9, -32 * 5 / 9), ("dew_f", "dew_c", 5 / 9, -32 * 5 / 9),
           ("pres_inhg", "pres_mb", 33.8639, 0)],
    "wav": [("hs_ft", "hs_m", 0.3048, 0), ("hmax_ft", "hmax_m", 0.3048, 0)],
    "wq": [(f"temp_f_{d}", f"temp_c_{d}", 5 / 9, -32 * 5 / 9) for d in ("SFC", "MID", "BTM1", "BTM2")],
}
TESSDATA = os.environ.get("LHZN_BLUE_TESSDATA")  # locally, a tessdata directory; in the image, the package's own
WORKDIR = Path(os.environ.get("LHZN_BLUE_OCR_TMP", tempfile.gettempdir()))


# ---------- reading an image ----------

def find_boxes(img) -> list[tuple[int, int, int, int]]:
    """The value boxes: rectangles of near-white pixels (their interiors) on the panel's grey ground."""
    from scipy import ndimage

    a = np.asarray(img.convert("RGB")).astype(int)
    lab, _ = ndimage.label(a.min(axis=2) >= 250)
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if 10 <= h <= 40 and 18 <= w <= 260 and (lab[sl] == i).mean() > 0.55:
            out.append((sl[1].start, sl[0].start, w, h))
    return out


def _prep(crop, variant: int):
    """Dark text on white for Tesseract: the darkest channel (coloured text turns dark), contrast, upscaled."""
    from PIL import Image, ImageOps

    g = Image.fromarray(np.asarray(crop.convert("RGB")).astype(int).min(axis=2).astype(np.uint8))
    g = ImageOps.autocontrast(g, cutoff=1)
    scale = (4, 6, 3)[variant]
    g = g.resize((g.width * scale, g.height * scale), Image.LANCZOS)
    if variant == 1:
        g = g.point(lambda v: 255 if v > 150 else 0)
    return ImageOps.expand(g, border=12, fill=255)


def _ocr(img) -> str:
    with tempfile.NamedTemporaryFile(suffix=".png", dir=WORKDIR, delete=False) as f:
        img.save(f.name)
    try:
        cmd = ["tesseract", f.name, "stdout", "-l", "eng", "--psm", "7"]
        if TESSDATA:
            cmd += ["--tessdata-dir", TESSDATA]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    finally:
        Path(f.name).unlink(missing_ok=True)


def _number(text: str) -> float | None:
    """The leading number of a box's text ("6 ug/L" -> 6, "1019.86" -> 1019.86); a leading O is a zero."""
    t = text.strip()
    t = re.sub(r"^[Oo](?=[\d.])", "0", t)
    m = NUM.match(t)
    return float(m.group(0).replace(",", "")) if m else None


@dataclass
class Reading:
    time: datetime | None
    time_raw: str
    values: dict[str, float]
    raw: dict[str, str]
    rejected: dict[str, str]
    absent: list[str]
    flags: dict[str, str]


def _base(field: str) -> str:
    return re.sub(r"_(SFC|MID|BTM1|BTM2)$", "", field)


def read_panel(png: bytes, panel: str, fetched: datetime) -> Reading:
    from PIL import Image

    img = Image.open(BytesIO(png)).convert("RGB")
    rw, rh = REF_SIZE[panel]
    sx, sy = img.width / rw, img.height / rh
    found = find_boxes(img)
    boxes: dict[str, tuple[int, int, int, int]] = {}
    absent = []
    for name, (x, y, w, h) in FIELDS[panel].items():
        m = [b for b in found if abs(b[0] / sx - x) <= 4 and abs(b[1] / sy - y) <= 4]
        if m:
            boxes[name] = m[0]
        else:
            absent.append(name)
    raw: dict[str, str] = {}
    vals: dict[str, float] = {}
    rejected: dict[str, str] = {}

    def crop(name: str):
        x, y, w, h = boxes[name]
        return img.crop((x + 1, y + 1, x + w - 1, y + h - 1))

    def read_field(name: str, variant: int = 0) -> None:
        text = _ocr(_prep(crop(name), variant))
        raw[name] = text
        if name == "time" or name.startswith("read_"):
            return
        if text == "" or re.match(r"^N/?A", text.upper()):
            vals.pop(name, None)
            return
        v = _number(text)
        lo, hi = RANGES.get(_base(name), (-1e9, 1e9))
        if v is None:
            rejected[name] = f"unreadable {text!r}"
        elif not lo <= v <= hi:
            rejected[name] = f"out of range {v}"
        else:
            vals[name] = v
            rejected.pop(name, None)

    for name in boxes:
        read_field(name)
    # Unit pairs: agree within the printed rounding, or read both again (two other preprocessings), or reject both.
    flags: dict[str, str] = {}
    for a, b, k, c in PAIRS[panel]:
        if a not in boxes or b not in boxes:
            continue
        seen = set()
        for variant in (None, 1, 2):
            if variant is not None:
                read_field(a, variant)
                read_field(b, variant)
            seen.add((vals.get(a), vals.get(b)))
            if a in vals and b in vals:
                ha = 0.5 * 10 ** -_decimals(raw[a]) * abs(k)
                hb = 0.5 * 10 ** -_decimals(raw[b])
                if abs(vals[a] * k + c - vals[b]) <= ha + hb + 1e-6:
                    break
        else:
            if len(seen) == 1 and None not in next(iter(seen)):
                # Read the same every time: the panel's own figures disagree. Keep the site's unit; drop the other.
                keep = KEEP_ON_PANEL_MISMATCH.get(a, a)
                drop = b if keep == a else a
                vals.pop(drop, None)
                rejected.pop(keep, None)
                flags[keep] = f"panel's units disagree: {raw.get(a)!r} vs {raw.get(b)!r}; kept {keep}"
            else:
                for f in (a, b):
                    if f in vals:
                        rejected[f] = f"unit mismatch {raw.get(a)!r} vs {raw.get(b)!r}"
                        vals.pop(f)
    dead = []
    for d in ("SFC", "MID", "BTM1", "BTM2"):
        if all(vals.get(f"{k}_{d}") == 0 for k in ("temp_c", "cond_sm", "psu")):
            dead.append(d)
            for k in [k for k in vals if k.endswith(f"_{d}")]:
                vals.pop(k)
    # Times: water quality by each column's own sensor read (the header has been seen with the wrong weekday and a
    # future hour); weather and waves by the header, if its weekday matches its date.
    if panel == "wq":
        reads = []
        for d in ("SFC", "MID", "BTM1", "BTM2"):
            tt = _sensor_time(raw.get(f"read_{d}", "")) if d not in dead else None
            if tt and tt <= fetched + timedelta(minutes=10) and any(k.endswith(f"_{d}") for k in vals):
                vals[f"read_{d}"] = tt.timestamp()
                reads.append(tt)
        t = max(reads) if reads else None
    else:
        t = _panel_time(raw.get("time", ""), fetched)
    return Reading(t, raw.get("time", ""), vals, raw, rejected, absent + [f"column {d} (zeros)" for d in dead], flags)


def _decimals(text: str) -> int:
    t = text.split()[0] if text.split() else ""
    return len(t.split(".")[1]) if "." in t else 0


def _panel_time(text: str, fetched: datetime) -> datetime | None:
    """'10:00:00 AM DST, Sat Oct 17' (local time; the year is the fetch's, or the one before across New Year)."""
    m = re.search(r"(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)\s*(?:DST|EDT|EST)?\s*,?\s*\w{3}\s+(\w{3})\s+(\d{1,2})", text)
    if not m:
        return None
    hh, mm, ss, ap, mon, day = m.groups()
    wd = re.search(r",\s*(\w{3})\s+\w{3}\s+\d", text)
    local = fetched.astimezone(NY)
    for year in (local.year, local.year - 1):
        try:
            t = datetime.strptime(f"{year} {mon} {day} {hh}:{mm}:{ss} {ap}", "%Y %b %d %I:%M:%S %p").replace(tzinfo=NY)
        except ValueError:
            return None
        if wd and t.strftime("%a") != wd.group(1):
            continue
        if t <= fetched + timedelta(minutes=10):
            return t.astimezone(timezone.utc)
    return None


def _sensor_time(text: str) -> datetime | None:
    """'17 Oct 2026 08:30:04', labelled EST on the panel: taken literally as UTC-5 (see the module note)."""
    m = re.search(r"(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})", text)
    if not m:
        return None
    try:
        return datetime.strptime(" ".join(m.groups()), "%d %b %Y %H %M %S").replace(tzinfo=EST).astimezone(timezone.utc)
    except ValueError:
        return None


# ---------- fetching and archiving ----------

class Archive:
    """The raw images, as fetched: gs://bucket/prefix/YYYY/MM/DD/<stn>_<panel>_<fetchUTC>_<sha12>.png (create-only)."""

    def __init__(self, root: str):
        self.dir = None
        if root.startswith("gs://"):
            from google.cloud import storage

            bucket, _, prefix = root[5:].partition("/")
            self.bucket = storage.Client().bucket(bucket)
            self.prefix = prefix.strip("/")
        else:
            self.dir = Path(root)

    def put(self, name: str, data: bytes) -> None:
        if self.dir is not None:
            p = self.dir / name
            p.parent.mkdir(parents=True, exist_ok=True)
            if not p.exists():
                p.write_bytes(data)
            return
        from google.api_core.exceptions import PreconditionFailed

        try:
            self.bucket.blob(f"{self.prefix}/{name}").upload_from_string(data, content_type="image/png", if_generation_match=0)
        except PreconditionFailed:
            pass


def publish(store: Store, archive_root: str | None, run_index: int | None = None) -> dict:
    """One run: fetch the panels due, archive them, read and check them, and update v1/panels.json."""
    end = now_utc()
    prev = store.read_json(KV_KEY) or {}
    health: dict = dict(prev.get("health", {}))
    stations: dict = {k: dict(v) for k, v in prev.get("stations", {}).items()}
    if prev.get("paused_until") and datetime.fromisoformat(prev["paused_until"].replace("Z", "+00:00")) > end:
        log.warning("panels: paused until %s (403 or 429 earlier)", prev["paused_until"])
        return prev
    run = run_index if run_index is not None else int(end.timestamp() // 600)
    arch = Archive(archive_root) if archive_root else None
    paused_until = None
    sess = requests.Session()
    for stn, panels in PANELS.items():
        for panel in panels:
            if panel not in EVERY_RUN and run % 3:
                continue
            key = f"{stn}_{panel}"
            h = dict(health.get(key, {}))
            if h.get("skip", 0) > 0:
                h["skip"] -= 1
                health[key] = h
                continue
            time.sleep(SPACING_S + random.random())
            url = f"{BASE}/{stn.lower()}_{panel}.png"
            fetched = now_utc()
            try:
                r = sess.get(url, headers=UA, timeout=30)
            except requests.RequestException as exc:
                h.update(status=f"error {type(exc).__name__}", fails=h.get("fails", 0) + 1)
                h["skip"] = min(12, 2 ** min(h["fails"] - 1, 3))
                health[key] = h
                continue
            h["last_fetch"] = iso(fetched)
            if r.status_code in (403, 429):
                paused_until = iso(end + timedelta(days=1))
                h["status"] = f"http {r.status_code}: all panel fetching paused for a day"
                health[key] = h
                log.error("panels: %s returned %s; pausing all panel fetching until %s", url, r.status_code, paused_until)
                break
            if r.status_code != 200 or not r.headers.get("Content-Type", "").startswith("image"):
                h.update(status=f"http {r.status_code}", fails=h.get("fails", 0) + 1)
                h["skip"] = min(12, 2 ** min(h["fails"] - 1, 3))
                health[key] = h
                continue
            h.update(status="ok", fails=0, skip=0)
            sha = hashlib.sha256(r.content).hexdigest()
            if arch is not None:
                arch.put(f"{fetched:%Y/%m/%d}/{stn.lower()}_{panel}_{fetched:%Y%m%dT%H%M%SZ}_{sha[:12]}.png", r.content)
            try:
                rd = read_panel(r.content, panel, fetched)
            except Exception as exc:  # a damaged image or a reader failure: recorded, never guessed around
                h["status"] = f"read failed: {type(exc).__name__}"
                health[key] = h
                log.warning("panels: %s not read (%s)", key, exc)
                continue
            if rd.time is None:
                h["status"] = f"no panel time ({rd.time_raw!r})"
                health[key] = h
                continue
            h["panel_time"] = iso(rd.time)
            h["stale"] = (fetched - rd.time) > timedelta(hours=STALE_HOURS)
            h["rejected"] = rd.rejected
            h["flags"] = rd.flags
            h["absent"] = rd.absent
            recs = list(stations.get(stn, {}).get(panel, []))
            if not h["stale"] and (not recs or recs[-1]["t"] < iso(rd.time)):
                recs.append({"t": iso(rd.time), "fetched": iso(fetched), "img": sha[:12],
                             "v": {k: round(v, 4) for k, v in rd.values.items()}})
            cutoff = iso(end - timedelta(days=KEEP_DAYS))
            stations.setdefault(stn, {})[panel] = [x for x in recs if x["t"] >= cutoff]
            health[key] = h
        if paused_until:
            break
    out = {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "LISICOS (UConn) station panels, transcribed by longhorizon.blue (provisional; replaced by the "
        "server's own record when it returns)",
        "time_note": "panel times are local; water-quality sensor reads are labelled EST on the panel and taken as UTC-5",
        "health": health,
        "stations": stations,
    }
    if paused_until:
        out["paused_until"] = paused_until
    store.write_json(KV_KEY, out, max_age=300)
    return out
