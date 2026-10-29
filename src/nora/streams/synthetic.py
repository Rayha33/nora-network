"""Synthetic streams: flows from the network model, operations, gas quality and pigs.

Also the scripted excursions and events, and the pig programme on every main line.
"""

from __future__ import annotations

import math
import random
import statistics
from datetime import datetime, timedelta

import networkx as nx

from ..analysis import routed_flow
from ..data import SUPPLY_TYPES, DataError, Network, suggest
from ..graph import build_graph
from .model import Event, Pig, Row, parse_time
from .pigs import _pig_problem

# A field's gas between lean (Troll-like) and rich (Åsgard-like), mol % of the hydrocarbons
# and nitrogen (CO2 comes from its own reading).
GC_LEAN = {
    "c1": 93.6,
    "c2": 3.7,
    "c3": 0.5,
    "ic4": 0.06,
    "nc4": 0.07,
    "ic5": 0.02,
    "nc5": 0.02,
    "c6plus": 0.03,
    "n2": 2.0,
}

GC_RICH = {
    "c1": 84.5,
    "c2": 8.6,
    "c3": 3.6,
    "ic4": 0.6,
    "nc4": 0.85,
    "ic5": 0.22,
    "nc5": 0.2,
    "c6plus": 0.23,
    "n2": 1.2,
}

# Typical gas quality at a field: each field gets a steady level in this range.
QUALITY_BASE = {"h2s_ppm": (0.2, 1.2), "co2_molpct": (0.5, 1.5)}


def synthesize(
    net: Network,
    spec: dict,
    events: tuple[Event, ...] = (),
    pressure_windows: dict | None = None,
) -> list[Row]:
    """Generate plausible operating data from the network model.

    Field output follows a daily demand shape plus slow random drift per field, LNG
    send-out stays flatter, and each event scales an asset's capacity while it is
    active. Every step is routed with routed_flow, so the flows always balance.

    With `operations = true` the stream also gets:
      nomination_msm3d  hourly nominations at each terminal: the flow the shippers
                        planned without events; dispatch keeps the flows on
                        it until an event intervenes
      booked_msm3d      booked capacity at each terminal, one exit booked tight
      pressure_bar      pressure at each node, following the gas actually moving
                        through it with a lag, inside its operating window, plus
                        the `pressure_excursions` the spec lists (a node's pressure
                        rising by `rise_bar` for `hours`, to show its limits)
    With `quality = true`, H2S (ppm) and CO2 (mol %) at each field: a steady level
    with a little noise, plus the `excursions` the spec lists.
    The same spec and seed always give the same rows.
    """
    start = parse_time(spec.get("start", "2026-01-05T00:00:00Z"))
    step = timedelta(minutes=int(spec.get("step_minutes", 60)))
    steps = int(spec.get("steps", 168))
    rng = random.Random(spec.get("seed", 1))
    base = build_graph(net)
    pipes = sorted({attrs["pipeline"] for _, _, attrs in base.edges(data=True)})
    suppliers = sorted(n for n, attrs in base.nodes(data=True) if attrs["type"] in SUPPLY_TYPES)
    operations = bool(spec.get("operations", False))
    drift = dict.fromkeys(suppliers, 0.0)
    rows: list[Row] = []
    actual: list[dict[str, float]] = []
    planned: list[dict[str, float]] = []
    times = [start + k * step for k in range(steps)]
    for when in times:
        graph = apply_events(base, events, when)
        supply, plan_supply = {}, {}
        for node in suppliers:
            drift[node] = 0.9 * drift[node] + rng.gauss(0, 0.012)
            share = _load(when, base.nodes[node]["type"], drift[node])
            # The event-applied graph, not the base: a derated or offline supply
            # node must actually reduce what it can push into the network...
            supply[node] = (graph.nodes[node]["capacity_msm3d"] or 0.0) * share
            # ...while the plan (the nominations) is what it would supply without
            # events, so a field outage shows as a shortfall against the plan.
            plan_supply[node] = (base.nodes[node]["capacity_msm3d"] or 0.0) * share
        # Dispatch keeps exit points on their nominations: the plan is what the supply
        # would deliver without events, and only an event pushes the flows off it.
        flow = routed_flow(graph, supply)
        rows += [
            (when, pipe, "flow_msm3d", round(flow.pipelines.get(pipe, 0.0), 3)) for pipe in pipes
        ]
        if operations:
            actual.append(_throughput(net, flow))
            planned.append(
                _throughput(net, flow if graph is base else routed_flow(base, plan_supply))
            )
    if operations:
        rises = _pressure_rises(net, times, spec.get("pressure_excursions", []))
        breaches = spec.get("breaches")
        targets, surges = (
            _random_breaches(net, times, breaches, rows, spec.get("seed", 1))
            if breaches
            else ([], [])
        )
        rows += _operations_rows(net, times, actual, planned, pressure_windows, rng, rises, targets)
        rows = _surge_flows(rows, surges)
    if spec.get("quality", False):
        rows += _quality_rows(net, times, spec.get("excursions", []), spec.get("seed", 1))
    if spec.get("composition", False):
        rows += _composition_rows(net, times, rows, spec.get("seed", 1))
    if spec.get("weather", False):
        rows += _weather_rows(net, times, spec.get("seed", 1))
    return rows


