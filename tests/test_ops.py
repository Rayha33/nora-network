"""The plan check: can the network deliver what shippers nominated at the exit points?
Review findings, 28 Oct: an exit point an event took out must count as short, and a
gas plant's processing capacity limits the plan as it limits the max-flow model."""

from datetime import UTC, datetime, timedelta

from nora.config import load_config
from nora.data import load_network
from nora.analysis import max_flow
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


# Review, 29 Oct: an event at 0 < capacity_factor < 1 on a terminal changed nothing (St
# Fergus at half capacity still took all it got). A plant, hub or terminal without a
# capacity of its own takes what its lines can bring it; a derate scales that.
HALF_A = Event(
    "Terminal A at half capacity",
    "a_terminal",
    NOW - timedelta(hours=1),
    NOW + timedelta(hours=4),
    capacity_factor=0.5,
)


def test_a_terminal_at_half_capacity_takes_half_of_what_its_lines_bring(tiny):
    # Pipe A (40) is Terminal A's only line in: at half capacity it passes 20 on,
    # so the network delivers 20 + 30 instead of the field's 60.
    base = build_graph(tiny)
    assert max_flow(base).value == 60.0
    assert max_flow(apply_events(base, (HALF_A,), NOW)).value == 50.0


def test_an_exit_terminal_at_half_capacity_limits_the_max_flow(tmp_path):
    # Without the onshore entries and the market, the terminals are the exit points.
    net = load_network(write_network(tmp_path / "data", NODES[:4], PIPELINES[:3]))
    base = build_graph(net)
    assert max_flow(base).value == 60.0
    assert max_flow(apply_events(base, (HALF_A,), NOW)).value == 50.0


def test_a_terminal_at_half_capacity_limits_the_plan(tiny):
    base = build_graph(tiny)
    noms = {"a_terminal": 40.0, "b_terminal": 20.0}
    assert check_plan(base, noms, THRESHOLDS, names(tiny)).level == 0
    check = check_plan(apply_events(base, (HALF_A,), NOW), noms, THRESHOLDS, names(tiny))
    assert check.asset == "a_terminal" and check.level == 3, "20 of 40 is 50 % short"
    assert check.deliverable == 40.0
    assert "Short 20.0" in check.text
