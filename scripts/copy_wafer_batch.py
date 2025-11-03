"""
Wafer Map 이미지 대량 복사 스크립트 (병렬 처리)

기존 wafer_geometric 폴더의 이미지를 3000개 복사
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
    print("Wafer Map Batch Copy - 3000 images")
    print("="*70)
    
    # 소스 파일
    source_dir = Path("wafer_geometric")
    source_files = list(source_dir.glob("*.jpg"))
    
    if not source_files:
        print(f"Error: No files found in {source_dir}")
        return
    
    print(f"\nSource files: {len(source_files)}")
    for f in source_files:
        print(f"  - {f.name}")
    
    # 타겟 디렉토리
    target_base = Path("D:/project/data/wm-811k/wafer_maps_3k")
    target_base.mkdir(parents=True, exist_ok=True)
    
    # 서브폴더로 분산 저장
    num_images = 3000
    images_per_folder = 1000
    num_folders = (num_images + images_per_folder - 1) // images_per_folder
    
    # 복사할 파일 쌍 생성
    copy_tasks = []
    file_count = 0
    
    for folder_idx in range(num_folders):
        subfolder = target_base / f"batch_{folder_idx+1:02d}"
        subfolder.mkdir(exist_ok=True)
        
        start_idx = folder_idx * images_per_folder
        end_idx = min(start_idx + images_per_folder, num_images)
        
        for img_idx in range(start_idx, end_idx):
            # 순환하면서 소스 파일 선택
            src_file = source_files[file_count % len(source_files)]
            dst_file = subfolder / f"wafer_{img_idx+1:05d}.jpg"
            copy_tasks.append((src_file, dst_file))
            file_count += 1
    
    print(f"\nTotal copies to create: {len(copy_tasks)}")
    print(f"Target: {target_base}")
    print(f"Subfolders: {num_folders} folders")
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