def _composition_rows(net: Network, times: list[datetime], rows: list[Row], seed) -> list[Row]:
    """Each producing field's export gas as its GC reads it (Ray, 29 Oct: "GC values in a
    table like C1 Metan, C2 Etan, C3 Propan etc all the way to C6+ and then CO2, N2 ...
    O2, WDP and HCDP"). Each field sits somewhere between lean and rich gas and drifts a
    little; its CO2 is its own CO2 reading, the rest scaled to fill 100 %. Synthetic."""
    co2 = {(when, node): value for when, node, metric, value in rows if metric == "co2_molpct"}
    out: list[Row] = []
    for node in sorted(n.id for n in net.nodes if n.type == "field" and n.capacity_msm3d):
        rng = random.Random(f"gc-{seed}-{node}")  # each field its own, whatever else changes
        rich, drift, dew, hc = rng.random(), 0.0, rng.gauss(-14, 1.5), 0.0
        for when in times:
            drift = 0.9 * drift + rng.gauss(0, 0.01)
            r = min(1.0, max(0.0, rich + drift))
            mix = {k: GC_LEAN[k] + (GC_RICH[k] - GC_LEAN[k]) * r for k in GC_LEAN}
            carbon = co2.get((when, node), 1.0)
            scale = (100 - carbon) / sum(mix.values())
            for k, v in mix.items():
                out.append((when, node, f"{k}_molpct", round(v * scale, 3)))
            hc = 0.8 * hc + rng.gauss(0, 0.3)
            out.append((when, node, "o2_ppm", round(max(0.0, 1.5 + rng.gauss(0, 0.4)), 2)))
            out.append((when, node, "wdp_c", round(dew + rng.gauss(0, 0.3), 1)))
            out.append((when, node, "hcdp_c", round(-9 + 6 * r + hc, 1)))
    return out


def _weather_rows(net: Network, times: list[datetime], seed) -> list[Row]:
    """The outside air temperature at each onshore site (Ray, 29 Oct: "what temperature it
    is at each of the main exit point hubs ... outside temperature in degrees celsius"):
    late autumn, cooler to the north, warmest early afternoon. Synthetic."""
    out: list[Row] = []
    onshore = sorted(
        (
            n
            for n in net.nodes
            if n.type in ("terminal", "processing", "market") and n.status == "operating"
        ),
        key=lambda n: n.id,
    )
    for node in onshore:
        rng, noise = random.Random(f"weather-{seed}-{node.id}"), 0.0
        mean = 14.0 - 0.35 * (node.lat - 50)
        for when in times:
            noise = 0.9 * noise + rng.gauss(0, 0.35)
            hour = when.hour + when.minute / 60
            out.append(
                (
                    when,
                    node.id,
                    "air_temp_c",
                    round(mean + 3 * math.cos(2 * math.pi * (hour - 13) / 24) + noise, 1),
                )
            )
    return out


