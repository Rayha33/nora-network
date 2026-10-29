import json
import re

import pytest

from nora.cli import main
from nora.data import DATA_DIR
from nora.site import build_site, index_html


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


def test_home_page_is_the_app(site):
    """Ray, 29 Oct: "remove all text below the screens" and "we are making software, not
    an essay". The home page opens the app at once, with a link's settings and place."""
    html = (site / "index.html").read_text()
    assert 'url=network.html"' in html
    assert 'location.replace("network.html" + location.search + location.hash)' in html
    assert "<iframe" not in html and "<main" not in html and "<p" not in html


def test_home_page_waits_on_the_apps_paper():
    from nora.config import load_config

    config = load_config()
    assert config["colors"]["paper"] in index_html(config)


def test_cli_validate_and_stats(capsys):
    assert main(["validate"]) == 0
    assert main(["stats", "--top", "3"]) == 0
    assert "Deliverable" in capsys.readouterr().out


def test_hostile_names_do_not_reach_the_page_as_html(tmp_path):
    """The CSVs are crowd-edited: a name like `Tyra<img src=x onerror=...>` must
    reach vis-network escaped, never as live markup."""
    from tests.conftest import NODES, write_network

    hostile = [row.replace("Gas field", "Tyra<img src=x onerror=alert(1)>") for row in NODES]
    data = write_network(tmp_path / "data", nodes=hostile)
    out = tmp_path / "site"
    build_site(out, data)
    html = (out / "network.html").read_text()
    assert "<img src=x" not in html  # no unescaped tag anywhere
    # the label rides to the browser inside JSON, where `&` is \u0026; the
    # browser decodes it back to &lt; before vis-network sees the label
    assert "u0026lt;img" in html


def test_a_build_says_which_commit_it_is(tmp_path, monkeypatch):
    """A tab left open compares this with version.json and reloads to a newer build (Ray,
    29 Oct: his tab showed bugs fixed hours before). The commit, never a clock time."""
    monkeypatch.setenv("GITHUB_SHA", "0123456789abcdef0123")
    out = tmp_path / "site"
    build_site(out, DATA_DIR)
    assert json.loads((out / "version.json").read_text()) == {"build": "0123456789ab"}
    assert '<meta name="nora-build" content="0123456789ab">' in (out / "network.html").read_text()
