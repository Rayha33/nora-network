import pytest

from nora.data import DataError, load_network

from .conftest import NODES, PIPELINES, write_network


def problems_for(tmp_path, nodes=NODES, pipelines=PIPELINES) -> list[str]:
    with pytest.raises(DataError) as caught:
        load_network(write_network(tmp_path / "data", nodes, pipelines))
    return caught.value.problems


def test_the_north_sea_data_is_valid(north_sea):
    assert len(north_sea.nodes) > 40
    assert len(north_sea.pipelines) > 40


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
    nodes = [*NODES[:-1], "market,Market, big,market,DE,52,8,,,operating,,"]
    assert any("wrap text containing commas" in p for p in problems_for(tmp_path, nodes=nodes))