def _quality_rows(net: Network, times: list[datetime], excursions: list, seed) -> list[Row]:
    """H2S and CO2 at each field. An excursion reads `peak` for `hours` (one by
    default): a slug of off-spec gas that long to follow (Ray, 29 Oct: "simulated peaks
    are too long"). With `every_hours` it comes back that often."""
    rng = random.Random(f"quality-{seed}")  # its own generator: flows stay as they were
    fields = sorted(n.id for n in net.nodes if n.type == "field")
    problems, bumps = [], []
    for i, spec in enumerate(excursions, start=1):
        asset, metric = spec.get("asset", ""), spec.get("metric", "")
        where = f"synthetic excursion {i}"
        if asset not in fields:
            problems.append(f"{where}: '{asset}' is not a field" + suggest(asset, fields))
        if metric not in QUALITY_BASE:
            problems.append(f"{where}: metric must be one of {', '.join(QUALITY_BASE)}")
        try:
            peak, hours = float(spec["peak"]), float(spec.get("hours", 1))
            start, every = parse_time(spec["start"]), float(spec.get("every_hours", 0))
            while start <= times[-1]:
                bumps.append((asset, metric, peak, start, hours))
                if every <= 0:
                    break
                start += timedelta(hours=every)
        except (KeyError, ValueError) as error:
            problems.append(f"{where}: needs a peak and a start time ({error})")
    if problems:
        raise DataError(problems)
    rows: list[Row] = []
    for metric, (low, high) in QUALITY_BASE.items():
        for node in fields:
            base, noise = rng.uniform(low, high), 0.0
            for when in times:
                noise = 0.7 * noise + rng.gauss(0, 0.02)
                value = base * (1 + noise)
                for asset, kind, peak, start, hours in bumps:
                    sending = start <= when < start + timedelta(hours=hours)
                    if asset == node and kind == metric and sending:
                        value += max(0.0, peak - base)
                rows.append((when, node, metric, round(max(0.0, value), 2)))
    return rows


def _plateau(when: datetime, start: datetime, hours: float) -> float:
    """0 before and after, 1 from `start` for `hours`, with one-hour ramps."""
    t = (when - start).total_seconds() / 3600
    return max(0.0, min(1.0, t + 1, hours + 1 - t))


def _throughput(net: Network, flow) -> dict[str, float]:
    """Gas through each node: what it supplies, or what arrives at it."""
    through: dict[str, float] = dict(flow.supplied)
    for pipe in net.pipelines:
        value = flow.pipelines.get(pipe.id, 0.0)
        target = pipe.to_id if value > 0 else pipe.from_id
        if pipe.type != "onshore" or net.node_by_id[target].type == "market":
            through[target] = through.get(target, 0.0) + abs(value)
    return through


def _pressure_rises(net: Network, times: list[datetime], excursions: list) -> list:
    """A node's pressure rising by `rise_bar` (a restriction downstream, a compressor
    trip): ramps up over an hour, holds for `hours`, ramps down, and the pressure
    follows at its usual pace.
    Scripted so the Flow view shows its limits in a demo (Ray, 29 Oct: high yellow,
    high-high red, integrity dark red)."""
    problems, rises = [], []
    for i, spec in enumerate(excursions, start=1):
        asset, where = spec.get("asset", ""), f"synthetic pressure excursion {i}"
        if asset not in net.node_by_id:
            problems.append(f"{where}: '{asset}' is not a node" + suggest(asset, net.node_by_id))
        try:
            rise, hours = float(spec["rise_bar"]), float(spec.get("hours", 3))
            start, every = parse_time(spec["start"]), float(spec.get("every_hours", 0))
            while start <= times[-1]:
                rises.append((asset, rise, start, hours))
                if every <= 0:
                    break
                start += timedelta(hours=every)
        except (KeyError, ValueError) as error:
            problems.append(f"{where}: needs a rise_bar and a start time ({error})")
    if problems:
        raise DataError(problems)
    return rises


