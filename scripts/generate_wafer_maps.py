"""
Palette PNG Wafer Map 생성 스크립트

Default color scheme으로 Palette PNG 이미지 생성:
- Grade0: #FFFFFF (칩)
- Background: #FEFEFE (배경, 육안으로는 동일하지만 index로 분리)
- 5가지 크기: 5MB, 10MB, 15MB, 20MB, 25MB
"""
import json
import random
import math
import shutil
from pathlib import Path
from PIL import Image, ImageDraw


def hex_to_rgb(hex_color: str) -> tuple:
    """16진수 색상을 RGB 튜플로 변환"""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def load_color_legends() -> dict:
    """color-legends.json 파일에서 색상 정보 로드"""
    color_legends_path = Path(__file__).parent.parent / "logs" / "color-legends.json"
    with open(color_legends_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def create_palette_from_scheme(scheme_data: dict) -> list:
    """
    Scheme 데이터로부터 32색 팔레트 생성

    Index 0-7: Grade0-7 (top)
    Index 8-13: Normal, Invalid, B285-B288 (bottom)
    Index 14: Background
    Index 15-31: 검은색 패딩
    """
    palette = []

    # Index 0-7: top (Grade0-7)
    top_colors = scheme_data.get('top', {})
    for grade in ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7']:
        r, g, b = hex_to_rgb(top_colors.get(grade, '#FFFFFF'))
        palette.extend([r, g, b])

    # Index 8-13: bottom (Normal, Invalid, B285-B288)
    bottom_colors = scheme_data.get('bottom', {})
    for label in ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288']:
        r, g, b = hex_to_rgb(bottom_colors.get(label, '#000000'))
        palette.extend([r, g, b])

    # Index 14: background
    bg_r, bg_g, bg_b = hex_to_rgb(scheme_data.get('background', '#FEFEFE'))
    palette.extend([bg_r, bg_g, bg_b])

    # Index 15-31: 검은색 패딩 (32색까지)
    palette.extend([0, 0, 0] * (32 - 15))

    return palette


def generate_palette_wafer_map(
    output_path: Path,
    image_size: int,
    palette: list,
    defect_ratio: float = 0.05,
    defect_pattern: str = 'random'
):
    """
    Palette PNG Wafer Map 이미지 생성

    Args:
        output_path: 출력 이미지 경로
        image_size: 이미지 크기 (정사각형)
        palette: 32색 팔레트 (96개 RGB 값)
        defect_ratio: 불량 chip 비율
        defect_pattern: 불량 패턴 ('edge', 'center', 'random', 'gradient')
    """
    # Palette 모드 이미지 생성
    img = Image.new('P', (image_size, image_size), 0)
    img.putpalette(palette)

    # 픽셀 데이터 생성 (numpy 배열 사용)
    import numpy as np
    pixels = np.zeros((image_size, image_size), dtype=np.uint8)

    # Wafer 반경
    wafer_radius = int(image_size * 0.45)
    center_x, center_y = image_size // 2, image_size // 2

    # 1단계: 전체를 Index 14 (Background, #FEFEFE)로 채움
    pixels[:] = 14

    # 2단계: Wafer 내부를 Index 0 (Grade0, #FFFFFF)로 채움
    for y in range(image_size):
        for x in range(image_size):
            dist = math.sqrt((x - center_x)**2 + (y - center_y)**2)
            if dist <= wafer_radius:
                pixels[y, x] = 0  # Grade0 (칩)

    # 3단계: 불량 패턴 생성 (Index 8-13 중 랜덤 선택)
    # Chip 크기 자동 계산 (이미지 크기에 비례)
    chip_size = max(20, image_size // 50)
    grid_size = image_size // chip_size

    total_chips_in_wafer = 0
    chip_positions = []

    for row in range(grid_size):
        for col in range(grid_size):
            chip_x = col * chip_size
            chip_y = row * chip_size
            chip_center_x = chip_x + chip_size // 2
            chip_center_y = chip_y + chip_size // 2

            # Wafer 내부 chip만 선택
            dist = math.sqrt((chip_center_x - center_x)**2 + (chip_center_y - center_y)**2)
            if dist <= wafer_radius:
                chip_positions.append((row, col, chip_x, chip_y, chip_center_x, chip_center_y, dist))
                total_chips_in_wafer += 1

    defect_count = int(total_chips_in_wafer * defect_ratio)

    # 불량 chip 선택 (패턴별)
    if defect_pattern == 'edge':
        # 가장자리에 집중 (반경 기준 상위 30%)
        chip_positions.sort(key=lambda x: x[6], reverse=True)
        defect_chips = chip_positions[:defect_count]
    elif defect_pattern == 'center':
        # 중심에 집중 (반경 기준 하위 30%)
        chip_positions.sort(key=lambda x: x[6])
        defect_chips = chip_positions[:defect_count]
    elif defect_pattern == 'gradient':
        # 중심에서 외곽으로 그라데이션
        chip_positions.sort(key=lambda x: random.random() * (1.0 - x[6] / wafer_radius), reverse=True)
        defect_chips = chip_positions[:defect_count]
    else:  # random
        defect_chips = random.sample(chip_positions, defect_count)

    # 불량 그리기
    for row, col, chip_x, chip_y, chip_center_x, chip_center_y, dist in defect_chips:
        # Bottom 색상 중 랜덤 선택 (Index 8-13)
        defect_index = random.randint(8, 13)

        # 불량 크기 (chip의 50-80%)
        defect_size = int(chip_size * random.uniform(0.5, 0.8))
        half_size = defect_size // 2

        # 불량 타입 랜덤
        defect_type = random.choice(['circle', 'rectangle', 'triangle', 'cross'])

        if defect_type == 'circle':
            for dy in range(-half_size, half_size + 1):
                for dx in range(-half_size, half_size + 1):
                    if dx*dx + dy*dy <= half_size*half_size:
                        px = chip_center_x + dx
                        py = chip_center_y + dy
                        if 0 <= px < image_size and 0 <= py < image_size:
                            pixels[py, px] = defect_index
        elif defect_type == 'rectangle':
            for dy in range(-half_size, half_size + 1):
                for dx in range(-half_size, half_size + 1):
                    px = chip_center_x + dx
                    py = chip_center_y + dy
                    if 0 <= px < image_size and 0 <= py < image_size:
                        pixels[py, px] = defect_index
        elif defect_type == 'triangle':
            for dy in range(-half_size, half_size + 1):
                for dx in range(-half_size, half_size + 1):
                    # 삼각형 조건: y >= -x/2 and y >= x/2
                    if dy >= -half_size and dy >= abs(dx) - half_size:
                        px = chip_center_x + dx
                        py = chip_center_y + dy
                        if 0 <= px < image_size and 0 <= py < image_size:
                            pixels[py, px] = defect_index
        elif defect_type == 'cross':
            line_width = max(2, defect_size // 8)
            # 세로선
            for dy in range(-half_size, half_size + 1):
                for dx in range(-line_width // 2, line_width // 2 + 1):
                    px = chip_center_x + dx
                    py = chip_center_y + dy
                    if 0 <= px < image_size and 0 <= py < image_size:
                        pixels[py, px] = defect_index
            # 가로선
            for dx in range(-half_size, half_size + 1):
                for dy in range(-line_width // 2, line_width // 2 + 1):
                    px = chip_center_x + dx
                    py = chip_center_y + dy
                    if 0 <= px < image_size and 0 <= py < image_size:
                        pixels[py, px] = defect_index

    # 4단계: Wafer 외부를 다시 Index 14 (Background)로 채움
    for y in range(image_size):
        for x in range(image_size):
            dist = math.sqrt((x - center_x)**2 + (y - center_y)**2)
            if dist > wafer_radius:
                pixels[y, x] = 14

    # NumPy 배열을 PIL 이미지로 변환
    img = Image.fromarray(pixels, mode='P')
    img.putpalette(palette)

    # PNG로 저장
    img.save(output_path, 'PNG', optimize=False)

    return output_path.stat().st_size


def main():
    """메인 함수"""
    print("=" * 80)
    print("Palette PNG Wafer Map 생성 스크립트")
    print("=" * 80)

    # 색상 정보 로드
    color_data = load_color_legends()
    default_scheme = color_data['default']
    palette = create_palette_from_scheme(default_scheme)

    print(f"\n[OK] Default scheme 로드 완료")
    print(f"   - Grade0 (Index 0): {default_scheme['top'][0]['color']}")
    print(f"   - Background (Index 14): {default_scheme['background']}")
    print(f"   - Palette 크기: {len(palette)//3} colors\n")

    # 출력 디렉토리
    base_dir = Path("D:/project/data/wm-811k")

    # 1. 5가지 크기 파일 생성
    various_sizes_dir = base_dir / "wafer_maps_palette"
    various_sizes_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 80)
    print("[1/2] 다양한 크기 파일 생성 (5MB, 10MB, 15MB, 20MB, 25MB)")
    print("=" * 80)

    # 목표 파일 크기 (MB) -> 이미지 크기 (픽셀) 매핑
    # Palette PNG는 압축률이 매우 높으므로 훨씬 큰 이미지 필요
    # 약 30배 정도 더 큰 이미지 필요 (실험 기반)
    target_sizes = [
        (5, 5000),    # 5MB  ≈ 5000x5000
        (10, 7000),   # 10MB ≈ 7000x7000
        (15, 8500),   # 15MB ≈ 8500x8500
        (20, 10000),  # 20MB ≈ 10000x10000
        (25, 11000),  # 25MB ≈ 11000x11000
    ]

    defect_patterns = ['random', 'edge', 'center', 'gradient']

    generated_files = []

    for target_mb, image_size in target_sizes:
        defect_pattern = random.choice(defect_patterns)
        defect_ratio = random.uniform(0.03, 0.08)

        filename = f"wafer_palette_{target_mb}mb.png"
        output_path = various_sizes_dir / filename

        print(f"\n생성 중: {filename} ({image_size}x{image_size}, pattern={defect_pattern})...")

        file_size = generate_palette_wafer_map(
            output_path=output_path,
            image_size=image_size,
            palette=palette,
            defect_ratio=defect_ratio,
            defect_pattern=defect_pattern
        )

        actual_mb = file_size / (1024 * 1024)
        print(f"[OK] 완료: {filename} ({actual_mb:.1f}MB)")

        if target_mb == 5:
            generated_files.append(output_path)

    # 2. 5MB 파일을 3000번 복사
    if generated_files:
        copies_dir = base_dir / "palette_copies_3k"
        copies_dir.mkdir(parents=True, exist_ok=True)

        print("\n" + "=" * 80)
        print("[2/2] 5MB 파일 3000번 복사")
        print("=" * 80)

        source_file = generated_files[0]
        print(f"\n소스 파일: {source_file.name}")
        print(f"대상 디렉토리: {copies_dir}")
        print(f"복사 개수: 3000개\n")

        for i in range(1, 3001):
            dest_file = copies_dir / f"wafer_palette_{i:05d}.png"
            shutil.copy2(source_file, dest_file)

            if i % 500 == 0 or i == 3000:
                print(f"  진행: {i}/3000 복사 완료")

    print("\n" + "=" * 80)
    print("[OK] 완료!")
    print("=" * 80)
    print(f"\n다양한 크기 파일: {various_sizes_dir}")
    print(f"3000개 복사본: {copies_dir}")
    print()


if __name__ == "__main__":
    main()
