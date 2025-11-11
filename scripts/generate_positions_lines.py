#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grid line edge detection 기반으로 웨이퍼 팔레트 이미지의 chip positions JSON 생성

사용 예시:
    python scripts/generate_positions_lines.py ^
        --input D:/project/data/wm-811k/palette_5mb ^
        --project-root D:/project/data ^
        --positions-root D:/project/data/position
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple

import cv2
import numpy as np
from PIL import Image

# 큰 이미지도 처리 가능하도록 제한 해제
Image.MAX_IMAGE_PIXELS = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect wafer grid lines and export chip positions JSON.")
    parser.add_argument("--input", required=True,
                        help="단일 PNG 파일 또는 PNG 파일들이 들어있는 디렉터리 경로")
    parser.add_argument("--project-root", default="D:/project/data",
                        help="이미지 경로 기준이 되는 프로젝트 루트 (positions JSON에 상대경로 저장)")
    parser.add_argument("--positions-root", default="D:/project/data/position",
                        help="positions JSON을 저장할 루트 디렉터리")
    parser.add_argument("--pattern", default="*.png",
                        help="디렉터리 입력 시 처리할 파일 패턴 (기본: *.png)")
    parser.add_argument("--min-line-coverage", type=float, default=0.12,
                        help="한 축에서 라인이 있다고 판단할 최소 비율 (default: 0.12)")
    parser.add_argument("--verbose", action="store_true",
                        help="세부 로그 출력")
    return parser.parse_args()


def load_gray_image(image_path: Path) -> np.ndarray:
    img = Image.open(image_path).convert("RGB")
    arr = np.array(img)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    return gray


def detect_grid_lines(gray: np.ndarray,
                      min_line_coverage: float = 0.12) -> Tuple[List[int], List[int]]:
    """Adaptive threshold + morphology로 수직/수평 라인을 검출해 grid edge 좌표를 반환."""
    height, width = gray.shape[:2]

    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    inv = cv2.bitwise_not(blur)
    binary = cv2.adaptiveThreshold(inv, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                   cv2.THRESH_BINARY, 15, -2)

    vertical_kernel_size = max(8, height // 40)
    horizontal_kernel_size = max(8, width // 40)

    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_kernel_size))
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_kernel_size, 1))

    vertical_lines = cv2.erode(binary, vertical_kernel, iterations=1)
    vertical_lines = cv2.dilate(vertical_lines, vertical_kernel, iterations=2)

    horizontal_lines = cv2.erode(binary, horizontal_kernel, iterations=1)
    horizontal_lines = cv2.dilate(horizontal_lines, horizontal_kernel, iterations=2)

    xs = extract_line_positions(vertical_lines, axis=0, length=height, min_ratio=min_line_coverage)
    ys = extract_line_positions(horizontal_lines, axis=1, length=width, min_ratio=min_line_coverage)

    xs = ensure_edge_coverage(xs, width)
    ys = ensure_edge_coverage(ys, height)

    if len(xs) < 2 or len(ys) < 2:
        raise RuntimeError("Grid line detection failed – not enough edges were detected.")

    return xs, ys


def extract_line_positions(mask: np.ndarray,
                           axis: int,
                           length: int,
                           min_ratio: float) -> List[int]:
    """
    axis=0 -> 수직 라인, axis=1 -> 수평 라인.
    mask에서 픽셀 존재 여부를 projection하여 라인 위치를 추출.
    """
    projection = (mask > 0).sum(axis=axis)
    threshold = max(1, int(length * min_ratio))
    candidate_indices = np.where(projection >= threshold)[0]
    return merge_consecutive_indices(candidate_indices.tolist())


def merge_consecutive_indices(indices: Sequence[int], gap: int = 2) -> List[int]:
    if not indices:
        return []
    clusters: List[List[int]] = [[indices[0]]]
    for idx in indices[1:]:
        if idx - clusters[-1][-1] <= gap:
            clusters[-1].append(idx)
        else:
            clusters.append([idx])
    merged = [int(sum(cluster) / len(cluster)) for cluster in clusters]
    return merged


def ensure_edge_coverage(edges: List[int], limit: int) -> List[int]:
    if not edges:
        return [0, limit]
    edges = sorted(set(edges))
    if edges[0] > 0:
        edges.insert(0, 0)
    if edges[-1] < limit:
        edges.append(limit)
    return edges


