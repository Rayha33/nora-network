"""The map draws the network where it is: physical pipelines follow their laid routes
(SODIR, NSTA and EMODnet) and join their nodes exactly; only schematic links stay straight."""

import math

from nora.render import _route_line, bathymetry, map_geojson, routes


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


def test_physical_pipelines_follow_their_laid_routes(north_sea):
    laid = routes()
    assert len(laid) >= 38, "SODIR, NSTA and EMODnet routes for the physical network"
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


def test_european_trunks_do_not_fall_back_to_chords():
    expected = {
        "flags",
        "sage",
        "seal",
        "iuk",  # NSTA
        "ngt",
        "wgt",  # EMODnet
    }
    laid = routes()
    assert expected <= laid.keys()
    assert all(len(laid[pid]) > 2 for pid in expected)


def test_draupner_platforms_sit_on_their_bridge(north_sea):
    """Draupner S and E are bridge-linked: SODIR puts them about 120 m apart."""
    where = {n.id: (n.lon, n.lat) for n in north_sea.nodes}
    assert km(where["draupner_s"], where["draupner_e"]) < 1


def test_water_depth_grid_is_shipped_and_optional(tmp_path):
    """The map's readout shows the water depth (EMODnet): the grid covers the map's
    bounds, and without the file the page simply shows no depth."""
    grid = bathymetry()
    assert grid is not None, "data/geo/bathymetry.json is in the repository"
    covers = grid["width"] * grid["step"] >= 19 and grid["height"] * grid["step"] >= 17
    assert covers, "it covers the map"
    assert "EMODnet" in grid["source"], "with its credit"
    assert "CC BY 4.0" in grid["source"], "and its licence"
    assert bathymetry(tmp_path / "missing.json") is None
