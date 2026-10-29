"""Download physical gas flows from the ENTSOG Transparency Platform as a raw CSV.

    python scripts/fetch_entsog.py 2026-10-13 2026-10-20 raw.csv
    python scripts/fetch_entsog.py 2026-10-01 2026-10-29 raw.csv --period day

Defaults to the points where Norwegian gas lands. Gassco registers its own side of every
point but publishes nothing there (hasData false), so the readings come from the
receiving operators' entry side, under their own point keys (the German operators do
not report at Gassco's Dornum and Emden keys, ITP-00208/209/210). Pass --points with
other point directions: operator key + point key + direction, e.g.
FR-TSO-0003ITP-00045entry. The CSV keeps ENTSOG's own columns; the stream.toml beside it
maps points to NORA assets.

National Gas (UK) reports Easington and St Fergus daily only: an hourly query returns
"No result found", so Easington joins the defaults with --period day. St Fergus is not
fetched: ENTSOG's own dashboards count it as "Norway+UK", and its flow is above what
Vesterled alone can carry, so it cannot be put on one NORA pipeline.

Where two German operators share one pipe ("pipe-in-pipe"), both publish the same flow;
the defaults follow ENTSOG's dashboard list and fetch each flow once (see issue #2).
The platform asks for one point per query, short date ranges and no parallel calls, so
the script fetches point by point.
API manual: https://transparency.entsog.eu/api/archiveDirectories/8/api-manual/ENTSOG_TP_API_UserManual_v3.0.pdf
Dashboard points: https://www.entsog.eu/sites/default/files/2023-09/Gas%20flows%20corridors%20and%20IPs%20used%20for%20the%20dashboards_v18-09-2023.pdf
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


# Entry side of the points where Norwegian gas lands, as ENTSOG's dashboards count them.
NORWAY_LANDINGS = [
    "FR-TSO-0003ITP-00045entry",  # Dunkerque (Franpipe)
    "BE-TSO-0001ITP-00106entry",  # Zeebrugge ZPT (Zeepipe I)
    # Emden EPT1: Europipe I and, since 1 Oct 2015, Norpipe (NPT was merged into it),
    # handed to three operators. Thyssengas (ITP-00105) is pipe-in-pipe with GUD and
    # repeats GUD's flow, so it is left out.
    "DE-TSO-0009ITP-00080entry",  # Emden (EPT1) (OGE)
    "DE-TSO-0005ITP-00081entry",  # Emden (EPT1) (GUD)
    "NL-TSO-0001ITP-00160entry",  # Emden (EPT1) (GTS)
    # Dornum: Europipe II. Dornum / NETRA (OGE ITP-00126, GUD ITP-00188) repeat it.
    "DE-TSO-0009ITP-00525entry",  # Dornum GASPOOL
    "DK-TSO-0001ITP-00630entry",  # North Sea Entry (Baltic Pipe, from Europipe II)
]
# National Gas publishes daily values only.
DAILY_ONLY = [
    "UK-TSO-0001ITP-00091entry",  # Easington (Langeled)
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
                # the current API returns the lowercase plural. `get`'s default
                # (not `or`) keeps a legitimate empty result from looking like
                # a missing key.
                rows = data.get("operationaldatas", data.get("operationalData"))
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
        if attempt < attempts:  # no backoff after the final try
            time.sleep(10 * attempt)
    print(f"{point}: gave up")
    return []


def default_points(period: str) -> list[str]:
    """Norway's landings; the daily-only UK points join when whole days are asked for."""
    return NORWAY_LANDINGS + (DAILY_ONLY if period == "day" else [])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("start", help="first day, YYYY-MM-DD")
    parser.add_argument("end", help="last day (exclusive), YYYY-MM-DD")
    parser.add_argument("out", type=Path, help="raw CSV to write")
    parser.add_argument("--points", nargs="+", help="point directions (default: Norway's)")
    parser.add_argument("--period", default="hour", choices=["hour", "day"])
    args = parser.parse_args()
    points = args.points or default_points(args.period)
    records = [r for point in points for r in fetch(args.start, args.end, point, args.period)]
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
