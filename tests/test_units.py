import pytest

from nora.data import DataError
from nora.units import load_units


def test_units_assign_each_node_once_and_pipelines_to_source_unit(tiny, tmp_path):
    path = tmp_path / "units.toml"
    path.write_text(
        '[units.upstream]\nnodes = ["gas", "hub"]\n'
        '[units.exports]\nnodes = ["a_terminal", "b_terminal", "market"]\n'
    )

    units = load_units(tiny, path)

    owners = {node: unit["id"] for unit in units for node in unit["nodes"]}
    assert set(owners) == set(tiny.node_by_id)
    assert len(owners) == len(tiny.nodes)
    assert next(unit for unit in units if unit["id"] == "upstream")["pipelines"] == [
        "feed",
        "pipe_a",
        "pipe_b",
    ]


def test_units_report_nodes_missing_from_all_units(tiny, tmp_path):
    path = tmp_path / "units.toml"
    path.write_text('[units.upstream]\nnodes = ["gas", "hub"]\n')

    with pytest.raises(DataError, match="nodes in no unit: a_terminal, b_terminal, market"):
        load_units(tiny, path)


def test_units_report_duplicate_node_ownership(tiny, tmp_path):
    path = tmp_path / "units.toml"
    path.write_text(
        '[units.first]\nnodes = ["gas", "hub", "a_terminal", "b_terminal", "market"]\n'
        '[units.second]\nnodes = ["gas"]\n'
    )

    with pytest.raises(DataError, match=r"'gas' is already in \[first\]"):
        load_units(tiny, path)


def test_units_suggest_a_valid_id_for_unknown_node(tiny, tmp_path):
    path = tmp_path / "units.toml"
    path.write_text('[units.all]\nnodes = ["gas", "hub", "a_terminal", "b_terminal", "markte"]\n')

    with pytest.raises(DataError, match="did you mean 'market'"):
        load_units(tiny, path)
