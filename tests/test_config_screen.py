"""[screen] now_in_middle: synthetic data is re-timed in the browser so now sits
mid-timeline. The setting must be a real boolean, and is on by default."""

import pytest

from nora.config import DEFAULTS, load_config
from nora.data import DataError


def test_now_in_middle_is_on_by_default(tmp_path):
    path = tmp_path / "nora.toml"
    path.write_text("[screen]\nspeed = 60\n", encoding="utf-8")
    assert DEFAULTS["screen"]["now_in_middle"] is True
    assert load_config(path)["screen"]["now_in_middle"] is True


def test_now_in_middle_can_be_turned_off(tmp_path):
    path = tmp_path / "nora.toml"
    path.write_text("[screen]\nnow_in_middle = false\n", encoding="utf-8")
    assert load_config(path)["screen"]["now_in_middle"] is False


def test_now_in_middle_must_be_true_or_false(tmp_path):
    path = tmp_path / "nora.toml"
    path.write_text('[screen]\nnow_in_middle = "yes"\n', encoding="utf-8")
    with pytest.raises(DataError) as error:
        load_config(path)
    assert "now_in_middle: must be true or false" in str(error.value)


def test_display_profile_is_one_of_the_choices(tmp_path):
    path = tmp_path / "nora.toml"
    path.write_text('[screen]\ndisplay = "wall"\n', encoding="utf-8")
    assert load_config(path)["screen"]["display"] == "wall"
    path.write_text('[screen]\ndisplay = "cinema"\n', encoding="utf-8")
    with pytest.raises(DataError) as error:
        load_config(path)
    assert "display: must be one of auto, desk, wall, compact" in str(error.value)


def test_flow_hide_is_a_list_of_node_ids(tmp_path):
    """[flow] hide: nodes on the Map only (Ray, 29 Oct: "remove poland vtp from flow only")."""
    path = tmp_path / "nora.toml"
    path.write_text('[flow]\nhide = ["pl_vtp"]\n', encoding="utf-8")
    assert load_config(path)["flow"]["hide"] == ["pl_vtp"]
    assert load_config()["flow"]["hide"][0] == "pl_vtp"  # shipped: then the detailed fields
    path.write_text('[flow]\nhide = "pl_vtp"\n', encoding="utf-8")
    with pytest.raises(DataError) as error:
        load_config(path)
    assert "hide: must be a list of node ids" in str(error.value)


def test_flow_watch_names_nodes(tmp_path):
    """[flow] watch: the hubs whose pressure change always shows (Ray: SLR, DRP S, DRP E)."""
    assert load_config()["flow"]["watch"] == ["sleipner", "draupner_s", "draupner_e"]
    path = tmp_path / "nora.toml"
    path.write_text('[flow]\nwatch = "sleipner"\n', encoding="utf-8")
    with pytest.raises(DataError) as error:
        load_config(path)
    assert "watch: must be a list of node ids" in str(error.value)
