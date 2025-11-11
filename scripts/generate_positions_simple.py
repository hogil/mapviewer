#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Simple grid + color detection으로 칩 위치 감지
"""

import os
import sys
import json
from pathlib import Path
from PIL import Image
import numpy as np
from datetime import datetime


def detect_chips_simple(image_path: str):
    """
    고정 그리드로 나누고 각 셀에서 색상 유무로 칩 감지
    """
    # 이미지 로드
    img = Image.open(image_path)
    img_array = np.array(img)

    height, width = img_array.shape[:2]
    print(f"이미지 크기: {width}x{height}")

    # 그리드 크기 추정 (이미지에서 수동으로 확인한 값)
    # 26x26 정도로 보임
    grid_count = 26
    tile_size = width // grid_count

    print(f"그리드: {grid_count}x{grid_count}, 타일 크기: {tile_size}x{tile_size}")

    # 웨이퍼 중심
    center_x = width // 2
    center_y = height // 2

    # 웨이퍼 반지름 (이미지의 약 45%)
    radius = min(width, height) * 0.45

    # 각 셀에서 칩 감지
    chips = []
    chip_idx = 0

    for row in range(grid_count):
        for col in range(grid_count):
            # 셀 좌표
            x0 = col * tile_size
            y0 = row * tile_size
            x1 = x0 + tile_size
            y1 = y0 + tile_size

            # 셀 중심
            cell_center_x = (x0 + x1) // 2
            cell_center_y = (y0 + y1) // 2

            # 웨이퍼 원형 영역 체크
            dist_from_center = np.sqrt(
                (cell_center_x - center_x)**2 +
                (cell_center_y - center_y)**2
            )

            if dist_from_center > radius:
                continue

            # 셀 영역 추출 (경계선 제외하고 내부만)
            margin = 2  # 경계선 제외
            cell = img_array[y0+margin:y1-margin, x0+margin:x1-margin]

            if cell.size == 0:
                continue

            # 평균 색상 계산
            if len(cell.shape) == 3:
                # RGB 평균
                mean_r = np.mean(cell[:, :, 0])
                mean_g = np.mean(cell[:, :, 1])
                mean_b = np.mean(cell[:, :, 2])

                # 흰색이 아니면 칩 (모든 채널이 240 이상이면 흰색)
                is_chip = not (mean_r > 240 and mean_g > 240 and mean_b > 240)
            else:
                # Grayscale
                mean_gray = np.mean(cell)
                is_chip = mean_gray < 240

            if is_chip:
                # Grid 기준 절대 좌표 (y축 반전 - 이미지는 위에서 아래로, wafer는 아래에서 위로)
                x_abs = col - grid_count // 2
                y_abs = (grid_count // 2) - row - 1  # Y축 반전

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

    # Grid edges 생성
    xs_edges = [i * tile_size for i in range(grid_count + 1)]
    ys_edges = [i * tile_size for i in range(grid_count + 1)]

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
            "x_min_abs": -(grid_count // 2),
            "y_min_abs": -(grid_count // 2),
            "tiles_w_rot": grid_count,
            "tiles_h_rot": grid_count,
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
        print("Usage: python generate_positions_simple.py <image_path> [positions_root]")
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
    positions_json = detect_chips_simple(image_path)

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

    output_path = output_dir / f"{image_stem}_positions.json"

    # JSON 저장
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(positions_json, f, ensure_ascii=False, indent=2)

    print(f"\nPositions JSON 생성 완료: {output_path}")
    print(f"   - 총 {len(positions_json['chips'])}개 칩")
    print(f"   - 그리드 크기: {positions_json['coord']['tiles_w_rot']}x{positions_json['coord']['tiles_h_rot']}")
    print(f"   - 이미지 크기: {positions_json['coord']['canvas']['width']}x{positions_json['coord']['canvas']['height']}")


if __name__ == "__main__":
    main()
