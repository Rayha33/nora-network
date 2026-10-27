"""Download a dataset from Energinet's Energi Data Service (Denmark) as a raw CSV.

    python scripts/fetch_energinet.py 2026-08-01 2026-10-27 raw.csv

Defaults to the Gasflow dataset: daily gas flows through the Danish system in kWh per
gas day (from Tyra, from the North Sea, to Poland, to Danish consumers, and more).
The CSV keeps Energinet's own column names, one row per gas day; the stream.toml beside
it maps the columns to NORA assets. Open data, no key needed:
https://www.energidataservice.dk/tso-gas/Gasflow

Behind a proxy that Python's certificate store does not trust, download the JSON with
curl or a browser and convert it instead:

    curl -o gasflow.json "https://api.energidataservice.dk/dataset/Gasflow?start=2026-08-01&end=2026-10-27&limit=0"
    python scripts/fetch_energinet.py 2026-08-01 2026-10-27 raw.csv --json gasflow.json
"""

from __future__ import annotations

import argparse
import csv
import json
import urllib.parse
import urllib.request
from pathlib import Path

URL = "https://api.energidataservice.dk/dataset/{dataset}"


def fetch(dataset: str, start: str, end: str) -> list[dict]:
    query = urllib.parse.urlencode(
        {"start": start, "end": end, "limit": 0}, quote_via=urllib.parse.quote
    )
    with urllib.request.urlopen(f"{URL.format(dataset=dataset)}?{query}", timeout=60) as response:
        return json.load(response)["records"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("start", help="first day, YYYY-MM-DD")
    parser.add_argument("end", help="last day (exclusive), YYYY-MM-DD")
    parser.add_argument("out", type=Path, help="raw CSV to write")
    parser.add_argument("--dataset", default="Gasflow")
    parser.add_argument("--json", type=Path, help="convert a response saved earlier instead")
    args = parser.parse_args()
    if args.json:
        records = json.loads(args.json.read_text())["records"]
    else:
        records = fetch(args.dataset, args.start, args.end)
    if not records:
        raise SystemExit("no records for that period")
    time_column = next(iter(records[0]))
    records.sort(key=lambda r: r[time_column])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(records[0]))
        writer.writeheader()
        writer.writerows(records)
    print(f"wrote {len(records)} rows to {args.out}")


if __name__ == "__main__":
    main()
