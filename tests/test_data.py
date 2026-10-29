import pytest

from nora.data import DataError, Node, load_network

from .conftest import NODES, PIPELINES, write_network


def problems_for(tmp_path, nodes=NODES, pipelines=PIPELINES) -> list[str]:
    with pytest.raises(DataError) as caught:
        load_network(write_network(tmp_path / "data", nodes, pipelines))
    return caught.value.problems


def test_the_north_sea_data_is_valid(north_sea):
    # Trimmed to what a North Sea operator watches (Ray, 29 Oct): 40 nodes, 40 lines
    assert len(north_sea.nodes) >= 35
    assert len(north_sea.pipelines) >= 35


def test_every_pipeline_connects_known_nodes(north_sea):
    ids = {node.id for node in north_sea.nodes}
    for pipe in north_sea.pipelines:
        assert pipe.from_id in ids and pipe.to_id in ids


def test_typo_in_a_node_reference_suggests_the_fix(tmp_path):
    broken = [PIPELINES[0].replace("gas,hub", "gas,hbu"), *PIPELINES[1:]]
    [problem] = problems_for(tmp_path, pipelines=broken)
    assert "pipelines.csv line 2" in problem
    assert "did you mean 'hub'" in problem


def test_all_problems_are_reported_at_once(tmp_path):
    nodes = [NODES[0].replace(",field,", ",feild,"), NODES[1].replace(",58,", ",158,"), *NODES[2:]]
    problems = problems_for(tmp_path, nodes=nodes)
    assert any("did you mean 'field'" in p for p in problems)
    assert any("'lat' must be -90 to 90" in p for p in problems)


def test_duplicate_ids_point_to_the_first_use(tmp_path):
    problems = problems_for(tmp_path, nodes=[*NODES, NODES[1]])
    assert any("already used on nodes.csv line 3" in p for p in problems)


def test_a_field_needs_a_capacity(tmp_path):
    nodes = [NODES[0].replace(",60,operating", ",,operating"), *NODES[1:]]
    assert any("needs 'capacity_msm3d'" in p for p in problems_for(tmp_path, nodes=nodes))


def test_parallel_lines_must_be_one_row(tmp_path):
    duplicate = PIPELINES[1].replace("pipe_a,Pipe A", "pipe_a2,Pipe A2")
    problems = problems_for(tmp_path, pipelines=[*PIPELINES, duplicate])
    assert any("already modelled" in p for p in problems)


def test_unquoted_comma_is_explained(tmp_path):
    nodes = [*NODES[:-1], "market,Market, big,market,DE,52,8,,,operating,,,,,"]
    assert any("wrap text containing commas" in p for p in problems_for(tmp_path, nodes=nodes))


def test_a_node_is_active_between_startup_and_retirement():
    node = Node(
        id="x",
        name="X",
        type="field",
        country="NO",
        lat=60,
        lon=3,
        operator="",
        capacity_msm3d=1.0,
        status="operating",
        startup=1990,
        shutdown=2010,
        source="",
        notes="",
        line=1,
    )
    assert not node.active_in(1989)
    assert node.active_in(1990)
    assert node.active_in(2009)
    assert not node.active_in(2010)  # the first year it was gone

    timeless = Node(
        id="y",
        name="Y",
        type="field",
        country="NO",
        lat=60,
        lon=3,
        operator="",
        capacity_msm3d=1.0,
        status="operating",
        startup=None,
        shutdown=None,
        source="",
        notes="",
        line=1,
    )
    assert timeless.active_in(1900)
    assert timeless.active_in(2100)


def test_nodes_in_year_filters_and_sorts(tmp_path):
    nodes = [
        "gas,Gas field,field,NO,60,3,,60,operating,1990,,test/",
        "hub,Hub,hub,NO,58,2,,,operating,,,test/",
        "a_terminal,Terminal A,terminal,GB,57,-1,,,operating,,,test/",
        "b_terminal,Terminal B,terminal,DE,53,7,,,operating,,,test/",
        "market,Market,market,DE,52,8,,,operating,,,test/",
        "future,Future field,field,NO,61,4,,10,planned,2030,,test/",
        "old,Old field,field,NO,59,2,,5,decommissioned,1970,1990,test/",
    ]
    network = load_network(write_network(tmp_path / "data", nodes=nodes))
    timeless = ["a_terminal", "b_terminal", "hub", "market"]
    assert [n.id for n in network.nodes_in_year(1985)] == [*timeless, "old"]
    assert [n.id for n in network.nodes_in_year(1995)] == [
        "a_terminal",
        "b_terminal",
        "gas",
        "hub",
        "market",
    ]
    assert [n.id for n in network.nodes_in_year(2026)] == [
        "a_terminal",
        "b_terminal",
        "gas",
        "hub",
        "market",
    ]
    assert [n.id for n in network.nodes_in_year(2031)] == [
        "a_terminal",
        "b_terminal",
        "future",
        "gas",
        "hub",
        "market",
    ]


def test_retirement_year_before_startup_is_explained(tmp_path):
    nodes = [*NODES, "old,Old field,field,NO,59,2,,5,decommissioned,1990,1970,test/"]
    assert any(
        "'shutdown' = 1970 is before 'startup' = 1990" in p
        for p in problems_for(tmp_path, nodes=nodes)
    )
