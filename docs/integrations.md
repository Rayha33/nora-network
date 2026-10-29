# Connecting Origo and Gassco Booking (GBS)

Origo (the shippers' nominations) and Gassco Booking, GBS (the capacity they have
booked), publish no open API: access comes with shipper credentials and their own
documentation. NORA is therefore built against two **mocks** of them, documented below,
so that connecting the real systems only means swapping the transport and the format in
`src/nora/integrations.py`; the stream, the live feed, the plan check and the app stay
as they are.

> **The JSON shapes on this page are NORA's own, not Origo's or Gassco's real formats.**
> They borrow only public concepts (the gas day, Edig@s nomination messages, kWh and
> Sm3). The mocks' values are made up from NORA's exit capacities, and a stream written
> from a mock is labelled synthetic.

| system | connector | NORA metric | environment | mock |
| --- | --- | --- | --- | --- |
| Origo | `Origo` | `nomination_msm3d` | `NORA_ORIGO_URL`, `NORA_ORIGO_TOKEN` | `scripts/mock_origo.py`, `GET /nominations` |
| Gassco Booking | `GasscoBooking` | `booked_msm3d` | `NORA_GBS_URL`, `NORA_GBS_TOKEN` | `scripts/mock_gbs.py`, `GET /bookings` |

## Try it with the mocks

```bash
python scripts/mock_origo.py --port 8701 --token mock-token &
python scripts/mock_gbs.py --port 8702 --token mock-token &
export NORA_ORIGO_URL=http://127.0.0.1:8701/nominations NORA_ORIGO_TOKEN=mock-token
export NORA_GBS_URL=http://127.0.0.1:8702/bookings NORA_GBS_TOKEN=mock-token

nora integrations                                   # both say "ready"
nora integrations fetch origo --to shipper-mock     # the current gas day
nora integrations fetch gbs --to shipper-mock --start 2026-10-28 --end 2026-10-30
nora stream show shipper-mock
nora live --stream shipper-mock                     # replay it in the app
nora live --source origo                            # or poll Origo live, 6 hours ahead
```

`nora integrations fetch NAME --to STREAM [--start S] [--end E]` writes
`data/streams/STREAM/`: `flows.csv` in NORA's long format
(`timestamp,asset,metric,value`, see `data/streams/README.md`) and a `stream.toml`
that records where each part came from. Fetching Origo and GBS into the same stream
combines them; fetching again replaces the hours fetched and keeps the rest.

- `--start` and `--end` take a date, meaning that gas day (`--start 2026-10-28 --end
  2026-10-30` is three gas days), or an ISO 8601 time (UTC when it has no offset; the
  end is excluded). Without them, the current gas day.
- Readings for exit points that are not in the network are skipped, with a note.
- A mock's answer carries `"mock": true`; the stream then gets `synthetic = true` and
  "MOCK DATA, not real" in its description, so the app labels it synthetic. The URL is
  recorded without its query string and the token is never written.
- Generated streams are for local use: do not commit a mock stream.

## Concepts the mocks use

- **Gas day.** Nominations and bookings count per gas day, which runs from 06:00 to
  06:00 CET (CEST in summer), the European convention: 05:00 to 05:00 UTC in winter,
  04:00 to 04:00 UTC in summer. The gas day the clocks change on has 23 or 25 hours.
  Every row carries its `gas_day`; `hour` is the hour's start in UTC.
- **Nominations (Edig@s NOMINT / NOMRES).** In the European gas industry a shipper sends
  its nomination in an Edig@s NOMINT message and the operator confirms it in NOMRES,
  with hourly quantities in energy (kWh). The Origo mock answers the confirmed hourly
  nominations in that spirit; it is JSON, not an Edig@s message.
- **Units.** NORA works in MSm3/d (million standard cubic metres per day). An hourly
  energy quantity in kWh/h converts through the gas's gross calorific value (GCV):

  MSm3/d = kWh/h x 24 / GCV (kWh/Sm3) / 1,000,000

  At the 11.0 kWh/Sm3 NORA assumes for Norwegian gas, 16,203,229 kWh/h is
  35.35 MSm3/d. Bookings are volume rates in Sm3/d: divide by a million.

## Origo mock: `GET /nominations`

Query: `start` and `end`, ISO 8601 (default: the current gas day); every hour that
overlaps `[start, end)` is answered, at most 31 days. Header:
`Authorization: Bearer <token>`.

