"""The `nora` command: validate, analyse, build, serve and replay."""

from __future__ import annotations

import argparse
import contextlib
import functools
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .analysis import analyse
from .config import load_config
from .data import DATA_DIR, DataError, load_network, suggest
from .integrations import CONNECTORS, SOURCES
from .layout import load_flow_layout
from .live import POLL_SECONDS
from .ops import plan_timeline
from .pms import load_pipeline_models
from .site import build_site
from .stream import describe, list_streams, load_stream, scaffold, write_flows
from .units import load_units


def _streams_dir(args) -> Path:
    return args.data / "streams"


def cmd_validate(args) -> int:
    net = load_network(args.data)
    config = load_config()
    unknown = [
        (key, n)
        for key in ("hide", "watch")
        for n in config["flow"][key]
        if n not in net.node_by_id
    ]
    if unknown:
        raise DataError(
            [
                f"nora.toml [flow] {k}: no node {n!r}" + suggest(n, net.node_by_id)
                for k, n in unknown
            ]
        )
    units = load_units(net, args.data / "units.toml")
    load_flow_layout(net, args.data / "flow_layout.toml")
    models = load_pipeline_models(net, args.data / "pipeline_models.csv")
    names = list_streams(_streams_dir(args))
    for name in names:
        load_stream(name, net, _streams_dir(args))
    print(
        f"OK: {len(net.nodes)} nodes, {len(net.pipelines)} pipelines, {len(units)} units, "
        f"{len(models)} pipeline models, {len(names)} stream(s), nora.toml"
    )
    return 0


def cmd_integrations(args) -> int:
    for connector in CONNECTORS:
        print(f"{connector.name:<24} {connector.metric:<18} {connector.status()}")
    return 0


def cmd_stats(args) -> int:
    result = analyse(load_network(args.data))
    print(
        f"{result['assets']} assets, {result['pipelines']} offshore pipelines, "
        f"{result['pipeline_km']:,} km, countries: {', '.join(result['countries'])}"
    )
    deliverable, supply = result["deliverable"], result["supply_capacity"]
    print(f"Deliverable: {deliverable:,.1f} of {supply:,.1f} MSm3/d supply")
    for node, value in sorted(result["delivered"].items(), key=lambda kv: -kv[1]):
        print(f"  {node:<14} {value:8.1f} MSm3/d")
    print("Biggest single points of failure (N-1):")
    for outage in result["outages"][: args.top]:
        print(
            f"  {outage['name']:<36} {outage['kind']:<9} -{outage['lost']:6.1f} MSm3/d "
            f"({outage['share']:.0%})"
        )
    sourced = result["sourced"]
    print(f"Rows with a source: {sourced['rows']} of {sourced['total']}")
    return 0


def _build(args) -> dict:
    """Build the site and print the line every build prints; return the summary."""
    summary = build_site(args.out, args.data)
    print(
        f"Built {summary['out']}/index.html and network.html ({len(summary['streams'])} stream(s))"
    )
    return summary


def cmd_build(args) -> int:
    _build(args)
    return 0


