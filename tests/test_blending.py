"""The blending stations (Ray, 27 Oct: "when clicking sleipner or draupner we need an
image showing how the main pipelines go for the gas at those two blending stations").
nora.toml [blending] names them; blending.py finds the lines in, between and out of
them, so the page never works out the topology itself."""

import pytest

from nora.analysis import analyse
from nora.blending import blending_routes
from nora.config import DEFAULTS, load_config
from nora.data import DataError
from nora.render import page_payload
from nora.units import load_units

STATIONS = ["sleipner", "draupner_s", "draupner_e"]


def test_the_shipped_stations_are_sleipner_and_both_draupner_platforms(north_sea):
    stations = load_config()["blending"]["stations"]
    assert stations == STATIONS
    for station in stations:
        assert station in north_sea.node_by_id
    assert DEFAULTS["blending"]["stations"] == [], "no assets hard-coded in Python"


def test_routes_on_the_real_network(north_sea):
    routes = blending_routes(north_sea, STATIONS)
    assert routes["stations"] == STATIONS
    # Gas from the plants and fields: Kollsnes (Zeepipe IIA to Sleipner, IIB to Draupner
    # E), Nyhamna (Langeled north), Kårstø (Statpipe dry gas), the Heimskringla tie-in,
    # Gina Krog and Gudrun.
    assert routes["incoming"] == [
        "gina_krog_sleipner",
        "gudrun_sleipner",
        "langeled_north",
        "statpipe_dry",
        "statpipe_heimdal",
        "zeepipe_2a",
        "zeepipe_2b",
    ]
    # Sleipner to Draupner S, and the bridge between the two Draupner platforms.
    assert routes["internal"] == ["draupner_bridge", "sleipner_draupner"]
    # The exports: Langeled south and Zeepipe I from Sleipner, Europipe I and Franpipe
    # from Draupner E, and Statpipe on to the Ekofisk tie-in (Norpipe) from Draupner S.
    assert routes["outgoing"] == [
        "europipe_1",
        "franpipe",
        "langeled_south",
        "statpipe_ekofisk",
        "zeepipe_1",
    ]
    every = routes["incoming"] + routes["internal"] + routes["outgoing"]
    assert len(every) == len(set(every)), "each line in one group"
    for pid in every:
        pipe = north_sea.pipeline_by_id[pid]
        assert pipe.from_id in STATIONS or pipe.to_id in STATIONS


def test_unknown_station_ids_are_reported_together_with_a_suggestion(north_sea):
    with pytest.raises(DataError) as error:
        blending_routes(north_sea, ["sleipnr", "draupner_s", "draupner_x"])
    text = str(error.value)
    assert "nora.toml [blending] stations: no node 'sleipnr'" in text
    assert "did you mean 'sleipner'?" in text
    assert "no node 'draupner_x'" in text


def test_stations_are_kept_in_order_once_each(north_sea):
    routes = blending_routes(north_sea, ["draupner_e", "sleipner", "draupner_e"])
    assert routes["stations"] == ["draupner_e", "sleipner"]
    assert routes["internal"] == []  # Sleipner and Draupner E are not linked directly
    assert "draupner_bridge" in routes["incoming"]  # pipelines.csv: Draupner S to E
    assert "sleipner_draupner" in routes["outgoing"]


def test_stations_must_be_a_list_of_node_ids(tmp_path):
    path = tmp_path / "nora.toml"
    path.write_text('[blending]\nstations = ["sleipner"]\n', encoding="utf-8")
    assert load_config(path)["blending"]["stations"] == ["sleipner"]
    path.write_text('[blending]\nstations = "sleipner"\n', encoding="utf-8")
    with pytest.raises(DataError) as error:
        load_config(path)
    assert "stations: must be a list of node ids" in str(error.value)
    path.write_text('[blending]\nstation = ["sleipner"]\n', encoding="utf-8")
    with pytest.raises(DataError) as error:
        load_config(path)
    assert "unknown key station in [blending] (did you mean 'stations'?)" in str(error.value)


def test_the_payload_carries_the_routes(north_sea):
    config = load_config()
    payload = page_payload(north_sea, analyse(north_sea), [], None, config, load_units(north_sea))
    assert payload["blending"] == blending_routes(north_sea, STATIONS)


def test_a_network_without_the_stations_still_builds(tiny, tiny_dir):
    """A network of its own (the tests' tiny one) has no Sleipner: the page leaves the
    picture out; `nora validate` is where an unknown id is reported."""
    payload = page_payload(tiny, analyse(tiny), [], None, load_config(), [], tiny_dir)
    assert payload["blending"] == {"stations": [], "incoming": [], "internal": [], "outgoing": []}
