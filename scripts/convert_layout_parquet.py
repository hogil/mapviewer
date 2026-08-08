#!/usr/bin/env python3
"""Convert an existing CSV-format layout file to the runtime Parquet format."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Any

from generate_layout_dummy import LAYOUT_COLUMNS, _write_layout_parquet


INT_COLUMNS = {
    "shot_id",
    "chip_id",
    "shot_x_pos",
    "shot_y_pos",
    "chip_x_pos",
    "chip_y_pos",
}
FLOAT_COLUMNS = {"chip_center_x_pos", "chip_center_y_pos"}


def _value_text(row: dict[str, Any], column: str) -> str:
    value = row.get(column)
    return "" if value is None else str(value).strip()


def convert(source: Path, target: Path) -> int:
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = set(reader.fieldnames or ())
        missing = [column for column in LAYOUT_COLUMNS if column not in fieldnames]
        if missing:
            raise ValueError(f"layout header missing columns: {missing}")

        rows: list[dict[str, Any]] = []
        for row_number, row in enumerate(reader, start=2):
            try:
                normalized: dict[str, Any] = {}
                for column in LAYOUT_COLUMNS:
                    value = _value_text(row, column)
                    if column in INT_COLUMNS:
                        normalized[column] = int(value)
                    elif column in FLOAT_COLUMNS:
                        normalized[column] = float(value)
                    else:
                        normalized[column] = value
                rows.append(normalized)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid layout row {row_number}: {exc}") from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    _write_layout_parquet(target, rows)
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    source = args.input.resolve()
    target = (args.output or source.with_suffix(".parquet")).resolve()
    if not source.is_file():
        raise SystemExit(f"input layout file not found: {source}")
    try:
        row_count = convert(source, target)
    except (OSError, ValueError, RuntimeError) as exc:
        raise SystemExit(str(exc)) from exc
    print(f"converted={target}")
    print(f"rows={row_count}")
    print(f"source_bytes={source.stat().st_size}")
    print(f"target_bytes={target.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
