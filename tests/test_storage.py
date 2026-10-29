"""Storage sites are modelled like fields: supply tied into the network. The real
network carries none (Ray, 29 Oct: remove the storage and LNG sites), so these tests
build small networks of their own."""

from collections import Counter

import pytest

from nora.analysis import SOURCE, exit_points, flow_graph, max_flow
from nora.data import SUPPLY_TYPES, DataError, load_network
from nora.graph import build_graph

from .conftest import PIPELINES, write_network


def test_the_real_network_stops_at_the_landings(north_sea):
    """Ray, 29 Oct: no storage or LNG import sites, no market hubs behind the landings
    (Poland VTP stays, at the end of Baltic Pipe). The terminals are the exit points."""
    kinds = Counter(n.type for n in north_sea.nodes)
    assert kinds["storage"] == kinds["lng"] == 0
    assert {n.id for n in north_sea.nodes if n.type == "market"} == {"pl_vtp", "tjeldbergodden"}
    assert not [p.id for p in north_sea.pipelines if p.type == "onshore"]
    terminals = {n.id for n in north_sea.nodes if n.type == "terminal"}
    assert terminals and terminals <= exit_points(build_graph(north_sea))


def test_the_flow_graph_feeds_a_storage(tmp_path):
    """A storage node gets a super-source edge with its withdrawal capacity."""
    assert "storage" in SUPPLY_TYPES
    nodes = [
        "store,Store,storage,GB,53,0,,10,operating,,",
        "market,Market,market,GB,52,-1,,,operating,,",
    ]
    pipelines = ["tie,Grid entry,store,market,onshore,,,,true,,operating,,"]
    net = load_network(write_network(tmp_path / "data", nodes=nodes, pipelines=pipelines))
    assert flow_graph(build_graph(net))[SOURCE]["store"]["capacity"] == 10


def test_a_storage_without_a_capacity_is_reported(tmp_path):
    no_capacity = "store,Store,storage,NO,60,3,,,operating,,"
    with pytest.raises(DataError) as caught:
        load_network(write_network(tmp_path / "data", nodes=[no_capacity]))
    assert any("a storage needs 'capacity_msm3d'" in p for p in caught.value.problems)


def test_a_storage_tied_to_a_market_adds_flow(tmp_path):
    """A storage behind a grid entry behaves like any other supplier."""
    nodes = [
        "store,Store,storage,GB,53,0,,10,operating,,",
        "market,Market,market,GB,52,-1,,,operating,,",
    ]
    pipelines = PIPELINES[:0] + ["tie,Grid entry,store,market,onshore,,,,true,,operating,,"]
    net = load_network(write_network(tmp_path / "data", nodes=nodes, pipelines=pipelines))
    flow = max_flow(build_graph(net))
    assert flow.value == 10.0
    assert flow.supplied["store"] == 10.0
