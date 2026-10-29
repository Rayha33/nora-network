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


def runs(workflow: str, job: str | None = None) -> list[str]:
    """The commands a workflow's steps run, in order; only one job's when `job` is given."""
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    if job:
        # A job is the block from its two-space-indented key to the next job's key.
        m = re.search(rf"^  {re.escape(job)}:\n(.*?)(?=^  [\w-]+:\n|\Z)", text, re.M | re.S)
        assert m, f"{workflow} has no job {job!r}"
        text = m.group(1)
    return [m.group(1).strip() for m in re.finditer(r"^\s*(?:-\s*)?run:\s*(.+)$", text, re.M)]


def test_the_site_is_published_only_after_every_check_ci_runs():
    # deploy.yml published on every push to main without lint or the JS tests, so a
    # change that broke them still reached the site.
    # The required "checks" job only: the browser smoke job is not required yet (it
    # becomes so after 3 green pull requests, and then joins deploy.yml and this test).
    deploy = runs("deploy.yml")
    missing = [command for command in runs("ci.yml", job="checks") if command not in deploy]
    assert missing == [], "CI checks the deploy workflow skips"


def test_the_job_reader_reads_one_job():
    # The test above passes vacuously if the reader finds no commands at all.
    checks, browser = runs("ci.yml", job="checks"), runs("ci.yml", job="browser")
    smoke = "node tests/browser/smoke.mjs"
    assert "pytest -q" in checks and "pytest -q" not in browser
    assert smoke in browser and smoke not in checks


def test_every_action_is_pinned_to_a_commit():
    """Review #49802: third-party actions with contents: write ran from a tag, and a
    tag can be moved to other code. Every `uses:` names a 40-hex commit SHA."""
    workflows = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    assert workflows
    for workflow in workflows:
        for line in workflow.read_text(encoding="utf-8").splitlines():
            if m := re.search(r"uses:\s*(\S+)", line):
                assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", m.group(1)), (
                    f"{workflow.name}: {m.group(1)} is not pinned to a commit SHA"
                )
