"""Settings from nora.toml: display defaults, alarm thresholds, pressure windows, colours.

Every key has a default here, so nora.toml only needs what a project wants to change.
Mistakes are reported like data problems, all at once and with a suggestion.
"""

from __future__ import annotations

import copy
import re
import tomllib
from pathlib import Path

from .data import NODE_TYPES, REPO_ROOT, DataError, suggest

CONFIG_PATH = REPO_ROOT / "nora.toml"

DEFAULTS: dict = {
    "screen": {
        "start": "overview",
        "network_view": "map",
        "network_mode": "live",
        "theme": "light",
        "autoplay": True,
        "speed": 600,  # default playback: data seconds per real second
        "now_speed": 600,  # data re-timed to now opens at 10 min/s too (Ray, 29 Oct)
        "now_in_middle": True,  # synthetic streams: the wall-clock now sits mid-timeline
        "display": "auto",  # auto (from the window), desk, wall or compact
        "wall_distance_m": 5.0,  # a video wall is read from this far
        "wall_width_m": 4.0,  # and its picture is this wide
    },
    "labels": {
        "names": True,
        "line_values": "auto",
        "pack": True,  # a line's line-pack change under its settle-out pressure
        "pressure_change": True,  # the last hour's change under a pressure tag's number
        "temperature": True,  # the outside temperature under an onshore site's name
    },
    "markers": {"pigs": True, "gas_quality": True},  # what moves along the lines
    "assets": {"hide": [], "grid_entries": True},
    "flow": {
        "direction": "vertical",
        "density": "comfortable",
        "animation": True,
        "hide": [],
        "watch": [],
    },
    # The blending stations drawn as one picture on their asset pages (nora.toml
    # [blending]); node ids, checked by `nora validate`.
    "blending": {"stations": []},
    "thresholds": {
        "load": [1.01, 1.05, 1.10],
        "nomination": [0.03, 0.06, 0.10],
        "booking": [0.95, 1.0, 1.05],
        "pressure_margin": [0.10, 0.05, 0.0],
        "step": [0.15, 0.25, 0.40],
        "pack_high": 0.20,
        "plan_lookahead_hours": 6,
        "gas_day_start_utc": 5,
    },
    "pipelines": {"gas_velocity_mps": 8.0, "step_min": 0.10, "peak_max": 5},
    "money": {"gcv_kwh_per_sm3": 11.0, "currency": "NOK", "prices": "data/prices.json"},
    "quality": {"h2s_ppm": [2.5, 3.0, 3.3], "co2_molpct": [2.2, 2.35, 2.5], "follow_from": 0.8},
    "pressure": {
        "field": [100, 175],
        "hub": [100, 170],
        "processing": [100, 165],
        "terminal": [55, 85],
        "lng": [60, 90],
        "storage": [50, 150],
        "market": [45, 80],
    },
    # Limits by asset type, [low-low, low, high, high-high, integrity] in bar: a pressure's
    # number turns yellow at low or high, red at low-low or high-high and dark red at the
    # integrity limit (Ray, 29 Oct).
    "pressure_limits": {
        "field": [110, 118, 160, 168, 175],
        "hub": [110, 118, 157, 163, 170],
        "processing": [110, 118, 152, 158, 165],
        "terminal": [57, 60, 76, 80, 85],
        "lng": [62, 66, 82, 86, 90],
        "storage": [55, 65, 135, 142, 150],
        "market": [48, 52, 70, 75, 80],
    },
    "colors": {
        "paper": "#c6c9cc",
        "dots": "#b4b8bc",
        "water": "#b4b8bc",
        "panel": "#d4d7d9",
        "inactive": "#6b7177",
        "normal": "#dfe2e4",
        "active": "#f1f2f3",
        "text": "#22272b",
        "text_dim": "#50575d",
        "warning": "#ffbf00",
        "medium": "#ff7a1a",
        "critical": "#e5322d",
        "integrity": "#8e1b1b",  # dark red: a pressure at its integrity limit
        "h2s": "#8a7616",
        "co2": "#93463e",
        "pig": "#5e4b31",  # dark umber: a pig creeping along the line; its label reads on the paper
        "peak": "#5f6d7a",  # neutral grey-blue: nominations in the next-6-hours chart
    },
    "colors_dark": {
        "paper": "#2a2e32",
        "dots": "#363b40",
        "water": "#212528",
        "panel": "#32373c",
        "inactive": "#4c5258",
        "normal": "#8c949b",
        "active": "#d5d9dc",
        "text": "#e1e4e6",
        "text_dim": "#9aa1a7",
        "warning": "#ffbf00",
        "medium": "#ff7a1a",
        "critical": "#ff4d47",
        "integrity": "#b0242a",
        "h2s": "#d2bd5c",
        "co2": "#d48c83",
        "pig": "#c4ae91",
        "peak": "#9fb1c1",
    },
    "map": {
        "style": "https://tiles.openfreemap.org/styles/positron",
        "bounds": [[-3.5, 50.2], [15.5, 67.4]],
    },
}

