"""The files the page's editor saves load with NORA's own validation (tests/js/edit.test.mjs
holds the edits: a node and lines removed, a field added and connected)."""

import json
import subprocess
from pathlib import Path

import pytest

from nora.data import load_network
from nora.units import load_units

ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(
    subprocess.run(["node", "--version"], capture_output=True).returncode != 0,
    reason="node is not available",
)


def test_the_editor_writes_files_nora_accepts(tmp_path):
    out = subprocess.run(
        ["node", str(ROOT / "tests" / "js" / "edited_files.mjs")],
        capture_output=True,
        text=True,
        check=True,
    )
    for name, text in json.loads(out.stdout.splitlines()[-1]).items():
        (tmp_path / name).write_text(text, encoding="utf-8")
    net = load_network(tmp_path)
    assert "gudrun" not in net.node_by_id and "ogt" not in net.pipeline_by_id
    assert net.node_by_id["snorre"].capacity_msm3d == 4
    assert net.pipeline_by_id["snorre_statfjord"].to_id == "statfjord"
    units = load_units(net, tmp_path / "units.toml")
    assert any("snorre" in unit["nodes"] for unit in units)
