#!/usr/bin/env python3
"""Generate deterministic process-level dummy wafer-layout Parquet data.

The generated layout is keyed by a four-character process_id and uses
micrometres with the wafer centre as the origin.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Any


LAYOUT_COLUMNS = [
    "process_id",
    "shot_id",
    "chip_id",
    "shot_x_pos",
    "shot_y_pos",
    "full_shot_type",
    "chip_x_pos",
    "chip_y_pos",
    "chip_center_x_pos",
    "chip_center_y_pos",
    "zone_id",
    "zone_type",
]
LAYOUT_FILENAME = "layout.parquet"

DEFAULT_SOURCE = (
    "unknown/CenterDonut/"
    "AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.json"
)
DEFAULT_PROCESS_ID = "P001"
WAFER_RADIUS_UM = 150_000.0
CHIP_PITCH_UM = 5_000
# Keep dummy shots small enough to make the shot boundaries visible.
SHOT_WIDTH = 4
SHOT_HEIGHT = 6


def _circle_zone(radius_um: float) -> tuple[str, str]:
    """Return deterministic dummy circle bands for the layout fixture.

    The production zone boundaries are not defined by this fixture yet. These
    bands keep all four requested circle IDs represented without changing the
    existing chip/shot coordinate contract.
    """
    if radius_um <= 10_000:
        return "C20", "circle"
    if radius_um <= 40_000:
        return "C80", "circle"
    if radius_um <= 80_000:
        return "E1", "circle"
    return "E20", "circle"


def _default_positions_root() -> Path:
    if os.name == "nt":
        return Path(os.getenv("POSITIONS_ROOT", "E:/data/positions"))
    return Path(os.getenv("POSITIONS_ROOT", "/appdata/appuser/positions"))


def _default_layout_root(positions_root: Path) -> Path:
    return Path(os.getenv("LAYOUT_ROOT", str(positions_root.parent / "layout")))


def _int_value(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    number = int(value)
    if str(value).strip() != str(number):
        raise ValueError(f"{field} must be an integer: {value!r}")
    return number


def _validate_process_id(value: str) -> str:
    process_id = str(value).strip()
    if len(process_id) != 4 or not process_id.isalnum():
        raise ValueError(f"process_id must be exactly four alphanumeric characters: {value!r}")
    return process_id


def _load_chips(source: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    with source.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    chips = payload.get("chips")
    if not isinstance(chips, list) or not chips:
        raise ValueError(f"positions file has no chips: {source}")
    return payload, chips


def _grid_dimensions(payload: dict[str, Any], chips: list[dict[str, Any]]) -> tuple[int, int]:
    coord = payload.get("coord") or {}
    edges = coord.get("grid_edges") or {}
    xs = edges.get("xs") or []
    ys = edges.get("ys") or []
    if len(xs) >= 2 and len(ys) >= 2:
        return len(xs) - 1, len(ys) - 1
    return (
        max(_int_value(chip.get("x_abs", 0), "x_abs") for chip in chips) + 1,
        max(_int_value(chip.get("y_abs", 0), "y_abs") for chip in chips) + 1,
    )


def _build_rows(
    payload: dict[str, Any], chips: list[dict[str, Any]], process_id: str
) -> list[dict[str, Any]]:
    grid_width, grid_height = _grid_dimensions(payload, chips)
    shot_columns = math.ceil(grid_width / SHOT_WIDTH)
    shot_rows = math.ceil(grid_height / SHOT_HEIGHT)
    grouped: dict[tuple[int, int], int] = {}
    for chip in chips:
        x_abs = _int_value(chip.get("x_abs"), "x_abs")
        y_abs = _int_value(chip.get("y_abs"), "y_abs")
        key = (x_abs // SHOT_WIDTH, y_abs // SHOT_HEIGHT)
        grouped[key] = grouped.get(key, 0) + 1

    rows: list[dict[str, Any]] = []
    for chip_index, chip in enumerate(chips, start=1):
        x_abs = _int_value(chip.get("x_abs"), "x_abs")
        y_abs = _int_value(chip.get("y_abs"), "y_abs")
        shot_column = x_abs // SHOT_WIDTH
        shot_row = y_abs // SHOT_HEIGHT
        shot_id = shot_row * shot_columns + shot_column + 1
        # shot_x_pos/shot_y_pos are signed shot order positions around the
        # wafer center, not physical micrometre coordinates.
        shot_x_order = shot_column - shot_columns // 2
        shot_y_order = shot_rows // 2 - shot_row

        # Synthetic physical layout: 32x32 logical cells at a 5 mm pitch,
        # centred on the wafer. The source positions provide the chip mask.
        chip_x = (x_abs - (grid_width - 1) / 2) * CHIP_PITCH_UM
        chip_y = ((grid_height - 1) / 2 - y_abs) * CHIP_PITCH_UM
        radius = math.hypot(chip_x, chip_y)
        if radius > WAFER_RADIUS_UM:
            raise ValueError(
                f"chip {chip_index} is outside 300 mm wafer: "
                f"({chip_x}, {chip_y}) radius={radius}"
            )
        zone_id, zone_type = _circle_zone(radius)

        expected_shot_chips = min(SHOT_WIDTH, grid_width - shot_column * SHOT_WIDTH) * min(
            SHOT_HEIGHT, grid_height - shot_row * SHOT_HEIGHT
        )
        full_shot_type = "FULL" if grouped[(shot_column, shot_row)] == expected_shot_chips else "PARTIAL"
        rows.append(
            {
                "process_id": process_id,
                "shot_id": shot_id,
                "chip_id": chip_index,
                "shot_x_pos": shot_x_order,
                "shot_y_pos": shot_y_order,
                "full_shot_type": full_shot_type,
                # The viewer's positions x_abs/y_abs are the chip matching key.
                # Keep the key in the same integer coordinate system so the
                # layout row can be matched directly while hovering a chip.
                "chip_x_pos": x_abs,
                "chip_y_pos": y_abs,
                "chip_center_x_pos": round(chip_x, 3),
                "chip_center_y_pos": round(chip_y, 3),
                "zone_id": zone_id,
                "zone_type": zone_type,
            }
        )
    return rows


def _write_layout_parquet(target: Path, rows: list[dict[str, Any]]) -> None:
    try:
        import pyarrow as pa
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise RuntimeError("layout.parquet 생성에는 pyarrow가 필요합니다.") from exc

    schema = pa.schema([
        pa.field("process_id", pa.string()),
        pa.field("shot_id", pa.int64()),
        pa.field("chip_id", pa.int64()),
        pa.field("shot_x_pos", pa.int64()),
        pa.field("shot_y_pos", pa.int64()),
        pa.field("full_shot_type", pa.string()),
        pa.field("chip_x_pos", pa.int64()),
        pa.field("chip_y_pos", pa.int64()),
        pa.field("chip_center_x_pos", pa.float64()),
        pa.field("chip_center_y_pos", pa.float64()),
        pa.field("zone_id", pa.string()),
        pa.field("zone_type", pa.string()),
    ])
    table = pa.Table.from_pylist(rows, schema=schema)
    parquet.write_table(table, target, compression="zstd")


def generate(
    source: Path,
    positions_root: Path,
    layout_root: Path,
    process_id: str = DEFAULT_PROCESS_ID,
) -> Path:
    process_id = _validate_process_id(process_id)
    payload, chips = _load_chips(source)
    rows = _build_rows(payload, chips, process_id)
    target = layout_root / LAYOUT_FILENAME
    target.parent.mkdir(parents=True, exist_ok=True)
    _write_layout_parquet(target, rows)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--positions-root",
        type=Path,
        default=_default_positions_root(),
    )
    parser.add_argument(
        "--layout-root",
        type=Path,
        default=None,
    )
    parser.add_argument("--process-id", default=DEFAULT_PROCESS_ID)
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    args = parser.parse_args()

    positions_root = args.positions_root.resolve()
    layout_root = (args.layout_root or _default_layout_root(positions_root)).resolve()
    source = (positions_root / args.source).resolve()
    if not source.is_file():
        raise SystemExit(f"positions source not found: {source}")
    if positions_root not in source.parents:
        raise SystemExit(f"source must be under positions root: {source}")

    try:
        process_id = _validate_process_id(args.process_id)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    target = generate(source, positions_root, layout_root, process_id)
    import pyarrow.parquet as parquet
    row_count = parquet.read_metadata(target).num_rows
    print(f"generated={target}")
    print(f"process_id={process_id}")
    print(f"rows={row_count}")
    print(f"wafer_radius_um={WAFER_RADIUS_UM:.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
