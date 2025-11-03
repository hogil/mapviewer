"""
Wafer Map 이미지 대량 생성 스크립트

3000개의 wafer map 이미지 생성
- chip마다 기하학적 불량 포함
- 불량 패턴 (edge, random, center, gradient 등)
- 5% 불량률
- 서브폴더로 자동 분산 저장
"""
import json
import random
import math
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np


def hex_to_rgb(hex_color: str) -> tuple:
    """16진수 색상을 RGB 튜플로 변환"""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def load_color_legends() -> dict:
    """color-legends.json 파일에서 색상 정보 로드"""
    color_legends_path = Path(__file__).parent.parent / "logs" / "color-legends.json"
    with open(color_legends_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def draw_geometric_defect(draw, chip_x, chip_y, chip_size, defect_color, defect_type='random'):
    """
    Chip 내에 기하학적 불량 그리기
    
    defect_type: 'circle', 'rectangle', 'triangle', 'cross', 'random'
    """
    center_x = chip_x + chip_size // 2
    center_y = chip_y + chip_size // 2
    
    if defect_type == 'random':
        defect_type = random.choice(['circle', 'rectangle', 'triangle', 'cross'])
    
    # 불량 크기 (chip의 30-70% 크기)
    defect_size_min = int(chip_size * 0.3)
    defect_size_max = int(chip_size * 0.7)
    defect_size = random.randint(defect_size_min, defect_size_max)
    
    if defect_type == 'circle':
        radius = defect_size // 2
        draw.ellipse(
            [center_x - radius, center_y - radius,
             center_x + radius, center_y + radius],
            fill=defect_color
        )
    elif defect_type == 'rectangle':
        half_size = defect_size // 2
        draw.rectangle(
            [center_x - half_size, center_y - half_size,
             center_x + half_size, center_y + half_size],
            fill=defect_color
        )
    elif defect_type == 'triangle':
        half_size = defect_size // 2
        points = [
            (center_x, center_y - half_size),
            (center_x - half_size, center_y + half_size),
            (center_x + half_size, center_y + half_size)
        ]
        draw.polygon(points, fill=defect_color)
    elif defect_type == 'cross':
        half_size = defect_size // 2
        line_width = max(2, defect_size // 8)
        draw.rectangle(
            [center_x - line_width // 2, center_y - half_size,
             center_x + line_width // 2, center_y + half_size],
            fill=defect_color
        )
        draw.rectangle(
            [center_x - half_size, center_y - line_width // 2,
             center_x + half_size, center_y + line_width // 2],
            fill=defect_color
        )


def generate_wafer_map(
    output_path: Path,
    grid_size: int,
    chip_size: int,
    wafer_radius_ratio: float = 0.45,
    defect_ratio: float = 0.05,
    defect_pattern: str = 'random'
):
    """
    Wafer Map 이미지 생성
    
    Args:
        output_path: 출력 이미지 경로
        grid_size: 격자 크기 (N x N chips)
        chip_size: 각 chip의 픽셀 크기
        wafer_radius_ratio: wafer 반지름 비율
        defect_ratio: 불량 chip 비율
        defect_pattern: 불량 패턴 ('edge', 'center', 'random', 'gradient')
    """
    # 색상 정보 로드
    color_data = load_color_legends()
    grade0_color = hex_to_rgb(color_data['default']['top'][0]['color'])  # Grade0 = 흰색
    
    # 불량 색상 선택 (bottom 색상 중 하나)
    defect_color_info = random.choice(color_data['default']['bottom'])
    defect_color = hex_to_rgb(defect_color_info['color'])
    
    # 실제 이미지 크기 계산
    image_size = grid_size * chip_size
    
    # 이미지 생성
    image = Image.new('RGB', (image_size, image_size), color='black')
    draw = ImageDraw.Draw(image)
    
    # 전체 chip 개수
    total_chips = grid_size * grid_size
    defect_count = int(total_chips * defect_ratio)
    
    # 불량 chip 위치 선택 (패턴별)
    if defect_pattern == 'edge':
        # 가장자리에 집중
        edge_cells = []
        for row in range(grid_size):
            for col in range(grid_size):
                if row == 0 or row == grid_size-1 or col == 0 or col == grid_size-1:
                    edge_cells.append(row * grid_size + col)
        defect_chips = random.sample(edge_cells, min(defect_count, len(edge_cells)))
        defect_set = set(defect_chips)
    elif defect_pattern == 'center':
        # 중심에 집중
        center_cells = []
        center_range = grid_size // 3
        for row in range(grid_size // 2 - center_range, grid_size // 2 + center_range):
            for col in range(grid_size // 2 - center_range, grid_size // 2 + center_range):
                if 0 <= row < grid_size and 0 <= col < grid_size:
                    center_cells.append(row * grid_size + col)
        defect_chips = random.sample(center_cells, min(defect_count, len(center_cells)))
        defect_set = set(defect_chips)
    elif defect_pattern == 'gradient':
        # 중심에서 외곽으로 그라데이션
        cells_with_dist = []
        center = grid_size // 2
        for row in range(grid_size):
            for col in range(grid_size):
                dist = math.sqrt((row - center)**2 + (col - center)**2)
                max_dist = math.sqrt(2 * (grid_size/2)**2)
                prob = 1.0 - (dist / max_dist)  # 중심일수록 높은 확률
                cells_with_dist.append((row * grid_size + col, prob))
        # 확률에 따라 선택
        cells_with_dist.sort(key=lambda x: random.random() * x[1], reverse=True)
        defect_set = set([idx for idx, _ in cells_with_dist[:defect_count]])
    else:  # random
        defect_chips = random.sample(range(total_chips), defect_count)
        defect_set = set(defect_chips)
    
    # 격자로 chip 배치
    for row in range(grid_size):
        for col in range(grid_size):
            chip_idx = row * grid_size + col
            chip_x = col * chip_size
            chip_y = row * chip_size
            
            # 불량 chip인지 확인
            is_defect = chip_idx in defect_set
            
            if is_defect:
                # 불량 chip: 기본 색상 + 기하학적 불량 그리기
                draw.rectangle(
                    [chip_x, chip_y, chip_x + chip_size, chip_y + chip_size],
                    fill=grade0_color,
                    outline=None
                )
                draw_geometric_defect(draw, chip_x, chip_y, chip_size, defect_color)
            else:
                # 정상 chip: Grade0 (흰색)
                draw.rectangle(
                    [chip_x, chip_y, chip_x + chip_size, chip_y + chip_size],
                    fill=grade0_color,
                    outline=None
                )
    
    # Wafer 원형 경계 그리기
    wafer_radius = int(image_size * wafer_radius_ratio)
    center_x, center_y = image_size // 2, image_size // 2
    
    # 원형 마스크 생성
    mask = Image.new('L', (image_size, image_size), 0)
    draw_mask = ImageDraw.Draw(mask)
    draw_mask.ellipse(
        [center_x - wafer_radius, center_y - wafer_radius,
         center_x + wafer_radius, center_y + wafer_radius],
        fill=255
    )
    
    # Wafer 경계선 그리기
    edge_color = (136, 136, 136)  # 회색 경계
    edge_width = 3
    
    for w in range(edge_width):
        r = wafer_radius - w
        for angle in range(0, 360, 1):
            rad = math.radians(angle)
            x = int(center_x + r * math.cos(rad))
            y = int(center_y + r * math.sin(rad))
            dist_from_center = math.sqrt((x - center_x)**2 + (y - center_y)**2)
            if dist_from_center > wafer_radius - 5:
                if 0 <= x < image_size and 0 <= y < image_size:
                    image.putpixel((x, y), edge_color)
    
    # Wafer 외부를 검은색으로 채우기
    for y in range(image_size):
        for x in range(image_size):
            dist_from_center = math.sqrt((x - center_x)**2 + (y - center_y)**2)
            if dist_from_center > wafer_radius:
                image.putpixel((x, y), (0, 0, 0))
    
    # JPEG로 저장 (용량 절약)
    image.save(output_path, 'JPEG', quality=95)
    
    return image_size


def main():
    """메인 함수"""
    print("="*70)
    print("Wafer Map Batch Generation - 3000 images")
    print("="*70)
    
    # 타겟 디렉토리
    base_dir = Path("D:/project/data/wm-811k")
    target_dir = base_dir / "wafer_maps_3k"
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # 서브폴더로 분산 저장 (1000개씩)
    num_images = 3000
    images_per_folder = 1000
    num_folders = (num_images + images_per_folder - 1) // images_per_folder
    
    # 불량 패턴
    defect_patterns = ['random', 'edge', 'center', 'gradient']
    
    # 격자 크기 변형 (20~25x20~25)
    grid_sizes = [20, 22, 24, 25]
    chip_sizes = [400, 450, 500]
    
    # 용량 기준 설정 (총 3000개)
    target_file_size_mb = 5  # 각 이미지 약 5MB
    
    print(f"\nGenerating {num_images} wafer maps...")
    print(f"Output: {target_dir}")
    print(f"Subfolders: {num_folders} folders x {images_per_folder} images each")
    print("="*70)
    
    total_generated = 0
    
    for folder_idx in range(num_folders):
        subfolder = target_dir / f"batch_{folder_idx+1:02d}"
        subfolder.mkdir(exist_ok=True)
        
        start_idx = folder_idx * images_per_folder
        end_idx = min(start_idx + images_per_folder, num_images)
        
        print(f"\n[{folder_idx+1}/{num_folders}] Generating batch {folder_idx+1:02d}...")
        print(f"Range: {start_idx+1} ~ {end_idx}")
        
        for img_idx in range(start_idx, end_idx):
            # 랜덤 설정
            grid_size = random.choice(grid_sizes)
            chip_size = random.choice(chip_sizes)
            defect_pattern = random.choice(defect_patterns)
            defect_ratio = random.uniform(0.03, 0.08)  # 3-8% 불량
            
            filename = f"wafer_{img_idx+1:05d}.jpg"
            output_path = subfolder / filename
            
            image_size = generate_wafer_map(
                output_path=output_path,
                grid_size=grid_size,
                chip_size=chip_size,
                wafer_radius_ratio=0.45,
                defect_ratio=defect_ratio,
                defect_pattern=defect_pattern
            )
            
            total_generated += 1
            
            # 진행 상황 출력 (100개마다)
            if (img_idx + 1) % 100 == 0 or (img_idx + 1) == end_idx:
                file_size_mb = output_path.stat().st_size / (1024 * 1024)
                print(f"  Progress: {img_idx+1}/{end_idx} ({total_generated}/{num_images}) "
                      f"| Last: {filename} ({image_size}x{image_size}, {file_size_mb:.1f}MB)")
    
    print("\n" + "="*70)
    print("Complete! Generated wafer map images")
    print(f"Location: {target_dir}")
    print(f"Total: {total_generated} images")
    print("="*70)


if __name__ == "__main__":
    main()








