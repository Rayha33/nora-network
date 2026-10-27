"""Turn the validated data into a networkx graph."""

from __future__ import annotations

import math
from collections.abc import Iterable

import networkx as nx

from .data import Network

EARTH_RADIUS_KM = 6371.0


def great_circle_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi, dlam = phi2 - phi1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def build_graph(net: Network, statuses: Iterable[str] = ("operating",)) -> nx.DiGraph:
    """Directed graph of the assets whose status is in `statuses`.

    Node and edge attributes mirror the CSV columns. A bidirectional pipeline becomes
    two opposite edges sharing one `pipeline` id; `from_id` records its drawn direction.
    Edges without a capacity get no `capacity` attribute, which networkx's flow
    algorithms treat as unlimited. A missing length falls back to the great-circle
    distance. Everything is added in id order so flow results never depend on
    PYTHONHASHSEED or on row order in the CSV files.
    """
    statuses = set(statuses)
    graph = nx.DiGraph()
    for node in sorted(net.nodes, key=lambda n: n.id):
        if node.status in statuses:
            graph.add_node(
                node.id,
                name=node.name,
                type=node.type,
                country=node.country,
                lat=node.lat,
                lon=node.lon,
                capacity_msm3d=node.capacity_msm3d,
                status=node.status,
            )
    for pipe in sorted(net.pipelines, key=lambda p: p.id):
        if pipe.status not in statuses or pipe.from_id not in graph or pipe.to_id not in graph:
            continue
        if pipe.length_km is not None:
            length = pipe.length_km
        else:
            a, b = graph.nodes[pipe.from_id], graph.nodes[pipe.to_id]
            length = great_circle_km(a["lat"], a["lon"], b["lat"], b["lon"])
        attrs = {
            "pipeline": pipe.id,
            "name": pipe.name,
            "type": pipe.type,
            "from_id": pipe.from_id,
            "length_km": length,
        }
        if pipe.capacity_msm3d is not None:
            attrs["capacity"] = pipe.capacity_msm3d
        graph.add_edge(pipe.from_id, pipe.to_id, **attrs)
        if pipe.bidirectional:
            graph.add_edge(pipe.to_id, pipe.from_id, **attrs)
    return graph
