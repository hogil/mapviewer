"""
팔레트 인덱스 재매핑 스크립트
인덱스 9-15를 8-14로 당기고, 인덱스 15를 #000001로 설정
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

def remap_image_indices(image_path: Path, output_dir: Path = None):
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
            # 인덱스 9 → 8, 10 → 9, ..., 15 → 14
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
            
            # 저장
            if output_dir:
                output_path = output_dir / image_path.name
            else:
                output_path = image_path  # 원본 덮어쓰기
            
            # 백업 생성 (원본 덮어쓰기 전)
            if output_path == image_path:
                backup_path = image_path.with_suffix('.png.bak')
                if not backup_path.exists():
                    img.save(backup_path, format='PNG', optimize=False, compress_level=0)
            
            new_img.save(output_path, format='PNG', optimize=False, compress_level=0)
            
            return True
            
    except Exception as e:
        print(f"[ERROR] {image_path.name}: {e}")
        return False


def process_directory(directory: Path, max_workers: int = 8):
    """디렉토리의 모든 PNG 이미지 처리"""
    if not directory.exists():
        print(f"[ERROR] 디렉토리가 없습니다: {directory}")
        return
    
    image_files = sorted([
        f for f in directory.iterdir() 
        if f.is_file() and f.suffix.lower() == '.png'
    ])
    
    if not image_files:
        print(f"[ERROR] 이미지가 없습니다: {directory}")
        return
    
    print("=" * 80)
    print(f"팔레트 인덱스 재매핑 시작")
    print("=" * 80)
    print(f"디렉토리: {directory}")
    print(f"이미지 개수: {len(image_files)}개")
    print(f"워커 수: {max_workers}개")
    print()
    
    start_time = time.time()
    success_count = 0
    fail_count = 0
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_file = {
            executor.submit(remap_image_indices, img_file): img_file
            for img_file in image_files
        }
        
        for future in as_completed(future_to_file):
            img_file = future_to_file[future]
            try:
                success = future.result()
                if success:
                    success_count += 1
                    if success_count % 10 == 0:
                        print(f"  처리 중... {success_count}개 완료")
                else:
                    fail_count += 1
            except Exception as e:
                print(f"[ERROR] {img_file.name}: {e}")
                fail_count += 1
    
    elapsed_time = time.time() - start_time
    
    print()
    print("=" * 80)
    print("처리 완료")
    print("=" * 80)
    print(f"성공: {success_count}개")
    print(f"실패: {fail_count}개")
    print(f"총 처리 시간: {elapsed_time:.2f}초")
    print(f"평균 처리 시간: {elapsed_time/len(image_files):.3f}초/개")
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
    print()
    print("원본 파일은 .png.bak으로 백업되었습니다.")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="팔레트 인덱스 재매핑")
    parser.add_argument("directory", type=str, help="이미지 디렉토리 경로")
    parser.add_argument("--workers", type=int, default=8, help="병렬 처리 워커 수")
    args = parser.parse_args()
    
    directory = Path(args.directory)
    process_directory(directory, max_workers=args.workers)

