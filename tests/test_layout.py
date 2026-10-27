from nora.data import NODE_TYPES
from nora.icons import GLYPHS, TYPES, icon_uri
from nora.layout import ROW_GAP, crossings, flow_positions, stages


def test_gas_flows_left_to_right(north_sea):
    column = stages(north_sea)
    kinds = {n.id: n.type for n in north_sea.nodes}
    for pipe in north_sea.pipelines:
        if not pipe.bidirectional and kinds[pipe.from_id] != "market":
            assert column[pipe.from_id] <= column[pipe.to_id], pipe.id
    terminal = {column[n] for n in column if kinds[n] == "terminal"}
    lng = {column[n] for n in column if kinds[n] == "lng"}
    market = {column[n] for n in column if kinds[n] == "market"}
    assert len(terminal) == len(lng) == len(market) == 1
    assert max(terminal) < min(lng) < min(market) == max(column.values())


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
    # the layered layout trades row-geography for clarity: 15 straight-line
    # crossings on the real network, against 112 for the geographic order
    assert crossings(north_sea, flow_positions(north_sea)) <= 20


def test_layout_is_deterministic(north_sea):
    assert flow_positions(north_sea) == flow_positions(north_sea)


def test_every_asset_type_has_an_icon():
    assert set(NODE_TYPES) == set(TYPES) == set(GLYPHS)
    for kind in NODE_TYPES:
        assert icon_uri(kind).startswith("data:image/svg+xml")
