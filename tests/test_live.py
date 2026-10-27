"""`nora live` loads the network and every stream once, not twice (issue #17)."""

from pathlib import Path

import nora.cli
import nora.live
import nora.site
from nora.cli import main
from nora.data import DATA_DIR
from nora.stream import list_streams


def _count_loads(monkeypatch, calls):
    """Wrap the loaders site/cli call so each load is recorded, not skipped."""
    real_net = nora.site.load_network
    real_stream = nora.site.load_stream

    def counted_net(data_dir=DATA_DIR):
        calls["load_network"] += 1
        return real_net(Path(data_dir))

    def counted_stream(*args, **kwargs):
        calls["load_stream"].append(args[0])
        return real_stream(*args, **kwargs)

    monkeypatch.setattr(nora.site, "load_network", counted_net)
    monkeypatch.setattr(nora.site, "load_stream", counted_stream)
    monkeypatch.setattr(nora.cli, "load_network", counted_net)
    monkeypatch.setattr(nora.cli, "load_stream", counted_stream)


def test_live_loads_the_network_and_each_stream_once(monkeypatch, tmp_path):
    calls = {"load_network": 0, "load_stream": []}
    _count_loads(monkeypatch, calls)
    served = {}
    monkeypatch.setattr(
        nora.live, "serve", lambda site_dir, stream, **kw: served.update(stream=stream)
    )

    assert main(["--data", str(DATA_DIR), "live", "--out", str(tmp_path / "site")]) == 0

    names = list_streams(DATA_DIR / "streams")
    assert calls["load_network"] == 1  # build_site's load is the only one
    assert sorted(calls["load_stream"]) == sorted(names)  # each stream loaded once
    assert len(calls["load_stream"]) == len(set(calls["load_stream"]))
    assert served["stream"].name == names[0]  # default: the first listed stream


def test_live_still_rejects_an_unknown_stream(monkeypatch, tmp_path):
    calls = {"load_network": 0, "load_stream": []}
    _count_loads(monkeypatch, calls)

    rc = main(
        [
            "--data",
            str(DATA_DIR),
            "live",
            "--stream",
            "no-such-stream",
            "--out",
            str(tmp_path / "site"),
        ]
    )
    assert rc == 1  # reported as a DataError, not a traceback
