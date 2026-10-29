import shutil
import socket
import sys
import threading
from datetime import UTC, datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from nora import cli
from nora.data import load_network
from nora.integrations import (
    ConnectorError,
    GasscoBooking,
    GassocoBooking,
    NotConfigured,
    Origo,
    current_gas_day,
    kwh_per_hour_to_msm3d,
    window_bound,
)
from nora.live import poll_once
from nora.stream import load_stream

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "test-token"
GAS_DAY = datetime(2026, 10, 29, 5, tzinfo=UTC)  # gas day 2026-10-29 starts 06:00 CET
EXITS = {"dornum", "dunkirk", "easington", "emden", "st_fergus", "zeebrugge"}


@pytest.fixture
def scripts(monkeypatch):
    """The mocks in scripts/, importable as modules."""
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import mock_api
    import mock_gbs
    import mock_origo

    yield mock_api, mock_origo, mock_gbs
    for name in ("mock_api", "mock_gbs", "mock_origo"):
        sys.modules.pop(name, None)


def start_mock(api, module, token=TOKEN):
    """Serve a mock on a free port in a thread; return (server, url)."""
    handler = api.make_handler(module.PATH, token, module.make_build(api.exit_bookings()))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}{module.PATH}"


@pytest.fixture
def origo_mock(scripts, monkeypatch):
    api, mock_origo, _ = scripts
    server, url = start_mock(api, mock_origo)
    monkeypatch.setenv("NORA_ORIGO_URL", url)
    monkeypatch.setenv("NORA_ORIGO_TOKEN", TOKEN)
    yield url
    server.shutdown()
    server.server_close()


@pytest.fixture
def gbs_mock(scripts, monkeypatch):
    api, _, mock_gbs = scripts
    server, url = start_mock(api, mock_gbs)
    monkeypatch.setenv("NORA_GBS_URL", url)
    monkeypatch.setenv("NORA_GBS_TOKEN", TOKEN)
    yield url
    server.shutdown()
    server.server_close()


@pytest.mark.parametrize(
    ("connector_type", "variables"),
    [
        (Origo, ("NORA_ORIGO_URL", "NORA_ORIGO_TOKEN")),
        (GasscoBooking, ("NORA_GBS_URL", "NORA_GBS_TOKEN")),
    ],
)
def test_credentials_required_connectors_fail_closed_without_environment(
    monkeypatch, connector_type, variables
):
    for variable in variables:
        monkeypatch.delenv(variable, raising=False)
    connector = connector_type()

    assert not connector.configured()
    assert all(variable in connector.status() for variable in variables)
    with pytest.raises(NotConfigured):
        list(connector.fetch(datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 2, tzinfo=UTC)))


def test_the_old_misspelt_booking_name_still_imports():
    assert GassocoBooking is GasscoBooking


def test_a_date_means_a_gas_day_from_0600_cet():
    assert window_bound("2026-10-29") == GAS_DAY
    assert window_bound("2026-10-29", end=True) == GAS_DAY + timedelta(days=1)
    assert window_bound("2026-07-01") == datetime(2026, 7, 1, 4, tzinfo=UTC)  # CEST
    assert window_bound("2026-10-29T12:00:00") == datetime(2026, 10, 29, 12, tzinfo=UTC)
    start, end = current_gas_day(datetime(2026, 10, 29, 3, tzinfo=UTC))  # before 06:00 CET
    assert (start, end) == (GAS_DAY - timedelta(days=1), GAS_DAY)


def test_kwh_per_hour_converts_to_msm3d_at_the_calorific_value():
    # 11 kWh/Sm3: one MSm3/d is 11e6 kWh a day, 458,333 kWh each hour
    assert kwh_per_hour_to_msm3d(11e6 / 24) == pytest.approx(1.0)
    assert kwh_per_hour_to_msm3d(10e6 / 24, gcv=10.0) == pytest.approx(1.0)


