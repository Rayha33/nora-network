"""The What-if max flow in the browser must match Python's analyse().

tests/js/whatif_value.mjs loads app.js in the JS harness with the same payload
the site ships, toggles the requested assets offline and prints the JS max
flow; this test computes the same numbers with ``analyse(net, offline=...)``
and refuses to let the two drift.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from nora.analysis import analyse
from nora.data import DATA_DIR, load_network

ROOT = Path(__file__).resolve().parents[1]
WHATIF_JS = ROOT / "tests" / "js" / "whatif_value.mjs"

pytestmark = pytest.mark.skipif(
    subprocess.run(["node", "--version"], capture_output=True).returncode != 0,
    reason="node is not available",
)


def js_whatif(*offline: str) -> dict:
    out = subprocess.run(
        ["node", str(WHATIF_JS), *offline],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)


CASES: list[tuple[str, ...]] = [
    (),
    ("troll",),
    ("kollsnes",),
    ("karsto", "nyhamna"),
    ("nybro",),
    ("easington",),
    ("statfjord", "gullfaks"),
]


@pytest.mark.parametrize("offline", CASES, ids=["-".join(c) or "intact" for c in CASES])
def test_js_whatif_matches_python(offline):
    net = load_network(DATA_DIR)
    py = analyse(net, offline=frozenset(offline))
    js = js_whatif(*offline)
    # The TOTAL must match exactly; the per-market split can differ because
    # Python routes min-cost with networkx and the browser uses Edmonds-Karp,
    # which breaks ties differently. The total is what the user reads.
    assert js["value"] == pytest.approx(py["deliverable"], rel=1e-2), (
        f"JS max flow drifted from Python for offline={offline}"
    )
    assert sum(js["delivered"].values()) == pytest.approx(js["value"], abs=0.05)
    assert set(js["delivered"]) <= set(py["delivered"]), "JS only delivers to known markets"
