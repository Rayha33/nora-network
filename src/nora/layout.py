"""Positions for the gas flow overview: a layered schematic in the direction gas flows.

Each asset gets a stage by how far gas has travelled to reach it: fields first, then
processing plants and riser hubs, then receiving terminals, LNG, and markets last. The
browser draws stages top to bottom (or left to right). Within a stage, assets are
ordered and spaced so the straight pipelines between stages cross as little as possible
(a layered, Sugiyama-style layout): geography only breaks ties, west before east.
"""

from __future__ import annotations

from itertools import combinations

import networkx as nx

from .data import STATUSES, Network
from .graph import build_graph

COLUMN_GAP = 230.0
ROW_GAP = 66.0
SWEEPS = 12  # ordering passes; the best order seen wins
SETTLE = 40  # spacing passes


def stages(net: Network) -> dict[str, int]:
    """Stage per node: the longest chain of pipelines from a supply node to it."""
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
    # Pull sources on to sit just before the first asset they feed, so a field next
    # to a terminal is drawn next to it instead of in a crowded first stage.
    for node in sorted(column, key=lambda n: -column[n]):
        if dag.in_degree(node) == 0 and kinds[node] not in ("lng", "market"):
            feeds = [column[s] for s in dag.successors(node)]
            if feeds:
                column[node] = max(column[node], min(feeds) - 1)
    return column


class _Layers:
    """The layered graph: real nodes plus one waypoint per stage a long pipeline passes
    through, so a pipeline spanning stages takes part in ordering and spacing there."""

    def __init__(self, net: Network):
        self.stage = stages(net)
        lon = {n.id: n.lon for n in net.nodes}
        self.real = set(lon)
        self.layers: dict[int, list[str]] = {}
        self.up: dict[str, list[str]] = {n: [] for n in lon}
        self.down: dict[str, list[str]] = {n: [] for n in lon}
        self.side: dict[str, list[str]] = {n: [] for n in lon}
        seed = dict(lon)
        for pipe in net.pipelines:
            a, b = sorted((pipe.from_id, pipe.to_id), key=lambda n: (self.stage[n], n))
            if self.stage[a] == self.stage[b]:  # e.g. an interconnector between terminals
                self.side[a].append(b)
                self.side[b].append(a)
                continue
            chain = [a]
            for s in range(self.stage[a] + 1, self.stage[b]):
                point = f"{pipe.id}@{s}"
                self.stage[point] = s
                share = (s - self.stage[a]) / (self.stage[b] - self.stage[a])
                seed[point] = lon[a] + (lon[b] - lon[a]) * share
                self.up[point], self.down[point], self.side[point] = [], [], []
                chain.append(point)
            chain.append(b)
            for upper, lower in zip(chain, chain[1:], strict=False):
                self.down[upper].append(lower)
                self.up[lower].append(upper)
        for node, s in self.stage.items():
            self.layers.setdefault(s, []).append(node)
        for members in self.layers.values():
            members.sort(key=lambda n: (seed[n], n))

    def crossings(self, order: dict[int, list[str]]) -> int:
        """Crossings between neighbouring stages for a given order."""
        total = 0
        for s in sorted(order)[:-1]:
            place = {n: i for i, n in enumerate(order[s + 1])} if s + 1 in order else {}
            ends = sorted((i, place[m]) for i, n in enumerate(order[s]) for m in self.down[n])
            total += sum(1 for (a, x), (b, y) in combinations(ends, 2) if a < b and x > y)
        return total

    def order(self) -> dict[int, list[str]]:
        """Barycentre sweeps down and up, then adjacent swaps; keeps the best order."""
        order = {s: list(m) for s, m in self.layers.items()}
        best, fewest = {s: list(m) for s, m in order.items()}, self.crossings(order)
        stages_ = sorted(order)
        for sweep in range(SWEEPS):
            downwards = sweep % 2 == 0
            for s in stages_[1:] if downwards else stages_[-2::-1]:
                ref = {n: i for i, n in enumerate(order[s - 1 if downwards else s + 1])}
                here = {n: i for i, n in enumerate(order[s])}

                def key(n, ref=ref, here=here, downwards=downwards):
                    near = [ref[m] for m in (self.up[n] if downwards else self.down[n])]
                    near += [here[m] - 0.5 for m in self.side[n]]
                    return (sum(near) / len(near) if near else here[n], here[n])

                order[s].sort(key=key)
            self._transpose(order)
            count = self.crossings(order)
            if count < fewest:
                best, fewest = {s: list(m) for s, m in order.items()}, count
        return best

    def _transpose(self, order: dict[int, list[str]]) -> None:
        def cost(u, v, place):  # crossings between u's and v's pipelines, u left of v
            out = 0
            for nbrs in (self.up, self.down):
                out += sum(1 for x in nbrs[u] for y in nbrs[v] if place[x] > place[y])
            return out

        improved = True
        while improved:
            improved = False
            place = {n: i for members in order.values() for i, n in enumerate(members)}
            for members in order.values():
                for i in range(len(members) - 1):
                    u, v = members[i], members[i + 1]
                    if cost(v, u, place) < cost(u, v, place):
                        members[i], members[i + 1] = v, u
                        place[u], place[v] = i + 1, i
                        improved = True

    def spacing(self, order: dict[int, list[str]]) -> dict[str, float]:
        """Rank positions: each node as close to the mean of its neighbours as the gaps
        allow (a card needs 1, a waypoint 0.35), solved per stage by isotonic regression."""
        x = {n: float(i) - (len(m) - 1) / 2 for m in order.values() for i, n in enumerate(m)}
        stages_ = sorted(order)
        for rnd in range(SETTLE):
            for s in stages_ if rnd % 2 == 0 else stages_[::-1]:
                members = order[s]
                want, weight = [], []
                for n in members:
                    near = [x[m] for m in self.up[n] + self.down[n]] + [x[m] for m in self.side[n]]
                    want.append(sum(near) / len(near) if near else x[n])
                    weight.append(1.0 if n in self.real else 2.0)
                gaps = [
                    1.0
                    if a in self.real and b in self.real
                    else 0.6
                    if a in self.real or b in self.real
                    else 0.35
                    for a, b in zip(members, members[1:], strict=False)
                ]
                for n, value in zip(members, _pack(want, weight, gaps), strict=False):
                    x[n] = value
        real = [v for n, v in x.items() if n in self.real]
        middle = (min(real) + max(real)) / 2
        return {n: round(v - middle, 2) for n, v in x.items() if n in self.real}


