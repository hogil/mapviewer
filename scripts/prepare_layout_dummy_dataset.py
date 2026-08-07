#!/usr/bin/env python3
"""Create the structured dummy wafer dataset used by the new Layout feature."""

from __future__ import annotations

import argparse
import os
import re
import shutil
from pathlib import Path

from generate_layout_dummy import DEFAULT_PROCESS_ID, generate


DEFAULT_DEVICE = "PW"
DEFAULT_DATE = "20260501"
SOURCE_POSITION_FILES = [
    Path("unknown/CenterDonut/AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.json"),
    Path("unknown/Donut_bank_boundary/AAB185_00P_11_20260501_010000_96.0_4_PE_PWQ.json"),
    Path("unknown/Donut_bank_boundary/AAF027_00P_21_20260501_010000_96.2_4_PE_ENGINEER.json"),
]


def _default_root(name: str, linux_default: str) -> Path:
    if os.name == "nt":
        return Path(os.getenv(name, {"IMAGES_ROOT": "E:/data/images", "POSITIONS_ROOT": "E:/data/positions"}[name]))
    return Path(os.getenv(name, linux_default))


def _validate_component(value: str, length: int, name: str, pattern: str = r"[A-Za-z0-9]+") -> str:
    value = str(value).strip()
    if len(value) != length or not re.fullmatch(pattern, value):
        raise SystemExit(f"{name} must be exactly {length} alphanumeric characters: {value!r}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images-root", type=Path, default=_default_root("IMAGES_ROOT", "/appdata/appuser/images"))
    parser.add_argument("--positions-root", type=Path, default=_default_root("POSITIONS_ROOT", "/appdata/appuser/positions"))
    parser.add_argument("--layout-root", type=Path, default=None)
    parser.add_argument("--device", default=DEFAULT_DEVICE)
    parser.add_argument("--process-id", default=DEFAULT_PROCESS_ID)
    parser.add_argument("--date", default=DEFAULT_DATE)
    args = parser.parse_args()

    images_root = args.images_root.resolve()
    positions_root = args.positions_root.resolve()
    layout_root = (args.layout_root or positions_root.parent / "layout").resolve()
    device = _validate_component(args.device, 2, "device")
    process_id = _validate_component(args.process_id, 4, "process_id")
    date = _validate_component(args.date, 8, "date", r"\d{8}")

    image_target_dir = images_root / device / process_id / date
    positions_target_dir = positions_root / device / process_id / date
    image_target_dir.mkdir(parents=True, exist_ok=True)
    positions_target_dir.mkdir(parents=True, exist_ok=True)

    for position_rel in SOURCE_POSITION_FILES:
        source_position = positions_root / position_rel
        source_image = images_root / position_rel.with_suffix(".png")
        if not source_position.is_file():
            raise SystemExit(f"positions source not found: {source_position}")
        if not source_image.is_file():
            raise SystemExit(f"image source not found: {source_image}")
        shutil.copy2(source_image, image_target_dir / source_image.name)
        shutil.copy2(source_position, positions_target_dir / source_position.name)

    layout_source = positions_root / SOURCE_POSITION_FILES[0]
    layout_file = generate(layout_source, positions_root, layout_root, process_id)
    print(f"images={image_target_dir}")
    print(f"positions={positions_target_dir}")
    print(f"layout={layout_file}")
    print(f"image_count={len(SOURCE_POSITION_FILES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
