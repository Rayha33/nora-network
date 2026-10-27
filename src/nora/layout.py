"""Positions for the gas flow overview: a schematic that reads left to right.

Each asset gets a column by how far gas has travelled to reach it: fields on the left,
then processing plants and riser hubs, then receiving terminals, LNG, and markets on
the right. Within a column, assets are ordered north to south, so the overview keeps a
sense of geography without the distances of a map.
"""

from __future__ import annotations

import networkx as nx

from .data import STATUSES, Network
from .graph import build_graph

COLUMN_GAP = 230.0
ROW_GAP = 66.0


def stages(net: Network) -> dict[str, int]:
    """Column per node: the longest chain of pipelines from a supply node to it."""
    graph = build_graph(net, STATUSES)
    dag = nx.DiGraph()
    dag.add_nodes_from(graph)
    dag.add_edges_from((u, v) for u, v, a in graph.edges(data=True) if u == a["from_id"])
    while True:  # break any loop, always at the same edge, so the layout is stable
        try:
            cycle = nx.find_cycle(dag)
        except nx.NetworkXNoCycle:
            break
        dag.remove_edge(*max(cycle)[:2])
    depth: dict[str, int] = {}
    for node in nx.lexicographical_topological_sort(dag):
        depth[node] = max((depth[p] + 1 for p in dag.predecessors(node)), default=0)

    kinds = {n.id: n.type for n in net.nodes}
    inner = [d for n, d in depth.items() if kinds[n] not in ("terminal", "lng", "market")]
    landing = max(inner, default=0) + 1
    column = {}
    for node, d in depth.items():
        if kinds[node] == "terminal":
            column[node] = landing
        elif kinds[node] == "lng":  # LNG arrives by ship and feeds markets directly
            column[node] = landing + 1
        elif kinds[node] == "market":
            column[node] = landing + 2
        else:
            column[node] = min(d, landing - 1)
    # Pull sources right to sit just before the first asset they feed, so a field next
    # to a terminal is drawn next to it instead of in a crowded first column.
    for node in sorted(column, key=lambda n: -column[n]):
        if dag.in_degree(node) == 0 and kinds[node] not in ("lng", "market"):
            feeds = [column[s] for s in dag.successors(node)]
            if feeds:
                column[node] = max(column[node], min(feeds) - 1)
    return column


def flow_positions(net: Network) -> dict[str, tuple[float, float]]:
    """Canvas x, y for every node: columns from `stages`, rows north to south."""
    column = stages(net)
    by_column: dict[int, list] = {}
    for node in net.nodes:
        by_column.setdefault(column[node.id], []).append(node)
    positions = {}
    for col, members in by_column.items():
        members.sort(key=lambda n: (-n.lat, n.lon, n.id))
        top = -(len(members) - 1) * ROW_GAP / 2
        for row, node in enumerate(members):
            positions[node.id] = (col * COLUMN_GAP, round(top + row * ROW_GAP, 1))
    return positions
