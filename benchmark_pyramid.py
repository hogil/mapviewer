"""
피라미드 생성 방식 벤치마크
4가지 방식으로 10개 이미지의 피라미드 레벨 생성 시간 비교

방식 1: 팔레트 PNG 피라미드 생성 → change scheme 적용
방식 2: change scheme 적용 → 현재 방식 피라미드 생성
방식 3: 현재 방식 피라미드 생성 → 팔레트 PNG → change scheme 적용
방식 4: 현재 방식 피라미드 생성만 (Base - 개인색 적용 없음)
"""

import os
import sys
import time
import json
from pathlib import Path
from PIL import Image
import shutil

# 프로젝트 루트 추가
sys.path.insert(0, str(Path(__file__).parent))

# 설정
SOURCE_DIR = Path(r"D:\project\data\wm-811k\palette_copies_3k")
OUTPUT_DIR = Path(r"D:\project\mapviewer\benchmark_pyramid_output")
COLOR_LEGENDS_PATH = Path(r"D:\project\mapviewer\logs\color-legends.json")
PYRAMID_LEVELS = [0.2, 0.5, 0.7, 1.0]
NUM_IMAGES = 10

# 출력 디렉토리 생성
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def load_color_legends():
    """color-legends.json 로드"""
    with open(COLOR_LEGENDS_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def get_change_palette(legends):
    """change scheme의 팔레트 생성"""
    scheme_data = legends['change']
    palette = []

    # Top colors (Grade0-7)
    for item in scheme_data['top']:
        color = item['color'].lstrip('#')
        r = int(color[0:2], 16)
        g = int(color[2:4], 16)
        b = int(color[4:6], 16)
        palette.extend([r, g, b])

    # Bottom colors
    for item in scheme_data['bottom']:
        color = item['color'].lstrip('#')
        r = int(color[0:2], 16)
        g = int(color[2:4], 16)
        b = int(color[4:6], 16)
        palette.extend([r, g, b])

    # Pad to 256 colors
    while len(palette) < 768:
        palette.extend([0, 0, 0])

    return palette

def method1_palette_pyramid_change(image_paths, output_dir, change_palette):
    """
    방식 1: 팔레트 PNG 피라미드 생성 → change scheme 적용
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            img = Image.open(img_path)

            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            for level in PYRAMID_LEVELS:
                # 1. 팔레트 PNG 피라미드 생성 (NEAREST로 팔레트 유지)
                new_w = max(1, int(img.width * level))
                new_h = max(1, int(img.height * level))
                pyramid = img.resize((new_w, new_h), Image.Resampling.NEAREST)

                # 2. change scheme 팔레트 적용
                pyramid.putpalette(change_palette)

                # 3. RGB 변환 후 JPEG 저장
                pyramid_rgb = pyramid.convert('RGB')
                output_path = output_dir / f"{img_path.stem}_L{int(level*100)}.jpg"
                pyramid_rgb.save(output_path, 'JPEG', quality=95)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def method2_change_pyramid(image_paths, output_dir, change_palette):
    """
    방식 2: change scheme 적용 → 현재 방식 피라미드 생성 (BICUBIC)
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            img = Image.open(img_path)

            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 1. change scheme 팔레트 적용
            img.putpalette(change_palette)

            # 2. RGB 변환
            img_rgb = img.convert('RGB')

            for level in PYRAMID_LEVELS:
                # 3. 현재 방식 피라미드 생성 (BICUBIC)
                new_w = max(1, int(img_rgb.width * level))
                new_h = max(1, int(img_rgb.height * level))
                pyramid = img_rgb.resize((new_w, new_h), Image.Resampling.BICUBIC)

                # 4. JPEG 저장
                output_path = output_dir / f"{img_path.stem}_L{int(level*100)}.jpg"
                pyramid.save(output_path, 'JPEG', quality=95)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def method3_pyramid_palette_change(image_paths, output_dir, change_palette):
    """
    방식 3: 현재 방식 피라미드 생성 (BICUBIC) → 팔레트 PNG → change scheme 적용
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            img = Image.open(img_path)

            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 1. RGB 변환
            img_rgb = img.convert('RGB')

            for level in PYRAMID_LEVELS:
                # 2. 현재 방식 피라미드 생성 (BICUBIC)
                new_w = max(1, int(img_rgb.width * level))
                new_h = max(1, int(img_rgb.height * level))
                pyramid_rgb = img_rgb.resize((new_w, new_h), Image.Resampling.BICUBIC)

                # 3. RGB → P 변환 (quantize)
                pyramid_p = pyramid_rgb.quantize(colors=256)

                # 4. change scheme 팔레트 적용
                pyramid_p.putpalette(change_palette)

                # 5. RGB 변환 후 JPEG 저장
                pyramid_final = pyramid_p.convert('RGB')
                output_path = output_dir / f"{img_path.stem}_L{int(level*100)}.jpg"
                pyramid_final.save(output_path, 'JPEG', quality=95)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def method4_base_pyramid(image_paths, output_dir):
    """
    방식 4: 현재 방식 피라미드 생성만 (Base - 개인색 적용 없음)
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            img = Image.open(img_path)

            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 1. RGB 변환
            img_rgb = img.convert('RGB')

            for level in PYRAMID_LEVELS:
                # 2. 현재 방식 피라미드 생성 (BICUBIC)
                new_w = max(1, int(img_rgb.width * level))
                new_h = max(1, int(img_rgb.height * level))
                pyramid = img_rgb.resize((new_w, new_h), Image.Resampling.BICUBIC)

                # 3. JPEG 저장
                output_path = output_dir / f"{img_path.stem}_L{int(level*100)}.jpg"
                pyramid.save(output_path, 'JPEG', quality=95)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def main():
    print("=" * 80)
    print("피라미드 생성 방식 벤치마크")
    print("=" * 80)
    print(f"소스 디렉토리: {SOURCE_DIR}")
    print(f"출력 디렉토리: {OUTPUT_DIR}")
    print(f"이미지 개수: {NUM_IMAGES}개")
    print(f"피라미드 레벨: {PYRAMID_LEVELS}")
    print()

    # 소스 디렉토리 확인
    if not SOURCE_DIR.exists():
        print(f"오류: 소스 디렉토리가 존재하지 않습니다: {SOURCE_DIR}")
        return

    # 이미지 파일 목록 가져오기
    image_files = list(SOURCE_DIR.glob("*.png"))
    if len(image_files) == 0:
        print(f"오류: 소스 디렉토리에 PNG 파일이 없습니다: {SOURCE_DIR}")
        return

    # 10개만 선택
    image_files = image_files[:NUM_IMAGES]
    print(f"선택된 이미지: {len(image_files)}개")
    print()

    # color-legends 로드
    print("color-legends.json 로딩...")
    legends = load_color_legends()
    change_palette = get_change_palette(legends)
    print(f"change scheme 팔레트 생성 완료 (색상 수: {len(change_palette)//3})")
    print()

    # 출력 디렉토리 정리
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 벤치마크 실행
    results = {}
    total_pyramids = len(image_files) * len(PYRAMID_LEVELS)

    # 방식 1
    print("[1/3] 방식 1: 팔레트 PNG 피라미드 생성 -> change scheme 적용")
    output_dir1 = OUTPUT_DIR / "method1"
    time1 = method1_palette_pyramid_change(image_files, output_dir1, change_palette)
    results['method1'] = time1
    print(f"[OK] 완료: {time1:.2f}초 ({time1/total_pyramids*1000:.1f}ms/피라미드)")
    print()

    # 방식 2
    print("[2/3] 방식 2: change scheme 적용 -> 현재 방식 피라미드 생성")
    output_dir2 = OUTPUT_DIR / "method2"
    time2 = method2_change_pyramid(image_files, output_dir2, change_palette)
    results['method2'] = time2
    print(f"[OK] 완료: {time2:.2f}초 ({time2/total_pyramids*1000:.1f}ms/피라미드)")
    print()

    # 방식 3
    print("[3/4] 방식 3: 현재 방식 피라미드 생성 -> 팔레트 PNG -> change scheme 적용")
    output_dir3 = OUTPUT_DIR / "method3"
    time3 = method3_pyramid_palette_change(image_files, output_dir3, change_palette)
    results['method3'] = time3
    print(f"[OK] 완료: {time3:.2f}초 ({time3/total_pyramids*1000:.1f}ms/피라미드)")
    print()

    # 방식 4
    print("[4/4] 방식 4: 현재 방식 피라미드 생성만 (Base)")
    output_dir4 = OUTPUT_DIR / "method4"
    time4 = method4_base_pyramid(image_files, output_dir4)
    results['method4'] = time4
    print(f"[OK] 완료: {time4:.2f}초 ({time4/total_pyramids*1000:.1f}ms/피라미드)")
    print()

    # 결과 요약
    print("=" * 80)
    print("벤치마크 결과 요약")
    print("=" * 80)
    print(f"방식 1 (팔레트 피라미드 → change):    {time1:.2f}초 ({time1/total_pyramids*1000:.1f}ms/피라미드)")
    print(f"방식 2 (change → 피라미드):          {time2:.2f}초 ({time2/total_pyramids*1000:.1f}ms/피라미드)")
    print(f"방식 3 (피라미드 → 팔레트 → change): {time3:.2f}초 ({time3/total_pyramids*1000:.1f}ms/피라미드)")
    print(f"방식 4 (피라미드만 - Base):          {time4:.2f}초 ({time4/total_pyramids*1000:.1f}ms/피라미드)")
    print()

    # 가장 빠른 방식
    fastest = min(results.items(), key=lambda x: x[1])
    print(f"[WINNER] 가장 빠른 방식: {fastest[0]} ({fastest[1]:.2f}초)")
    print()

    # 상대 속도
    baseline = time4  # 방식 4 (Base)를 기준으로
    print("상대 속도 (방식 4 Base 기준):")
    print(f"  방식 1: {time1/baseline*100:.1f}%")
    print(f"  방식 2: {time2/baseline*100:.1f}%")
    print(f"  방식 3: {time3/baseline*100:.1f}%")
    print(f"  방식 4: 100.0% (기준)")
    print()

    # 이미지당 평균 시간
    print(f"이미지당 평균 시간 (레벨 {len(PYRAMID_LEVELS)}개):")
    print(f"  방식 1: {time1/len(image_files):.3f}초")
    print(f"  방식 2: {time2/len(image_files):.3f}초")
    print(f"  방식 3: {time3/len(image_files):.3f}초")
    print(f"  방식 4: {time4/len(image_files):.3f}초")
    print()

    print(f"출력 디렉토리: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
