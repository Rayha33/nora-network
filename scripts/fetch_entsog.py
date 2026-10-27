"""Download hourly physical gas flows from the ENTSOG Transparency Platform as a raw CSV.

    python scripts/fetch_entsog.py 2026-10-13 2026-10-20 data/streams/norway-exports-entsog/raw.csv

Defaults to Gassco's exit points, where Norwegian gas lands at the UK and continental
terminals. Pass --points with other ENTSOG point directions (operator key + point key +
direction, lowercase). The CSV keeps ENTSOG's own columns; the stream.toml beside it
maps the points to NORA assets.
API documentation: https://transparency.entsog.eu/api/archiveDirectories/8/api-manual/TP_REG715_Documentation_TP_API%20-%20v2.1.pdf
"""

from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

URL = "https://transparency.entsog.eu/api/v1/operationalData"
FIELDS = [
    "periodFrom", "periodTo", "pointKey", "pointLabel", "operatorKey", "operatorLabel",
    "directionKey", "indicator", "value", "unit", "flowStatus",
]  # fmt: skip


# Gassco exit points: St. Fergus, Dunkerque, Easington, Zeebrugge ZPT, Dornum, Emden (x2).
GASSCO_EXITS = [
    f"no-tso-0001{point}exit"
    for point in (
        "itp-00022",
        "itp-00045",
        "itp-00091",
        "itp-00106",
        "itp-00208",
        "itp-00209",
        "itp-00210",
    )
]


def fetch(start: str, end: str, points: list[str], period: str, attempts: int = 4) -> list[dict]:
    query = urllib.parse.urlencode(
        {
            "pointDirection": ",".join(points),
            "indicator": "Physical Flow",
            "periodType": period,
            "timezone": "UCT",
            "from": start,
            "to": end,
            "limit": -1,
        },
        quote_via=urllib.parse.quote,  # ENTSOG wants %20, not +, in "Physical Flow"
    )
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(f"{URL}?{query}", timeout=180) as response:
                return json.load(response)["operationalData"]
        except OSError as error:  # the platform is often slow; back off and retry
            print(f"attempt {attempt} failed: {error}")
            time.sleep(10 * attempt)
    raise SystemExit("ENTSOG did not answer; try again later")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("start", help="first day, YYYY-MM-DD")
    parser.add_argument("end", help="last day (exclusive), YYYY-MM-DD")
    parser.add_argument("out", type=Path, help="raw CSV to write")
    parser.add_argument("--points", nargs="+", default=GASSCO_EXITS, help="ENTSOG point directions")
    parser.add_argument("--period", default="hour", choices=["hour", "day"])
    args = parser.parse_args()
    records = fetch(args.start, args.end, args.points, args.period)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sorted(records, key=lambda r: (r["periodFrom"], r["pointKey"])))
    print(f"wrote {len(records)} readings to {args.out}")


if __name__ == "__main__":
    main()
