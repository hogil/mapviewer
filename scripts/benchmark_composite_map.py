"""
Composite Map 성능 평가 스크립트
"""
import sys
import time
from pathlib import Path

# 프로젝트 루트를 Python 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.composite_map import create_composite_heatmaps
from api.config import IMAGES_ROOT

def benchmark_composite_map(image_folder: str, num_images: int = 10):
    """
    Composite Map 생성 성능 평가
    
    Args:
        image_folder: 이미지 폴더 경로 (IMAGES_ROOT 기준 상대 경로)
        num_images: 사용할 이미지 개수
    """
    print("=" * 80)
    print("Composite Map 성능 평가")
    print("=" * 80)
    
    # 이미지 파일 목록 가져오기
    folder_path = IMAGES_ROOT / image_folder
    if not folder_path.exists():
        print(f"[ERROR] 폴더가 존재하지 않습니다: {folder_path}")
        return
    
    image_files = sorted(folder_path.glob("*.png"))[:num_images]
    if len(image_files) < num_images:
        print(f"[WARN] 요청한 {num_images}개보다 {len(image_files)}개만 찾았습니다.")
    
    if len(image_files) == 0:
        print(f"[ERROR] 이미지 파일을 찾을 수 없습니다: {folder_path}")
        return
    
    # 상대 경로로 변환 (IMAGES_ROOT 기준)
    image_paths = [str(f.relative_to(IMAGES_ROOT)).replace("\\", "/") for f in image_files]
    
    print(f"\n[INFO] 이미지 폴더: {image_folder}")
    print(f"[INFO] 이미지 개수: {len(image_paths)}개")
    print(f"[INFO] 이미지 목록:")
    for i, path in enumerate(image_paths[:5], 1):
        print(f"   {i}. {Path(path).name}")
    if len(image_paths) > 5:
        print(f"   ... 외 {len(image_paths) - 5}개")
    
    # 첫 번째 이미지로 크기 확인
    first_img_path = IMAGES_ROOT / image_paths[0]
    from PIL import Image
    with Image.open(first_img_path) as img:
        width, height = img.size
        mode = img.mode
    print(f"\n[INFO] 이미지 크기: {width}x{height}")
    print(f"[INFO] 이미지 모드: {mode}")
    
    # 성능 측정
    print("\n" + "=" * 80)
    print("[START] Composite Map 생성 시작...")
    print("=" * 80)
    
    start_time = time.time()
    
    try:
        result = create_composite_heatmaps(
            image_paths=image_paths,
            indices=list(range(8)),
            create_sum=True,
            loader_mode="thread",
            max_workers=4,
            batch_size=2
        )
        
        end_time = time.time()
        total_time = end_time - start_time
        
        # 결과 출력
        print("\n" + "=" * 80)
        print("[RESULT] 성능 평가 결과")
        print("=" * 80)
        print(f"[TIME] 총 처리 시간: {total_time:.2f}초")
        print(f"[INFO] 처리된 이미지: {result['source_images']}개")
        print(f"[INFO] 이미지 크기: {result['image_size']['width']}x{result['image_size']['height']}")
        print(f"[INFO] 출력 디렉토리: {result['output_dir']}")
        
        if 'processing_time' in result:
            print(f"[TIME] 내부 처리 시간: {result['processing_time']:.2f}초")
        
        print(f"\n[HEATMAP] 생성된 히트맵:")
        for heatmap in result['heatmaps']:
            print(f"   - Index {heatmap['index']}: {heatmap['pixel_count']:,} 픽셀 ({heatmap['percentage']:.2f}%)")
        
        if 'sum_map_path' in result:
            print(f"\n[INFO] Sum Map: {result['sum_map_path']}")
        
        # 성능 분석
        print("\n" + "=" * 80)
        print("[ANALYSIS] 성능 분석")
        print("=" * 80)
        avg_time_per_image = total_time / len(image_paths)
        pixels_per_second = (width * height * len(image_paths)) / total_time / 1_000_000
        print(f"[PERF] 이미지당 평균 시간: {avg_time_per_image:.3f}초")
        print(f"[PERF] 처리 속도: {pixels_per_second:.2f} MPixels/초")
        
        # 예상 성능 비교
        print("\n" + "=" * 80)
        print("[ESTIMATE] 예상 성능 비교 (100개 이미지 기준)")
        print("=" * 80)
        estimated_100 = total_time * 10  # 10개 → 100개
        print(f"[ESTIMATE] 예상 처리 시간: {estimated_100:.1f}초 ({estimated_100/60:.1f}분)")
        
        return result
        
    except Exception as e:
        print(f"\n[ERROR] 오류 발생: {e}")
        import traceback
        traceback.print_exc()
        return None

if __name__ == "__main__":
    # 명령줄 인자 처리
    if len(sys.argv) > 1:
        image_folder = sys.argv[1]
    else:
        image_folder = "palette_3k"
    
    if len(sys.argv) > 2:
        num_images = int(sys.argv[2])
    else:
        num_images = 10
    
    benchmark_composite_map(image_folder, num_images)