def test_origo_mock_gives_hourly_nominations_converted_to_msm3d(origo_mock, scripts):
    api, mock_origo, _ = scripts
    connector = Origo()
    payload = connector.download(GAS_DAY, GAS_DAY + timedelta(days=1))
    assert payload["mock"] is True and "Not Origo's real" in payload["notice"]
    assert payload["unit"] == "kWh/h"

    readings = list(connector.parse(payload))
    assert len(readings) == 24 * len(EXITS)  # every hour of the gas day, every exit point
    assert {r.asset for r in readings} == EXITS
    assert {r.metric for r in readings} == {"nomination_msm3d"}
    assert min(r.when for r in readings) == GAS_DAY
    assert all(r.when.minute == 0 for r in readings)
    booked = {node: value for node, (_, value) in api.exit_bookings().items()}
    for r in readings:  # in MSm3/d, not kWh/h: a share of the exit's booking
        assert 0.7 * booked[r.asset] < r.value <= booked[r.asset]
    first = payload["nominations"][0]
    assert readings[0].value == pytest.approx(first["kwh_h"] * 24 / 11.0 / 1e6)
    # one renomination a day: the rate of change at each exit point shows
    emden = [r.value for r in readings if r.asset == "emden"]
    assert max(abs(b - a) for a, b in zip(emden, emden[1:], strict=False)) > 1.5


def test_the_gas_day_the_clocks_go_back_has_25_hours(origo_mock):
    start, end = window_bound("2026-10-24"), window_bound("2026-10-24", end=True)
    readings = list(Origo().fetch(start, end))
    assert end - start == timedelta(hours=25)
    assert len({r.when for r in readings}) == 25


def test_gbs_mock_gives_bookings_per_gas_day_in_msm3d(gbs_mock):
    readings = list(GasscoBooking().fetch(GAS_DAY, GAS_DAY + timedelta(days=3)))
    assert {r.metric for r in readings} == {"booked_msm3d"}
    assert {r.asset for r in readings} == EXITS
    emden = {r.when: r.value for r in readings if r.asset == "emden"}
    assert len(emden) == 72
    thursday = {emden[GAS_DAY + timedelta(hours=h)] for h in range(24)}
    saturday = {emden[GAS_DAY + timedelta(days=2, hours=h)] for h in range(24)}
    assert thursday == {39.5}  # 90 % of Norpipe's 44 MSm3/d, in half MSm3/d steps
    assert saturday == {37.5}  # 5 % less on weekend gas days


def test_a_bad_token_gives_a_clear_error(origo_mock, monkeypatch):
    monkeypatch.setenv("NORA_ORIGO_TOKEN", "wrong")
    with pytest.raises(ConnectorError, match=r"refused the token \(HTTP 401\).*NORA_ORIGO_TOKEN"):
        list(Origo().fetch(GAS_DAY, GAS_DAY + timedelta(hours=1)))


def test_a_silent_server_times_out_with_a_clear_error(monkeypatch):
    silent = socket.socket()
    silent.bind(("127.0.0.1", 0))
    silent.listen()  # accepts the connection, never answers
    try:
        monkeypatch.setenv("NORA_GBS_URL", f"http://127.0.0.1:{silent.getsockname()[1]}/b")
        monkeypatch.setenv("NORA_GBS_TOKEN", TOKEN)
        connector = GasscoBooking()
        connector.timeout = 0.3
        with pytest.raises(ConnectorError, match=r"no answer from .* within 0.3 s"):
            list(connector.fetch(GAS_DAY, GAS_DAY + timedelta(hours=1)))
    finally:
        silent.close()


def test_an_unreachable_server_gives_a_clear_error(monkeypatch):
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    port = closed.getsockname()[1]
    closed.close()
    monkeypatch.setenv("NORA_ORIGO_URL", f"http://127.0.0.1:{port}/nominations")
    monkeypatch.setenv("NORA_ORIGO_TOKEN", TOKEN)
    with pytest.raises(ConnectorError, match="cannot reach"):
        list(Origo().fetch(GAS_DAY, GAS_DAY + timedelta(hours=1)))


