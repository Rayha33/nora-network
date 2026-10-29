from datetime import UTC, datetime

import pytest

from nora.integrations import GassocoBooking, NotConfigured, Origo


@pytest.mark.parametrize(
    ("connector_type", "variables"),
    [
        (Origo, ("NORA_ORIGO_URL", "NORA_ORIGO_TOKEN")),
        (GassocoBooking, ("NORA_GBS_URL", "NORA_GBS_TOKEN")),
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
