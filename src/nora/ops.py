"""Operations checks: is the plan deliverable now, and will it still be in a few hours?

The plan is the hourly nominations at the exit points. For each time step of a stream
that has nominations, NORA asks the network model whether the gas the fields can
supply (with the stream's events applied) can reach every exit point at its nominated
rate. The answer uses the alarm priorities from nora.toml:

  0 normal   the plan holds
  1 warning  an exit point would fall short by at least the warning share
  2 medium   ... by the medium share
  3 critical ... by the critical share

A plan that only runs pipelines full is not an alarm; the busiest pipeline is
reported as context.

When the plan falls short, `advise` adds decision support: the likely cause (an active
event upstream of the exit point) and where the gas could still go (spare deliverable
capacity at other exit points, within their bookings). Every suggestion carries its
basis and its uncertainty, so an operator can judge it rather than follow it.
"""

from __future__ import annotations

from dataclasses import dataclass

import networkx as nx

from .analysis import OUT, SINK, SOURCE, shortest_max_flow
from .data import SUPPLY_TYPES, Network
from .graph import build_graph
from .stream import Stream, apply_events

LEVELS = ("normal", "warning", "medium", "critical")


def level(value: float, thresholds: list[float], rising: bool = True) -> int:
    """How many of the three thresholds [warning, medium, critical] `value` has passed."""
    if rising:
        return sum(value >= t for t in thresholds)
    return sum(value <= t for t in thresholds)


@dataclass(frozen=True)
class PlanCheck:
    level: int
    text: str
    asset: str | None  # the exit point that falls shortest
    nominated: float
    deliverable: float
    max_load: float
    bottleneck: str | None  # the busiest pipeline in the plan


def _plan_graph(graph: nx.DiGraph, exits: dict[str, float]) -> nx.DiGraph:
    """Fields and storage supply the network; each exit point takes up to its rate."""
    flows = nx.DiGraph()
    flows.add_node(SOURCE)
    flows.add_node(SINK)
    skip = {n for n, a in graph.nodes(data=True) if a["type"] in ("market", "lng")}
    for u, v, attrs in graph.edges(data=True):
        if u not in skip and v not in skip:
            flows.add_edge(u, v, **attrs)
    for node, attrs in graph.nodes(data=True):
        if node in skip:
            continue
        if attrs["type"] in ("field", "storage") and attrs.get("capacity_msm3d"):
            flows.add_edge(SOURCE, node, capacity=attrs["capacity_msm3d"])
        elif (
            attrs["type"] not in SUPPLY_TYPES and attrs.get("capacity_msm3d") and node not in exits
        ):
            # A gas plant's processing capacity limits what passes it, as in the
            # max-flow model (analysis.flow_graph): its lines leave from an out-node.
            out = node + OUT
            for _, target, edge in list(flows.out_edges(node, data=True)):
                flows.add_edge(out, target, **edge)
            flows.remove_edges_from(list(flows.out_edges(node)))
            flows.add_edge(node, out, capacity=attrs["capacity_msm3d"])
    for node, rate in exits.items():
        # An exit point an event took out is not in `graph`: it is still added, with
        # nothing reaching it, so its whole nomination shows as short.
        flows.add_edge(node, SINK, capacity=rate)
    return flows


def check_plan(
    graph: nx.DiGraph, nominations: dict[str, float], thresholds: dict, names: dict[str, str]
) -> PlanCheck:
    """Can `graph` (events applied) deliver `nominations` {exit node: MSm3/d}?

    Every nomination counts, also at an exit point an event took out of `graph`: it
    can take no gas, so it falls short by all of it (dropping it read "Plan holds"
    during a terminal trip)."""
    wanted = {node: rate for node, rate in nominations.items() if rate > 0}
    nominated = sum(wanted.values())
    if not wanted:
        return PlanCheck(0, "No nominations", None, 0.0, 0.0, 0.0, None)
    flows = _plan_graph(graph, wanted)
    flow = shortest_max_flow(flows)
    delivered = {node: flow.get(node, {}).get(SINK, 0.0) for node in wanted}
    short = {node: (rate - delivered[node]) / rate for node, rate in wanted.items()}
    worst = max(short, key=lambda n: (short[n], n))
    loads: dict[str, float] = {}
    for u, v, attrs in flows.edges(data=True):
        if "pipeline" in attrs and attrs.get("capacity"):
            pipe = attrs["pipeline"]
            loads[pipe] = loads.get(pipe, 0.0) + flow[u].get(v, 0.0) / attrs["capacity"]
    bottleneck = max(loads, key=lambda p: (loads[p], p)) if loads else None
    found = level(short[worst], thresholds["nomination"])
    missing = wanted[worst] - delivered[worst]
    text = (
        f"Short {missing:.1f} MSm³/d at {names.get(worst, worst)}"
        if found
        else "Plan holds at every exit point"
    )
    return PlanCheck(
        level=found,
        text=text,
        asset=worst if found else None,
        nominated=round(nominated, 1),
        deliverable=round(sum(delivered.values()), 1),
        max_load=round(loads.get(bottleneck, 0.0), 3) if bottleneck else 0.0,
        bottleneck=bottleneck,
    )


