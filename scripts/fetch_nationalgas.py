"""Download daily physical gas flows from National Gas Transmission's data portal as a raw CSV.

    python scripts/fetch_nationalgas.py 2025-10-01 2026-10-28 raw.csv

Defaults to the Interconnector (IUK) at Bacton, both ways:

  PUBOB2038  "NTS Physical Flows, Bacton, Interconnector"      Bacton -> Zeebrugge
  PUBOBJ592  "System Entry Volume, BactonInterconnector, D+1"  Zeebrugge -> Bacton

Values are million cubic metres per gas day at standard conditions, numerically
MSm3/d. Pass --ids with other publication ids (the portal's "Find gas data" lists them).
The gas day runs from 05:00 to 05:00 UK time, so each reading is written at 05:00 on its
gas day, and the stream.toml beside it reads that with timezone = "Europe/London".
The portal publishes a value again when it is amended or late; the CSV keeps the one
published last. Open endpoint, no key: https://data.nationalgas.com/find-gas-data
(terms: https://www.nationalgas.com/our-policies/terms-and-conditions).

Behind a proxy that Python's certificate store does not trust, download the CSV with
curl or a browser and convert it instead:

    curl -o download.csv "https://data.nationalgas.com/api/find-gas-data-download?applicableFor=Y&dateFrom=2025-10-01&dateTo=2026-10-28&dateType=GASDAY&latestFlag=Y&ids=PUBOB2038,PUBOBJ592&type=CSV"
    python scripts/fetch_nationalgas.py 2025-10-01 2026-10-28 raw.csv --csv download.csv
"""

from __future__ import annotations

import argparse
import csv
import io
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

URL = "https://data.nationalgas.com/api/find-gas-data-download"
IUK = ("PUBOB2038", "PUBOBJ592")
# The portal answers a client that names itself; there is no need to pose as a browser.
USER_AGENT = "nora-network (https://github.com/Rayha33/nora-network)"
FIELDS = ("gas_day", "point", "value", "quality")


def download(ids: tuple[str, ...], start: str, end: str) -> str:
    query = urllib.parse.urlencode(
        {
            "applicableFor": "Y",
            "dateFrom": start,
            "dateTo": end,
            "dateType": "GASDAY",
            "latestFlag": "Y",
            "ids": ",".join(ids),
            "type": "CSV",
        }
    )
    request = urllib.request.Request(
        f"{URL}?{query}", headers={"User-Agent": USER_AGENT, "Accept": "text/csv"}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read().decode("utf-8-sig")


def readings(text: str) -> list[dict[str, str]]:
    """One reading per data item and gas day, the one published last, in day order."""
    latest: dict[tuple[datetime, str], tuple[datetime, dict]] = {}
    for row in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        day = datetime.strptime(row["Applicable For"].strip(), "%d/%m/%Y")
        published = datetime.strptime(row["Generated Time"].strip(), "%d/%m/%Y %H:%M:%S")
        key = (day, row["Data Item"].strip())
        if key not in latest or published >= latest[key][0]:
            latest[key] = (published, row)
    return [
        {
            "gas_day": f"{day:%Y-%m-%d}T05:00",
            "point": point,
            "value": row["Value"].strip(),
            "quality": (row.get("Quality Indicator") or "").strip(),
        }
        for (day, point), (_, row) in sorted(latest.items())
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("start", help="first gas day, YYYY-MM-DD")
    parser.add_argument("end", help="last gas day, YYYY-MM-DD")
    parser.add_argument("out", type=Path, help="raw CSV to write")
    parser.add_argument("--ids", default=",".join(IUK), help="publication ids, comma-separated")
    parser.add_argument("--csv", type=Path, help="convert a download saved earlier instead")
    args = parser.parse_args()
    text = (
        args.csv.read_text(encoding="utf-8-sig")
        if args.csv
        else download(tuple(args.ids.split(",")), args.start, args.end)
    )
    rows = readings(text)
    if not rows:
        raise SystemExit("no readings for that period")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} readings to {args.out}")


if __name__ == "__main__":
    main()
