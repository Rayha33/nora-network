"""Network analysis: how much gas the network can deliver, and what breaks it.

All quantities are in MSm3/d (million standard cubic metres per day).

  max_flow     the most gas the supply side can push into the markets
  routed_flow  the same amount, routed along the fewest pipeline-kilometres; the
               routing stays stable from step to step, so streams use it
  n_minus_1    for every single asset outage, the deliverable gas that is lost
  analyse      everything the site shows, as JSON-ready data

The amount max_flow finds is unique, but how it splits between suppliers sharing a
full pipeline is not, and networkx's choice can change with PYTHONHASHSEED. Anything
that reports per-pipeline flows therefore uses routed_flow, which breaks those ties by
distance and always gives the same answer.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass

import networkx as nx

from .data import SUPPLY_TYPES, Network
from .graph import build_graph

SOURCE, SINK = "__supply__", "__markets__"


@dataclass(frozen=True)
class Flow:
    value: float
    pipelines: dict[str, float]  # net flow, positive along the pipeline's from -> to
    delivered: dict[str, float]  # per market node
    supplied: dict[str, float]  # per supply node


@dataclass(frozen=True)
class Outage:
    kind: str  # "pipeline" or "node"
    id: str
    name: str
    lost: float  # deliverable gas lost, MSm3/d
    share: float  # lost as a share of the intact network's deliverable gas


def flow_graph(graph: nx.DiGraph, supply: dict[str, float] | None = None) -> nx.DiGraph:
    """The graph plus a super-source feeding every supplier and a super-sink behind
    every market. `supply` overrides the suppliers' capacities (MSm3/d)."""
    flows = graph.copy()
    flows.add_node(SOURCE)
    flows.add_node(SINK)
    for node, attrs in graph.nodes(data=True):
        if attrs["type"] in SUPPLY_TYPES:
            capacity = attrs["capacity_msm3d"] if supply is None else supply.get(node, 0.0)
            if capacity:
                flows.add_edge(SOURCE, node, capacity=capacity)
        elif attrs["type"] == "market":
            flows.add_edge(node, SINK)
    return flows


def max_flow(graph: nx.DiGraph, supply: dict[str, float] | None = None) -> Flow:
    value, flow = nx.maximum_flow(flow_graph(graph, supply), SOURCE, SINK)
    return _summarise(graph, value, flow)


def routed_flow(graph: nx.DiGraph, supply: dict[str, float] | None = None) -> Flow:
    """Maximum flow at the lowest total pipeline-kilometres.

    Plain max flow may pick any of many equivalent routings and jump between them
    from one time step to the next. Minimising distance gives one stable, plausible
    routing. Network simplex wants integers, so capacities are scaled to kSm3/d and
    lengths rounded to whole kilometres.
    """
    flows = flow_graph(graph, supply)
    scaled = nx.DiGraph()
    scaled.add_nodes_from(flows)
    for u, v, attrs in flows.edges(data=True):
        edge = {"weight": round(attrs.get("length_km", 0))}
        if "capacity" in attrs:
            edge["capacity"] = round(attrs["capacity"] * 1000)
        scaled.add_edge(u, v, **edge)
    flow = nx.max_flow_min_cost(scaled, SOURCE, SINK)
    flow = {u: {v: f / 1000 for v, f in targets.items()} for u, targets in flow.items()}
    return _summarise(graph, sum(flow[SOURCE].values()), flow)


def _summarise(graph: nx.DiGraph, value: float, flow: dict[str, dict[str, float]]) -> Flow:
    pipelines: dict[str, float] = {}
    for u, v, attrs in graph.edges(data=True):
        sign = 1 if u == attrs["from_id"] else -1
        pipe = attrs["pipeline"]
        pipelines[pipe] = pipelines.get(pipe, 0.0) + sign * flow[u].get(v, 0.0)
    markets = [n for n, attrs in graph.nodes(data=True) if attrs["type"] == "market"]
    return Flow(
        value=round(value, 6),
        pipelines={pipe: round(f, 6) for pipe, f in pipelines.items()},
        delivered={market: round(flow[market].get(SINK, 0.0), 6) for market in markets},
        supplied={node: round(f, 6) for node, f in flow[SOURCE].items()},
    )


def n_minus_1(graph: nx.DiGraph, base: float | None = None) -> list[Outage]:
    """Take out each pipeline and each non-market node in turn; rank by gas lost.

    Notional onshore entries are skipped: losing one is the same as losing its terminal.
    """
    if base is None:
        base = max_flow(graph).value
    outages = []
    pipes = sorted(
        {
            (attrs["pipeline"], attrs["name"])
            for _, _, attrs in graph.edges(data=True)
            if attrs["type"] != "onshore"
        }
    )
    for pipe, name in pipes:
        reduced = graph.copy()
        reduced.remove_edges_from(
            [(u, v) for u, v, attrs in graph.edges(data=True) if attrs["pipeline"] == pipe]
        )
        outages.append(_outage("pipeline", pipe, name, base, max_flow(reduced).value))
    for node, attrs in graph.nodes(data=True):
        if attrs["type"] != "market":
            reduced = graph.copy()
            reduced.remove_node(node)
            outages.append(_outage("node", node, attrs["name"], base, max_flow(reduced).value))
    return sorted(outages, key=lambda o: (-o.lost, o.kind, o.id))


def _outage(kind: str, asset: str, name: str, base: float, remaining: float) -> Outage:
    lost = max(0.0, round(base - remaining, 3))
    return Outage(kind, asset, name, lost, round(lost / base, 4) if base else 0.0)


def analyse(net: Network) -> dict:
    """Everything the site shows, as plain JSON-ready data."""
    graph = build_graph(net)
    best = routed_flow(graph)  # same total as max_flow, with a reproducible split
    lengths = {attrs["pipeline"]: attrs["length_km"] for _, _, attrs in graph.edges(data=True)}
    offshore = [p for p in net.pipelines if p.status == "operating" and p.type != "onshore"]
    supply = [n for n in net.nodes if n.status == "operating" and n.type in SUPPLY_TYPES]
    rows = [*net.nodes, *net.pipelines]
    utilization = {
        p.id: round(abs(best.pipelines.get(p.id, 0.0)) / p.capacity_msm3d, 4)
        for p in net.pipelines
        if p.capacity_msm3d and p.id in best.pipelines
    }
    return {
        "assets": len(net.nodes),
        "pipelines": len(offshore),
        "countries": sorted({n.country for n in net.nodes}),
        "node_types": dict(sorted(Counter(n.type for n in net.nodes).items())),
        "pipeline_km": round(sum(lengths.get(p.id, 0.0) for p in offshore)),
        "supply_capacity": round(sum(n.capacity_msm3d or 0.0 for n in supply), 1),
        "deliverable": round(best.value, 1),
        "delivered": best.delivered,
        "supplied": best.supplied,
        "pipeline_flow": best.pipelines,
        "utilization": utilization,
        "outages": [asdict(o) for o in n_minus_1(graph, best.value)],
        "sourced": {"rows": sum(1 for r in rows if r.source), "total": len(rows)},
    }
