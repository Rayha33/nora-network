"""A mock Origo nomination API, for building and testing NORA's Origo connector.

    python scripts/mock_origo.py --port 8701 --token mock-token
    export NORA_ORIGO_URL=http://127.0.0.1:8701/nominations NORA_ORIGO_TOKEN=mock-token
    nora integrations fetch origo --to shipper-mock

GET /nominations?start=2026-10-29T05:00:00Z&end=2026-10-30T05:00:00Z with
`Authorization: Bearer <token>` answers the shippers' confirmed hourly nominations at
each exit point, in kWh/h, for every hour that overlaps the window (default: the
current gas day). The values are MADE UP from the bookings in data/nodes.csv (or 90 %
of the export capacity landing at each exit point) and a smooth daily swing, with one
within-day renomination per exit point so the rate of change shows. This is NOT
Origo's real API or format; docs/integrations.md documents the shape.
"""

from __future__ import annotations

import math
from datetime import datetime

from mock_api import Build, hour_of_gas_day, hours, iso, serve

from nora.integrations import GCV_KWH_PER_SM3, gas_day_of

PATH = "/nominations"
NOTICE = (
    "Mock Origo API (scripts/mock_origo.py in nora-network). Not Origo's real API or "
    "format, and not real nominations: values are made up from NORA's exit capacities."
)


def nominated_share(hour: datetime, k: int) -> float:
    """The share of an exit point's booking nominated for an hour: a daily swing, a
    weekly one, and a renomination down for four hours each gas day."""
    h = hour_of_gas_day(hour)
    day = gas_day_of(hour).toordinal()
    share = 0.86 + 0.05 * math.sin(2 * math.pi * (h + 3 * k) / 24)
    share += 0.03 * math.sin(2 * math.pi * (day + k) / 7)
    if 14 <= (h + 2 * k) % 24 < 18:
        share -= 0.06
    return round(share, 3)


def make_build(bookings: dict[str, tuple[str, float]]) -> Build:
    def build(start: datetime, end: datetime) -> dict:
        nominations = []
        for hour in hours(start, end):
            for k, (point, booked) in enumerate(bookings.values()):
                msm3d = booked * nominated_share(hour, k)
                nominations.append(
                    {
                        "point": point,
                        "gas_day": gas_day_of(hour).isoformat(),
                        "hour": iso(hour),
                        "kwh_h": round(msm3d * 1e6 * GCV_KWH_PER_SM3 / 24),
                    }
                )
        return {
            "mock": True,
            "notice": NOTICE,
            "document": "confirmed hourly nominations per exit point (NOMRES-like)",
            "gas_day_start": "06:00 CET (CEST in summer)",
            "unit": "kWh/h",
            "gcv_kwh_per_sm3": GCV_KWH_PER_SM3,
            "start": iso(start),
            "end": iso(end),
            "nominations": nominations,
        }

    return build


if __name__ == "__main__":
    serve("Origo", PATH, 8701, "NORA_ORIGO_URL", "NORA_ORIGO_TOKEN", make_build)
