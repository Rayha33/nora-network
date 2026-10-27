from nora.data import NODE_TYPES
from nora.icons import COLORS, GLYPHS, icon_uri
from nora.layout import ROW_GAP, flow_positions, stages


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


def test_rows_run_north_to_south_without_overlap(north_sea):
    positions = flow_positions(north_sea)
    lat = {n.id: n.lat for n in north_sea.nodes}
    columns: dict[float, list[str]] = {}
    for node, (x, _) in positions.items():
        columns.setdefault(x, []).append(node)
    for members in columns.values():
        members.sort(key=lambda n: positions[n][1])
        assert [lat[n] for n in members] == sorted((lat[n] for n in members), reverse=True)
        ys = [positions[n][1] for n in members]
        assert all(b - a >= ROW_GAP for a, b in zip(ys, ys[1:], strict=False))


def test_layout_is_deterministic(north_sea):
    assert flow_positions(north_sea) == flow_positions(north_sea)


def test_every_asset_type_has_an_icon():
    assert set(NODE_TYPES) == set(COLORS) == set(GLYPHS)
    for kind in NODE_TYPES:
        assert icon_uri(kind).startswith("data:image/svg+xml")