def cmd_serve(args) -> int:
    token = os.environ.get("NORA_EDIT_TOKEN") or None
    if args.edit and args.host != "127.0.0.1" and not token:
        raise DataError(
            [
                "`nora serve --edit` binds to 127.0.0.1 unless NORA_EDIT_TOKEN is set: "
                "hosted, every save must carry that key (serve it over HTTPS)"
            ]
        )
    cmd_build(args)
    if args.edit:
        from .edit import make_handler

        handler = make_handler(args.data, args.out, token)
    else:
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(args.out))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Serving {url} (Ctrl-C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
    return 0


def cmd_live(args) -> int:
    from .live import SharedPoll, serve

    # build_site has already loaded the network and every stream; reuse them
    # instead of loading (and re-solving synthetic streams) a second time.
    summary = _build(args)
    if args.source:
        source = SOURCES[args.source]
        serve(
            args.out,
            meta=source.meta(),
            frames=SharedPoll(source, args.poll_seconds).frames,  # one poller for all readers
            plan=None,
            host=args.host,
            port=args.port,
            open_browser=not args.no_browser,
        )
        return 0
    streams = summary["streams"]
    names = list_streams(_streams_dir(args))
    name = args.stream or (names[0] if names else None)
    if not name:
        raise DataError(["no streams in data/streams; add one with `nora stream new`"])
    stream = next((s for s in streams if s.name == name), None)
    if stream is None:
        # a `--stream` name that is not a stream: let load_stream report it
        stream = load_stream(name, summary["net"], _streams_dir(args))
    serve(
        args.out,
        stream,
        plan=plan_timeline(stream, summary["net"], load_config()),
        host=args.host,
        port=args.port,
        speed=args.speed,
        open_browser=not args.no_browser,
    )
    return 0


def cmd_stream_list(args) -> int:
    for name in list_streams(_streams_dir(args)):
        print(name)
    return 0


def cmd_stream_show(args) -> int:
    net = load_network(args.data)
    print(describe(load_stream(args.name, net, _streams_dir(args)), net))
    return 0


def cmd_stream_new(args) -> int:
    toml_path = scaffold(args.name, args.source, load_network(args.data), _streams_dir(args))
    print(f"Created {toml_path}")
    print(
        "Next: check the [import.assets] mapping, then run "
        f"`nora stream show {args.name}` and `nora build`."
    )
    return 0


def cmd_stream_export(args) -> int:
    stream = load_stream(args.name, load_network(args.data), _streams_dir(args))
    write_flows(stream, args.out)
    print(f"Wrote {args.out} in NORA's flows.csv format")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="nora", description="NORA: Network Operations and Realtime Analysis"
    )
    parser.add_argument(
        "--data",
        type=Path,
        default=DATA_DIR,
        help="folder with nodes.csv, pipelines.csv and streams/",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("validate", help="check the data files and every stream").set_defaults(
        run=cmd_validate
    )
    stats = commands.add_parser("stats", help="what the network delivers and its weak points")
    stats.add_argument("--top", type=int, default=10)
    stats.set_defaults(run=cmd_stats)

    def site_options(sub, port):
        sub.add_argument("--out", type=Path, default=Path("site"), help="output folder")
        if port:
            sub.add_argument("--host", default="127.0.0.1")
            sub.add_argument("--port", type=int, default=port)
            sub.add_argument("--no-browser", action="store_true", help="do not open a browser")

    build = commands.add_parser("build", help="build the site into ./site")
    site_options(build, None)
    build.set_defaults(run=cmd_build)
    serve = commands.add_parser("serve", help="build, then serve the site locally")
    site_options(serve, 8000)
    serve.add_argument(
        "--edit",
        action="store_true",
        help="enable the network editor API (loopback only unless NORA_EDIT_TOKEN is set)",
    )
    serve.set_defaults(run=cmd_serve)
    live = commands.add_parser("live", help="build, then replay a stream as a live feed")
    site_options(live, 8765)
    live.add_argument("--stream", help="stream name (default: the first one)")
    live.add_argument(
        "--source",
        choices=sorted(SOURCES),
        help="poll a live source instead of replaying a stream",
    )
    live.add_argument(
        "--poll-seconds",
        type=float,
        default=POLL_SECONDS,
        help="seconds between polls for --source (default 300, Gassco publishes every 5 min)",
    )
    live.add_argument(
        "--speed",
        type=float,
        default=3600.0,
        help="data seconds per real second (default 3600: an hour a second)",
    )
    live.set_defaults(run=cmd_live)

    commands.add_parser(
        "integrations", help="show the Origo and Gassco Booking connections"
    ).set_defaults(run=cmd_integrations)

    stream = commands.add_parser("stream", help="list, inspect and add stream datasets")
    stream_commands = stream.add_subparsers(dest="stream_command", required=True)
    stream_commands.add_parser("list", help="list streams").set_defaults(run=cmd_stream_list)
    show = stream_commands.add_parser("show", help="summarise what a stream contains")
    show.add_argument("name")
    show.set_defaults(run=cmd_stream_show)
    new = stream_commands.add_parser("new", help="start a stream from a raw CSV file")
    new.add_argument("name", help="folder name, e.g. my-data")
    new.add_argument("--from", dest="source", type=Path, required=True, help="raw CSV file")
    new.set_defaults(run=cmd_stream_new)
    export = stream_commands.add_parser("export", help="write a stream as flows.csv")
    export.add_argument("name")
    export.add_argument("--out", type=Path, default=Path("flows.csv"))
    export.set_defaults(run=cmd_stream_export)

    args = parser.parse_args(argv)
    try:
        return args.run(args)
    except DataError as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
