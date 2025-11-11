#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Edge detection을 이용한 실제 칩 감지 및 positions JSON 생성
"""

import os
import sys
import json
from pathlib import Path
from PIL import Image
import numpy as np
import cv2
from datetime import datetime


def detect_chips_with_edges(image_path: str):
    """
    Edge detection으로 실제 칩만 감지
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

    # 흰색 배경과 칩 분리 (threshold)
    # 흰색(255)에 가까운 픽셀은 배경, 나머지는 칩
    # threshold를 낮춰서 더 많은 칩 감지
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    # Morphological operations로 노이즈 제거
    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Contour 감지
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    print(f"감지된 contour 개수: {len(contours)}")

    # 칩 정보 추출
    chips = []

    # 칩 크기 필터링 (너무 작거나 큰 것 제외)
    min_area = 10  # 최소 면적 (작은 칩도 감지)
    max_area = width * height * 0.01  # 최대 면적 (이미지의 1%)

    valid_contours = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if min_area < area < max_area:
            valid_contours.append(contour)

    print(f"유효한 칩 개수: {len(valid_contours)}")

    # Grid 추정 (칩들의 평균 간격)
    if len(valid_contours) > 0:
        # 모든 칩의 bounding box 수집
        bboxes = []
        for contour in valid_contours:
            x, y, w, h = cv2.boundingRect(contour)
            bboxes.append((x, y, w, h))

        # 칩 크기 평균 계산
        avg_width = np.mean([w for _, _, w, _ in bboxes])
        avg_height = np.mean([h for _, _, _, h in bboxes])
        tile_size = int((avg_width + avg_height) / 2)

        print(f"평균 칩 크기: {avg_width:.1f}x{avg_height:.1f} -> tile_size: {tile_size}")

        # Grid 크기 추정
        tiles_w = width // tile_size
        tiles_h = height // tile_size

        # 웨이퍼 중심 계산
        center_x = width // 2
        center_y = height // 2

        # 각 칩의 절대 좌표 계산
        for idx, (x, y, w, h) in enumerate(bboxes):
            # 칩 중심
            chip_center_x = x + w // 2
            chip_center_y = y + h // 2

            # Grid 기준 절대 좌표
            x_abs = (chip_center_x - center_x) // tile_size
            y_abs = (chip_center_y - center_y) // tile_size

            chip_info = {
                "x_abs": int(x_abs),
                "y_abs": int(y_abs),
                "b": f"B{idx:03d}",
                "x_cal": int(x_abs),
                "y_cal": int(y_abs),
                "text3": f"{idx:03d}",
                "rect": {
                    "x0": int(x),
                    "y0": int(y),
                    "x1": int(x + w),
                    "y1": int(y + h),
                    "quad": [
                        [int(x), int(y)],
                        [int(x + w), int(y)],
                        [int(x + w), int(y + h)],
                        [int(x), int(y + h)]
                    ]
                }
            }

            chips.append(chip_info)

        # Grid edges 생성
        xs_edges = [i * tile_size for i in range(tiles_w + 1)]
        ys_edges = [i * tile_size for i in range(tiles_h + 1)]

    else:
        print("칩을 찾을 수 없습니다!")
        tile_size = 24
        tiles_w = width // tile_size
        tiles_h = height // tile_size
        xs_edges = [i * tile_size for i in range(tiles_w + 1)]
        ys_edges = [i * tile_size for i in range(tiles_h + 1)]

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
            "x_min_abs": -(tiles_w // 2),
            "y_min_abs": -(tiles_h // 2),
            "tiles_w_rot": tiles_w,
            "tiles_h_rot": tiles_h,
            "grid_edges": {
                "xs": xs_edges,
                "ys": ys_edges
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
        print("Usage: python generate_positions_edge_detection.py <image_path> [positions_root]")
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
    positions_json = detect_chips_with_edges(image_path)

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
