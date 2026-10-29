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


def test_edit_api_refuses_non_loopback_bind(capsys):
    assert main(["serve", "--edit", "--host", "0.0.0.0", "--no-browser"]) == 1
    assert "must bind to 127.0.0.1" in capsys.readouterr().err
