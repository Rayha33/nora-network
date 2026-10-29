"""Pipeline models for the What-if: one regression per pipeline, as a pipeline modelling
system (PMS) keeps them. Ray, 29 Oct: the what-if "uses pipeline-specific regression
formulas and correction factor to estimate pressures and the flow of gas stored in each
pipeline".

    p_in² − p_out² = correction × (a × Q² + b × Q)

with the pressures absolute (bar a) and Q in MSm³/d. data/pipeline_models.csv holds a, b
and a correction for each pipeline. scripts/build_pipeline_models.py seeds `a` from the
Weymouth equation (length and diameter) until the PMS regressions replace them; it keeps
any row whose source is not its own estimate.
"""

from __future__ import annotations

from pathlib import Path

from .data import DATA_DIR, DataError, Network, read_rows, suggest

MODELS_PATH = DATA_DIR / "pipeline_models.csv"
COLUMNS = ("pipeline", "a", "b", "correction", "source")
WEYMOUTH = "Weymouth estimate"


def weymouth(
    length_km: float,
    diameter_in: float,
    *,
    efficiency: float = 0.95,
    gravity: float = 0.6,
    flowing_k: float = 278.15,  # 5 °C on the seabed
    z: float = 0.85,
) -> float:
    """`a` in bar² per (MSm³/d)² from the Weymouth equation (SI form, Menon):
    Q = 3.7435e-3 E (Tb/Pb) √((P1² − P2²) / (G Tf L Z)) D^2.667, Q m³/d, P kPa, D mm,
    L km; at 15 °C and 1.01325 bar."""
    base = 3.7435e-3 * efficiency * (288.15 / 101.325) * (diameter_in * 25.4) ** 2.667
    return (1e6 / base) ** 2 * gravity * flowing_k * length_km * z / 1e4


def load_pipeline_models(net: Network, path: Path = MODELS_PATH) -> dict[str, dict]:
    """{pipeline: {a, b, correction, source}}; a missing file means no models. Raises
    DataError listing every problem, with file and line."""
    path = Path(path)
    if not path.exists():
        return {}
    pipelines = {p.id for p in net.pipelines}
    problems: list[str] = []
    models: dict[str, dict] = {}
    for row in read_rows(path, COLUMNS, problems):
        pid = row.text("pipeline", required=True)
        if pid and pid not in pipelines:
            row.problem(f"no pipeline '{pid}' in pipelines.csv" + suggest(pid, pipelines))
            continue
        if pid in models:
            row.problem(f"'{pid}' has a model already")
            continue
        a = row.number("a", required=True, low=0)
        b = row.number("b")
        correction = row.number("correction", low=0.05, high=20)
        if pid and a is not None:
            models[pid] = {
                "a": a,
                "b": b or 0.0,
                "correction": 1.0 if correction is None else correction,
                "source": row.text("source"),
            }
    if problems:
        raise DataError(problems)
    return models
