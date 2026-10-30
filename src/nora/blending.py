"""The blending stations: where gas from several plants is mixed before it leaves the
shelf (Sleipner and Draupner today). Which nodes they are is set in nora.toml
[blending] stations; the pipelines around them come from data/pipelines.csv.

The app draws them as one left-to-right picture on their asset pages (app.js
blendingPicture): the payload carries the lines found here, so the browser only
places them by the current flow and never works out the topology itself.
"""

from __future__ import annotations

from collections.abc import Iterable

from .data import DataError, Network, suggest


def blending_routes(net: Network, stations: Iterable[str]) -> dict[str, list[str]]:
    """The stations and the pipelines around them, by pipelines.csv's from and to:
    `incoming` ends at a station, `internal` joins two stations and `outgoing` leaves
    one. The browser puts a line on the side its current flow says, so a line running
    against its CSV direction still sits on the right side. Raises DataError naming
    every id that is not a node, with a suggestion."""
    stations = list(dict.fromkeys(stations))  # in order, once each
    unknown = [s for s in stations if s not in net.node_by_id]
    if unknown:
        raise DataError(
            [
                f"nora.toml [blending] stations: no node {s!r}" + suggest(s, net.node_by_id)
                for s in unknown
            ]
        )
    inside = set(stations)
    routes: dict[str, list[str]] = {
        "stations": stations,
        "incoming": [],
        "internal": [],
        "outgoing": [],
    }
    # Map detail (satellites, map_min_zoom) is not one of the main lines.
    detail = {n.id for n in net.nodes if n.map_min_zoom}
    for pipe in sorted(net.pipelines, key=lambda p: p.id):
        if pipe.from_id in detail or pipe.to_id in detail:
            continue
        start, end = pipe.from_id in inside, pipe.to_id in inside
        if start and end:
            routes["internal"].append(pipe.id)
        elif end:
            routes["incoming"].append(pipe.id)
        elif start:
            routes["outgoing"].append(pipe.id)
    return routes
