"""Build the static site GitHub Pages serves: index.html, network.html and data/.

The output is plain files with no server-side code, so the same folder works on
GitHub Pages, any static host, or opened straight from disk.
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
from .data import DATA_DIR, NODE_TYPES, PIPELINE_TYPES, REPO_ROOT, STATUSES, Network, load_network
from .graph import build_graph
from .render import TEMPLATES, network_html
from .stream import Stream, list_streams, load_stream
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
    owner, name = repo.split("/", 1)
    base = f"https://github.com/{repo}"
    return {
        "repo": base,
        "blob": f"{base}/blob/main",
        "edit": f"{base}/edit/main",
        "issues": f"{base}/issues",
        "codespaces": f"https://codespaces.new/{repo}?quickstart=1",
        "pages": f"https://{owner.lower()}.github.io/{name}/",
        "home": "./",
    }


def build_info() -> dict:
    commit = os.environ.get("GITHUB_SHA") or _git("rev-parse", "HEAD")
    return {"commit": commit[:7], "date": _git("log", "-1", "--format=%cs")}


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
    (out / "network.html").write_text(
        network_html(
            net,
            analysis,
            streams,
            links,
            config,
            load_units(net, data_dir / "units.toml"),
            data_dir,
        ),
        encoding="utf-8",
    )
    page = index_html(net, analysis, streams, links, build_info())
    (out / "index.html").write_text(page, encoding="utf-8")
    for name in ("nodes.csv", "pipelines.csv"):
        shutil.copyfile(data_dir / name, out / "data" / name)
    graph = nx.node_link_data(build_graph(net, STATUSES), edges="edges")
    (out / "data" / "network.json").write_text(json.dumps(graph, indent=1), encoding="utf-8")
    (out / "data" / "analysis.json").write_text(json.dumps(analysis, indent=1), encoding="utf-8")
    for stream in streams:
        payload = json.dumps(stream.payload(), separators=(",", ":"))
        (out / "data" / "streams" / f"{stream.name}.json").write_text(payload, encoding="utf-8")
    (out / ".nojekyll").touch()
    # `streams` are the loaded Stream objects (and `net` the loaded network),
    # so callers like `nora live` can reuse them instead of loading everything
    # a second time.
    return {"out": out, "net": net, "streams": streams, "analysis": analysis}


def _stream_summary(stream: Stream) -> dict:
    step = (stream.times[1] - stream.times[0]) if len(stream.times) > 1 else None
    return {
        "name": stream.name,
        "title": stream.title,
        "description": stream.description,
        "source": stream.source,
        "synthetic": stream.synthetic,
        "start": stream.times[0] if stream.times else None,
        "end": stream.times[-1] if stream.times else None,
        "step_minutes": int(step.total_seconds() // 60) if step else None,
        "assets": len(stream.assets),
        "events": stream.events,
    }


def index_html(
    net: Network, analysis: dict, streams: list[Stream], links: dict, build: dict
) -> str:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)), autoescape=select_autoescape(["html", "j2"])
    )
    names = {n.id: n.name for n in net.nodes} | {p.id: p.name for p in net.pipelines}
    kinds = {n.id: NODE_TYPES[n.type] for n in net.nodes}
    kinds |= {p.id: PIPELINE_TYPES[p.type] for p in net.pipelines}
    delivered = sorted(analysis["delivered"].items(), key=lambda item: -item[1])
    return env.get_template("index.html.j2").render(
        a=analysis,
        names=names,
        kinds=kinds,
        delivered=delivered,
        top_delivery=max((v for _, v in delivered), default=1) or 1,
        outages=[o for o in analysis["outages"] if o["lost"] > 0][:8],
        streams=[_stream_summary(s) for s in streams],
        links=links,
        build=build,
    )
