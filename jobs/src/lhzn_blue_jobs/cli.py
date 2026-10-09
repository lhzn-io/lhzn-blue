"""Command line: ``lhzn-blue-jobs {history,live,import-archive} --out <dir or gs://bucket/prefix>``."""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from . import build


def main() -> None:
    parser = argparse.ArgumentParser(prog="lhzn-blue-jobs")
    parser.add_argument("command", choices=["history", "live", "import-archive"])
    parser.add_argument(
        "--out",
        default=os.environ.get("LHZN_BLUE_OUT", "out"),
        help="local directory or gs://bucket[/prefix] (env LHZN_BLUE_OUT)",
    )
    parser.add_argument("--archive-dir", type=Path, help="import-archive: directory of <vintage>/<dataset>.h5")
    parser.add_argument("--vintage", help="import-archive: fallback snapshot folder when stations.json names none")
    parser.add_argument("--full", action="store_true", help="live: refetch the whole 45-day window")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    store = build.Store(args.out)
    if args.command == "history":
        build.history(store)
    elif args.command == "live":
        build.live(store, full=args.full)
    else:
        if not args.archive_dir:
            parser.error("import-archive needs --archive-dir")
        build.import_archive(store, args.archive_dir, args.vintage)


if __name__ == "__main__":
    main()
