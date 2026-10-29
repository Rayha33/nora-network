# Wiring up live data

NORA draws whatever readings reach it: flows, pressures, nominations, gas quality. There
are three ways in. Pick the first that fits.

| You have | Do this |
| --- | --- |
| Any system that can send an HTTP request (a historian's export job, a script, a queue bridge) | **Push** JSON to `nora live --ingest` |
| A source NORA should fetch from on a timer | **Poll** it with a connector (`nora live --source ...`) |
| Files (CSV exports) | **Replay** them as a stream (`data/streams/README.md`) |

Whichever you choose, the page needs no change: open `network.html?live=/stream` on the
server and it plays what arrives.

## Push: `nora live --ingest`

Start the server. Bound to this computer only, it needs no token:

```bash
nora live --ingest
```

Taking pushes from other machines, it needs a token. Set a long random secret first:

```bash
NORA_INGEST_TOKEN=$(openssl rand -hex 24) nora live --ingest --host 0.0.0.0
```

Then send readings. A push may carry one reading or all of them. NORA keeps the latest
value of each, so every frame the page gets is the whole picture.

```bash
curl -X POST http://127.0.0.1:8765/ingest \
  -H "Authorization: Bearer $NORA_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"t": "2026-10-29T12:00:00Z",
       "flows": {"troll_kollsnes": 101.2, "europipe_1": 45.6},
       "metrics": {"pressure_bar": {"kollsnes": 152.1, "dornum": 66.4},
                   "nomination_msm3d": {"dornum": 92.0}}}'
```

Or as a list of readings, the way most historians export them:

```bash
curl -X POST http://127.0.0.1:8765/ingest -H "Content-Type: application/json" \
  -d '[{"asset": "kollsnes", "metric": "pressure_bar", "value": 152.1, "t": 1793275200},
       {"asset": "troll_kollsnes", "metric": "flow_msm3d", "value": 101.2}]'
```

The reply says what was taken and what was not, and why:

```json
{"accepted": 2, "ignored": [{"asset": "kolsnes", "metric": "pressure_bar", "why": "unknown asset"}]}
```

- **Status codes:** `202` when something was taken, `422` when nothing was. `400`, `401`, `413` and `415` mean bad JSON, a wrong token, too large, or not JSON.
- **Ids** are NORA's: the `id` column of `data/nodes.csv` and `data/pipelines.csv`. A tag that is not an id is turned away, never guessed.
- **Flows** are on pipelines, in MSm³/d, from the line's `from` to its `to`. A negative value flows the other way.
- **Time** `t` is epoch seconds (or milliseconds) or ISO 8601. If it is left out, the reading is taken as now.
- **`null`** clears a reading, so the page shows it as missing instead of keeping the last value.
- **Size:** at most 1 MB per push. Anything that is not a finite number is turned away.

### Metrics and units

| metric | what | unit |
| --- | --- | --- |
| `flow_msm3d` | flow on a pipeline (or through a node) | MSm³/d |
| `pressure_bar` | pressure at a node | bar g |
| `nomination_msm3d` | hourly nominated rate at an exit point | MSm³/d |
| `booked_msm3d` | booked capacity at an exit point | MSm³/d |
| `h2s_ppm` | H₂S in a field's export gas | ppm |
| `co2_molpct` | CO₂ in a field's export gas | mol % |
| `c1_molpct`, `c2_molpct`, `c3_molpct`, `ic4_molpct`, `nc4_molpct`, `ic5_molpct`, `nc5_molpct`, `c6plus_molpct` | the gas chromatograph's components, methane to hexanes and heavier | mol % |
| `n2_molpct` | nitrogen | mol % |
| `o2_ppm` | oxygen | ppm |
| `wdp_c` | water dew point | °C |
| `hcdp_c` | hydrocarbon dew point | °C |
| `air_temp_c` | outside air temperature at a site | °C |

`src/nora/stream.py` (`METRICS`) is the list NORA checks against.

## Poll: a connector

For a source NORA should fetch itself, subclass `Connector` in
`src/nora/integrations.py`:

- implement `fetch(start, end)` to yield `Reading(when, asset, metric, value)`;
- set `metric`, and `flows = True` for flows;
- add it to `SOURCES`.

`nora live --source NAME --poll-seconds 60` then polls it once for every browser. A failed
poll shows the page as stale instead of stopping. The Gassco, Origo and Gassco Booking
(`--source gbs`) connectors there are worked examples; Origo and GBS need credentials, and
run against mocks until then ([docs/integrations.md](integrations.md)).

## Replay: files

A CSV export becomes a stream: `nora stream new NAME --from file.csv`, then map its
columns in `stream.toml`. See `data/streams/README.md`. `nora live --stream NAME` plays it
as if it were live.

## Showcase: a stream at the current time

To show NORA running, on a laptop or a screen in a meeting room, replay a stream with its
times moved to now:

```bash
nora live --now --stream synthetic-week
```

- The stream's first hour is stamped with the hour the server started in, its next hour
  one step later, and so on, so the app's clock reads the real time. The stream loops for
  ever and the times keep rising across loops.
- Each browser first gets the last 24 hours at once, so trends and the gas day have their
  past, then each hour as the wall clock reaches it. Every frame carries what a replay
  carries: flows, pressures, nominations, H₂S and CO₂, the plan and the hours ahead.
- Pigs and events move with the stream: each loop sends a new `meta` event with that
  loop's pigs and events at their new times.
- `--speed N` plays N seconds of data per real second: `--speed 60` is an hour a minute,
  so pigs and gas quality peaks move visibly. Above 1 the clock runs ahead of the wall
  clock. At real time (the default) the page moves once per data step (an hour).
- Re-timed is not live. Synthetic data stays labelled synthetic, and a recording is
  labelled a recording: the feed's title ends in "(synthetic, re-timed to now)" or
  "(recorded, re-timed to now)".

To share it with others on the same network (office Wi-Fi, a phone on the LAN), bind to
every interface and give them your laptop's address:

```bash
nora live --now --stream synthetic-week --host 0.0.0.0
ipconfig getifaddr en0      # macOS; on Linux: hostname -I
# others open http://<that address>:8765/network.html?live=/stream
```

The page and its feed come from the same server, so the page accepts the feed. Nothing
there takes input from the network: `--now` has no `/ingest`. Your firewall may ask
whether to allow incoming connections; allow them for the session and stop the server
(Ctrl-C) when you are done.
