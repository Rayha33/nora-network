"""Pipeline models for the What-if (Ray, 29 Oct: "pipeline-specific regression formulas
and correction factor to estimate pressures"): data/pipeline_models.csv, checked like the
other data files."""

import pytest

from nora import edit
from nora.data import DataError, load_network
from nora.pms import COLUMNS, load_pipeline_models, weymouth


def test_the_shipped_models_cover_the_lines_with_a_length_and_diameter(north_sea):
    models = load_pipeline_models(north_sea)
    sized = {p.id for p in north_sea.pipelines if p.length_km and p.diameter_in}
    assert set(models) == sized
    assert all(m["a"] > 0 and m["correction"] == 1.0 for m in models.values())
    # Norpipe at today's 44 MSm³/d: the drop the Weymouth seed gives is in the range
    # the data shows (about 18,600 bar² between Ekofisk and Emden).
    assert 15_000 < models["norpipe"]["a"] * 44**2 < 22_000


def test_weymouth_grows_with_length_and_falls_with_diameter():
    assert weymouth(400, 36) > weymouth(200, 36)
    assert weymouth(400, 42) < weymouth(400, 36)


def write(tmp_path, *rows):
    path = tmp_path / "pipeline_models.csv"
    path.write_text("\n".join([",".join(COLUMNS), *rows]) + "\n", encoding="utf-8")
    return path


def test_every_problem_is_reported_with_its_line(tiny, tmp_path):
    a, b = tiny.pipelines[0].id, tiny.pipelines[1].id
    path = write(tmp_path, f"{a},1,0,1,x", "nope,1,0,1,x", f"{a},2,0,1,x", f"{b},-1,0,1,x")
    with pytest.raises(DataError) as caught:
        load_pipeline_models(tiny, path)
    problems = " | ".join(caught.value.problems)
    assert "line 3: no pipeline 'nope'" in problems
    assert f"line 4: '{a}' has a model already" in problems
    assert "line 5: 'a' must be at least 0" in problems


def test_no_file_means_no_models(tiny, tmp_path):
    assert load_pipeline_models(tiny, tmp_path / "missing.csv") == {}


def test_removing_a_pipeline_in_the_editor_drops_its_model(tiny_dir, tiny):
    pid = tiny.pipelines[0].id
    path = tiny_dir / "pipeline_models.csv"
    path.write_text(f"{','.join(COLUMNS)}\n{pid},1.5,0,1,test\n", encoding="utf-8")
    assert load_pipeline_models(load_network(tiny_dir), path)[pid]["a"] == 1.5
    kept = [p for p in tiny.pipelines if p.id != pid]
    edit.save(type(tiny)(nodes=tiny.nodes, pipelines=tuple(kept)), tiny_dir)
    assert pid not in path.read_text(encoding="utf-8")
    assert load_pipeline_models(load_network(tiny_dir), path) == {}
