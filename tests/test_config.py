import pytest

from nora.config import DEFAULTS, load_config
from nora.data import DataError


def test_config_defaults_are_deep_merged_without_mutating_defaults(tmp_path):
    path = tmp_path / "nora.toml"
    path.write_text('[screen]\ntheme = "dark"\n[colors]\nwarning = "#123456"\n')

    config = load_config(path)

    assert config["screen"]["theme"] == "dark"
    assert config["screen"]["start"] == DEFAULTS["screen"]["start"]
    assert config["colors"]["warning"] == "#123456"
    assert config["colors"]["critical"] == DEFAULTS["colors"]["critical"]
    assert DEFAULTS["screen"]["theme"] == "light"


@pytest.mark.parametrize(
    ("contents", "key"),
    [
        ('[colors]\nwarning = "orange"\n', "warning"),
        ("[thresholds]\npressure_margin = [0.0, 0.05, 0.1]\n", "pressure_margin"),
        ("[quality]\nh2s_ppm = [3.0, 2.5, 3.3]\n", "h2s_ppm"),
        ('[screen]\ntheme = "teal"\n', "theme"),
    ],
)
def test_invalid_setting_reports_one_problem_with_file_and_key(tmp_path, contents, key):
    path = tmp_path / "nora.toml"
    path.write_text(contents)

    with pytest.raises(DataError) as caught:
        load_config(path)

    assert len(caught.value.problems) == 1
    assert "nora.toml" in caught.value.problems[0]
    assert key in caught.value.problems[0]


@pytest.mark.parametrize(
    ("contents", "message"),
    [
        ("[threshholds]\nload = [1.0, 2.0, 3.0]\n", "unknown section"),
        ('[screen]\ntheem = "dark"\n', "unknown key"),
    ],
)
def test_unknown_section_or_key_suggests_the_correct_name(tmp_path, contents, message):
    path = tmp_path / "nora.toml"
    path.write_text(contents)

    with pytest.raises(DataError) as caught:
        load_config(path)

    problem = caught.value.problems[0]
    assert "nora.toml" in problem
    assert message in problem
    assert "did you mean" in problem
