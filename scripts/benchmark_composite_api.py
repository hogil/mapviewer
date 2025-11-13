"""
Composite Map 최적화 버전 성능 벤치마크 (API를 통한 테스트)
서버가 실행 중이어야 합니다.
"""
import requests
import json
import time
from pathlib import Path

def main():
    # 테스트 이미지 경로
    test_dir = Path("D:/project/data/wm-811k/palette_3k")
    
    # 이미지 파일 목록 가져오기 (10개)
    image_files = sorted([
        f for f in test_dir.iterdir() 
        if f.is_file() and f.suffix.lower() in ['.png', '.jpg', '.jpeg']
    ])[:10]
    
    if len(image_files) < 10:
        print(f"[ERROR] 이미지가 10개 미만입니다. (현재: {len(image_files)}개)")
        return
    
    # 상대 경로로 변환 (IMAGES_ROOT 기준: D:/project/data/wm-811k)
    image_paths = []
    images_root = Path("D:/project/data/wm-811k")
    for img_file in image_files:
        try:
            rel_path = img_file.relative_to(images_root)
            image_paths.append(str(rel_path))
        except ValueError:
            print(f"[WARNING] 경로 변환 실패: {img_file}")
            continue
    
    print("=" * 70)
    print("Composite Map 최적화 버전 성능 벤치마크 (API)")
    print("=" * 70)
    print(f"테스트 이미지: {len(image_paths)}개")
    print(f"이미지 경로: {test_dir}")
    print("\n처리할 이미지:")
    for i, path in enumerate(image_paths[:10], 1):
        print(f"  {i}. {Path(path).name}")
    print()
    
    # 최적화 정보 출력
    print("적용된 최적화:")
    print("  [OK] pyvips 사용 (memory=True)")
    print("  [OK] 병렬 저장 (4개 워커)")
    print("  [OK] PNG compress_level=0")
    print("  [OK] 배열 Contiguous 보장")
    print("  [OK] 워커 수 최적화 (cpu_count * 2, 최대 16)")
    print("  [OK] 배치 크기 증가 (기본 4)")
    print()
    
    # API 엔드포인트
    api_url = "http://localhost:8080/api/composite-map"
    
    # 요청 데이터
    payload = {
        "image_paths": image_paths,
        "loader_mode": "thread",
        "max_workers": None,  # 자동 계산
        "batch_size": None   # 자동 계산
    }
    
    print(f"API 요청: {api_url}")
    print("요청 중...\n")
    
    # 시간 측정 시작
    start_time = time.time()
    
    try:
        response = requests.post(
            api_url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=300  # 5분 타임아웃
        )
        
        elapsed_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            
            print("=" * 70)
            print("[SUCCESS] 처리 완료!")
            print("=" * 70)
            print(f"전체 처리 시간: {elapsed_time:.2f}초")
            print(f"서버 처리 시간: {result.get('processing_time', 'N/A')}초")
            print(f"출력 디렉토리: {result.get('output_dir', 'N/A')}")
            print(f"처리된 이미지: {result.get('image_count', result.get('source_images', 'N/A'))}개")
            
            if 'width' in result and 'height' in result:
                print(f"이미지 크기: {result['width']}×{result['height']}")
            elif 'image_size' in result:
                print(f"이미지 크기: {result['image_size']['width']}×{result['image_size']['height']}")
            
            if 'heatmaps' in result:
                print(f"생성된 히트맵: {len(result['heatmaps'])}개")
            
            if 'sum_map_path' in result:
                print(f"Sum Map: {result['sum_map_path']}")
            
            if 'heatmaps' in result:
                print("\n히트맵 상세:")
                for hm in result['heatmaps']:
                    print(f"  Index {hm['index']}: {Path(hm['path']).name}")
                    print(f"    - 픽셀 수: {hm['pixel_count']:,}")
                    print(f"    - 최대 카운트: {hm['max_count']}")
                    print(f"    - 비율: {hm['percentage']}%")
            
            print("\n" + "=" * 70)
            print("성능 요약")
            print("=" * 70)
            print(f"전체 처리 시간 (클라이언트 측): {elapsed_time:.2f}초")
            print(f"서버 처리 시간: {result.get('processing_time', 'N/A')}초")
            print(f"평균 처리 시간 (이미지당): {elapsed_time / len(image_paths):.3f}초")
            print(f"처리량: {len(image_paths) / elapsed_time:.2f} 이미지/초")
            
            # 이전 결과와 비교 (참고용)
            print("\n" + "=" * 70)
            print("비교 (참고용)")
            print("=" * 70)
            print("이전 버전 (v2 기본):")
            print("  - 전체: 16.95초")
            print("  - 로딩: 10.53초")
            print("  - 저장: 5.92초")
            print()
            print("현재 버전 (최적화 적용):")
            print(f"  - 전체: {elapsed_time:.2f}초 ({((16.95 - elapsed_time) / 16.95 * 100):.1f}% 개선)")
            print("=" * 70)
        else:
            print(f"[ERROR] API 오류: {response.status_code}")
            print(f"응답: {response.text}")
            
    except requests.exceptions.ConnectionError:
        print("[ERROR] 서버에 연결할 수 없습니다.")
        print("서버가 실행 중인지 확인하세요: python -m api.main")
    except requests.exceptions.Timeout:
        print("[ERROR] 요청 시간 초과 (5분)")
    except Exception as e:
        elapsed_time = time.time() - start_time
        print(f"\n[ERROR] 오류 발생: {e}")
        print(f"실패까지 걸린 시간: {elapsed_time:.2f}초")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

