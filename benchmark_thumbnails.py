"""
썸네일 생성 방식 벤치마크
4가지 방식으로 1000개 이미지 썸네일 생성 시간 비교

방식 1: 팔레트 PNG 썸네일 생성 → change scheme 적용
방식 2: change scheme 적용 → 현재 방식 썸네일 생성
방식 3: 현재 방식 썸네일 생성 → 팔레트 PNG → change scheme 적용
방식 4: 현재 방식 썸네일 생성만 (Base - 개인색 적용 없음)
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
OUTPUT_DIR = Path(r"D:\project\mapviewer\benchmark_output")
COLOR_LEGENDS_PATH = Path(r"D:\project\mapviewer\logs\color-legends.json")
THUMBNAIL_SIZE = 512
NUM_IMAGES = 1000

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

def method1_palette_then_change(image_paths, output_dir, change_palette):
    """
    방식 1: 팔레트 PNG 썸네일 생성 → change scheme 적용
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            # 1. 원본 로드
            img = Image.open(img_path)

            # 2. 팔레트 모드 확인
            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 3. 팔레트 PNG 썸네일 생성 (NEAREST로 팔레트 유지)
            w = int(img.width * THUMBNAIL_SIZE / max(img.width, img.height))
            h = int(img.height * THUMBNAIL_SIZE / max(img.width, img.height))
            thumb = img.resize((w, h), Image.Resampling.NEAREST)

            # 4. change scheme 팔레트 적용
            thumb.putpalette(change_palette)

            # 5. RGB 변환 후 JPEG 저장
            thumb_rgb = thumb.convert('RGB')
            output_path = output_dir / f"{img_path.stem}.jpg"
            thumb_rgb.save(output_path, 'JPEG', quality=100)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def method2_change_then_thumbnail(image_paths, output_dir, change_palette):
    """
    방식 2: change scheme 적용 → 현재 방식 썸네일 생성
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            # 1. 원본 로드
            img = Image.open(img_path)

            # 2. 팔레트 모드 확인
            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 3. change scheme 팔레트 적용
            img.putpalette(change_palette)

            # 4. RGB 변환
            img_rgb = img.convert('RGB')

            # 5. 현재 방식 썸네일 생성 (BICUBIC)
            w = int(img_rgb.width * THUMBNAIL_SIZE / max(img_rgb.width, img_rgb.height))
            h = int(img_rgb.height * THUMBNAIL_SIZE / max(img_rgb.width, img_rgb.height))
            thumb = img_rgb.resize((w, h), Image.Resampling.BICUBIC)

            # 6. JPEG 저장
            output_path = output_dir / f"{img_path.stem}.jpg"
            thumb.save(output_path, 'JPEG', quality=100)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def method3_thumbnail_palette_change(image_paths, output_dir, change_palette):
    """
    방식 3: 현재 방식 썸네일 생성 → 팔레트 PNG → change scheme 적용
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            # 1. 원본 로드
            img = Image.open(img_path)

            # 2. 팔레트 모드 확인
            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 3. 원본 팔레트 저장
            original_palette = img.getpalette()

            # 4. RGB 변환
            img_rgb = img.convert('RGB')

            # 5. 현재 방식 썸네일 생성 (BICUBIC)
            w = int(img_rgb.width * THUMBNAIL_SIZE / max(img_rgb.width, img_rgb.height))
            h = int(img_rgb.height * THUMBNAIL_SIZE / max(img_rgb.width, img_rgb.height))
            thumb_rgb = img_rgb.resize((w, h), Image.Resampling.BICUBIC)

            # 6. RGB → P 변환 (quantize)
            thumb_p = thumb_rgb.quantize(colors=256)

            # 7. change scheme 팔레트 적용
            thumb_p.putpalette(change_palette)

            # 8. RGB 변환 후 JPEG 저장
            thumb_final = thumb_p.convert('RGB')
            output_path = output_dir / f"{img_path.stem}.jpg"
            thumb_final.save(output_path, 'JPEG', quality=100)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def method4_base_thumbnail(image_paths, output_dir):
    """
    방식 4: 현재 방식 썸네일 생성만 (Base - 개인색 적용 없음)
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    for img_path in image_paths:
        try:
            # 1. 원본 로드
            img = Image.open(img_path)

            # 2. 팔레트 모드 확인
            if img.mode != 'P':
                print(f"경고: {img_path.name}은 팔레트 모드가 아님 (mode={img.mode})")
                continue

            # 3. RGB 변환
            img_rgb = img.convert('RGB')

            # 4. 현재 방식 썸네일 생성 (BICUBIC)
            w = int(img_rgb.width * THUMBNAIL_SIZE / max(img_rgb.width, img_rgb.height))
            h = int(img_rgb.height * THUMBNAIL_SIZE / max(img_rgb.width, img_rgb.height))
            thumb = img_rgb.resize((w, h), Image.Resampling.BICUBIC)

            # 5. JPEG 저장
            output_path = output_dir / f"{img_path.stem}.jpg"
            thumb.save(output_path, 'JPEG', quality=100)

        except Exception as e:
            print(f"오류 ({img_path.name}): {e}")

    elapsed = time.time() - start_time
    return elapsed

def main():
    print("=" * 80)
    print("썸네일 생성 방식 벤치마크")
    print("=" * 80)
    print(f"소스 디렉토리: {SOURCE_DIR}")
    print(f"출력 디렉토리: {OUTPUT_DIR}")
    print(f"이미지 개수: {NUM_IMAGES}개")
    print(f"썸네일 크기: {THUMBNAIL_SIZE}px")
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

    # 1000개만 선택
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

    # 방식 1
    print("[1/3] 방식 1: 팔레트 PNG 썸네일 생성 -> change scheme 적용")
    output_dir1 = OUTPUT_DIR / "method1"
    time1 = method1_palette_then_change(image_files, output_dir1, change_palette)
    results['method1'] = time1
    print(f"[OK] 완료: {time1:.2f}초 ({time1/len(image_files)*1000:.1f}ms/이미지)")
    print()

    # 방식 2
    print("[2/3] 방식 2: change scheme 적용 -> 현재 방식 썸네일 생성")
    output_dir2 = OUTPUT_DIR / "method2"
    time2 = method2_change_then_thumbnail(image_files, output_dir2, change_palette)
    results['method2'] = time2
    print(f"[OK] 완료: {time2:.2f}초 ({time2/len(image_files)*1000:.1f}ms/이미지)")
    print()

    # 방식 3
    print("[3/4] 방식 3: 현재 방식 썸네일 생성 -> 팔레트 PNG -> change scheme 적용")
    output_dir3 = OUTPUT_DIR / "method3"
    time3 = method3_thumbnail_palette_change(image_files, output_dir3, change_palette)
    results['method3'] = time3
    print(f"[OK] 완료: {time3:.2f}초 ({time3/len(image_files)*1000:.1f}ms/이미지)")
    print()

    # 방식 4
    print("[4/4] 방식 4: 현재 방식 썸네일 생성만 (Base)")
    output_dir4 = OUTPUT_DIR / "method4"
    time4 = method4_base_thumbnail(image_files, output_dir4)
    results['method4'] = time4
    print(f"[OK] 완료: {time4:.2f}초 ({time4/len(image_files)*1000:.1f}ms/이미지)")
    print()

    # 결과 요약
    print("=" * 80)
    print("벤치마크 결과 요약")
    print("=" * 80)
    print(f"방식 1 (팔레트 썸네일 → change):   {time1:.2f}초 ({time1/len(image_files)*1000:.1f}ms/이미지)")
    print(f"방식 2 (change → 썸네일):         {time2:.2f}초 ({time2/len(image_files)*1000:.1f}ms/이미지)")
    print(f"방식 3 (썸네일 → 팔레트 → change): {time3:.2f}초 ({time3/len(image_files)*1000:.1f}ms/이미지)")
    print(f"방식 4 (썸네일만 - Base):         {time4:.2f}초 ({time4/len(image_files)*1000:.1f}ms/이미지)")
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

    print(f"출력 디렉토리: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