def test_a_live_origo_poll_carries_the_next_hours(origo_mock):
    item = poll_once(Origo(), 0, poll_seconds=300)
    assert not isinstance(item, dict), item
    when, flows, metrics, index, ahead = item
    assert flows == {}, "nominations are not flows"
    assert set(metrics["nomination_msm3d"]) == EXITS
    assert all(len(values) >= 5 for values in ahead["nomination_msm3d"].values())


@pytest.fixture
def data_copy(tmp_path):
    """The real network without its streams, so a fetched stream is the only one."""
    folder = tmp_path / "data"
    folder.mkdir()
    for name in ("nodes.csv", "pipelines.csv"):
        shutil.copyfile(ROOT / "data" / name, folder / name)
    return folder


def test_the_cli_writes_a_stream_that_load_stream_reads(origo_mock, gbs_mock, data_copy, capsys):
    for name in ("origo", "gbs"):
        argv = ["--data", str(data_copy), "integrations", "fetch", name, "--to", "shipper-mock"]
        assert cli.main([*argv, "--start", "2026-10-29", "--end", "2026-10-30"]) == 0
    out = capsys.readouterr().out
    assert "Wrote 288 readings" in out and "Booked capacity (MSm3/d): 6 assets" in out

    folder = data_copy / "streams" / "shipper-mock"
    assert (folder / "flows.csv").read_text().startswith("timestamp,asset,metric,value\n")
    toml = (folder / "stream.toml").read_text()
    assert TOKEN not in toml, "the token never lands in the stream"
    stream = load_stream("shipper-mock", load_network(data_copy), data_copy / "streams")
    assert stream.synthetic, "mock data is labelled synthetic"
    assert "(mock)" in stream.title and "MOCK DATA" in stream.description
    assert set(stream.metrics) == {"nomination_msm3d", "booked_msm3d"}
    assert len(stream.times) == 48 and stream.times[0] == GAS_DAY
    assets, values = stream.metrics["booked_msm3d"]
    assert dict(zip(assets, values[0], strict=True))["emden"] == 39.5
    assert stream.payload()["synthetic"] is True

    # fetching again replaces those hours instead of adding duplicate rows
    argv = ["--data", str(data_copy), "integrations", "fetch", "gbs", "--to", "shipper-mock"]
    assert cli.main([*argv, "--start", "2026-10-29"]) == 0
    reloaded = load_stream("shipper-mock", load_network(data_copy), data_copy / "streams")
    assert reloaded.times == stream.times


def test_the_cli_reports_a_bad_token_and_writes_nothing(origo_mock, data_copy, monkeypatch, capsys):
    monkeypatch.setenv("NORA_ORIGO_TOKEN", "wrong")
    argv = ["--data", str(data_copy), "integrations", "fetch", "origo", "--to", "shipper-mock"]
    assert cli.main(argv) == 1
    assert "refused the token" in capsys.readouterr().err
    assert not (data_copy / "streams" / "shipper-mock").exists()


def test_integrations_without_a_subcommand_still_lists_the_connections(capsys):
    assert cli.main(["integrations"]) == 0
    out = capsys.readouterr().out
    assert "Origo" in out and "Gassco Booking (GBS)" in out


def test_a_synthetic_label_must_be_true_false_or_a_table(tiny_dir, tiny):
    folder = tiny_dir / "streams" / "odd"
    folder.mkdir(parents=True)
    (folder / "stream.toml").write_text('synthetic = "yes"\n')
    (folder / "flows.csv").write_text("timestamp,asset,flow_msm3d\n2026-10-29T05:00:00Z,pipe_a,1\n")
    with pytest.raises(Exception, match="synthetic must be true, false or a"):
        load_stream("odd", tiny, tiny_dir / "streams")
