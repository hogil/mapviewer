#!/usr/bin/env python3
"""
wafer_palette_5mb.png 샘플 이미지와 chip positions/annotations JSON을 생성합니다.

기본 경로
 - 이미지: ./wafer/images
 - 칩 메타/라벨: D:/project/data/position
"""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from datetime import datetime, UTC
from pathlib import Path
from typing import List, Tuple

from PIL import Image, ImageDraw

PALETTE = [
    "#f6a6d8", "#a0c4ff", "#bdb2ff", "#caffbf",
    "#ffd6a5", "#fdffb6", "#c9c9c9", "#9bf6ff",
    "#ffc6ff", "#ffadad", "#d0d0d0",
]

BIN_CODES = ["B001", "B002", "B101", "B201", "B285", "B286", "B287", "B288"]
CLASSES = ["defect_edge_loc", "defect_particle", "defect_scratch", "good_chip"]


@dataclass
class ChipRect:
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def quad(self) -> List[List[int]]:
        return [
            [self.x0, self.y0],
            [self.x1, self.y0],
            [self.x1, self.y1],
            [self.x0, self.y1],
        ]


def hex_to_rgb(value: str) -> Tuple[int, int, int]:
    value = value.lstrip("#")
    lv = len(value)
    return tuple(int(value[i:i + lv // 3], 16) for i in range(0, lv, lv // 3))


def jitter(value: int, delta: int = 18) -> int:
    return max(0, min(255, value + random.randint(-delta, delta)))


def draw_chip(draw: ImageDraw.ImageDraw, rect: ChipRect, fill: Tuple[int, int, int]) -> None:
    margin = max(2, (rect.x1 - rect.x0) // 12)
    inner = (
        rect.x0 + margin, rect.y0 + margin,
        rect.x1 - margin, rect.y1 - margin,
    )
    draw.rectangle(inner, fill=fill)
    for _ in range(12):
        x = random.randint(inner[0], inner[2] - 1)
        y = random.randint(inner[1], inner[3] - 1)
        noise = (jitter(fill[0], 12), jitter(fill[1], 12), jitter(fill[2], 12))
        draw.point((x, y), fill=noise)


def generate(args: argparse.Namespace) -> None:
    random.seed(args.seed)

    image_dir = args.images_root / args.line / args.process / args.day
    position_dir = args.positions_root / args.line / args.process / args.day
    annotation_dir = args.annotations_root / args.line / args.process / args.day
    for directory in (image_dir, position_dir, annotation_dir):
        directory.mkdir(parents=True, exist_ok=True)

    image_path = image_dir / f"{args.name}.png"
    positions_path = position_dir / f"{args.name}.json"
    annotations_path = annotation_dir / f"{args.name}_chips.json"

    img = Image.new("RGB", (args.size, args.size), "#ffffff")
    draw = ImageDraw.Draw(img)
    cell = args.size // args.grid
    radius = args.size * 0.48
    center = args.size / 2.0

    chips = []
    chip_counter = 0
    for row in range(args.grid):
        for col in range(args.grid):
            x0 = col * cell
            y0 = row * cell
            rect = ChipRect(x0, y0, x0 + cell, y0 + cell)
            cx = x0 + cell / 2.0
            cy = y0 + cell / 2.0
            if math.hypot(cx - center, cy - center) > radius:
                continue
            chip_counter += 1
            base = hex_to_rgb(random.choice(PALETTE))
            draw_chip(draw, rect, base)
            bin_code = random.choice(BIN_CODES)
            chips.append({
                "chip_id": f"chip_{chip_counter:04d}",
                "row": row,
                "col": col,
                "x_abs": col - args.grid // 2,
                "y_abs": row - args.grid // 2,
                "b": bin_code,
                "rect": {
                    "x0": rect.x0, "y0": rect.y0,
                    "x1": rect.x1, "y1": rect.y1,
                    "quad": rect.quad,
                },
            })

    # grid lines
    for idx in range(args.grid + 1):
        offset = idx * cell
        draw.line([(offset, 0), (offset, args.size)], fill="#ececec", width=2)
        draw.line([(0, offset), (args.size, offset)], fill="#ececec", width=2)

    img.save(image_path, optimize=True, compress_level=5)

    now = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    grid_edges = {
        "xs": [i * cell for i in range(args.grid + 1)],
        "ys": [i * cell for i in range(args.grid + 1)],
    }
    positions_payload = {
        "image_path": str(image_path),
        "root": args.line,
        "step": args.process,
        "wafer": args.name,
        "stime": now,
        "day": args.day,
        "coord": {
            "rot_code": 5,
            "tiles_w_rot": args.grid,
            "tiles_h_rot": args.grid,
            "grid_edges": grid_edges,
            "canvas": {"width": args.size, "height": args.size},
            "scale": {"sx": 1.0, "sy": 1.0},
            "border": 1,
            "defect_border": 2,
            "center_rule": {"even_x_zero": "left", "even_y_zero": "down"},
        },
        "chips": chips,
    }
    positions_path.write_text(json.dumps(positions_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    class_counts = {}
    marked = []
    for idx, chip in enumerate(chips[:20]):
        rect = chip["rect"]
        cls = CLASSES[idx % len(CLASSES)]
        class_counts[cls] = class_counts.get(cls, 0) + 1
        marked.append({
            "chip_id": chip["chip_id"],
            "x_abs": chip["x_abs"],
            "y_abs": chip["y_abs"],
            "row": chip["row"],
            "col": chip["col"],
            "class": cls,
            "bbox": rect,
        })

    annotations_payload = {
        "image_path": str(image_path),
        "positions_ref": str(positions_path),
        "metadata": {
            "created_at": now,
            "created_by": "demo.user",
            "last_modified": now,
            "last_modified_by": "demo.user",
            "status": "draft",
            "total_marked_chips": len(marked),
            "defect_chips": sum(1 for m in marked if not m["class"].startswith("good")),
            "good_chips": sum(1 for m in marked if m["class"].startswith("good")),
        },
        "marked_chips": marked,
        "class_distribution": class_counts,
    }
    annotations_path.write_text(json.dumps(annotations_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[OK] Generated sample wafer -> {image_path}")
    print(f"     positions JSON      -> {positions_path}")
    print(f"     annotations JSON    -> {annotations_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate wafer_palette_5mb sample assets")
    parser.add_argument("--images-root", type=Path, default=Path("wafer/images"))
    parser.add_argument("--positions-root", type=Path, default=Path("D:/project/data/position"))
    parser.add_argument("--annotations-root", type=Path, default=Path("D:/project/data/position"))
    parser.add_argument("--line", default="LINE1")
    parser.add_argument("--process", default="PALETTE")
    parser.add_argument("--day", default="20250108")
    parser.add_argument("--name", default="wafer_palette_5mb")
    parser.add_argument("--size", type=int, default=7788)
    parser.add_argument("--grid", type=int, default=66)
    parser.add_argument("--seed", type=int, default=2025)
    return parser.parse_args()


if __name__ == "__main__":
    generate(parse_args())
