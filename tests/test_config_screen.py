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


def test_pressure_limits_are_high_high_high_integrity_rising(tmp_path):
    """Ray, 29 Oct: "high = yellow, high high = red, integrity = dark red". Every asset
    type has three upper limits, rising, the integrity limit at the window's top."""
    defaults = load_config(tmp_path / "missing.toml")
    for kind, (high, high_high, integrity) in defaults["pressure_limits"].items():
        assert high <= high_high <= integrity == defaults["pressure"][kind][1], kind
    assert defaults["colors"]["integrity"] != defaults["colors"]["critical"]
    path = tmp_path / "nora.toml"
    path.write_text("[pressure_limits]\nhub = [150, 160, 170]\n", encoding="utf-8")
    assert load_config(path)["pressure_limits"]["hub"] == [150, 160, 170]
    for bad, message in (
        ("hub = [160, 150, 170]", "must be [high, high-high, integrity] in bar, rising"),
        ("hub = [150, 160]", "must be [high, high-high, integrity] in bar, rising"),
        ("hubb = [150, 160, 170]", "is not an asset type"),
    ):
        path.write_text(f"[pressure_limits]\n{bad}\n", encoding="utf-8")
        with pytest.raises(DataError) as error:
            load_config(path)
        assert message in str(error.value)


def test_a_wall_needs_a_distance_and_a_width_above_zero(tmp_path):
    """The wall's text size is worked out from both (review #49802)."""
    path = tmp_path / "nora.toml"
    path.write_text("[screen]\nwall_distance_m = 8\nwall_width_m = 6.5\n", encoding="utf-8")
    assert load_config(path)["screen"]["wall_distance_m"] == 8
    for bad in ("0", "-2", "true"):
        path.write_text(f"[screen]\nwall_distance_m = {bad}\n", encoding="utf-8")
        with pytest.raises(DataError) as error:
            load_config(path)
        assert "metres above 0" in str(error.value)
