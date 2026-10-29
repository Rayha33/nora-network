"""A mock Gassco Booking (GBS) API, for building and testing NORA's GBS connector.

    python scripts/mock_gbs.py --port 8702 --token mock-token
    export NORA_GBS_URL=http://127.0.0.1:8702/bookings NORA_GBS_TOKEN=mock-token
    nora integrations fetch gbs --to shipper-mock

GET /bookings?start=2026-10-29T05:00:00Z&end=2026-10-30T05:00:00Z with
`Authorization: Bearer <token>` answers the capacity booked at each exit point, in
Sm3/d, for every hour that overlaps the window (default: the current gas day).
Capacity is booked per gas day, so it is the same for every hour of one. The values
are MADE UP: the exit point's booked_msm3d in data/nodes.csv, or 90 % of the export
capacity landing there, and 5 % less on weekend gas days. This is NOT Gassco's real
API or format; docs/integrations.md documents the shape.
"""

from __future__ import annotations

import math
from datetime import datetime

from mock_api import Build, hours, iso, serve

from nora.integrations import gas_day_of

PATH = "/bookings"
NOTICE = (
    "Mock Gassco Booking API (scripts/mock_gbs.py in nora-network). Not Gassco's real "
    "API or format, and not real bookings: values are made up from NORA's exit capacities."
)
WEEKEND_SHARE = 0.95


def make_build(bookings: dict[str, tuple[str, float]]) -> Build:
    def build(start: datetime, end: datetime) -> dict:
        rows = []
        for hour in hours(start, end):
            day = gas_day_of(hour)
            share = WEEKEND_SHARE if day.weekday() >= 5 else 1.0
            for point, booked in bookings.values():
                msm3d = math.floor(booked * share * 2) / 2  # booked in half MSm3/d steps
                rows.append(
                    {
                        "point": point,
                        "gas_day": day.isoformat(),
                        "hour": iso(hour),
                        "sm3_d": round(msm3d * 1e6),
                    }
                )
        return {
            "mock": True,
            "notice": NOTICE,
            "document": "booked firm exit capacity per exit point and gas day",
            "gas_day_start": "06:00 CET (CEST in summer)",
            "unit": "Sm3/d",
            "start": iso(start),
            "end": iso(end),
            "bookings": rows,
        }

    return build


if __name__ == "__main__":
    serve("Gassco Booking (GBS)", PATH, 8702, "NORA_GBS_URL", "NORA_GBS_TOKEN", make_build)
