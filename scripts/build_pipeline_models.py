"""Seed data/pipeline_models.csv: a Weymouth estimate of each pipeline's regression from
its length and diameter, for the What-if's pressures. Rows from a PMS (any source that is
not this script's estimate) are kept as they are.

    python scripts/build_pipeline_models.py
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from nora.data import load_network  # noqa: E402
from nora.pms import COLUMNS, MODELS_PATH, WEYMOUTH, weymouth  # noqa: E402


def main() -> int:
    net = load_network()
    kept: dict[str, dict] = {}
    if MODELS_PATH.exists():
        with MODELS_PATH.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                if not row["source"].startswith(WEYMOUTH):
                    kept[row["pipeline"]] = row
    rows = []
    for pipe in sorted(net.pipelines, key=lambda p: p.id):
        if pipe.id in kept:
            rows.append(kept[pipe.id])
        elif pipe.length_km and pipe.diameter_in:
            a = weymouth(pipe.length_km, pipe.diameter_in)
            rows.append(
                {
                    "pipeline": pipe.id,
                    "a": f"{a:.4g}",
                    "b": "0",
                    "correction": "1",
                    "source": f"{WEYMOUTH} from {pipe.length_km:g} km and {pipe.diameter_in:g} in"
                    " (E 0.95, G 0.6, 5 °C, Z 0.85); replace with the PMS regression",
                }
            )
    with MODELS_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} pipeline models to {MODELS_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
