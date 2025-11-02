"""
팔레트 이미지를 3000개 복사하는 스크립트
"""
import shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import time


def copy_file(args):
    """단일 파일 복사"""
    src, dst = args
    shutil.copy2(src, dst)
    return dst.name


def main():
    """메인 함수"""
    print("="*70)
    print("Palette Image Batch Copy - 3000 copies")
    print("="*70)
    
    # 소스 파일
    source_file = Path("D:/project/data/wm-811k/wafer_maps_palette/wafer_palette_5mb.png")
    
    if not source_file.exists():
        print(f"Error: Source file not found: {source_file}")
        return
    
    print(f"\nSource file: {source_file.name}")
    file_size_mb = source_file.stat().st_size / (1024 * 1024)
    print(f"Size: {file_size_mb:.2f} MB")
    
    # 타겟 디렉토리
    target_base = Path("D:/project/data/wm-811k/palette_copies_3k")
    target_base.mkdir(parents=True, exist_ok=True)
    
    # 한 폴더에 3000개 파일 저장
    num_images = 3000
    
    # 복사할 파일 쌍 생성
    copy_tasks = []
    
    for img_idx in range(num_images):
        dst_file = target_base / f"wafer_palette_{img_idx+1:05d}.png"
        copy_tasks.append((source_file, dst_file))
    
    print(f"\nTotal copies to create: {len(copy_tasks)}")
    print(f"Target: {target_base}")
    print(f"Single folder with {num_images} files")
    print("="*70)
    print("\nCopying files...")
    
    # 병렬 복사
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=32) as executor:
        futures = {executor.submit(copy_file, task): i for i, task in enumerate(copy_tasks)}
        
        completed = 0
        for future in as_completed(futures):
            completed += 1
            try:
                filename = future.result()
                if completed % 500 == 0 or completed == len(copy_tasks):
                    elapsed = time.time() - start_time
                    speed = completed / elapsed if elapsed > 0 else 0
                    print(f"  Progress: {completed}/{len(copy_tasks)} ({speed:.1f} files/sec)")
            except Exception as e:
                print(f"Error copying file: {e}")
    
    total_time = time.time() - start_time
    
    print("\n" + "="*70)
    print("Complete!")
    print(f"Total: {len(copy_tasks)} images copied")
    print(f"Time: {total_time:.2f}s ({len(copy_tasks)/total_time:.1f} files/sec)")
    print(f"Location: {target_base}")
    print("="*70)


if __name__ == "__main__":
    main()

