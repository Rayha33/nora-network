import pytest

from nora.data import NODE_TYPES, DataError
from nora.icons import GLYPHS, TYPES, icon_uri
from nora.layout import ROW_GAP, crossings, flow_grid, flow_positions, load_flow_layout, stages


def test_gas_flows_left_to_right(north_sea):
    column = stages(north_sea)
    kinds = {n.id: n.type for n in north_sea.nodes}
    for pipe in north_sea.pipelines:
        if not pipe.bidirectional and kinds[pipe.from_id] != "market":
            assert column[pipe.from_id] <= column[pipe.to_id], pipe.id
    terminal = {column[n] for n in column if kinds[n] == "terminal"}
    market = {column[n] for n in column if kinds[n] == "market"}
    assert len(terminal) == len(market) == 1  # the landings line up, the consumers after
    assert max(terminal) < min(market) == max(column.values())


def test_rows_are_spaced_without_overlap(north_sea):
    positions = flow_positions(north_sea)
    columns: dict[float, list[str]] = {}
    for node, (x, _) in positions.items():
        columns.setdefault(x, []).append(node)
    for members in columns.values():
        ys = sorted(positions[n][1] for n in members)
        # a card's clearance between neighbours (a hair of float slack allowed)
        assert all(b - a >= ROW_GAP - 1e-6 for a, b in zip(ys, ys[1:], strict=False))


def test_pipelines_cross_as_little_as_possible(north_sea):
    # the layered layout trades row-geography for clarity: 23 straight-line
    # crossings on the real network, against 112 for the geographic order
    # (the timeline's frigg and odin rows add some)
    assert crossings(north_sea, flow_positions(north_sea)) <= 35


def test_layout_is_deterministic(north_sea):
    assert flow_positions(north_sea) == flow_positions(north_sea)


def test_every_asset_type_has_an_icon():
    assert set(NODE_TYPES) == set(TYPES) == set(GLYPHS)
    for kind in NODE_TYPES:
        assert icon_uri(kind).startswith("data:image/svg+xml")


def test_the_shipped_layout_places_every_node_apart(north_sea):
    """data/flow_layout.toml: the Area D-like overview (Ray, 29 Oct). Every node has a
    place, and no two squares overlap: one step across or one row down apart."""
    placed = load_flow_layout(north_sea)
    assert set(placed) == {n.id for n in north_sea.nodes}
    for a, b in __import__("itertools").combinations(sorted(placed), 2):
        (ax, ay), (bx, by) = placed[a], placed[b]
        assert abs(ax - bx) >= 1 - 1e-9 or abs(ay - by) >= 1 - 1e-9, f"{a} and {b} overlap"
    grid = flow_grid(north_sea, placed)
    assert grid["sleipner"] == (placed["sleipner"][1], placed["sleipner"][0])
    terminals = {
        placed[n.id][1] for n in north_sea.nodes if n.type == "terminal" and n.id != "st_fergus"
    }
    assert len(terminals) == 1, "the landings share the bottom row"
    row = sorted((placed[n.id][0], n.lon) for n in north_sea.nodes if placed[n.id][1] in terminals)
    assert row[0][1] < row[-1][1], "west on the left, east on the right"


def test_a_bad_layout_entry_is_reported(north_sea, tmp_path):
    path = tmp_path / "flow_layout.toml"
    path.write_text('[positions]\nslepner = [1, 2]\ntroll = "top"\n', encoding="utf-8")
    with pytest.raises(DataError) as caught:
        load_flow_layout(north_sea, path)
    problems = " ".join(caught.value.problems)
    assert "no node 'slepner'" in problems and "did you mean 'sleipner'" in problems
    assert "troll must be [across, down]" in problems
