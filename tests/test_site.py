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


def payload(html: str, name: str):
    """A JSON value the page assigns to `var name`, unwrapping vis.DataSet(...)."""
    match = re.search(rf"var {name} = (?:new vis\.DataSet\()?(.*?)\)?;\n", html)
    return json.loads(match.group(1))


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


def test_only_maplibre_and_fonts_come_from_the_web(site):
    """Everything else is inlined, so the Flow view works offline; MapLibre is pinned
    and integrity-checked."""
    html = (site / "network.html").read_text()
    scripts = re.findall(r"<script[^>]+src=\"([^\"]+)\"[^>]*>", html)
    assert scripts == ["https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js"]
    for tag in re.findall(r"<(?:script|link)[^>]+cdnjs[^>]+>", html):
        assert 'integrity="sha512-' in tag
    stylesheets = re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
    assert all(
        href.startswith(("https://fonts.googleapis.com/", "https://cdnjs.cloudflare.com/"))
        for href in stylesheets
    )
    assert "new vis.Network" in html and "new maplibregl.Map" in html


def test_both_views_get_every_asset(site, north_sea):
    html = (site / "network.html").read_text()
    nodes = payload(html, "nodes")
    assert len(nodes) == len(north_sea.nodes)
    assert all("x" in n and "y" in n and n["image"].startswith("data:image/svg+xml") for n in nodes)
    assert len(payload(html, "edges")) == len(north_sea.pipelines)
    nora = payload(html, "NORA")
    assert set(nora["assets"]) == set(north_sea.asset_ids)
    assert len(nora["geo"]["nodes"]["features"]) == len(north_sea.nodes)
    assert len(nora["geo"]["pipes"]["features"]) == len(north_sea.pipelines)
    assert {s["name"] for s in nora["streams"]} >= {"synthetic-week", "denmark-gas-energinet"}
    assert nora["streams"][0]["name"] == "synthetic-week"  # lowest order plays first


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
