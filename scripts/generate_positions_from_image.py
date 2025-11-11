#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
웨이퍼 이미지를 분석해서 positions JSON 생성
"""

import os
import sys
import json
from pathlib import Path
from PIL import Image
import numpy as np
from datetime import datetime

def analyze_wafer_image(image_path: str):
    """
    웨이퍼 이미지를 분석해서 칩 위치 정보 추출
    """
    img = Image.open(image_path)
    img_array = np.array(img)

    height, width = img_array.shape[:2]
    print(f"이미지 크기: {width}x{height}")

    # 칩 크기 추정 (이미지에서 반복 패턴 찾기)
    # 대략적으로 26x26 그리드로 가정
    tile_size = 24  # 각 칩의 크기 (픽셀)

    # 그리드 추정
    tiles_w = width // tile_size
    tiles_h = height // tile_size

    print(f"추정 그리드: {tiles_w}x{tiles_h}")

    # 칩 정보 생성
    chips = []
    chip_idx = 0

    # 웨이퍼 중심 계산
    center_x = width // 2
    center_y = height // 2

    # 원형 웨이퍼 반지름 (이미지의 90% 정도)
    radius = min(width, height) * 0.45

    for row in range(tiles_h):
        for col in range(tiles_w):
            # 픽셀 좌표
            x0 = col * tile_size
            y0 = row * tile_size
            x1 = x0 + tile_size
            y1 = y0 + tile_size

            # 칩 중심
            chip_center_x = (x0 + x1) // 2
            chip_center_y = (y0 + y1) // 2

            # 웨이퍼 중심으로부터의 거리
            dist_from_center = np.sqrt(
                (chip_center_x - center_x)**2 +
                (chip_center_y - center_y)**2
            )

            # 원형 웨이퍼 내부에만 칩이 있다고 가정
            if dist_from_center > radius:
                continue

            # 해당 영역의 픽셀이 배경(흰색)인지 확인
            chip_region = img_array[y0:y1, x0:x1]

            # 완전히 흰색이면 빈 칩으로 간주
            if chip_region.size == 0:
                continue

            # RGB 평균값 계산
            if len(chip_region.shape) == 3:
                mean_color = chip_region.mean(axis=(0, 1))
                # 거의 흰색이면 (240 이상) 건너뛰기
                if all(c > 240 for c in mean_color):
                    continue

            # 절대 좌표 (그리드 기준)
            x_abs = col - tiles_w // 2
            y_abs = row - tiles_h // 2

            # Bin code는 일단 색상 기반으로 추정
            bin_code = f"B{chip_idx % 100:03d}"

            chip_info = {
                "x_abs": int(x_abs),
                "y_abs": int(y_abs),
                "b": bin_code,
                "x_cal": int(x_abs),
                "y_cal": int(y_abs),
                "text3": bin_code[-3:],
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

    print(f"감지된 칩 개수: {len(chips)}")

    # Grid edges 생성
    xs_edges = [i * tile_size for i in range(tiles_w + 1)]
    ys_edges = [i * tile_size for i in range(tiles_h + 1)]

    # Positions JSON 구조 생성
    positions_json = {
        "image_path": image_path,
        "root": "WAFER",
        "step": "DEMO",
        "wafer": "001",
        "stime": datetime.now().strftime("%Y%m%d_%H%M%S"),
        "day": datetime.now().strftime("%Y%m%d"),
        "coord": {
            "rot_code": 5,  # 회전 없음
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
        print("Usage: python generate_positions_from_image.py <image_path> [positions_root]")
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
    positions_json = analyze_wafer_image(image_path)

    # 출력 경로 결정 (별도 positions 폴더에 저장)
    # 이미지: D:\project\data\wm-811k\palette_5mb\wafer_palette_5mb.png
    # 출력: D:\project\positions\wm-811k\palette_5mb\wafer_palette_5mb.json

    image_path_obj = Path(image_path)
    image_stem = image_path_obj.stem

    # 이미지 경로에서 상대 경로 추출 (data 이후 부분)
    # 예: D:\project\data\wm-811k\palette_5mb -> wm-811k\palette_5mb
    image_abs = Path(image_path).resolve()
    try:
        # PROJECT_ROOT 환경변수에서 images 루트 찾기
        data_root = Path(os.getenv("PROJECT_ROOT", "D:/project/data")).resolve()
        relative_path = image_abs.parent.relative_to(data_root)
    except ValueError:
        # 상대 경로 추출 실패 시 이미지와 같은 폴더에 저장
        relative_path = Path(".")

    # positions 폴더에 저장
    positions_root_path = Path(positions_root)
    output_dir = positions_root_path / relative_path
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{image_stem}.json"

    # JSON 저장
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(positions_json, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Positions JSON 생성 완료: {output_path}")
    print(f"   - 총 {len(positions_json['chips'])}개 칩")
    print(f"   - 그리드 크기: {positions_json['coord']['tiles_w_rot']}x{positions_json['coord']['tiles_h_rot']}")
    print(f"   - 이미지 크기: {positions_json['coord']['canvas']['width']}x{positions_json['coord']['canvas']['height']}")


if __name__ == "__main__":
    main()
