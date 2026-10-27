import json
import os
import subprocess
import sys

from nora.analysis import analyse, max_flow, n_minus_1, routed_flow
from nora.data import load_network
from nora.graph import build_graph, great_circle_km
from tests.conftest import NODES, write_network


def test_max_flow_is_limited_by_the_export_lines(tiny):
    flow = max_flow(build_graph(tiny))
    assert flow.value == 60  # supply 60 fits through 40 + 30 of export capacity
    assert flow.delivered == {"market": 60}
    assert flow.pipelines["feed"] == 60


def test_routed_flow_prefers_the_shorter_route(tiny):
    flow = routed_flow(build_graph(tiny))
    assert flow.value == 60
    # Via B is 400 km + ~130 km to market, via A 300 km + ~760 km: B fills first.
    assert flow.pipelines["pipe_b"] == 30
    assert flow.pipelines["pipe_a"] == 30


def test_supply_override_scales_the_flow(tiny):
    assert max_flow(build_graph(tiny), {"gas": 25}).value == 25


def test_processing_capacity_limits_the_flow(tmp_path):
    """A capacitated plant is split into in- and out-nodes, so its capacity —
    not just the pipelines around it — caps the flow through it."""
    nodes = list(NODES)
    nodes[2] = "a_terminal,Terminal A,processing,GB,57,-1,,25,operating,,"
    net = load_network(write_network(tmp_path / "capped", nodes=nodes))
    flow = max_flow(build_graph(net))
    assert flow.value == 55  # 25 through the plant + 30 through pipe_b
    assert flow.pipelines["pipe_a"] == 25
    assert flow.pipelines["pipe_b"] == 30


def test_n_minus_1_ranks_by_gas_lost(tiny):
    outages = {(o.kind, o.id): o.lost for o in n_minus_1(build_graph(tiny))}
    assert outages[("node", "gas")] == 60
    assert outages[("pipeline", "pipe_a")] == 30  # pipe_b can only carry 30
    assert outages[("pipeline", "pipe_b")] == 20
    assert ("pipeline", "a_entry") not in outages  # notional onshore entries are skipped


def test_bidirectional_pipelines_report_net_flow(tiny):
    graph = build_graph(tiny)
    attrs = dict(graph.edges["hub", "a_terminal"])
    graph.add_edge("a_terminal", "hub", **attrs)  # make pipe_a two-way
    flow = max_flow(graph)
    assert flow.pipelines["pipe_a"] >= 0


def test_missing_length_falls_back_to_distance(tiny):
    graph = build_graph(tiny)
    expected = great_circle_km(57, -1, 52, 8)
    assert abs(graph.edges["a_terminal", "market"]["length_km"] - expected) < 1e-6


def test_tiny_pipelines_stay_nearly_blocked_not_fully_blocked(tiny):
    """Integer scaling rounds capacities to kSm3/d: a fraction of a kSm3/d
    must keep a sliver of capacity, not become a closed valve."""
    flow = routed_flow(build_graph(tiny), {"gas": 0.0004})
    assert flow.value > 0


def test_north_sea_analysis_is_consistent(north_sea):
    result = analyse(north_sea)
    assert 0 < result["deliverable"] <= result["supply_capacity"]
    assert abs(sum(result["delivered"].values()) - result["deliverable"]) < 0.01
    assert result["outages"] == sorted(
        result["outages"], key=lambda o: (-o["lost"], o["kind"], o["id"])
    )


def test_results_do_not_depend_on_hash_seed():
    """Flow results must be identical whatever PYTHONHASHSEED is (sets of strings)."""
    script = (
        "import json; from nora.data import load_network; from nora.analysis import analyse;"
        "print(json.dumps(analyse(load_network()), sort_keys=True))"
    )
    outputs = set()
    for seed in ("1", "2", "3"):
        env = {**os.environ, "PYTHONHASHSEED": seed}
        done = subprocess.run(
            [sys.executable, "-c", script], env=env, capture_output=True, text=True, check=True
        )
        outputs.add(done.stdout)
    assert len(outputs) == 1
    assert json.loads(outputs.pop())["deliverable"] > 0


def test_whatif_without_offline_is_the_intact_analysis(tiny):
    assert analyse(tiny, frozenset()) == analyse(tiny)
    assert analyse(tiny)["deliverable"] == 60


def test_whatif_loses_one_branch(tiny):
    """Taking Terminal A out leaves only Pipe B, so only 30 of 60 is deliverable."""
    cut = analyse(tiny, frozenset({"a_terminal"}))
    assert cut["deliverable"] == 30
    assert cut["delivered"] == {"market": 30.0}
    assert cut["supplied"] == {"gas": 30.0}
    assert "pipe_a" not in cut["pipeline_flow"]  # the offline branch carries nothing


def test_whatif_isolating_the_market(tiny):
    """Everything upstream of the market is intact, but it is unreachable: 0."""
    cut = analyse(tiny, frozenset({"hub"}))
    assert cut["deliverable"] == 0
    assert cut["delivered"] == {"market": 0.0}
    assert cut["supplied"] == {"gas": 0.0}
    assert cut["pipeline_flow"] == {"a_entry": 0.0, "b_entry": 0.0}


def test_whatif_taking_the_market_itself_offline(tiny):
    """The only market offline: nothing left to deliver, and it is not reported."""
    cut = analyse(tiny, frozenset({"market"}))
    assert cut["deliverable"] == 0
    assert cut["delivered"] == {}
    assert cut["offline"] == ["market"]


def test_whatif_everything_offline_degrades_gracefully(tiny):
    cut = analyse(tiny, frozenset(n.id for n in tiny.nodes))
    assert cut["deliverable"] == 0
    assert cut["delivered"] == {}
    assert cut["supplied"] == {}
    assert cut["pipeline_flow"] == {}
