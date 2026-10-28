"""The plan check: can the network deliver what shippers nominated at the exit points?
Review findings, 28 Oct: an exit point an event took out must count as short, and a
gas plant's processing capacity limits the plan as it limits the max-flow model."""

from datetime import UTC, datetime, timedelta

from nora.config import load_config
from nora.data import load_network
from nora.graph import build_graph
from nora.ops import advise, check_plan
from nora.stream import Event, Stream, apply_events

from .conftest import NODES, PIPELINES, write_network

THRESHOLDS = load_config()["thresholds"]
NOW = datetime(2026, 1, 5, 12, tzinfo=UTC)


def names(net):
    return {n.id: n.name for n in net.nodes}


def test_an_exit_point_taken_out_falls_short_by_all_of_its_nomination(tiny):
    base = build_graph(tiny)
    noms = {"a_terminal": 30.0, "b_terminal": 20.0}
    assert check_plan(base, noms, THRESHOLDS, names(tiny)).level == 0, "the intact network delivers"
    trip = Event(
        "Terminal A trip", "a_terminal", NOW - timedelta(hours=1), NOW + timedelta(hours=4)
    )
    graph = apply_events(base, (trip,), NOW)
    check = check_plan(graph, noms, THRESHOLDS, names(tiny))
    assert check.level == 3, "a terminal trip is a critical shortfall, not 'Plan holds'"
    assert check.asset == "a_terminal"
    assert check.nominated == 50.0 and check.deliverable == 20.0
    assert "Short 30.0" in check.text and "Terminal A" in check.text
    stream = Stream("s", "S", "", "", "", True, (trip,), (NOW,), (), ())
    advice = advise(graph, base, check, noms, {}, (trip,), stream, names(tiny))
    assert advice["cause"] == "Terminal A trip (unplanned event) at Terminal A itself"


def test_a_gas_plant_limits_the_plan(tmp_path):
    # gas (60) -> plant (processes 25) -> a_terminal, through lines of 40
    nodes = [*NODES[:2], "plant,Plant,processing,NO,59,4,,25,operating,,,", *NODES[2:]]
    pipelines = [
        "feed,Feed,gas,plant,feeder,100,36,100,false,2000,operating,,,",
        "to_hub,To hub,plant,hub,trunk,10,36,100,false,2000,operating,,,",
        *PIPELINES[1:],
    ]
    net = load_network(write_network(tmp_path / "data", nodes, pipelines))
    check = check_plan(build_graph(net), {"a_terminal": 35.0}, THRESHOLDS, names(net))
    assert check.deliverable == 25.0, "no more than the plant can process"
    assert check.level > 0 and "Short 10.0" in check.text
