"""Real Norwegian gas landings from the ENTSOG Transparency Platform (issue #2).

Gassco publishes nothing at its own side of the landing points, so the readings come
from the receiving operators. Where two German operators share one pipe, both publish
the same flow; counting both would double Dornum and Emden, so these tests hold the
fetched points to ENTSOG's own dashboard list and every reading to its line's capacity.
"""

from __future__ import annotations

import csv
import importlib.util
from pathlib import Path

import pytest

from nora.stream import load_stream

ROOT = Path(__file__).resolve().parents[1]
# pipe-in-pipe repeats of a flow already fetched: Thyssengas at Emden EPT1 (GUD's),
# Dornum / NETRA at OGE and GUD (Dornum GASPOOL's)
REPEATS = {"ITP-00105", "ITP-00126", "ITP-00188"}
GASSCO_KEYS = {"ITP-00208", "ITP-00209", "ITP-00210"}  # registered, no data
ST_FERGUS = "ITP-00022"  # Norwegian and UK gas together


def fetcher():
    spec = importlib.util.spec_from_file_location(
        "fetch_entsog", ROOT / "scripts" / "fetch_entsog.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_each_landing_is_fetched_once_from_the_receiving_operator():
    fetch = fetcher()
    hourly, daily = fetch.default_points("hour"), fetch.default_points("day")
    for points in (hourly, daily):
        keys = {point[11:20] for point in points}
        assert not keys & (REPEATS | GASSCO_KEYS | {ST_FERGUS})
        assert len(points) == len(set(points))
        assert all(point.endswith("entry") for point in points)
    # National Gas reports Easington per gas day only; an hourly query finds nothing
    easington = "UK-TSO-0001ITP-00091entry"
    assert easington in daily and easington not in hourly


@pytest.mark.parametrize("name", ["norway-exports", "norway-exports-daily"])
def test_no_flow_is_counted_twice(name):
    with (ROOT / "data" / "streams" / name / "raw.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows and not {row["pointKey"] for row in rows} & (REPEATS | {ST_FERGUS})
    assert {row["indicator"] for row in rows} == {"Physical Flow"}


@pytest.mark.parametrize("name", ["norway-exports", "norway-exports-daily"])
def test_real_landings_stay_within_their_lines(name, north_sea):
    stream = load_stream(name, north_sea)
    assert not stream.synthetic and "ENTSOG" in stream.license
    lines = {p.id: p for p in north_sea.pipelines}
    for j, asset in enumerate(stream.assets):
        readings = [row[j] for row in stream.values if row[j] is not None]
        mean = sum(readings) / len(readings)
        # A doubled flow would be about twice what the line carries; 10 % allows for
        # the 11 kWh per Sm3 conversion (Zeepipe I runs at its listed 42 MSm3/d).
        if asset in lines:
            assert 0 < mean <= 1.1 * lines[asset].capacity_msm3d, asset
    # Emden EPT1 is Europipe I and Norpipe together, so it sits on the terminal
    assert "emden" in stream.assets and "norpipe" not in stream.assets


def test_the_daily_dataset_adds_easington(north_sea):
    hourly = {"baltic_pipe_ns", "emden", "europipe_2_south", "franpipe", "zeepipe_1"}
    assert set(load_stream("norway-exports", north_sea).assets) == hourly
    daily = load_stream("norway-exports-daily", north_sea)
    assert set(daily.assets) == hourly | {"langeled_south"}
