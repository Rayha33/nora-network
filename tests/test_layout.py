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


def _crosses_box(a, b, box) -> bool:
    """Does the segment a-b pass through the box (x0, y0, x1, y1)? Liang-Barsky."""
    (x0, y0), (x1, y1) = a, b
    t0, t1, dx, dy = 0.0, 1.0, x1 - x0, y1 - y0
    for p, q in ((-dx, x0 - box[0]), (dx, box[2] - x0), (-dy, y0 - box[1]), (dy, box[3] - y0)):
        if p == 0:
            if q < 0:
                return False
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return False
            t0 = max(t0, r)
        else:
            if r < t0:
                return False
            t1 = min(t1, r)
    return True


def test_no_line_runs_through_another_node_in_the_flow_view(north_sea):
    """Ray, 29 Oct: "position the nodes better, you already got an image from me" (his Area
    D screen). In the shipped layout no line crosses a square it does not end at: a step
    across is 258 px, a row 204 px, and a square with its tags reaches 70 px either way."""
    from nora.config import load_config

    hidden = set(load_config()["flow"]["hide"])
    placed = {k: (x * 258, y * 204) for k, (x, y) in load_flow_layout(north_sea).items()}
    shown = {k: p for k, p in placed.items() if k not in hidden}
    through = [
        f"{line.id} through {node}"
        for line in north_sea.pipelines
        if line.from_id in shown and line.to_id in shown
        for node, (x, y) in shown.items()
        if node not in (line.from_id, line.to_id)
        and _crosses_box(shown[line.from_id], shown[line.to_id], (x - 70, y - 70, x + 70, y + 70))
    ]
    assert through == []


def test_the_exit_points_line_the_bottom_of_the_flow_view(north_sea):
    """Ray, 30 Oct: "all exit points except nyhamna and st.fergus should be lined at the
    bottom of the flow view, we need it to look orderly and nice". Every place where gas
    leaves the drawing (a shown node with no line on to another shown node: the
    terminals, Tjeldbergodden, and Nybro now that Poland is on the Map only) sits on its
    bottom row, except St Fergus, beside the UK lines."""
    from nora.config import load_config

    hidden = set(load_config()["flow"]["hide"])
    placed = load_flow_layout(north_sea)
    shown = {k for k in placed if k not in hidden}
    onward = {p.from_id for p in north_sea.pipelines if p.to_id in shown}
    ends = {n for n in shown if n not in onward} - {"st_fergus"}
    ends = {n for n in ends if north_sea.node_by_id[n].type not in ("field", "tee")}
    bottom = max(placed[n][1] for n in shown)
    assert {"tjeldbergodden", "nybro", "emden", "easington"} <= ends
    assert {n: placed[n][1] for n in ends if placed[n][1] != bottom} == {}
