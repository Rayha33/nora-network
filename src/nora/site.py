"""Build the static site factorlab.app/nora-network/ serves: network.html (the app),
index.html (which opens it) and data/.

The output is plain files with no server-side code, so the same folder works on any
static host, or opened straight from disk.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import networkx as nx
from jinja2 import Environment, FileSystemLoader, select_autoescape

from .analysis import analyse
from .config import load_config
from .data import DATA_DIR, REPO_ROOT, STATUSES, load_network
from .graph import build_graph
from .render import TEMPLATES, network_html
from .stream import list_streams, load_stream
from .units import load_units

DEFAULT_REPO = "Rayha33/nora-network"


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def repo_links() -> dict:
    """Links back to the repository; forks building their own site link to themselves."""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not repo:
        match = re.search(
            r"github\.com[:/](.+?/.+?)(?:\.git)?$", _git("remote", "get-url", "origin")
        )
        repo = match.group(1) if match else DEFAULT_REPO
    base = f"https://github.com/{repo}"
    return {
        "repo": base,
        "blob": f"{base}/blob/main",
        "edit": f"{base}/edit/main",
        "issues": f"{base}/issues",
        "codespaces": f"https://codespaces.new/{repo}?quickstart=1",
        "home": "./",
    }


def build_id() -> str:
    """The commit the site is built from (empty outside git and CI)."""
    sha = os.environ.get("GITHUB_SHA") or _git("rev-parse", "HEAD")
    return sha[:12] if re.fullmatch(r"[0-9a-f]{7,40}", sha or "") else ""


NO_PRICE_FEED = {
    "note": "No price feed on this copy of the site. The hosted site's server writes this "
    "file every 15 minutes (scripts/fetch_prices.py) and serves it in place of this one."
}


def _no_price_feed(out: Path, config: dict) -> None:
    """The money counter's price file, saying there is no feed, so a copy of the site with
    none (a local build, CI) shows no counter and asks for no missing file: the browser
    smoke check failed on that 404 from #217 on. A file fetched into the site by hand is
    kept. On factorlab.app the droplet serves its own file at this path."""
    where = str(config.get("money", {}).get("prices", ""))
    if not where or "://" in where or where.startswith("/") or ".." in Path(where).parts:
        return
    path = out / where
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(NO_PRICE_FEED) + "\n", encoding="utf-8")


def build_site(out_dir: Path, data_dir: Path = DATA_DIR) -> dict:
    """Validate the data, run the analysis, and write the site. Returns a summary."""
    data_dir = Path(data_dir)
    net = load_network(data_dir)
    streams_dir = data_dir / "streams"
    streams = [load_stream(name, net, streams_dir) for name in list_streams(streams_dir)]
    streams.sort(key=lambda s: (s.order, s.name))
    analysis = analyse(net)
    links = repo_links()

    out = Path(out_dir)
    (out / "data" / "streams").mkdir(parents=True, exist_ok=True)
    config = load_config()
    page = network_html(
        net, analysis, streams, links, config, load_units(net, data_dir / "units.toml"), data_dir
    )
    # Which build this is, so a tab left open can tell a newer one is published and
    # reload (Ray, 29 Oct: his tab showed bugs fixed hours before). The commit, never a
    # wall-clock time: the same commit builds the same site.
    build = build_id()
    if build:
        page = page.replace("<head>", f'<head>\n<meta name="nora-build" content="{build}">', 1)
        (out / "version.json").write_text(json.dumps({"build": build}) + "\n", encoding="utf-8")
    (out / "network.html").write_text(page, encoding="utf-8")
    (out / "index.html").write_text(index_html(config), encoding="utf-8")
    for name in ("nodes.csv", "pipelines.csv"):
        shutil.copyfile(data_dir / name, out / "data" / name)
    graph = nx.node_link_data(build_graph(net, STATUSES), edges="edges")
    (out / "data" / "network.json").write_text(json.dumps(graph, indent=1), encoding="utf-8")
    (out / "data" / "analysis.json").write_text(json.dumps(analysis, indent=1), encoding="utf-8")
    for stream in streams:
        payload = json.dumps(stream.payload(), separators=(",", ":"))
        (out / "data" / "streams" / f"{stream.name}.json").write_text(payload, encoding="utf-8")
    _no_price_feed(out, config)
    (out / ".nojekyll").touch()
    # `streams` are the loaded Stream objects (and `net` the loaded network),
    # so callers like `nora live` can reuse them instead of loading everything
    # a second time.
    return {"out": out, "net": net, "streams": streams, "analysis": analysis}


def index_html(config: dict | None = None) -> str:
    """The home page: it opens the app (Ray, 29 Oct: "we are making software, not an
    essay"), on the app's paper while it does."""
    config = config or load_config()
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)), autoescape=select_autoescape(["html", "j2"])
    )
    return env.get_template("index.html.j2").render(paper=config["colors"]["paper"])
