"""
이미지 파일을 3000개 복사
"""
import sys
from pathlib import Path
import shutil
import time

def copy_image_3000(source_path: Path, target_dir: Path, target_count: int = 3000):
    """이미지 파일을 지정된 개수만큼 복사"""
    if not source_path.exists():
        print(f"[ERROR] 원본 파일이 없습니다: {source_path}")
        return False
    
    if not target_dir.exists():
        print(f"[ERROR] 대상 디렉토리가 없습니다: {target_dir}")
        return False
    
    print("=" * 80)
    print("이미지 파일 복사")
    print("=" * 80)
    print(f"원본 파일: {source_path.name}")
    print(f"대상 디렉토리: {target_dir}")
    print(f"복사할 개수: {target_count}개")
    print()
    
    # 파일명 패턴 추출
    base_name = source_path.stem  # wafer_palette_5mb_0000
    suffix = source_path.suffix   # .png
    
    # 숫자 부분 추출
    parts = base_name.rsplit('_', 1)
    if len(parts) == 2 and parts[1].isdigit():
        prefix = parts[0]  # wafer_palette_5mb
        start_num = int(parts[1])  # 0
        num_digits = len(parts[1])  # 4
    else:
        prefix = base_name
        start_num = 0
        num_digits = 4
    
    start_time = time.time()
    copied_count = 0
    skipped_count = 0
    
    for i in range(target_count):
        if i == start_num:
            # 원본 파일은 건너뛰기
            skipped_count += 1
            continue
        
        new_name = f"{prefix}_{i:0{num_digits}d}{suffix}"
        new_path = target_dir / new_name
        
        # 이미 존재하는 파일은 건너뛰기
        if new_path.exists():
            skipped_count += 1
            continue
        
        try:
            shutil.copy2(source_path, new_path)
            copied_count += 1
            if copied_count % 100 == 0:
                print(f"  복사 중... {copied_count}개 완료")
        except Exception as e:
            print(f"  [ERROR] {new_name} 복사 실패: {e}")
    
    elapsed_time = time.time() - start_time
    
    print()
    print("=" * 80)
    print("복사 완료")
    print("=" * 80)
    print(f"복사된 파일: {copied_count}개")
    print(f"건너뛴 파일: {skipped_count}개")
    print(f"총 처리 시간: {elapsed_time:.2f}초")
    if copied_count > 0:
        print(f"평균 복사 시간: {elapsed_time/copied_count:.3f}초/개")
    
    return True


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="이미지 파일 3000개 복사")
    parser.add_argument("source", type=str, help="원본 파일 경로")
    parser.add_argument("--target-dir", type=str, help="대상 디렉토리 (기본값: 원본 파일과 같은 디렉토리)")
    parser.add_argument("--count", type=int, default=3000, help="복사할 개수 (기본값: 3000)")
    args = parser.parse_args()
    
    source_path = Path(args.source)
    if args.target_dir:
        target_dir = Path(args.target_dir)
    else:
        target_dir = source_path.parent
    
    copy_image_3000(source_path, target_dir, args.count)

