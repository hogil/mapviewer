#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Wafer 이미지에서 chip positions 감지 및 JSON 생성
Grid line detection + 원형 wafer mask 적용
"""

import os
import sys
import json
from pathlib import Path
from PIL import Image
import numpy as np
import cv2
from datetime import datetime
from typing import List, Tuple, Optional


def detect_wafer_circle(gray: np.ndarray) -> Optional[Tuple[int, int, int]]:
    """
    Wafer의 원형 영역 감지 (HoughCircles)
    Returns: (center_x, center_y, radius) or None
    """
    # Blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)

    # Detect circles
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1,
        minDist=gray.shape[0] // 2,  # 최소 거리 = 이미지 높이의 절반
        param1=50,
        param2=30,
        minRadius=min(gray.shape) // 4,
        maxRadius=max(gray.shape) // 2
    )

    if circles is not None:
        circles = np.uint16(np.around(circles))
        # 가장 큰 원 선택
        largest = max(circles[0, :], key=lambda c: c[2])
        return int(largest[0]), int(largest[1]), int(largest[2])

    return None


def detect_grid_lines(gray: np.ndarray, mask: Optional[np.ndarray] = None) -> Tuple[List[int], List[int]]:
    """
    Grid 라인 감지 (Hough Line Transform)
    Returns: (vertical_lines, horizontal_lines)
    """
    # Edge detection
    edges = cv2.Canny(gray, 30, 100, apertureSize=3)

    # Mask 적용
    if mask is not None:
        edges = cv2.bitwise_and(edges, mask)

    # Hough Line Transform
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi/180,
        threshold=80,
        minLineLength=50,
        maxLineGap=15
    )

    if lines is None:
        print("⚠️ Grid 라인을 찾을 수 없습니다!")
        return [], []

    vertical_lines = []
    horizontal_lines = []

    for line in lines:
        x1, y1, x2, y2 = line[0]

        # 각도 계산
        angle = np.abs(np.arctan2(y2 - y1, x2 - x1) * 180 / np.pi)

        # 수평선 (각도가 0도에 가까움)
        if angle < 10 or angle > 170:
            horizontal_lines.append((y1 + y2) // 2)
        # 수직선 (각도가 90도에 가까움)
        elif 80 < angle < 100:
            vertical_lines.append((x1 + x2) // 2)

    # 중복 제거 및 정렬
    vertical_lines = sorted(list(set(vertical_lines)))
    horizontal_lines = sorted(list(set(horizontal_lines)))

    # 비슷한 위치의 라인 병합
    def merge_close_lines(lines: List[int], threshold: int = 3) -> List[int]:
        if not lines:
            return []
        merged = [lines[0]]
        for line in lines[1:]:
            if line - merged[-1] > threshold:
                merged.append(line)
            else:
                # 평균값으로 대체
                merged[-1] = (merged[-1] + line) // 2
        return merged

    vertical_lines = merge_close_lines(vertical_lines)
    horizontal_lines = merge_close_lines(horizontal_lines)

    return vertical_lines, horizontal_lines


def is_point_in_circle(x: int, y: int, cx: int, cy: int, radius: int) -> bool:
    """점이 원 안에 있는지 확인"""
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def detect_chips_from_grid(
    img_array: np.ndarray,
    vertical_lines: List[int],
    horizontal_lines: List[int],
    wafer_circle: Optional[Tuple[int, int, int]] = None
) -> List[dict]:
    """
    Grid에서 chip 감지
    """
    chips = []
    chip_idx = 0

    height, width = img_array.shape[:2]

    # Wafer circle 정보
    if wafer_circle:
        cx, cy, radius = wafer_circle
    else:
        cx, cy, radius = width // 2, height // 2, max(width, height)

    # 각 grid cell 검사
    for i in range(len(vertical_lines) - 1):
        for j in range(len(horizontal_lines) - 1):
            x0 = vertical_lines[i]
            x1 = vertical_lines[i + 1]
            y0 = horizontal_lines[j]
            y1 = horizontal_lines[j + 1]

            # Cell 중심점
            cell_center_x = (x0 + x1) // 2
            cell_center_y = (y0 + y1) // 2

            # Wafer 원형 영역 밖이면 skip
            if not is_point_in_circle(cell_center_x, cell_center_y, cx, cy, radius):
                continue

            # Cell 내부 영역 추출
            cell = img_array[y0:y1, x0:x1]

            if cell.size == 0:
                continue

            # 셀의 평균 밝기 계산
            if len(cell.shape) == 3:
                cell_gray = cv2.cvtColor(cell, cv2.COLOR_RGB2GRAY)
            else:
                cell_gray = cell

            mean_brightness = np.mean(cell_gray)

            # 흰색이 아니면 (밝기 < 250) chip이 있음
            # Border 라인을 고려하여 threshold를 높임
            if mean_brightness < 250:
                # Grid 기준 절대 좌표 계산
                x_abs = i - len(vertical_lines) // 2
                y_abs = j - len(horizontal_lines) // 2

                chip_info = {
                    "x_abs": int(x_abs),
                    "y_abs": int(y_abs),
                    "b": f"B{chip_idx:03d}",
                    "x_cal": int(x_abs),
                    "y_cal": int(y_abs),
                    "text3": f"{chip_idx:03d}",
                    "rect": {
                        "x0": int(x0),
                        "y0": int(y0),
                        "x1": int(x1),
                        "y1": int(y1),
                        "quad": [
                            [int(x0), int(y0)],
                            [int(x1), int(y0)],
                            [int(x1), int(y1)],
                            [int(x0), int(y1)]
                        ]
                    }
                }

                chips.append(chip_info)
                chip_idx += 1

    return chips


def generate_positions_json(image_path: str, output_path: Optional[str] = None) -> dict:
    """
    이미지에서 chip positions JSON 생성
    """
    # 이미지 로드
    img = Image.open(image_path)
    img_array = np.array(img)

    height, width = img_array.shape[:2]
    print(f"📐 이미지 크기: {width}x{height}")

    # Grayscale 변환
    if len(img_array.shape) == 3:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_array

    # 1. Wafer 원형 영역 감지
    print("🔍 Wafer 원형 영역 감지 중...")
    wafer_circle = detect_wafer_circle(gray)

    if wafer_circle:
        cx, cy, radius = wafer_circle
        print(f"   ✓ 원형 영역: 중심({cx}, {cy}), 반지름={radius}")

        # Mask 생성
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.circle(mask, (cx, cy), radius, 255, -1)
    else:
        print("   ⚠️ 원형 영역을 찾지 못했습니다. 전체 영역 사용")
        mask = None

    # 2. Grid 라인 감지
    print("🔍 Grid 라인 감지 중...")
    vertical_lines, horizontal_lines = detect_grid_lines(gray, mask)

    print(f"   ✓ 수직선: {len(vertical_lines)}개")
    print(f"   ✓ 수평선: {len(horizontal_lines)}개")

    if len(vertical_lines) < 2 or len(horizontal_lines) < 2:
        raise ValueError("Grid 라인을 충분히 감지하지 못했습니다!")

    # Grid 간격 계산
    v_gaps = np.diff(vertical_lines)
    h_gaps = np.diff(horizontal_lines)
    tile_w = int(np.median(v_gaps))
    tile_h = int(np.median(h_gaps))
    print(f"   ✓ Grid 간격: {tile_w}x{tile_h} 픽셀")

    # 3. Chip 감지
    print("🔍 Chip 감지 중...")
    chips = detect_chips_from_grid(img_array, vertical_lines, horizontal_lines, wafer_circle)

    print(f"   ✓ 감지된 chip: {len(chips)}개")

    # 4. Positions JSON 생성
    image_name = Path(image_path).stem

    positions_json = {
        "image_path": str(Path(image_path).resolve()),
        "image_name": image_name,
        "root": "WAFER",
        "step": "DEMO",
        "wafer": image_name.split('_')[-1] if '_' in image_name else "001",
        "stime": datetime.now().strftime("%Y%m%d_%H%M%S"),
        "day": datetime.now().strftime("%Y%m%d"),
        "coord": {
            "rot_code": 5,
            "x_min_abs": -(len(vertical_lines) // 2),
            "y_min_abs": -(len(horizontal_lines) // 2),
            "tiles_w_rot": len(vertical_lines) - 1,
            "tiles_h_rot": len(horizontal_lines) - 1,
            "grid_edges": {
                "xs": vertical_lines,
                "ys": horizontal_lines
            },
            "canvas": {
                "width": width,
                "height": height
            },
            "scale": {
                "sx": 1.0,
                "sy": 1.0
            },
            "border": 1,
            "defect_border": 2,
            "center_rule": {
                "even_x_zero": "left",
                "even_y_zero": "down"
            }
        },
        "chips": chips
    }

    # Wafer circle 정보 추가
    if wafer_circle:
        positions_json["wafer_circle"] = {
            "center_x": int(cx),
            "center_y": int(cy),
            "radius": int(radius)
        }

    # 5. JSON 저장
    if output_path:
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)

        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(positions_json, f, ensure_ascii=False, indent=2)

        print(f"\n✅ Positions JSON 저장: {output_file}")

    return positions_json


def main():
    if len(sys.argv) < 2:
        print("Usage: python detect_chip_positions.py <image_path> [output_json_path]")
        print("\nExample:")
        print("  python detect_chip_positions.py wafer.png")
        print("  python detect_chip_positions.py wafer.png D:/project/positions/wafer.json")
        sys.exit(1)

    image_path = sys.argv[1]

    if not os.path.exists(image_path):
        print(f"❌ 이미지 파일을 찾을 수 없습니다: {image_path}")
        sys.exit(1)

    # Output path 결정
    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        # 기본: D:/project/positions/<image_name>.json
        positions_root = Path(os.getenv("POSITIONS_ROOT", "D:/project/positions"))
        image_name = Path(image_path).stem
        output_path = positions_root / f"{image_name}.json"

    try:
        positions_json = generate_positions_json(image_path, str(output_path))

        print(f"\n📊 결과:")
        print(f"   - 총 chip 개수: {len(positions_json['chips'])}")
        print(f"   - Grid 크기: {positions_json['coord']['tiles_w_rot']}x{positions_json['coord']['tiles_h_rot']}")
        print(f"   - 이미지 크기: {width}x{height}")
        if 'wafer_circle' in positions_json:
            wc = positions_json['wafer_circle']
            print(f"   - Wafer 원형: 중심({wc['center_x']}, {wc['center_y']}), 반지름={wc['radius']}")

    except Exception as e:
        print(f"\n❌ 오류 발생: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