CHOICES = {
    ("screen", "start"): ("overview", "network"),
    ("screen", "network_view"): ("map", "flow"),
    ("money", "currency"): ("NOK", "USD"),
    ("screen", "network_mode"): ("live", "load", "risk", "plain"),
    ("screen", "theme"): ("light", "dark", "auto"),
    ("screen", "speed"): (1, 60, 120, 300, 600, 1800),
    ("screen", "now_speed"): (1, 60, 120, 300, 600, 1800),
    ("screen", "display"): ("auto", "desk", "wall", "compact"),
    ("labels", "line_values"): ("auto", "on", "off"),
    ("flow", "direction"): ("auto", "horizontal", "vertical"),
    ("flow", "density"): ("compact", "comfortable", "spacious"),
}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def load_config(path: Path = CONFIG_PATH) -> dict:
    """Defaults merged with nora.toml (if present), checked; raises DataError."""
    config = copy.deepcopy(DEFAULTS)
    path = Path(path)
    if not path.exists():
        return config
    try:
        given = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise DataError([f"{path.name}: {error}"]) from None
    problems: list[str] = []
    for section, values in given.items():
        if section not in DEFAULTS:
            problems.append(
                f"{path.name}: unknown section [{section}]" + suggest(section, DEFAULTS)
            )
            continue
        if not isinstance(values, dict):
            problems.append(f"{path.name}: [{section}] must be a table")
            continue
        for key, value in values.items():
            where = f"{path.name} [{section}] {key}"
            if section not in ("pressure", "pressure_limits") and key not in DEFAULTS[section]:
                problems.append(
                    f"{path.name}: unknown key {key} in [{section}]"
                    + suggest(key, DEFAULTS[section])
                )
                continue
            problem = _check(section, key, value)
            if problem:
                problems.append(f"{where}: {problem}")
            else:
                config[section][key] = value
    if problems:
        raise DataError(problems)
    return config


def _check(section: str, key: str, value) -> str | None:
    default = DEFAULTS[section].get(key)
    if (section, key) in CHOICES:
        options = CHOICES[(section, key)]
        return None if value in options else f"must be one of {', '.join(options)}"
    if section in ("colors", "colors_dark"):
        return (
            None
            if isinstance(value, str) and _HEX.match(value)
            else "must be a colour like #9aa1a8"
        )
    if section == "pressure":
        if key not in NODE_TYPES:
            return "is not an asset type" + suggest(key, NODE_TYPES)
        ok = (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(v, int | float) for v in value)
        )
        return None if ok and value[0] < value[1] else "must be [min, max] in bar, min below max"
    if section == "pressure_limits":
        if key not in NODE_TYPES:
            return "is not an asset type" + suggest(key, NODE_TYPES)
        ok = (
            isinstance(value, list)
            and len(value) == 5
            and all(isinstance(v, int | float) for v in value)
            and all(a <= b for a, b in zip(value, value[1:], strict=False))
        )
        return None if ok else "must be [low-low, low, high, high-high, integrity] in bar, rising"
    if section in ("thresholds", "quality") and isinstance(default, list):
        ok = (
            isinstance(value, list)
            and len(value) == 3
            and all(isinstance(v, int | float) for v in value)
        )
        if not ok:
            return "must be three numbers: [warning, medium, critical]"
        rising = key != "pressure_margin"
        ordered = value[0] <= value[1] <= value[2] if rising else value[0] >= value[1] >= value[2]
        return None if ordered else "must run from warning to critical"
    if section == "assets" and key == "hide":
        bad = [t for t in value if t not in NODE_TYPES] if isinstance(value, list) else ["?"]
        return None if not bad else f"unknown asset type(s) {bad}"
    if section == "flow" and key in ("hide", "watch"):  # node ids; `nora validate` checks them
        ok = isinstance(value, list) and all(isinstance(v, str) for v in value)
        return None if ok else "must be a list of node ids"
    if section == "blending" and key == "stations":  # node ids; `nora validate` checks them
        ok = isinstance(value, list) and all(isinstance(v, str) for v in value)
        return None if ok else "must be a list of node ids"
    if section == "screen" and key in ("wall_distance_m", "wall_width_m"):
        ok = isinstance(value, int | float) and not isinstance(value, bool) and value > 0
        return None if ok else "must be a number of metres above 0"
    if isinstance(default, bool):
        return None if isinstance(value, bool) else "must be true or false"
    if isinstance(default, int | float):
        return None if isinstance(value, int | float) and value >= 0 else "must be a number"
    if isinstance(default, str):
        return None if isinstance(value, str) else "must be text"
    return None
