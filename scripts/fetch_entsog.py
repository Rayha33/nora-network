"""Download physical gas flows from the ENTSOG Transparency Platform as a raw CSV.

    python scripts/fetch_entsog.py 2026-10-13 2026-10-20 raw.csv

Defaults to the points where Norwegian gas lands. Gassco publishes nothing for its own
side of these points, so the readings come from the receiving operators' entry side
(National Gas, Fluxys, NaTran, the German operators and GTS). Pass --points with other
point directions: operator key + point key + direction, e.g. UK-TSO-0001ITP-00091entry.
The CSV keeps ENTSOG's own columns; the stream.toml beside it maps points to NORA assets.

The platform asks for one point per query, short date ranges and no parallel calls, so
the script fetches point by point. On 2026-10-27 it returned "No result found" for recent
dates and timed out on older ones; see issue #2.
API manual: https://transparency.entsog.eu/api/archiveDirectories/8/api-manual/ENTSOG_TP_API_UserManual_v3.0.pdf
"""

from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

URL = "https://transparency.entsog.eu/api/v1/operationaldatas"
FIELDS = [
    "periodFrom", "periodTo", "pointKey", "pointLabel", "operatorKey", "operatorLabel",
    "directionKey", "indicator", "value", "unit", "flowStatus",
]  # fmt: skip


# Entry side of the points where Norwegian gas lands (Gassco's exit side has no data).
NORWAY_LANDINGS = [
    "UK-TSO-0001ITP-00022entry",  # St Fergus (Vesterled)
    "UK-TSO-0001ITP-00091entry",  # Easington (Langeled)
    "BE-TSO-0001ITP-00106entry",  # Zeebrugge ZPT (Zeepipe)
    "FR-TSO-0003ITP-00045entry",  # Dunkerque (Franpipe)
    "DE-TSO-0005ITP-00208entry",  # Dornum (Europipe I and II), two receiving operators
    "DE-TSO-0009ITP-00208entry",
    "DE-TSO-0002ITP-00210entry",  # Emden NPT (Norpipe), three receiving operators
    "DE-TSO-0005ITP-00210entry",
    "NL-TSO-0001ITP-00210entry",
]


def fetch(start: str, end: str, point: str, period: str, attempts: int = 3) -> list[dict]:
    query = urllib.parse.urlencode(
        {
            "pointDirection": point,
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
            with urllib.request.urlopen(f"{URL}?{query}", timeout=120) as response:
                data = json.load(response)
                # the platform's key changed: older docs say operationalData,
                # the current API returns the lowercase plural
                rows = data.get("operationaldatas") or data.get("operationalData")
                if rows is None:
                    raise KeyError(f"unexpected response keys: {list(data)}")
                return rows
        except urllib.error.HTTPError as error:
            if error.code == 404:  # ENTSOG's "No result found"
                print(f"{point}: no data for {start} to {end}")
                return []
            print(f"{point}: attempt {attempt} failed: {error}")
        except OSError as error:  # the platform is often slow; back off and retry
            print(f"{point}: attempt {attempt} failed: {error}")
        time.sleep(10 * attempt)
    print(f"{point}: gave up")
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("start", help="first day, YYYY-MM-DD")
    parser.add_argument("end", help="last day (exclusive), YYYY-MM-DD")
    parser.add_argument("out", type=Path, help="raw CSV to write")
    parser.add_argument("--points", nargs="+", default=NORWAY_LANDINGS, help="point directions")
    parser.add_argument("--period", default="hour", choices=["hour", "day"])
    args = parser.parse_args()
    records = [r for point in args.points for r in fetch(args.start, args.end, point, args.period)]
    if not records:
        raise SystemExit("no readings returned; nothing written")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sorted(records, key=lambda r: (r["periodFrom"], r["pointKey"])))
    print(f"wrote {len(records)} readings to {args.out}")


if __name__ == "__main__":
    main()
