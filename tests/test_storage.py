"""Storage sites are modelled like fields and LNG terminals: supply tied into a market."""

import networkx as nx
import pytest

from nora.analysis import SOURCE, flow_graph, max_flow
from nora.data import SUPPLY_TYPES, DataError, load_network
from nora.graph import build_graph

from .conftest import PIPELINES, write_network


def test_the_storages_are_real_supply_with_a_source(north_sea):
    """Every operating storage site has a withdrawal capacity and reaches a market."""
    assert "storage" in SUPPLY_TYPES
    graph = build_graph(north_sea)
    markets = [n.id for n in north_sea.nodes if n.type == "market"]
    storages = [n for n in north_sea.nodes if n.type == "storage" and n.status == "operating"]
    assert len(storages) >= 5  # Rough, Norg, Bergermeer, Etzel, Jemgum, Stenlille, Lille Torup
    for node in storages:
        assert node.capacity_msm3d, node.id
        assert node.source, node.id
        assert any(nx.has_path(graph, node.id, market) for market in markets), node.id


def test_the_flow_graph_feeds_the_storages(north_sea):
    """A storage node gets a super-source edge with its withdrawal capacity."""
    flows = flow_graph(build_graph(north_sea))
    for node in north_sea.nodes:
        if node.type == "storage" and node.status == "operating":
            assert flows[SOURCE][node.id]["capacity"] == node.capacity_msm3d


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
