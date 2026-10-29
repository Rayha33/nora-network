"""The repository's own setup (review, 29 Oct): every package the code imports is a
declared dependency, and the site is never published without the checks CI runs."""

from __future__ import annotations

import ast
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"


def test_every_package_the_code_imports_is_a_declared_dependency():
    # site.py imported jinja2, which only arrived because pyvis happens to need it.
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    declared = {re.split(r"[<>=!~ \[;]", d, maxsplit=1)[0].lower() for d in project["dependencies"]}
    imported = set()
    for path in (ROOT / "src" / "nora").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])
    third_party = {m for m in imported if m not in sys.stdlib_module_names and m != "nora"}
    assert third_party - declared == set(), "imported but not in pyproject dependencies"


def runs(workflow: str) -> list[str]:
    """The commands a workflow's steps run, in order."""
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    return [m.group(1).strip() for m in re.finditer(r"^\s*(?:-\s*)?run:\s*(.+)$", text, re.M)]


def test_the_site_is_published_only_after_every_check_ci_runs():
    # deploy.yml published on every push to main without lint or the JS tests, so a
    # change that broke them still reached the site.
    deploy = runs("deploy.yml")
    missing = [command for command in runs("ci.yml") if command not in deploy]
    assert missing == [], "CI checks the deploy workflow skips"
