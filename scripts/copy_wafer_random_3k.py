"""
특정 Wafer 이미지 파일을 3000번 복사하는 스크립트 (랜덤 파일명)

- 원본 파일: D:\project\data\wm-811k\palette_5mb\wafer_palette_5mb.png
- 목표 폴더: D:\project\data\wm-811k\palette_copies_3k
- 3000개 파일을 랜덤 파일명으로 복사
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
    
    # 원본 파일
    source_file = Path("D:/project/data/wm-811k/palette_5mb/wafer_palette_5mb.png")
    if not source_file.exists():
        print(f"[ERROR] 원본 파일을 찾을 수 없습니다: {source_file}")
        return
    
    # 목표 폴더
    target_dir = Path("D:/project/data/wm-811k/palette_copies_3k")
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # 원본 파일 정보 출력
    size_mb = source_file.stat().st_size / (1024 * 1024)
    print(f"\n[INFO] 원본 파일: {source_file}")
    print(f"  크기: {size_mb:.2f}MB")
    print(f"[INFO] 목표 폴더: {target_dir}")
    
    # 3000개 생성 (0~2999 범위의 숫자를 순서 상관없이 1개씩 사용)
    target_count = 3000
    print(f"\n[INFO] 목표 파일 수: {target_count}개")
    print(f"[INFO] 파일명: 0~2999 범위의 숫자를 순서 상관없이 1개씩 사용")
    
    # 0~2999 범위의 숫자 리스트 생성
    number_list = list(range(target_count))
    
    # 랜덤 시드 설정 (매번 다르게)
    import time
    random.seed(int(time.time() * 1000000) % (2**32))
    
    # 랜덤하게 섞기
    random.shuffle(number_list)
    
    # 파일명 생성 (섞인 순서대로)
    file_tasks = []
    for num in number_list:
        dst_filename = f"wafer_{num:04d}.png"
        dst_path = target_dir / dst_filename
        file_tasks.append((source_file, dst_path))
    
    # 생성된 파일명 순서 확인 (처음 10개만 출력)
    print(f"\n[파일명 생성 순서] 처음 10개:")
    for i, (_, dst_path) in enumerate(file_tasks[:10], 1):
        print(f"  {i}. {dst_path.name}")
    
    print(f"\n[INFO] 파일명 생성 완료: {len(file_tasks)}개 (0~{target_count-1} 범위, 랜덤 순서)")
    
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

