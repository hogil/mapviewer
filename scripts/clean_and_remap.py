"""
폴더의 모든 파일 삭제 후 첫 번째 파일만 재처리 및 복사
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
import shutil
import time

def remap_image_indices(image_path: Path):
    """이미지의 인덱스 9-15를 8-14로 재매핑하고, 인덱스 15를 #000001로 설정"""
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
            
            # 새 팔레트 생성
            new_palette = list(source_palette[:768])
            
            # 인덱스 8-14에 원본 9-15의 색상 복사
            for old_idx in range(9, 15):
                new_idx = old_idx - 1
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
            new_palette[15 * 3] = 0
            new_palette[15 * 3 + 1] = 0
            new_palette[15 * 3 + 2] = 1
            
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


def process_directory(directory: Path, original: Path = None):
    """1. 모든 파일 삭제 2. 첫 번째 파일만 처리 3. 3000개 복사"""
    if not directory.exists():
        print(f"[ERROR] 디렉토리가 없습니다: {directory}")
        return
    
    print("=" * 80)
    print("1단계: 모든 파일 삭제")
    print("=" * 80)
    
    # 모든 PNG 파일 찾기 (백업, 임시 파일 포함)
    all_files = [
        f for f in directory.iterdir() 
        if f.is_file() and f.suffix.lower() == '.png'
    ]
    
    print(f"삭제할 파일: {len(all_files)}개")
    
    deleted_count = 0
    for img_file in all_files:
        try:
            img_file.unlink()
            deleted_count += 1
            if deleted_count % 100 == 0:
                print(f"  삭제 중... {deleted_count}개 완료")
        except Exception as e:
            print(f"  [ERROR] {img_file.name} 삭제 실패: {e}")
    
    print(f"[OK] {deleted_count}개 파일 삭제 완료\n")
    
    # 원본 파일 찾기
    original_file = None
    
    # --original 옵션으로 지정된 경로 확인
    if original:
        original_file = Path(original)
        if not original_file.exists():
            print(f"[ERROR] 지정된 원본 파일이 없습니다: {original_file}")
            print("백업 파일이나 다른 위치에서 원본을 찾아보세요.")
            return
    else:
        # 기본 경로 확인
        default_path = directory / "wafer_palette_5mb_0001.png"
        if default_path.exists():
            original_file = default_path
        else:
            # 백업 파일 확인
            bak_files = [f for f in directory.iterdir() if f.suffix == '.bak']
            if bak_files:
                bak_file = bak_files[0]
                original_file = directory / bak_file.stem
                if not original_file.exists():
                    shutil.copy2(bak_file, original_file)
                    print(f"[OK] 백업 파일에서 복원: {original_file.name}")
    
    if not original_file or not original_file.exists():
        print(f"[ERROR] 원본 파일을 찾을 수 없습니다.")
        print(f"디렉토리: {directory}")
        print("원본 파일 경로를 --original 옵션으로 지정해주세요.")
        return
    
    print("=" * 80)
    print("2단계: 원본 파일 복사 및 처리")
    print("=" * 80)
    
    # 원본 파일을 디렉토리로 복사
    first_file = directory / original_file.name
    try:
        shutil.copy2(original_file, first_file)
        print(f"[OK] 원본 파일 복사: {first_file.name}")
    except Exception as e:
        print(f"[ERROR] 원본 파일 복사 실패: {e}")
        return
    
    # 첫 번째 파일 처리
    print(f"첫 번째 파일 처리 중...")
    if not remap_image_indices(first_file):
        print("[ERROR] 첫 번째 파일 처리 실패")
        return
    
    print(f"[OK] 첫 번째 파일 처리 완료\n")
    
    # 첫 번째 파일을 3000개 복사
    print("=" * 80)
    print("3단계: 첫 번째 파일을 3000개 복사")
    print("=" * 80)
    
    target_count = 3000
    base_name = first_file.stem
    suffix = first_file.suffix
    
    # 숫자 부분 추출
    parts = base_name.rsplit('_', 1)
    if len(parts) == 2 and parts[1].isdigit():
        prefix = parts[0]
        start_num = int(parts[1])
        num_digits = len(parts[1])
    else:
        prefix = base_name
        start_num = 1
        num_digits = 4
    
    copied_count = 0
    for i in range(1, target_count + 1):
        if i == start_num:
            copied_count += 1
            continue
        
        new_name = f"{prefix}_{i:0{num_digits}d}{suffix}"
        new_path = directory / new_name
        
        try:
            shutil.copy2(first_file, new_path)
            copied_count += 1
            if copied_count % 100 == 0:
                print(f"  복사 중... {copied_count}개 완료")
        except Exception as e:
            print(f"  [ERROR] {new_name} 복사 실패: {e}")
    
    print(f"[OK] {copied_count}개 파일 복사 완료")
    print()
    print("=" * 80)
    print("처리 완료")
    print("=" * 80)
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
    
    parser = argparse.ArgumentParser(description="폴더 정리 후 재처리")
    parser.add_argument("directory", type=str, help="이미지 디렉토리 경로")
    parser.add_argument("--original", type=str, help="원본 파일 경로 (선택사항)")
    args = parser.parse_args()
    
    directory = Path(args.directory)
    original_file = Path(args.original) if args.original else None
    
    process_directory(directory, original_file)

