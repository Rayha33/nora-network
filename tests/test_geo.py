"""The map draws the network where it is: pipelines follow their laid routes (SODIR's
pipeline register) and join their nodes exactly; lines without a route stay straight."""

import math

from nora.render import _route_line, map_geojson, routes


def km(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k * 111.32, (a[1] - b[1]) * 111.32)


def test_route_line_joins_both_nodes_and_falls_back_to_straight():
    start, end = [2.0, 58.0], [3.0, 56.0]
    route = [[2.1, 57.9], [2.6, 57.0], [3.0, 56.1]]
    line = _route_line(route, start, end)
    assert line[0] == start and line[-1] == end, "the line meets both nodes exactly"
    assert line[1:-1] == route, "and keeps the laid route between them"
    assert _route_line(None, start, end) == [start, end], "no route: a straight line"


def test_norwegian_pipelines_follow_their_laid_routes(north_sea):
    laid = routes()
    assert len(laid) >= 30, "SODIR routes for the Norwegian system"
    lines = {
        f["properties"]["asset"]: f["geometry"]["coordinates"]
        for f in map_geojson(north_sea)["pipes"]["features"]
    }
    where = {n.id: [n.lon, n.lat] for n in north_sea.nodes}
    pipes = {p.id: p for p in north_sea.pipelines}
    for pid in laid:
        line = lines[pid]
        assert len(line) > 2, f"{pid} follows its route, not a chord"
        p = pipes[pid]
        assert line[0] == where[p.from_id] and line[-1] == where[p.to_id], f"{pid} meets its nodes"
        # The laid route itself starts and ends near the nodes: a node far from the
        # route it is on is in the wrong place on the map.
        assert km(laid[pid][0], where[p.from_id]) < 25, f"{pid} starts near {p.from_id}"
        assert km(laid[pid][-1], where[p.to_id]) < 25, f"{pid} ends near {p.to_id}"


def test_draupner_platforms_sit_on_their_bridge(north_sea):
    """Draupner S and E are bridge-linked: SODIR puts them about 120 m apart."""
    where = {n.id: (n.lon, n.lat) for n in north_sea.nodes}
    assert km(where["draupner_s"], where["draupner_e"]) < 1