def advise(
    graph: nx.DiGraph,
    base: nx.DiGraph,
    check: PlanCheck,
    nominations: dict[str, float],
    bookings: dict[str, float],
    events: tuple,
    stream: Stream,
    names: dict[str, str],
) -> dict:
    """Cause, suggestions, basis and uncertainty for a plan that falls short."""
    short_exit = check.asset
    missing = check.nominated - check.deliverable
    cause = None
    for event in events:
        kind = "planned work" if event.planned else "unplanned event"
        if event.asset == short_exit:  # the exit point itself is out
            cause = f"{event.label} ({kind}) at {names.get(short_exit, short_exit)} itself"
            break
        upstream = event.asset if event.asset in base else None
        if upstream is None:  # a pipeline: start from where it leaves
            ends = [u for u, _, a in base.edges(data=True) if a["pipeline"] == event.asset]
            upstream = ends[0] if ends else None
        if upstream and short_exit in base and nx.has_path(base, upstream, short_exit):
            cause = f"{event.label} ({kind}) is upstream of {names.get(short_exit, short_exit)}"
            break
    wanted = {n: r for n, r in nominations.items() if r > 0 and n in graph}
    spare = []
    for other in sorted(wanted):
        if other == short_exit:
            continue
        ceiling = bookings.get(other, wanted[other] * 1.2)
        if ceiling <= wanted[other]:
            continue
        trial = dict(wanted, **{other: ceiling})
        flow = shortest_max_flow(_plan_graph(graph, trial))
        extra = flow.get(other, {}).get(SINK, 0.0) - min(
            wanted[other], flow.get(other, {}).get(SINK, 0.0)
        )
        if extra > 0.5:
            spare.append((round(extra, 1), other))
    spare.sort(reverse=True)
    spare_total = sum(x for x, _ in spare)
    suggestions = []
    if spare and missing > 0.5:
        targets = ", ".join(f"{names.get(n, n)} (up to {x:.1f})" for x, n in spare[:3])
        suggestions.append(
            "Ask shippers to renominate toward exit points that can still take more gas: "
            f"{targets} MSm³/d, within booked capacity."
        )
    if missing - spare_total > 0.5:
        suggestions.append(
            f"About {missing - spare_total:.1f} MSm³/d cannot be rerouted within today's "
            "bookings: prepare curtailment, or draw on line pack and storage."
        )
    uncertainty = [
        "Pipeline capacities are approximate public figures.",
        "The model is steady-state: no pressure, line-pack or compressor dynamics.",
        "Spare capacity is worked out one exit point at a time; it may not all be "
        "available at once.",
    ]
    if stream.synthetic:
        uncertainty.append("The data are synthetic.")
    confidence = "low" if stream.synthetic else "medium"
    situation = (
        f"The network can deliver {check.deliverable:.1f} of {check.nominated:.1f} MSm³/d "
        f"nominated: {missing:.1f} short in total, most at {names.get(short_exit, short_exit)}."
    )
    return {
        "situation": situation,
        "cause": cause or "Cause not identified from the events in this dataset",
        "suggestions": suggestions,
        "basis": (
            "Max-flow model of data/pipelines.csv with the events active at this time; "
            f"nominations and bookings from '{stream.title}'"
            + (f" ({stream.source})" if stream.source else "")
            + "; thresholds from nora.toml."
        ),
        "uncertainty": uncertainty,
        "confidence": confidence,
    }


def plan_timeline(stream: Stream, net: Network, config: dict) -> list[dict] | None:
    """Plan status for every time step, now and looking ahead; None without nominations."""
    if "nomination_msm3d" not in stream.metrics:
        return None
    assets, values = stream.metrics["nomination_msm3d"]
    thresholds = config["thresholds"]
    names = {n.id: n.name for n in net.nodes} | {p.id: p.name for p in net.pipelines}
    base = build_graph(net)
    cache: dict = {}
    advice_cache: dict = {}
    booked_assets, booked_values = stream.metrics.get("booked_msm3d", ((), ()))

    def advice_for(j: int, known: tuple, result: PlanCheck) -> dict:
        when = stream.times[j]
        active = tuple(e for e in known if e.active(when))
        nominations = {a: v for a, v in zip(assets, values[j], strict=True) if v is not None}
        bookings = (
            {a: v for a, v in zip(booked_assets, booked_values[j], strict=True) if v is not None}
            if booked_values
            else {}
        )
        key = (active, tuple(sorted(nominations.items())), tuple(sorted(bookings.items())))
        if key not in advice_cache:
            advice_cache[key] = advise(
                apply_events(base, active, when),
                base,
                result,
                nominations,
                bookings,
                active,
                stream,
                names,
            )
        return advice_cache[key]

    def check(j: int, known: tuple) -> PlanCheck:
        when = stream.times[j]
        active = tuple(e for e in known if e.active(when))
        key = (j, active)
        if key not in cache:
            row = values[j]
            nominations = {a: v for a, v in zip(assets, row, strict=True) if v is not None}
            cache[key] = check_plan(
                apply_events(base, active, when), nominations, thresholds, names
            )
        return cache[key]

    step_hours = (
        (stream.times[1] - stream.times[0]).total_seconds() / 3600 if len(stream.times) > 1 else 1
    )
    ahead_steps = max(1, round(thresholds["plan_lookahead_hours"] / step_hours))
    timeline = []
    for i, when in enumerate(stream.times):
        # Looking ahead uses only what is known now: planned work, and events under way.
        known = tuple(e for e in stream.events if e.planned or e.start <= when)
        now = check(i, tuple(stream.events))
        upcoming = [
            (j, check(j, known)) for j in range(i + 1, min(len(stream.times), i + 1 + ahead_steps))
        ]
        j, ahead = max(upcoming, key=lambda jc: (jc[1].level, -jc[0]), default=(i, now))
        entry = {
            "now": [now.level, now.text, now.asset],
            "ahead": [ahead.level, ahead.text, ahead.asset, round((j - i) * step_hours, 1)],
            "nominated": now.nominated,
            "deliverable": now.deliverable,
            "maxLoad": now.max_load,
            "bottleneck": now.bottleneck,
        }
        if now.level:
            entry["advice"] = advice_for(i, tuple(stream.events), now)
        elif ahead.level:
            entry["advice"] = advice_for(j, known, ahead)
        timeline.append(entry)
    return timeline
