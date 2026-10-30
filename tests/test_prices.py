"""scripts/fetch_prices.py: today's TTF and NOK rates for the page's money counter (Ray, 30
Oct: "it should check current gas prices"). Parsed from the two sources' own formats, no
network; a bad answer raises and the last good file stays."""

import importlib.util
import json
from pathlib import Path

import pytest

from nora.config import load_config
from nora.data import DataError

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "fetch_prices.py"


def load():
    spec = importlib.util.spec_from_file_location("fetch_prices", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


META = {
    "currency": "EUR",
    "symbol": "TTF=F",
    "regularMarketPrice": 102.79,
    "regularMarketTime": 1793354736,
}
YAHOO = {"chart": {"result": [{"meta": META}]}}
NORGES_BANK = {
    "data": {
        "dataSets": [
            {
                "series": {
                    "0:0:0:0": {"observations": {"0": ["10.3315"]}},
                    "0:1:0:0": {"observations": {"0": ["9.2826"]}},
                }
            }
        ],
        "structure": {
            "dimensions": {
                "series": [{"values": [{"id": "B"}]}, {"values": [{"id": "EUR"}, {"id": "USD"}]}],
                "observation": [{"values": [{"id": "2026-10-29"}]}],
            }
        },
    }
}


def test_ttf_price_and_nok_rates_are_read_from_the_sources_formats():
    prices = load()
    assert prices.ttf_price(YAHOO) == (102.79, 1793354736)
    assert prices.nok_rates(NORGES_BANK) == ({"EUR": 10.3315, "USD": 9.2826}, "2026-10-29")


def test_an_implausible_or_foreign_price_is_refused():
    prices = load()
    usd = json.loads(json.dumps(YAHOO))
    usd["chart"]["result"][0]["meta"]["currency"] = "USD"
    with pytest.raises(ValueError, match="not EUR"):
        prices.ttf_price(usd)
    wild = json.loads(json.dumps(YAHOO))
    wild["chart"]["result"][0]["meta"]["regularMarketPrice"] = 0
    with pytest.raises(ValueError, match="plausible"):
        prices.ttf_price(wild)


def test_a_failed_fetch_keeps_the_last_good_file(tmp_path, monkeypatch):
    prices = load()
    out = tmp_path / "prices.json"
    out.write_text('{"ttf_eur_per_mwh": 90}')

    def offline(url, timeout=20):
        raise OSError("offline")

    monkeypatch.setattr(prices, "fetch_json", offline)
    assert prices.main([str(out)]) == 1
    assert json.loads(out.read_text()) == {"ttf_eur_per_mwh": 90}


def test_money_settings_default_and_check_the_currency(tmp_path):
    money = {"gcv_kwh_per_sm3": 11.0, "currency": "NOK", "prices": "data/prices.json"}
    assert load_config()["money"] == money
    bad = tmp_path / "nora.toml"
    bad.write_text('[money]\ncurrency = "GBP"\n')
    with pytest.raises(DataError) as caught:
        load_config(bad)
    assert "currency" in caught.value.problems[0]
