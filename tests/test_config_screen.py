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