def _random_breaches(net: Network, times: list[datetime], spec, flow_rows: list[Row], seed):
    """Random limit breaches for a demo (Ray, 29 Oct: "random pressure and flow limits
    breached but keep the not too frequent. then less frequent a few of them turning red,
    meaning high high or low low"). `breaches = {pressure_per_day, flow_per_day,
    severe_share}`: each event picks a node (its pressure heads past its low or high
    limit, nora.toml [pressure_limits]) or a busy pipeline (its flow runs over capacity),
    a start and a few hours; a `severe_share` of them go on to low-low or high-high (a
    flow past the load's critical level). Returns pressure targets and flow surges."""
    from ..config import load_config

    config = load_config()
    limits, load = config["pressure_limits"], config["thresholds"]["load"]
    rng = random.Random(f"breaches-{seed}")  # its own generator: nothing else moves
    days = (times[-1] - times[0]).total_seconds() / 86400 + 1 / 24
    severe = float(spec.get("severe_share", 0.25))
    when = lambda: times[0] + timedelta(hours=rng.uniform(0, days * 24 - 8))  # noqa: E731
    nodes = sorted(n.id for n in net.nodes if n.type in limits and n.status == "operating")

    def flags(count):  # exactly a `severe` share of the events go on to red, in random order
        hard = [k < round(count * severe) for k in range(count)]
        rng.shuffle(hard)
        return hard

    targets = []  # (node, bar to head for, start, hours)
    red_up = rng.random() < 0.5  # the red ones take turns: high-high, then low-low
    for hard in flags(round(float(spec.get("pressure_per_day", 0)) * days)):
        node, up = rng.choice(nodes), rng.random() < 0.5
        if hard:
            up, red_up = red_up, not red_up
        kind = net.node_by_id[node].type
        ll, low, high, hh, _top = limits[kind]
        bar = (hh + 1.5 if hard else high + 3) if up else (ll - 1.5 if hard else low - 3)
        hours = rng.uniform(3, 5) if hard else rng.uniform(5, 9)  # red is brief
        if hard:  # but long enough to get there at 6 bar/h from where the node usually sits
            lo_w, hi_w = config["pressure"][kind]
            usual = lo_w + (hi_w - lo_w) * (0.5 if kind in ("terminal", "market", "lng") else 0.7)
            hours += abs(bar - usual) / 6
        targets.append((node, bar, when(), hours))
    flows: dict[str, list[float]] = {}
    for _when, asset, metric, value in flow_rows:
        if metric == "flow_msm3d":
            flows.setdefault(asset, []).append(abs(value))
    busy = sorted(
        p.id
        for p in net.pipelines
        if p.capacity_msm3d
        and flows.get(p.id)
        and statistics.median(flows[p.id]) >= 0.5 * p.capacity_msm3d
    )
    surges = []  # (pipeline, share of capacity, start, hours, capacity)
    for hard in flags(round(float(spec.get("flow_per_day", 0)) * days) if busy else 0):
        pipe = rng.choice(busy)
        share = (
            rng.uniform(load[2] + 0.01, load[2] + 0.04)
            if hard
            else rng.uniform(load[0] + 0.01, load[1] - 0.01)
        )
        capacity = next(p.capacity_msm3d for p in net.pipelines if p.id == pipe)
        surges.append((pipe, share, when(), rng.uniform(3, 6), capacity))
    return targets, surges


def _surge_flows(rows: list[Row], surges) -> list[Row]:
    """A pipeline's flow raised towards `share` of its capacity while a surge lasts (its
    sign kept). Synthetic: the other lines are not rebalanced."""
    if not surges:
        return rows
    out = []
    for when, asset, metric, value in rows:
        if metric == "flow_msm3d":
            for pipe, share, start, hours, capacity in surges:
                if pipe == asset:
                    peak = share * capacity
                    bump = _plateau(when, start, hours) * max(0.0, peak - abs(value))
                    value = round(math.copysign(abs(value) + bump, value or 1.0), 3)
        out.append((when, asset, metric, value))
    return out


