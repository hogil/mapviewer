"""
Wafer 이미지 파일을 랜덤 비복원 추출로 3000개 복사하는 스크립트

- 원본 폴더: D:\project\data\wm-811k\palette_5mb
- 목표 폴더: D:\project\data\wm-811k\palette_copies_3k
- 3000개 파일을 랜덤 비복원 추출로 복사
"""
import random
import shutil
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed


def copy_file(src_path: Path, dst_path: Path) -> tuple:
    """파일 복사"""
    try:
        shutil.copy2(src_path, dst_path)
        return (True, dst_path.name, None)
    except Exception as e:
        return (False, dst_path.name, str(e))


def main():
    """메인 함수"""
    print("="*80)
    print("Wafer 이미지 파일 랜덤 복사 (3000개)")
    print("="*80)
    
    # 원본 폴더
    source_dir = Path("D:/project/data/wm-811k/palette_5mb")
    if not source_dir.exists():
        print(f"[ERROR] 원본 폴더를 찾을 수 없습니다: {source_dir}")
        return
    
    # 목표 폴더
    target_dir = Path("D:/project/data/wm-811k/palette_copies_3k")
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # 원본 파일 수집
    source_files = list(source_dir.glob("*.png"))
    if not source_files:
        print(f"[ERROR] 원본 폴더에 PNG 파일이 없습니다: {source_dir}")
        return
    
    print(f"\n[INFO] 원본 폴더: {source_dir}")
    print(f"[INFO] 목표 폴더: {target_dir}")
    print(f"[INFO] 원본 파일 수: {len(source_files)}개")
    for i, f in enumerate(source_files, 1):
        size_mb = f.stat().st_size / (1024 * 1024)
        print(f"  {i}. {f.name} ({size_mb:.2f}MB)")
    
    # 3000개 생성 (비복원 추출: 원본 파일들을 반복 사용하되 랜덤 순서로)
    target_count = 3000
    print(f"\n[INFO] 목표 파일 수: {target_count}개")
    print(f"[INFO] 복사 방식: 비복원 추출로 랜덤 순서 복사")
    
    # 원본 파일을 충분히 반복해서 리스트 생성
    # 각 원본 파일을 약 target_count / len(source_files) 번 사용
    file_pool = []
    files_per_source = target_count // len(source_files)
    remainder = target_count % len(source_files)
    
    for source_file in source_files:
        # 기본 반복 횟수
        count = files_per_source
        # 나머지 분배
        if remainder > 0:
            count += 1
            remainder -= 1
        file_pool.extend([source_file] * count)
    
    # 비복원 추출로 랜덤하게 섞기
    random.shuffle(file_pool)
    
    # 정확히 3000개만 사용
    file_pool = file_pool[:target_count]
    
    print(f"[INFO] 파일 풀 생성 완료: {len(file_pool)}개")
    
    # 파일명 생성 (0~2999가 아닌 랜덤 숫자 사용)
    # 중복 방지를 위해 set 사용
    used_numbers = set()
    max_attempts = 100000
    file_tasks = []
    
    for source_file in file_pool:
        # 랜덤 숫자 생성 (0~999999 범위에서 충분히 큰 범위 사용)
        attempts = 0
        while attempts < max_attempts:
            random_num = random.randint(0, 999999)
            if random_num not in used_numbers:
                used_numbers.add(random_num)
                dst_filename = f"wafer_{random_num:06d}.png"
                dst_path = target_dir / dst_filename
                file_tasks.append((source_file, dst_path))
                break
            attempts += 1
        
        if attempts >= max_attempts:
            print(f"[WARN] 파일명 생성 실패 (너무 많은 시도), 순차 번호 사용")
            # 순차 번호 사용 (fallback)
            fallback_num = len(file_tasks)
            dst_filename = f"wafer_{fallback_num:06d}.png"
            dst_path = target_dir / dst_filename
            file_tasks.append((source_file, dst_path))
    
    print(f"[INFO] 파일명 생성 완료: {len(file_tasks)}개")
    
    # 병렬 복사 시작
    max_workers = 8
    print(f"\n[INFO] 병렬 복사 시작 ({max_workers} workers)...")
    
    start_time = time.time()
    success_count = 0
    error_count = 0
    errors = []
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # 모든 작업 제출
        future_to_task = {
            executor.submit(copy_file, src, dst): (src.name, dst.name)
            for src, dst in file_tasks
        }
        
        # 완료된 작업 처리
        completed = 0
        for future in as_completed(future_to_task):
            completed += 1
            src_name, dst_name = future_to_task[future]
            
            try:
                success, filename, error = future.result()
                if success:
                    success_count += 1
                    if completed % 500 == 0 or completed == len(file_tasks):
                        progress = (completed / len(file_tasks)) * 100
                        print(f"  [진행] {completed}/{len(file_tasks)} ({progress:.1f}%) - 성공: {success_count}, 실패: {error_count}")
                else:
                    error_count += 1
                    errors.append((filename, error))
            except Exception as e:
                error_count += 1
                errors.append((dst_name, str(e)))
    
    elapsed = time.time() - start_time
    
    # 결과 출력
    print("\n" + "="*80)
    print("[RESULT] 복사 완료!")
    print(f"  성공: {success_count}/{target_count}개 파일")
    print(f"  실패: {error_count}개 파일")
    print(f"  소요 시간: {elapsed:.1f}초")
    if success_count > 0:
        avg_time = elapsed / success_count
        throughput = success_count / elapsed if elapsed > 0 else 0
        print(f"  평균 파일당: {avg_time*1000:.1f}ms")
        print(f"  처리 속도: {throughput:.1f} 파일/초")
    
    if errors:
        print(f"\n[ERROR] 실패한 파일 목록 (최대 10개):")
        for filename, error in errors[:10]:
            print(f"  - {filename}: {error}")
        if len(errors) > 10:
            print(f"  ... 외 {len(errors) - 10}개")
    
    print(f"\n[INFO] 위치: {target_dir}")
    print("="*80)


if __name__ == "__main__":
    main()

