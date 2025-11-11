#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grid line detection을 이용한 칩 위치 감지
"""

import os
import sys
import json
from pathlib import Path
from PIL import Image
import numpy as np
import cv2
from datetime import datetime


def detect_grid_and_chips(image_path: str):
    """
    Grid 라인을 감지하고 각 셀에서 칩 유무 확인
    """
    # 이미지 로드
    img = Image.open(image_path)
    img_array = np.array(img)

    height, width = img_array.shape[:2]
    print(f"이미지 크기: {width}x{height}")

    # RGB to Grayscale
    if len(img_array.shape) == 3:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_array

    # Canny edge detection
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    # Hough Line Transform으로 직선 감지
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=100, minLineLength=100, maxLineGap=10)

    if lines is None:
        print("그리드 라인을 찾을 수 없습니다!")
        return None

    # 수직선과 수평선 분리
    vertical_lines = []
    horizontal_lines = []

    for line in lines:
        x1, y1, x2, y2 = line[0]

        # 각도 계산
        angle = np.abs(np.arctan2(y2 - y1, x2 - x1) * 180 / np.pi)

        # 수평선 (각도가 0도에 가까움)
        if angle < 10 or angle > 170:
            horizontal_lines.append((y1 + y2) // 2)  # y 좌표
        # 수직선 (각도가 90도에 가까움)
        elif 80 < angle < 100:
            vertical_lines.append((x1 + x2) // 2)  # x 좌표

    # 중복 제거 및 정렬
    vertical_lines = sorted(list(set(vertical_lines)))
    horizontal_lines = sorted(list(set(horizontal_lines)))

    # 비슷한 위치의 라인 병합 (threshold = 5 픽셀)
    def merge_close_lines(lines, threshold=5):
        if not lines:
            return []
        merged = [lines[0]]
        for line in lines[1:]:
            if line - merged[-1] > threshold:
                merged.append(line)
        return merged

    vertical_lines = merge_close_lines(vertical_lines)
    horizontal_lines = merge_close_lines(horizontal_lines)

    print(f"감지된 수직선: {len(vertical_lines)}개")
    print(f"감지된 수평선: {len(horizontal_lines)}개")

    # 그리드 간격 계산
    if len(vertical_lines) > 1 and len(horizontal_lines) > 1:
        v_gaps = np.diff(vertical_lines)
        h_gaps = np.diff(horizontal_lines)
        tile_w = int(np.median(v_gaps))
        tile_h = int(np.median(h_gaps))
        print(f"그리드 간격: {tile_w}x{tile_h}")
    else:
        print("그리드 간격을 계산할 수 없습니다!")
        tile_w = tile_h = 24

    # 각 그리드 셀에서 칩 감지
    chips = []
    chip_idx = 0

    center_x = width // 2
    center_y = height // 2

    for i in range(len(vertical_lines) - 1):
        for j in range(len(horizontal_lines) - 1):
            x0 = vertical_lines[i]
            x1 = vertical_lines[i + 1]
            y0 = horizontal_lines[j]
            y1 = horizontal_lines[j + 1]

            # 셀 내부 영역
            cell = img_array[y0:y1, x0:x1]

            if cell.size == 0:
                continue

            # 셀의 평균 밝기 계산
            if len(cell.shape) == 3:
                cell_gray = cv2.cvtColor(cell, cv2.COLOR_RGB2GRAY)
            else:
                cell_gray = cell

            mean_brightness = np.mean(cell_gray)

            # 흰색이 아니면 (밝기 < 240) 칩이 있음
            if mean_brightness < 240:
                # 칩 중심
                chip_center_x = (x0 + x1) // 2
                chip_center_y = (y0 + y1) // 2

                # Grid 기준 절대 좌표
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

    print(f"최종 감지된 칩 개수: {len(chips)}")

    # Positions JSON 구조 생성
    positions_json = {
        "image_path": image_path,
        "root": "WAFER",
        "step": "DEMO",
        "wafer": "001",
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

    return positions_json


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_positions_grid_lines.py <image_path> [positions_root]")
        sys.exit(1)

    image_path = sys.argv[1]

    # positions_root 인자가 있으면 사용, 없으면 기본값
    if len(sys.argv) >= 3:
        positions_root = sys.argv[2]
    else:
        positions_root = os.getenv("POSITIONS_ROOT", "D:/project/positions")

    if not os.path.exists(image_path):
        print(f"이미지 파일을 찾을 수 없습니다: {image_path}")
        sys.exit(1)

    # Positions JSON 생성
    positions_json = detect_grid_and_chips(image_path)

    if positions_json is None:
        print("칩 감지 실패!")
        sys.exit(1)

    # 출력 경로 결정
    image_path_obj = Path(image_path)
    image_stem = image_path_obj.stem

    # 이미지 경로에서 상대 경로 추출
    image_abs = Path(image_path).resolve()
    try:
        data_root = Path(os.getenv("PROJECT_ROOT", "D:/project/data")).resolve()
        relative_path = image_abs.parent.relative_to(data_root)
    except ValueError:
        relative_path = Path(".")

    # positions 폴더에 저장
    positions_root_path = Path(positions_root)
    output_dir = positions_root_path / relative_path
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{image_stem}.json"

    # JSON 저장
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(positions_json, f, ensure_ascii=False, indent=2)

    print(f"\nPositions JSON 생성 완료: {output_path}")
    print(f"   - 총 {len(positions_json['chips'])}개 칩")
    print(f"   - 그리드 크기: {positions_json['coord']['tiles_w_rot']}x{positions_json['coord']['tiles_h_rot']}")
    print(f"   - 이미지 크기: {positions_json['coord']['canvas']['width']}x{positions_json['coord']['canvas']['height']}")


if __name__ == "__main__":
    main()
