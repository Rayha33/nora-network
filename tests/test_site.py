import json
import re

import pytest

from nora.cli import main
from nora.data import DATA_DIR
from nora.site import build_site


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    out = tmp_path_factory.mktemp("site")
    build_site(out, DATA_DIR)
    return out


def test_site_has_pages_and_data(site):
    for path in (
        "index.html",
        "network.html",
        ".nojekyll",
        "data/network.json",
        "data/analysis.json",
        "data/nodes.csv",
        "data/pipelines.csv",
    ):
        assert (site / path).exists(), path


def test_network_page_is_self_contained(site):
    """The map must work as a single file: no external scripts, only optional fonts."""
    html = (site / "network.html").read_text()
    assert not re.search(r"<script[^>]+src=", html)
    stylesheets = re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
    assert all(href.startswith("https://fonts.googleapis.com/") for href in stylesheets)
    assert "new vis.Network" in html


def test_network_page_contains_every_asset_and_stream(site, north_sea):
    html = (site / "network.html").read_text()
    for asset in north_sea.asset_ids:
        assert f'"{asset}"' in html, asset
    nodes = json.loads(re.search(r"var nodes = new vis\.DataSet\((.*?)\);\n", html).group(1))
    assert len(nodes) == len(north_sea.nodes)
    assert all("x" in node and "y" in node and "nora" in node for node in nodes)
    assert '"streams": [{' in html or '"streams":[{' in html


def test_home_page_shows_the_analysis(site):
    html = (site / "index.html").read_text()
    analysis = json.loads((site / "data" / "analysis.json").read_text())
    assert f"{analysis['deliverable']:,.0f} MSm³/d" in html
    assert analysis["outages"][0]["name"] in html
    assert "network.html?embed=1" in html


def test_cli_validate_and_stats(capsys):
    assert main(["validate"]) == 0
    assert main(["stats", "--top", "3"]) == 0
    assert "Deliverable" in capsys.readouterr().out