def build_chip_entries(xs: List[int], ys: List[int],
                       width: int, height: int) -> Tuple[List[dict], int, int]:
    cols = len(xs) - 1
    rows = len(ys) - 1
    cx = width / 2.0
    cy = height / 2.0
    tile_w = np.median(np.diff(xs))
    tile_h = np.median(np.diff(ys))
    radius = min(width, height) / 2.0 - min(tile_w, tile_h) * 0.35

    chips: List[dict] = []
    chip_idx = 0

    for row in range(rows):
        for col in range(cols):
            x0, x1 = xs[col], xs[col + 1]
            y0, y1 = ys[row], ys[row + 1]
            if x1 - x0 <= 1 or y1 - y0 <= 1:
                continue

            center_x = (x0 + x1) / 2.0
            center_y = (y0 + y1) / 2.0
            if (center_x - cx) ** 2 + (center_y - cy) ** 2 > radius ** 2:
                # 웨이퍼 원 외부는 제외
                continue

            x_abs = col - (cols // 2)
            y_abs = (rows // 2) - row  # 위쪽이 +Y가 되도록 반전

            chips.append({
                "x_abs": int(x_abs),
                "y_abs": int(y_abs),
                "b": f"B{chip_idx:04d}",
                "x_cal": int(x_abs),
                "y_cal": int(y_abs),
                "text3": f"{chip_idx:04d}",
                "rect": {
                    "x0": int(x0),
                    "y0": int(y0),
                    "x1": int(x1),
                    "y1": int(y1),
                    "quad": [
                        [int(x0), int(y0)],
                        [int(x1), int(y0)],
                        [int(x1), int(y1)],
                        [int(x0), int(y1)],
                    ]
                }
            })
            chip_idx += 1

    return chips, cols, rows


def drop_first_component(rel_path: Path | None) -> Path | None:
    if rel_path is None:
        return None
    parts = [p for p in rel_path.parts if p not in (".",)]
    if len(parts) <= 1:
        return rel_path if parts else Path(".")
    return Path(*parts[1:])


def build_positions_json(image_path: Path,
                         project_root: Path,
                         xs: List[int],
                         ys: List[int],
                         chips: List[dict],
                         cols: int,
                         rows: int) -> dict:
    now = datetime.now()
    rel_path = try_relative(image_path, project_root)
    rel_trimmed = drop_first_component(rel_path)
    rel_parts = rel_trimmed.parts if rel_trimmed else image_path.parts

    root = rel_parts[0] if rel_parts else "ROOT"
    step = rel_parts[1] if len(rel_parts) > 1 else "STEP"
    wafer_name = image_path.stem

    width = xs[-1]
    height = ys[-1]

    json_obj = {
        "image_path": str(rel_trimmed).replace("\\", "/") if rel_trimmed else (
            str(rel_path).replace("\\", "/") if rel_path else str(image_path)
        ),
        "root": root,
        "step": step,
        "wafer": wafer_name,
        "stime": now.strftime("%Y%m%d_%H%M%S"),
        "day": now.strftime("%Y%m%d"),
        "coord": {
            "rot_code": 5,
            "x_min_abs": int(-(cols // 2)),
            "y_min_abs": int(-(rows // 2)),
            "tiles_w_rot": int(cols),
            "tiles_h_rot": int(rows),
            "grid_edges": {
                "xs": [int(x) for x in xs],
                "ys": [int(y) for y in ys],
            },
            "canvas": {"width": int(width), "height": int(height)},
            "scale": {"sx": 1.0, "sy": 1.0},
            "border": 1,
            "defect_border": 2,
            "center_rule": {"even_x_zero": "left", "even_y_zero": "down"}
        },
        "chips": chips
    }
    return json_obj


def try_relative(path: Path, root: Path) -> Path | None:
    try:
        return path.resolve().relative_to(root.resolve())
    except ValueError:
        return None


def save_positions_json(json_data: dict,
                        image_path: Path,
                        project_root: Path,
                        positions_root: Path) -> Path:
    rel = try_relative(image_path, project_root)
    rel = drop_first_component(rel)
    if rel is None:
        rel = image_path.name
        output_dir = positions_root
    else:
        output_dir = positions_root / rel.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{image_path.stem}_positions.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(json_data, f, ensure_ascii=False, indent=2)
    return output_path


def process_image(image_path: Path,
                  project_root: Path,
                  positions_root: Path,
                  min_line_coverage: float,
                  verbose: bool) -> None:
    if verbose:
        print(f"[INFO] Processing {image_path}")
    gray = load_gray_image(image_path)
    xs, ys = detect_grid_lines(gray, min_line_coverage=min_line_coverage)
    chips, cols, rows = build_chip_entries(xs, ys, gray.shape[1], gray.shape[0])

    if verbose:
        print(f"  - detected edges: {len(xs)} vertical, {len(ys)} horizontal")
        print(f"  - chips inside wafer: {len(chips)}")

    json_data = build_positions_json(image_path, project_root, xs, ys, chips, cols, rows)
    output_path = save_positions_json(json_data, image_path, project_root, positions_root)
    print(f"[OK] {image_path.name}: {len(chips)} chips → {output_path}")


def collect_images(input_path: Path, pattern: str) -> List[Path]:
    if input_path.is_file():
        return [input_path]
    return sorted(input_path.rglob(pattern))


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    project_root = Path(args.project_root)
    positions_root = Path(args.positions_root)

    images = collect_images(input_path, args.pattern)
    if not images:
        raise SystemExit(f"No images matching pattern under {input_path}")

    for image_path in images:
        try:
            process_image(image_path, project_root, positions_root,
                          min_line_coverage=args.min_line_coverage,
                          verbose=args.verbose)
        except Exception as exc:
            print(f"[ERROR] {image_path}: {exc}")


if __name__ == "__main__":
    main()
