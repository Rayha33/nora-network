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

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src"))

from nora.analysis import analyse  # noqa: E402
from nora.config import load_config  # noqa: E402
from nora.data import (  # noqa: E402
    DATA_DIR,
    NODE_TYPES,
    PIPELINE_TYPES,
    load_network,
)
from nora.icons import TYPES, icon_uri  # noqa: E402
from nora.layout import flow_grid  # noqa: E402
from nora.ops import plan_timeline  # noqa: E402
from nora.render import PLURAL, SHORT, assets_payload, map_geojson  # noqa: E402
from nora.site import repo_links  # noqa: E402
from nora.stream import list_streams, load_stream  # noqa: E402
from nora.units import load_units  # noqa: E402


def build_payload(data_dir: Path = DATA_DIR) -> dict:
    """The `NORA` global exactly as render.network_html builds it for the page."""
    net = load_network(data_dir)
    streams_dir = data_dir / "streams"
    streams = sorted(
        (load_stream(name, net, streams_dir) for name in list_streams(streams_dir)),
        key=lambda s: (s.order, s.name),
    )
    analysis = analyse(net)
    config = load_config()
    units = load_units(net, data_dir / "units.toml")
    worst = max((o["lost"] for o in analysis["outages"]), default=0.0)
    return {
        "assets": assets_payload(net, analysis),
        "geo": map_geojson(net),
        "grid": flow_grid(net),
        "units": units,
        "iconSets": {
            theme: {
                kind: icon_uri(
                    kind,
                    disc=config[key]["normal"],
                    glyph=config[key]["paper"] if theme == "dark" else config[key]["text"],
                    edge=config[key]["text_dim"],
                )
                for kind in TYPES
            }
            for theme, key in (("light", "colors"), ("dark", "colors_dark"))
        },
        "config": config,
        "nodeTypes": NODE_TYPES,
        "pipelineTypes": PIPELINE_TYPES,
        "short": SHORT,
        "plural": PLURAL,
        "deliverable": analysis["deliverable"],
        "worstOutage": worst,
        "streams": [
            stream.payload() | {"plan": plan_timeline(stream, net, config)} for stream in streams
        ],
        "links": repo_links(),
    }


def main() -> None:
    out = Path(__file__).parent / "payload.json"
    out.write_text(json.dumps(build_payload(), indent=1, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
