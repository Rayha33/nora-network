import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

from nora import edit
from nora.cli import main
from nora.data import DataError, load_network


def test_crud_and_check_use_csv_field_names(tiny):
    network = edit.add_node(
        tiny,
        {
            "id": "new_field",
            "name": "New field",
            "type": "field",
            "country": "NO",
            "lat": 61,
            "lon": 4,
            "capacity_msm3d": 10,
            "status": "operating",
        },
    )
    network = edit.add_pipeline(
        network,
        {
            "id": "new_feed",
            "name": "New feed",
            "from": "new_field",
            "to": "hub",
            "type": "feeder",
            "status": "operating",
        },
    )
    assert edit.check(network) == []

    network = edit.update_node(network, "new_field", {"id": "renamed_field"})
    network = edit.update_pipeline(network, "new_feed", {"from": "renamed_field"})
    assert network.node_by_id["renamed_field"].name == "New field"
    assert network.pipeline_by_id["new_feed"].from_id == "renamed_field"
    assert edit.check(network) == []


def test_check_returns_every_file_line_and_suggestion(tiny):
    network = edit.update_node(tiny, "gas", {"type": "feild", "lat": 100})
    network = edit.update_pipeline(network, "feed", {"from": "unknown_node"})

    problems = edit.check(network)

    assert any(
        "nodes.csv line 2" in problem and "did you mean 'field'" in problem for problem in problems
    )
    assert any(
        "nodes.csv line 2" in problem and "'lat' must be -90 to 90" in problem
        for problem in problems
    )
    assert any(
        "pipelines.csv line 2" in problem and "not an id in nodes.csv" in problem
        for problem in problems
    )


def test_remove_node_lists_all_connected_pipelines(tiny):
    with pytest.raises(DataError, match="feed, pipe_a, pipe_b"):
        edit.remove_node(tiny, "hub")

    network = tiny
    for pipeline_id in ("feed", "pipe_a", "pipe_b"):
        network = edit.remove_pipeline(network, pipeline_id)
    assert "hub" not in edit.remove_node(network, "hub").node_by_id


def test_save_changes_only_edited_row_and_preserves_csv_bytes(tiny_dir, tiny):
    nodes_path = tiny_dir / "nodes.csv"
    raw = nodes_path.read_bytes().replace(b"\n", b"\r\n")
    raw = raw.replace(b"hub,Hub,hub", b'hub,"Hub, Offshore",hub')
    raw = b"\xef\xbb\xbf" + raw
    nodes_path.write_bytes(raw)
    before = raw.splitlines(keepends=True)
    pipelines_path = tiny_dir / "pipelines.csv"
    pipelines_before = (tiny_dir / "pipelines.csv").read_bytes()
    pipeline_rows_before = pipelines_before.splitlines(keepends=True)
    tiny = load_network(tiny_dir)

    updated = edit.update_node(tiny, "gas", {"name": "Renamed field"})
    updated = edit.update_pipeline(updated, "feed", {"name": "Renamed feed"})
    edit.save(updated, tiny_dir)

    after = nodes_path.read_bytes().splitlines(keepends=True)
    assert after[0] == before[0]
    assert after[1] != before[1]
    assert after[2:] == before[2:]
    pipeline_rows_after = pipelines_path.read_bytes().splitlines(keepends=True)
    assert pipeline_rows_after[0] == pipeline_rows_before[0]
    assert pipeline_rows_after[1] != pipeline_rows_before[1]
    assert pipeline_rows_after[2:] == pipeline_rows_before[2:]
    network = load_network(tiny_dir)
    assert network.node_by_id["gas"].name == "Renamed field"
    assert network.pipeline_by_id["feed"].name == "Renamed feed"
    assert (network.pipeline_by_id["feed"].from_id, network.pipeline_by_id["feed"].to_id) == (
        "gas",
        "hub",
    )


def test_save_appends_new_nodes_and_pipelines(tiny, tiny_dir):
    network = edit.add_node(
        tiny,
        {
            "id": "extra_field",
            "name": "Extra field",
            "type": "field",
            "country": "NO",
            "lat": 61,
            "lon": 4,
            "capacity_msm3d": 10,
            "status": "operating",
        },
    )
    network = edit.add_pipeline(
        network,
        {
            "id": "extra_feed",
            "name": "Extra feed",
            "from": "extra_field",
            "to": "hub",
            "type": "feeder",
            "status": "operating",
        },
    )
    edit.save(network, tiny_dir)

    saved = load_network(tiny_dir)
    assert saved.nodes[-1].id == "extra_field"
    assert saved.pipelines[-1].id == "extra_feed"