def _pack(want: list[float], weight: list[float], gaps: list[float]) -> list[float]:
    """Positions closest to `want` (weighted least squares) that keep the order and at
    least `gaps[i]` between neighbours i and i+1: pool adjacent violators."""
    offset = [0.0]
    for g in gaps:
        offset.append(offset[-1] + g)
    blocks: list[list[float]] = []  # [value, weight, size]
    for w, wt, off in zip(want, weight, offset, strict=False):
        blocks.append([w - off, wt, 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            v2, w2, n2 = blocks.pop()
            v1, w1, n1 = blocks.pop()
            blocks.append([(v1 * w1 + v2 * w2) / (w1 + w2), w1 + w2, n1 + n2])
    out = []
    for value, _, size in blocks:
        out.extend([value] * size)
    return [v + off for v, off in zip(out, offset, strict=False)]


def flow_grid(net: Network) -> dict[str, tuple[int, float]]:
    """(stage, rank) for every node: the stage from `stages`, and the place within the
    stage, centred on 0, chosen so pipelines cross as little as possible. The browser
    turns these into positions for either direction; 1 rank is one card's width."""
    layers = _Layers(net)
    ranks = layers.spacing(layers.order())
    return {node: (layers.stage[node], ranks[node]) for node in sorted(ranks)}


def flow_positions(net: Network) -> dict[str, tuple[float, float]]:
    """Canvas x, y for the left-to-right layout: columns by stage, rows by rank."""
    return {
        node: (stage * COLUMN_GAP, round(rank * ROW_GAP, 1))
        for node, (stage, rank) in flow_grid(net).items()
    }


def crossings(net: Network, positions: dict[str, tuple[float, float]]) -> int:
    """How many pairs of pipelines cross when drawn as straight lines: the measure of a
    tangled overview. Pipelines that share an end do not count."""
    segments = [(p.from_id, p.to_id) for p in net.pipelines]

    def side(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    total = 0
    for (a, b), (c, d) in combinations(segments, 2):
        if {a, b} & {c, d}:
            continue
        pa, pb, pc, pd = positions[a], positions[b], positions[c], positions[d]
        if side(pa, pb, pc) * side(pa, pb, pd) < 0 and side(pc, pd, pa) * side(pc, pd, pb) < 0:
            total += 1
    return total