def _operations_rows(net, times, actual, planned, windows, rng, rises=(), targets=()) -> list[Row]:
    if windows is None:
        from ..config import load_config

        windows = load_config()["pressure"]
    rows: list[Row] = []
    exits = sorted(n.id for n in net.nodes if n.type == "terminal")
    # Hourly nominations: the planned flow at each exit point.
    nominated: dict[str, list[float]] = {}
    for node in exits:
        nominated[node] = [round(p.get(node, 0.0), 1) for p in planned]
        for when, value in zip(times, nominated[node], strict=True):
            rows.append((when, node, "nomination_msm3d", value))
    # Bookings: comfortable headroom, except the busiest exit, booked tight.
    busiest = max(exits, key=lambda n: max(nominated[n]), default=None)
    for node in exits:
        peak = max(nominated[node])
        if peak <= 0:
            continue
        booked = math.ceil(peak * (1.05 if node == busiest else 1.15) * 2) / 2
        rows += [(when, node, "booked_msm3d", booked) for when in times]
    # Pressures: arrival points follow the gas arriving; departure points the load. A
    # pipeline's pressure is its line pack, so it moves slowly: it tracks its target a
    # fifth of the way each hour, at most 1.5 bar/h, with a gentle drift. Faster moves
    # made the line pack swing by hundreds of MSm3/d where operators see a few (Ray, 29
    # Oct: the pack rate stays near 0, and the rate of change of pressure is watched).
    hours = (times[1] - times[0]).total_seconds() / 3600 if len(times) > 1 else 1.0
    typical = {
        node: statistics.median(p.get(node, 0.0) for p in planned) for node in net.node_by_id
    }
    for node in sorted(net.node_by_id):
        kind = net.node_by_id[node].type
        if kind not in windows or typical[node] <= 0:
            continue
        low, high = windows[kind]
        span = high - low
        arrival = kind in ("terminal", "market", "lng")
        pressure, noise = None, 0.0
        for when, through in zip(times, actual, strict=True):
            ratio = min(1.4, through.get(node, 0.0) / typical[node])
            share = 0.2 + 0.3 * ratio if arrival else 0.55 + 0.15 * ratio  # same means, calmer
            noise = 0.95 * noise + rng.gauss(0, 0.0012)
            target = low + span * (share + noise)
            target += sum(r * _plateau(when, s, h) for a, r, s, h in rises if a == node)
            # a random breach heads for its bar from where the node usually sits
            usual = low + span * (0.5 if arrival else 0.7)
            breach = sum(
                (bar - usual) * _plateau(when, s, h) for a, bar, s, h in targets if a == node
            )
            target += breach
            # a breach (a trip, a restriction) moves the pressure faster: up to 6 bar/h
            pull, most = (0.5, 6.0) if breach else (0.2, 1.5)
            if pressure is None:
                pressure = target
            else:
                step = min(1.0, pull * hours) * (target - pressure)
                pressure += max(-most * hours, min(most * hours, step))
            rows.append((when, node, "pressure_bar", round(pressure, 2)))
    return rows


def _load(when: datetime, kind: str, drift: float) -> float:
    """Share of capacity in use: a morning and evening peak, quieter weekends."""
    hour = when.hour + when.minute / 60
    daily = 0.05 * math.cos(2 * math.pi * (hour - 18) / 24)
    daily += 0.02 * math.cos(2 * math.pi * (hour - 8) / 12)
    weekend = -0.05 if when.weekday() >= 5 else 0.0
    level = 0.55 + daily / 2 if kind == "lng" else 0.84 + daily
    return min(1.0, max(0.05, level + weekend + drift))