def test_api_get_check_save_and_rejects_bad_requests(tiny_dir, tiny, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(edit, "build_site", lambda out, data: calls.append((out, data)))
    server = ThreadingHTTPServer(("127.0.0.1", 0), edit.make_handler(tiny_dir, tmp_path / "site"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    origin = f"http://127.0.0.1:{port}"

    def request(
        method, path, payload=None, *, content_type="application/json", request_origin=origin
    ):
        body = None if payload is None else json.dumps(payload).encode()
        headers = {}
        if content_type:
            headers["Content-Type"] = content_type
        if request_origin:
            headers["Origin"] = request_origin
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    try:
        status, payload = request("GET", "/api/network")
        assert status == 200
        assert payload["pipelines"][0]["from"] == "gas"
        assert payload["pipelines"][0]["to"] == "hub"

        assert request("POST", "/api/check", payload, content_type="text/plain")[0] == 415
        assert (
            request("POST", "/api/check", payload, request_origin="http://evil.example")[0] == 403
        )
        unsafe = {**payload, "path": "/tmp/other.csv"}
        assert request("POST", "/api/check", unsafe)[0] == 400

        status, checked = request("POST", "/api/check", payload)
        assert status == 200 and checked["valid"] and checked["problems"] == []
        invalid = json.loads(json.dumps(payload))
        invalid["nodes"][0]["lat"] = 100
        status, checked = request("POST", "/api/check", invalid)
        assert status == 200 and not checked["valid"]
        assert any("nodes.csv line 2" in item for item in checked["problems"])

        external = edit.update_node(load_network(tiny_dir), "hub", {"name": "External edit"})
        edit.save(external, tiny_dir)
        payload["nodes"][0]["name"] = "Edited through API"
        assert request("POST", "/api/save", payload)[0] == 409
        current = load_network(tiny_dir)
        assert current.node_by_id["hub"].name == "External edit"
        assert current.node_by_id["gas"].name == "Gas field"

        _, payload = request("GET", "/api/network")
        payload["nodes"][0]["name"] = "Edited through API"
        status, saved = request("POST", "/api/save", payload)
        assert status == 200 and saved["saved"] and saved["reload"]
        assert len(saved["revision"]) == 64
        assert load_network(tiny_dir).node_by_id["gas"].name == "Edited through API"
        assert calls == [(tmp_path / "site", tiny_dir)]
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_failed_site_rebuild_restores_csvs(tiny_dir, tmp_path, monkeypatch):
    builds = 0

    def build(out, data):
        nonlocal builds
        builds += 1
        if builds == 1:
            raise RuntimeError("simulated render failure")

    monkeypatch.setattr(edit, "build_site", build)
    server = ThreadingHTTPServer(("127.0.0.1", 0), edit.make_handler(tiny_dir, tmp_path / "site"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    origin = f"http://127.0.0.1:{port}"

    try:
        connection.request("GET", "/api/network")
        response = connection.getresponse()
        payload = json.loads(response.read())
        assert response.status == 200
        connection.close()

        payload["nodes"][0]["name"] = "Uncommitted edit"
        body = json.dumps(payload).encode()
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request(
            "POST",
            "/api/save",
            body=body,
            headers={"Content-Type": "application/json", "Origin": origin},
        )
        response = connection.getresponse()
        result = json.loads(response.read())
        assert response.status == 500 and not result["saved"]
        assert load_network(tiny_dir).node_by_id["gas"].name == "Gas field"
        assert builds == 2
    finally:
        connection.close()
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_edit_api_refuses_non_loopback_bind(capsys, monkeypatch):
    monkeypatch.delenv("NORA_EDIT_TOKEN", raising=False)
    assert main(["serve", "--edit", "--host", "0.0.0.0", "--no-browser"]) == 1
    assert "binds to 127.0.0.1 unless NORA_EDIT_TOKEN is set" in capsys.readouterr().err


def test_hosted_edit_api_saves_only_with_its_key(tiny_dir, tmp_path, monkeypatch):
    """Ray, 29 Oct: "i will later host this solution". Hosted, Save writes data/ like
    `make edit` does, but only for a request carrying the server's edit key."""
    monkeypatch.setattr(edit, "build_site", lambda out, data: None)
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), edit.make_handler(tiny_dir, tmp_path / "site", token="s3cret")
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]

    def request(method, path, payload=None, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        body = None if payload is None else json.dumps(payload).encode()
        connection.request(method, path, body=body, headers={"Host": "nora.example", **headers})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    try:
        _, payload = request("GET", "/api/network")
        payload["nodes"][0]["name"] = "Saved on the hosted NORA"
        post = {"Content-Type": "application/json", "Origin": "https://nora.example"}
        assert request("POST", "/api/save", payload, **post)[0] == 401
        wrong = {**post, "Authorization": "Bearer guess"}
        assert request("POST", "/api/save", payload, **wrong)[0] == 401
        keyed = {**post, "Authorization": "Bearer s3cret"}
        other = {**keyed, "Origin": "https://evil.example"}
        assert request("POST", "/api/save", payload, **other)[0] == 403
        assert load_network(tiny_dir).node_by_id["gas"].name == "Gas field"
        status, saved = request("POST", "/api/save", payload, **keyed)
        assert status == 200 and saved["saved"]
        assert load_network(tiny_dir).node_by_id["gas"].name == "Saved on the hosted NORA"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


UNITS = """# Two desks for the tiny network.

[units.offshore]
name = "Offshore"
nodes = ["gas", "hub"]

[units.landings]
name = "Landings"
nodes = ["a_terminal", "b_terminal", "market"]
"""


def test_save_keeps_every_node_in_one_unit(tiny_dir, tiny):
    """The editor in the page (Ray, 29 Oct) removes and adds nodes: units.toml follows,
    comments kept, so the site still builds."""
    (tiny_dir / "units.toml").write_text(UNITS, encoding="utf-8")
    network = edit.remove_pipeline(tiny, "b_entry")
    network = edit.remove_pipeline(network, "pipe_b")
    network = edit.remove_node(network, "b_terminal")
    network = edit.add_node(
        network,
        {
            "id": "c_field",
            "name": "C field",
            "type": "field",
            "country": "NO",
            "lat": 61,
            "lon": 3,
            "capacity_msm3d": 5,
            "status": "operating",
        },
    )
    network = edit.add_pipeline(
        network,
        {
            "id": "c_feed",
            "name": "C feed",
            "from": "c_field",
            "to": "hub",
            "type": "feeder",
            "status": "operating",
        },
    )
    edit.save(network, tiny_dir, {"c_field": "offshore"})
    text = (tiny_dir / "units.toml").read_text(encoding="utf-8")
    assert text.startswith("# Two desks for the tiny network.")
    assert 'nodes = ["gas", "hub", "c_field"]' in text
    assert 'nodes = ["a_terminal", "market"]' in text


def test_save_moves_a_renamed_node_to_its_new_unit(tiny_dir, tiny):
    """The editor's node form (Ray, 30 Oct: "a fully fledged editing program") changes a
    node's name and unit: the row is rewritten, the node leaves its old unit for the new
    one, and still sits in exactly one."""
    (tiny_dir / "units.toml").write_text(UNITS, encoding="utf-8")
    network = edit.update_node(tiny, "hub", {"name": "Hub platform"})
    edit.save(network, tiny_dir, {"hub": "landings"})
    text = (tiny_dir / "units.toml").read_text(encoding="utf-8")
    assert 'nodes = ["gas"]' in text
    assert 'nodes = ["a_terminal", "b_terminal", "market", "hub"]' in text
    assert "Hub platform" in (tiny_dir / "nodes.csv").read_text(encoding="utf-8")


def test_save_refuses_a_new_node_without_a_unit(tiny_dir, tiny):
    (tiny_dir / "units.toml").write_text(UNITS, encoding="utf-8")
    network = edit.add_node(
        tiny,
        {
            "id": "loose",
            "name": "Loose",
            "type": "hub",
            "country": "NO",
            "lat": 60,
            "lon": 2,
            "status": "operating",
        },
    )
    with pytest.raises(DataError) as caught:
        edit.save(network, tiny_dir, {})
    assert any("loose" in problem for problem in caught.value.problems)
    with pytest.raises(DataError):
        edit.save(network, tiny_dir, {"loose": "nowhere"})
    assert (tiny_dir / "units.toml").read_text(encoding="utf-8") == UNITS  # nothing written


def test_removing_a_streamed_asset_keeps_the_data_valid(tmp_path):
    """Found in the browser: removing Gudrun in the editor failed to save, because the
    SODIR stream maps a column to it and the synthetic week has a CO2 excursion there.
    Saving drops those references, so the data still validates and the site builds."""
    import shutil

    from nora.data import DATA_DIR
    from nora.stream import list_streams, load_stream

    data = tmp_path / "data"
    shutil.copytree(DATA_DIR, data)
    net = load_network(data)
    for pipe in [p.id for p in net.pipelines if "gudrun" in (p.from_id, p.to_id)]:
        net = edit.remove_pipeline(net, pipe)
    net = edit.remove_node(net, "gudrun")
    edit.save(net, data, {})
    saved = load_network(data)
    for name in list_streams(data / "streams"):
        load_stream(name, saved, data / "streams")  # raises on a reference left behind
    sodir = (data / "streams" / "sodir-field-production" / "stream.toml").read_text()
    assert '"GUDRUN" = ""  # gudrun was removed from the network' in sodir
    synthetic = (data / "streams" / "synthetic-week" / "stream.toml").read_text()
    assert 'asset = "gudrun"' not in synthetic and 'asset = "troll"' in synthetic


def test_save_places_moved_and_new_nodes_in_the_layout(tiny_dir, tiny):
    """A node dragged or added in the Flow view keeps its place: flow_layout.toml."""
    (tiny_dir / "flow_layout.toml").write_text(
        "# places\n[positions]\ngas = [0, 0]\nhub = [0, 1]\nb_terminal = [1, 2]\n", encoding="utf-8"
    )
    network = edit.remove_pipeline(tiny, "b_entry")
    network = edit.remove_pipeline(network, "pipe_b")
    network = edit.remove_node(network, "b_terminal")
    edit.save(network, tiny_dir, {}, {"hub": [0.5, 1.25], "market": [2, 3]})
    text = (tiny_dir / "flow_layout.toml").read_text(encoding="utf-8")
    assert text.startswith("# places\n[positions]\ngas = [0, 0]\nhub = [0.5, 1.25]\n")
    assert "b_terminal" not in text and text.endswith("market = [2, 3]\n")
