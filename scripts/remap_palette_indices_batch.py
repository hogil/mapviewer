"""
팔레트 인덱스 재매핑 스크립트 (배치 복사 방식)
첫 번째 파일만 변경하고 나머지는 삭제 후 복사
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
import shutil
import time

def remap_image_indices(image_path: Path):
    """
    이미지의 인덱스 9-15를 8-14로 재매핑하고, 인덱스 15를 #000001로 설정
    
    매핑:
    - 인덱스 9 → 8
    - 인덱스 10 → 9
    - 인덱스 11 → 10
    - 인덱스 12 → 11
    - 인덱스 13 → 12
    - 인덱스 14 → 13
    - 인덱스 15 → 14
    - 인덱스 15 (새로운) → #000001
    """
    try:
        with Image.open(image_path) as img:
            if img.mode != 'P':
                print(f"[SKIP] {image_path.name}: 팔레트 모드가 아님 ({img.mode})")
                return False
            
            # 픽셀 인덱스 추출
            pixel_indices = np.array(img, dtype=np.uint8)
            
            # 인덱스 재매핑: 9-15를 8-14로 당기기
            remapped = pixel_indices.copy()
            
            # 인덱스 9-15를 8-14로 매핑
            for old_idx in range(9, 16):
                new_idx = old_idx - 1
                mask = (pixel_indices == old_idx)
                remapped[mask] = new_idx
            
            # 원본 팔레트 가져오기
            source_palette = img.getpalette()
            
            # 새 팔레트 생성 (768개 값 = 256 * 3)
            new_palette = list(source_palette[:768])  # 기존 팔레트 복사
            
            # 인덱스 8-14에 원본 9-15의 색상 복사
            for old_idx in range(9, 15):
                new_idx = old_idx - 1
                # RGB 값 복사 (old_idx * 3부터 3개 값)
                old_rgb_start = old_idx * 3
                new_rgb_start = new_idx * 3
                if old_rgb_start + 2 < len(source_palette):
                    new_palette[new_rgb_start] = source_palette[old_rgb_start]
                    new_palette[new_rgb_start + 1] = source_palette[old_rgb_start + 1]
                    new_palette[new_rgb_start + 2] = source_palette[old_rgb_start + 2]
            
            # 인덱스 14에 원본 15의 색상 복사
            if 15 * 3 + 2 < len(source_palette):
                new_palette[14 * 3] = source_palette[15 * 3]
                new_palette[14 * 3 + 1] = source_palette[15 * 3 + 1]
                new_palette[14 * 3 + 2] = source_palette[15 * 3 + 2]
            
            # 인덱스 15를 #000001로 설정
            new_palette[15 * 3] = 0      # R
            new_palette[15 * 3 + 1] = 0  # G
            new_palette[15 * 3 + 2] = 1  # B
            
            # 새 이미지 생성
            new_img = Image.fromarray(remapped, mode='P')
            new_img.putpalette(new_palette)
            
            # 임시 파일로 저장 후 교체
            temp_path = image_path.with_suffix('.tmp.png')
            new_img.save(temp_path, format='PNG', optimize=False, compress_level=0)
            new_img.close()
            
            # 원본 파일 삭제 후 임시 파일을 원본 이름으로 변경
            if image_path.exists():
                image_path.unlink()
            temp_path.rename(image_path)
            
            return True
            
    except Exception as e:
        print(f"[ERROR] {image_path.name}: {e}")
        return False


def process_directory(directory: Path):
    """디렉토리의 모든 PNG 이미지 처리 (첫 번째만 변경 후 복사)"""
    if not directory.exists():
        print(f"[ERROR] 디렉토리가 없습니다: {directory}")
        return
    
    image_files = sorted([
        f for f in directory.iterdir() 
        if f.is_file() and f.suffix.lower() == '.png' and not f.name.endswith('.bak')
    ])
    
    if not image_files:
        print(f"[ERROR] 이미지가 없습니다: {directory}")
        return
    
    print("=" * 80)
    print(f"팔레트 인덱스 재매핑 시작 (배치 복사 방식)")
    print("=" * 80)
    print(f"디렉토리: {directory}")
    print(f"이미지 개수: {len(image_files)}개")
    print()
    
    start_time = time.time()
    
    # 첫 번째 파일 처리
    first_file = image_files[0]
    print(f"1. 첫 번째 파일 처리: {first_file.name}")
    if not remap_image_indices(first_file):
        print("[ERROR] 첫 번째 파일 처리 실패")
        return
    
    print(f"   [OK] 첫 번째 파일 처리 완료")
    
    # 나머지 파일 삭제
    print(f"\n2. 나머지 {len(image_files) - 1}개 파일 삭제 중...")
    deleted_count = 0
    for img_file in image_files[1:]:
        try:
            img_file.unlink()
            deleted_count += 1
            if deleted_count % 100 == 0:
                print(f"   삭제 중... {deleted_count}개 완료")
        except Exception as e:
            print(f"   [ERROR] {img_file.name} 삭제 실패: {e}")
    
    print(f"   [OK] {deleted_count}개 파일 삭제 완료")
    
    # 첫 번째 파일을 3000개 복사
    target_count = 3000
    print(f"\n3. 첫 번째 파일을 {target_count}개 복사 중...")
    
    # 파일명 패턴 추출
    # 예: wafer_palette_5mb_0001.png -> wafer_palette_5mb_{:04d}.png
    base_name = first_file.stem  # wafer_palette_5mb_0001
    suffix = first_file.suffix   # .png
    
    # 숫자 부분 추출
    parts = base_name.rsplit('_', 1)
    if len(parts) == 2 and parts[1].isdigit():
        prefix = parts[0]  # wafer_palette_5mb
        start_num = int(parts[1])  # 1
        num_digits = len(parts[1])  # 4
    else:
        # 숫자 패턴을 찾을 수 없으면 기본 패턴 사용
        prefix = base_name
        start_num = 1
        num_digits = 4
    
    copied_count = 0
    for i in range(1, target_count + 1):
        if i == start_num:
            # 첫 번째 파일은 이미 처리됨
            copied_count += 1
            continue
        
        new_name = f"{prefix}_{i:0{num_digits}d}{suffix}"
        new_path = directory / new_name
        
        try:
            shutil.copy2(first_file, new_path)
            copied_count += 1
            if copied_count % 100 == 0:
                print(f"   복사 중... {copied_count}개 완료")
        except Exception as e:
            print(f"   [ERROR] {new_name} 복사 실패: {e}")
    
    elapsed_time = time.time() - start_time
    
    print()
    print("=" * 80)
    print("처리 완료")
    print("=" * 80)
    print(f"첫 번째 파일 처리: {first_file.name}")
    print(f"삭제된 파일: {deleted_count}개")
    print(f"복사된 파일: {copied_count}개")
    print(f"총 처리 시간: {elapsed_time:.2f}초")
    print()
    print("인덱스 재매핑:")
    print("  인덱스 9 → 8")
    print("  인덱스 10 → 9")
    print("  인덱스 11 → 10")
    print("  인덱스 12 → 11")
    print("  인덱스 13 → 12")
    print("  인덱스 14 → 13")
    print("  인덱스 15 → 14")
    print("  인덱스 15 (새로운) → #000001")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="팔레트 인덱스 재매핑 (배치 복사)")
    parser.add_argument("directory", type=str, help="이미지 디렉토리 경로")
    args = parser.parse_args()
    
    directory = Path(args.directory)
    process_directory(directory)