def apply_events(base: nx.DiGraph, events: tuple[Event, ...], when: datetime) -> nx.DiGraph:
    active = [e for e in events if e.active(when)]
    if not active:
        return base
    graph = base.copy()
    for event in active:
        factor = event.capacity_factor
        if event.asset in graph:
            attrs = graph.nodes[event.asset]
            if attrs["type"] in SUPPLY_TYPES:
                attrs["capacity_msm3d"] = (attrs["capacity_msm3d"] or 0.0) * factor
            elif factor == 0:
                graph.remove_node(event.asset)
            else:
                # A processing node's capacity travels on the node, not its edges:
                # scale it too, or a partial derate is silently ignored. A terminal or
                # hub without a capacity of its own takes what its lines can bring it.
                if not attrs.get("capacity_msm3d"):
                    attrs["capacity_msm3d"] = _intake(graph, event.asset)
                if attrs.get("capacity_msm3d"):
                    attrs["capacity_msm3d"] *= factor
                for _, _, edge in graph.out_edges(event.asset, data=True):
                    if "capacity" in edge:
                        edge["capacity"] *= factor
            continue
        edges = [(u, v) for u, v, a in graph.edges(data=True) if a["pipeline"] == event.asset]
        if factor == 0:
            graph.remove_edges_from(edges)
        for u, v in edges if factor else ():
            if "capacity" in graph.edges[u, v]:
                graph.edges[u, v]["capacity"] *= factor
    return graph


def _intake(graph: nx.DiGraph, node: str) -> float | None:
    """What the lines into `node` can carry together; None when one has no capacity."""
    capacities = [edge.get("capacity") for _, _, edge in graph.in_edges(node, data=True)]
    if not capacities or None in capacities:
        return None
    return sum(capacities)


# A pigging programme puts a pig on every trunk, export line and interconnector:
# one pig per main line, launches staggered evenly over `every_hours` from the stream
# start, so several are always under way. An explicit [[pigs]] entry wins for its line.
PIG_LINES = ("trunk", "export", "interconnector")


def _pig_programme(
    meta: dict, net: Network, explicit: set[str], where: str, problems: list[str]
) -> list[Pig]:
    synthetic = meta.get("synthetic")
    if not isinstance(synthetic, dict):
        return []
    programme = synthetic.get("pig_programme")
    if not isinstance(programme, dict):
        if programme is not None:
            problems.append(f"{where}/stream.toml pig_programme: must be a table")
        return []
    try:
        every = float(programme.get("every_hours", 48))
        speed = float(programme.get("speed_mps", 4.0))
        notify = float(programme.get("notify_every_hours", 6.0))
    except (TypeError, ValueError):
        problems.append(
            f"{where}/stream.toml pig_programme: every_hours and speed_mps must be numbers"
        )
        return []
    if every <= 0:
        problems.append(f"{where}/stream.toml pig_programme: every_hours must be above 0")
        return []
    if speed <= 0:
        problems.append(f"{where}/stream.toml pig_programme: speed_mps must be above 0")
        return []
    kind = str(programme.get("kind", "cleaning"))
    problem = _pig_problem(
        Pig("", "", start_of(synthetic), 1.0, kind=kind, notify_every_hours=notify), net
    )
    if problem:
        problems.append(f"{where}/stream.toml pig_programme: {problem}")
        return []
    start = start_of(synthetic)
    mains = sorted(p.id for p in net.pipelines if p.type in PIG_LINES and p.id not in explicit)
    pigs = []
    for i, pipeline in enumerate(mains):
        launch = start + timedelta(seconds=every * 3600 * i / max(1, len(mains)))
        pigs.append(
            Pig(
                label=f"Pig on {net.asset_name(pipeline)}",
                pipeline=pipeline,
                launch=launch,
                speed_mps=speed,
                every_hours=every,
                kind=kind,
                notify_every_hours=notify,
            )
        )
    return pigs


def start_of(synthetic: dict) -> datetime:
    return parse_time(synthetic.get("start", "2026-01-05T00:00:00Z"))
