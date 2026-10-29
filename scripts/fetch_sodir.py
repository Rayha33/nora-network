"""Download monthly per-field gas production from the SODIR factpages as a raw CSV.

    python scripts/fetch_sodir.py 2024-09-01 2026-10-01 \
        data/streams/sodir-field-production/raw.csv

One request fetches the whole monthly production table from the Norwegian Offshore
Directorate's (SODIR) factpages. Net gas is published as prfPrdGasNetBillSm3, billion
standard cubic metres per month; the script appends two derived columns: `month`
(ISO timestamp of the month's first day, combining prfYear and prfMonth) and
`gas_msm3d` (the monthly net gas converted to MSm3/d with the month's real day
count, NORA's unit). The stream.toml beside it maps fields to NORA nodes.

By default only the fields that map to a node in data/nodes.csv are kept (the list
below and [import.assets] in stream.toml must stay in sync); pass --fields to choose
others. Licence: NLOD (https://data.norge.no/nlod/en) - credit SODIR as the source.
"""

from __future__ import annotations

import argparse
import calendar
import csv
import io
import time
import urllib.error
import urllib.request
from pathlib import Path

URL = (
    "https://factpages.sodir.no/public?/Factpages/external/tableview/"
    "field_production_monthly&rs:Command=Render&rc:Toolbar=false&rc:Parameters=f"
    "&IpAddress=not_used&CultureCode=en&rs:Format=CSV&Top100=false"
)

# Fields in SODIR's table that map to a node in data/nodes.csv. Sleipner Vest and
# Øst both feed the `sleipner` node, Valhall and Hod `valhall`, Balder and Jotun `jotun`;
# readings mapping to the same asset are summed.
MAPPED_FIELDS = [
    "TROLL",
    "KVITEBJØRN",
    "OSEBERG",
    "STATFJORD",
    "GJØA",
    "SLEIPNER VEST",
    "SLEIPNER ØST",
    "EKOFISK",
    "ORMEN LANGE",
    "ÅSGARD",
    "AASTA HANSTEEN",
    "GULLFAKS",
    "VISUND",
    "JOHAN SVERDRUP",
    "GUDRUN",
    "EDVARD GRIEG",
    "HEIDRUN",
    "NORNE",
    "GINA KROG",
    "IVAR AASEN",
    "DVALIN",
    "VALHALL",
    "HOD",
    "MARTIN LINGE",
    "JOTUN",
    "BALDER",
]


def fetch(attempts: int = 3) -> list[dict]:
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(URL, timeout=60) as response:
                text = io.TextIOWrapper(response, encoding="utf-8-sig")
                return list(csv.DictReader(text))
        except (urllib.error.HTTPError, OSError, csv.Error) as error:
            print(f"attempt {attempt} failed: {error}")
            if attempt < attempts:
                time.sleep(10 * attempt)
    raise SystemExit("could not reach the SODIR factpages; nothing written")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("start", help="first month, YYYY-MM")
    parser.add_argument("end", help="last month (inclusive), YYYY-MM")
    parser.add_argument("out", type=Path, help="raw CSV to write")
    parser.add_argument("--fields", nargs="+", default=MAPPED_FIELDS, help="fields to keep")
    args = parser.parse_args()

    if args.start > args.end:
        raise SystemExit("end month is before the start month")

    rows = []
    for row in fetch():
        month = f"{row['prfYear']}-{int(row['prfMonth']):02d}"
        if not (args.start <= month <= args.end):
            continue
        row["prfMonth"] = f"{int(row['prfMonth']):02d}"
        if row["prfInformationCarrier"] not in args.fields:
            continue
        year, mon = int(row["prfYear"]), int(row["prfMonth"])
        days = calendar.monthrange(year, mon)[1]
        gas = float(row["prfPrdGasNetBillSm3"] or 0)
        rows.append(
            row
            | {
                "month": f"{year:04d}-{mon:02d}-01T00:00:00Z",
                "gas_msm3d": f"{gas * 1000 / days:.6f}",  # billion Sm3/month -> MSm3/d
            }
        )
    if not rows:
        raise SystemExit("no production rows for that period; nothing written")

    rows.sort(key=lambda r: (r["month"], r["prfInformationCarrier"]))
    columns = list(rows[0])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    fields = sorted({r["prfInformationCarrier"] for r in rows})
    print(f"wrote {len(rows)} rows for {len(fields)} fields to {args.out}")


if __name__ == "__main__":
    main()