```json
{
 "mock": true,
 "notice": "Mock Origo API (scripts/mock_origo.py in nora-network). Not Origo's real API or format, and not real nominations: values are made up from NORA's exit capacities.",
 "document": "confirmed hourly nominations per exit point (NOMRES-like)",
 "gas_day_start": "06:00 CET (CEST in summer)",
 "unit": "kWh/h",
 "gcv_kwh_per_sm3": 11.0,
 "start": "2026-10-29T05:00:00Z",
 "end": "2026-10-29T06:00:00Z",
 "nominations": [
  {"point": "Emden", "gas_day": "2026-10-29", "hour": "2026-10-29T05:00:00Z", "kwh_h": 16203229}
 ]
}
```

| field | meaning |
| --- | --- |
| `point` | Gassco's name for the exit point; `EXIT_POINTS` in `integrations.py` maps it to a NORA node (a NORA node id is accepted too) |
| `gas_day` | the gas day the hour belongs to |
| `hour` | start of the hour, UTC |
| `kwh_h` | the confirmed nomination for that hour, kWh/h; converted at `gcv_kwh_per_sm3` |
| `msm3d` | alternative to `kwh_h`: the rate already in MSm3/d |

The connector reads `kwh_h` (or `msm3d`) as `nomination_msm3d` at the exit point's
node. The values: each exit point's booking (below) times a share between about 0.72
and 0.94 that swings over the day and the week, with a four-hour renomination down each
gas day so the rate of change shows.

## GBS mock: `GET /bookings`

Same query and header.

```json
{
 "mock": true,
 "notice": "Mock Gassco Booking API (scripts/mock_gbs.py in nora-network). Not Gassco's real API or format, and not real bookings: values are made up from NORA's exit capacities.",
 "document": "booked firm exit capacity per exit point and gas day",
 "gas_day_start": "06:00 CET (CEST in summer)",
 "unit": "Sm3/d",
 "start": "2026-10-29T05:00:00Z",
 "end": "2026-10-29T06:00:00Z",
 "bookings": [
  {"point": "Emden", "gas_day": "2026-10-29", "hour": "2026-10-29T05:00:00Z", "sm3_d": 39500000}
 ]
}
```

| field | meaning |
| --- | --- |
| `point`, `gas_day`, `hour` | as for Origo |
| `sm3_d` | capacity booked for the gas day, Sm3/d; the same for every hour of it |
| `msm3d` | alternative to `sm3_d`: already in MSm3/d |

The connector reads it as `booked_msm3d`, which NORA holds until the next value. The
values: an exit point's `booked_msm3d` in `data/nodes.csv`, or else 90 % of the
capacity of the export lines landing there, in half-MSm3/d steps (Emden: 90 % of
Norpipe's 44 is 39.5), and 5 % less on weekend gas days.

## Errors

| what happens | what NORA says |
| --- | --- |
| URL or token not set | `Origo: not configured: set NORA_ORIGO_URL, NORA_ORIGO_TOKEN` |
| wrong token (HTTP 401 or 403) | `Origo: <url> refused the token (HTTP 401); check NORA_ORIGO_TOKEN` |
| no answer in 30 s | `Origo: no answer from <url> within 30 s` |
| nothing listening, DNS failure | `Origo: cannot reach <url>: <reason>` |
| another HTTP error | `Origo: <url> answered HTTP 400: <the server's "error">` |
| not JSON | `Origo: <url> did not answer JSON: ...` |

`nora integrations fetch` prints the message and exits with 1, writing nothing. A live
poll (`nora live --source origo`) reports it as a failed poll and keeps the feed going.

## Connecting the real systems

1. Set `NORA_ORIGO_URL` / `NORA_ORIGO_TOKEN` (or the GBS pair) to the real endpoint and
   credentials. Keep the token out of files and the repository.
2. If the real answer is shaped differently, change `parse` in `Origo` or
   `GasscoBooking` to yield the same `Reading(hour, node, metric, MSm3/d)` rows.
3. If the real API is not "GET with `start` and `end`, bearer token, JSON back"
   (an Edig@s XML exchange, a certificate, OAuth), change `download`.
4. Add a test with a trimmed copy of a real answer, as `tests/test_integrations.py`
   does for the mocks.

## Gassco's public real-time feed

`nora live --source gassco` polls Gassco's open endpoint
(`https://gassco.eu/wp-json/gassco/v1/realTimeGraphData`), aggregate Norwegian export
flow by receiving country. Checked with one request on 29 October 2026 at 15:39 UTC,
sending NORA's own User-Agent: HTTP 200 JSON, published 15:08:10 UTC, with Germany
158.89, France 46, Belgium 43.6, Great Britain 73.8, Other 13.9 and Total 336.3 MSm3/d.
The connector maps France to Dunkirk and Belgium to Zeebrugge; Germany and Great
Britain land at two terminals each, so NORA does not split them. Cloudflare in front of
gassco.eu may refuse a client at other times; the feed then reports each failed poll.
