"""Keep the JS test payload fixture in sync with what render.py ships.

The browser templates load `NORA` from the page; tests/js loads it from
tests/js/fixtures/payload.json, built by the same code path. If render.py, the
analysis, the streams or the config change the payload, this test fails until the
fixture is regenerated:

    python tests/js/fixtures/build_payload.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "tests" / "js" / "fixtures"

sys.path.insert(0, str(FIXTURES))

from build_payload import build_payload  # noqa: E402


def test_payload_fixture_matches_the_code() -> None:
    committed = json.loads((FIXTURES / "payload.json").read_text(encoding="utf-8"))
    # JSON round-trip normalises tuples to lists, matching the fixture file.
    fresh = json.loads(json.dumps(build_payload()))
    assert committed == fresh, (
        "tests/js/fixtures/payload.json is stale; regenerate it with "
        "`python tests/js/fixtures/build_payload.py`"
    )
