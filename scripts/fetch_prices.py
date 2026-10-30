"""Today's gas price and exchange rates for the page's money counter, as one small JSON file.

    python scripts/fetch_prices.py site/data/prices.json

Ray, 30 Oct: "show real flow of money in NOK and USD (toggle between them) based on flows
after the gas day started at 06:00 am. it then resets, it should check current gas prices".
The page values the gas delivered at the exit points since the gas day began at TTF, the
North-West European gas price:

- TTF front-month future in EUR/MWh, from Yahoo Finance's chart API (symbol TTF=F). The
  API sends no CORS header, so a browser cannot read it directly; this script runs on the
  server (the droplet's nora-prices timer, every 15 minutes) and the page reads the file
  from its own site.
- NOK per EUR and per USD, Norges Bank's daily reference rates (SDMX JSON, open data).

A fetch that fails leaves the last good file as it is, so the page keeps the price it
had and says when that was. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.request

TTF_URL = "https://query1.finance.yahoo.com/v8/finance/chart/TTF=F?interval=1d&range=5d"
FX_URL = (
    "https://data.norges-bank.no/api/data/EXR/B.EUR+USD.NOK.SP?lastNObservations=1&format=sdmx-json"
)


def fetch_json(url: str, timeout: float = 20) -> dict:
    agent = {"User-Agent": "Mozilla/5.0 (NORA gas network model)"}
    request = urllib.request.Request(url, headers=agent)
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (fixed https URLs)
        return json.load(response)


def ttf_price(chart: dict) -> tuple[float, int]:
    """The TTF front month's last price (EUR/MWh) and when it traded, from the chart API."""
    meta = chart["chart"]["result"][0]["meta"]
    if meta.get("currency") != "EUR":
        raise ValueError(f"TTF quoted in {meta.get('currency')!r}, not EUR")
    price = float(meta["regularMarketPrice"])
    if not 1 <= price <= 1000:
        raise ValueError(f"TTF at {price} EUR/MWh is not a plausible price")
    return price, int(meta["regularMarketTime"])


def nok_rates(sdmx: dict) -> tuple[dict[str, float], str]:
    """NOK per one EUR and per one USD, and their date, from Norges Bank's SDMX JSON."""
    data = sdmx["data"]
    currencies = data["structure"]["dimensions"]["series"][1]["values"]
    rates = {}
    for key, series in data["dataSets"][0]["series"].items():
        code = currencies[int(key.split(":")[1])]["id"]
        rates[code] = float(next(iter(series["observations"].values()))[0])
    day = data["structure"]["dimensions"]["observation"][0]["values"][-1]["id"]
    if not {"EUR", "USD"} <= set(rates):
        raise ValueError(f"Norges Bank sent {sorted(rates)}, not EUR and USD")
    return rates, day


def prices(now: float | None = None) -> dict:
    ttf, traded = ttf_price(fetch_json(TTF_URL))
    rates, day = nok_rates(fetch_json(FX_URL))
    return {
        "ttf_eur_per_mwh": ttf,
        "ttf_at": traded,
        "ttf_source": "TTF front-month future, via Yahoo Finance (TTF=F)",
        "nok_per_eur": rates["EUR"],
        "nok_per_usd": rates["USD"],
        "fx_date": day,
        "fx_source": "Norges Bank daily exchange rates",
        "fetched_at": int(now if now is not None else time.time()),
    }


def write_atomically(path: str, payload: dict) -> None:
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".prices-", suffix=".json")
    with os.fdopen(fd, "w") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("out", help="the JSON file to write, e.g. site/data/prices.json")
    args = parser.parse_args(argv)
    try:
        payload = prices()
    except Exception as error:  # the last good file stays
        print(f"prices not updated: {error}", file=sys.stderr)
        return 1
    write_atomically(args.out, payload)
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
