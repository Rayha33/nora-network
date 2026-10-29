"""Regenerate the NORA payload fixture the JS tests load.

The page embeds this dict as the `NORA` global (render.py builds it inline, so it is
replicated here). Run as a script to refresh tests/js/fixtures/payload.json:

    python tests/js/fixtures/build_payload.py

tests/test_js_harness.py fails when the committed fixture drifts from the code, so
the JS tests always exercise the payload the app actually ships.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "src"))

from nora.analysis import analyse  # noqa: E402
from nora.config import load_config  # noqa: E402
from nora.data import DATA_DIR, load_network  # noqa: E402
from nora.render import page_payload  # noqa: E402
from nora.site import repo_links  # noqa: E402
from nora.stream import list_streams, load_stream  # noqa: E402
from nora.units import load_units  # noqa: E402


def build_payload(data_dir: Path = DATA_DIR) -> dict:
    """The `NORA` global exactly as the page embeds it (render.page_payload)."""
    net = load_network(data_dir)
    streams_dir = data_dir / "streams"
    streams = sorted(
        (load_stream(name, net, streams_dir) for name in list_streams(streams_dir)),
        key=lambda s: (s.order, s.name),
    )
    config = load_config()
    units = load_units(net, data_dir / "units.toml")
    return page_payload(net, analyse(net), streams, repo_links(), config, units)


def main() -> None:
    out = Path(__file__).parent / "payload.json"
    out.write_text(json.dumps(build_payload(), indent=1, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
