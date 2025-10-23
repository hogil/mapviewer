#!/usr/bin/env python3
"""
썸네일 생성 성능 대량 테스트 스크립트
Windows/Ubuntu 환경 모두 지원
"""

import os
import sys
import time
import json
from pathlib import Path
from typing import List, Dict, Any

# 프로젝트 루트를 Python path에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api import config
from api.thumbnail_service import ThumbnailService
from concurrent.futures import ThreadPoolExecutor

def find_test_images(root_dir: Path, min_count: int = 100) -> List[Path]:
    """테스트용 이미지 파일 찾기"""
    images = []
    supported_exts = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp'}

    print(f"🔍 이미지 검색 중: {root_dir}")

    for ext in supported_exts:
        pattern = f"**/*{ext}"
        found = list(root_dir.glob(pattern))
        images.extend(found)
        if len(images) >= min_count:
            break

    print(f"✅ 발견된 이미지: {len(images)}장")
    return images[:min_count]

def run_benchmark(images: List[Path], batch_size: int = 100) -> Dict[str, Any]:
    """썸네일 생성 벤치마크 실행"""

    # ThumbnailService 초기화
    thumbnail_service = ThumbnailService(
        root_dir=config.ROOT_DIR,
        thumbnail_dir=config.THUMBNAIL_DIR,
        thumbnail_format=config.THUMBNAIL_FORMAT,
        thumbnail_quality=config.THUMBNAIL_QUALITY
    )

    executor = ThreadPoolExecutor(max_workers=os.cpu_count() or 4)

    print("\n" + "="*80)
    print("📊 벤치마크 시작")
    print("="*80)
    print(f"환경:")
    print(f"  - OS: {sys.platform}")
    print(f"  - CPU 코어: {os.cpu_count()}")
    print(f"  - THUMBNAIL_FORMAT: {config.THUMBNAIL_FORMAT}")
    print(f"  - THUMBNAIL_QUALITY: {config.THUMBNAIL_QUALITY}")
    print(f"  - THUMBNAIL_SIZE: {config.THUMBNAIL_SIZE_DEFAULT}")
    print(f"  - THUMBNAIL_SEM: {config.THUMBNAIL_SEM}")
    print(f"  - IO_THREADS: {config.IO_THREADS}")
    print(f"  - VIPS_CONCURRENCY: {config.VIPS_CONCURRENCY}")
    print(f"  - USE_TURBOJPEG: {getattr(config, 'USE_TURBOJPEG', False)}")
    print(f"\n테스트 이미지: {len(images)}장")
    print("="*80 + "\n")

    # 썸네일 캐시 삭제 (정확한 측정을 위해)
    print("🗑️  기존 썸네일 캐시 삭제 중...")
    for img in images:
        thumb_path = thumbnail_service.get_thumbnail_path(
            img,
            (config.THUMBNAIL_SIZE_DEFAULT, config.THUMBNAIL_SIZE_DEFAULT)
        )
        if thumb_path.exists():
            thumb_path.unlink()

    results = []
    total_start = time.time()

    # 배치 단위로 처리
    for i in range(0, len(images), batch_size):
        batch = images[i:i+batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(images) + batch_size - 1) // batch_size

        print(f"\n📦 배치 {batch_num}/{total_batches} ({len(batch)}장) 처리 중...")

        batch_start = time.time()

        # 동기 방식으로 썸네일 생성
        for img in batch:
            img_start = time.time()

            thumb_path = thumbnail_service.get_thumbnail_path(
                img,
                (config.THUMBNAIL_SIZE_DEFAULT, config.THUMBNAIL_SIZE_DEFAULT)
            )

            success = thumbnail_service._generate_thumbnail_sync(
                img,
                thumb_path,
                (config.THUMBNAIL_SIZE_DEFAULT, config.THUMBNAIL_SIZE_DEFAULT)
            )

            elapsed = (time.time() - img_start) * 1000  # ms

            results.append({
                "image": str(img.name),
                "success": success,
                "time_ms": elapsed
            })

            # 진행상황 표시 (10개마다)
            if len(results) % 10 == 0:
                avg_time = sum(r["time_ms"] for r in results[-10:]) / 10
                print(f"  ✓ {len(results)}장 완료 (최근 10개 평균: {avg_time:.1f}ms)")

        batch_elapsed = time.time() - batch_start
        batch_avg = (batch_elapsed / len(batch)) * 1000
        print(f"  ⏱️  배치 완료: {batch_elapsed:.2f}초 (평균 {batch_avg:.1f}ms/장)")

    total_elapsed = time.time() - total_start

    # 통계 계산
    success_count = sum(1 for r in results if r["success"])
    fail_count = len(results) - success_count
    times = [r["time_ms"] for r in results if r["success"]]

    avg_time = sum(times) / len(times) if times else 0
    min_time = min(times) if times else 0
    max_time = max(times) if times else 0

    # 백분위수 계산
    sorted_times = sorted(times)
    p50 = sorted_times[len(sorted_times)//2] if sorted_times else 0
    p90 = sorted_times[int(len(sorted_times)*0.9)] if sorted_times else 0
    p95 = sorted_times[int(len(sorted_times)*0.95)] if sorted_times else 0
    p99 = sorted_times[int(len(sorted_times)*0.99)] if sorted_times else 0

    print("\n" + "="*80)
    print("📊 최종 결과")
    print("="*80)
    print(f"총 처리 시간: {total_elapsed:.2f}초")
    print(f"처리량: {len(images)/total_elapsed:.2f}장/초")
    print(f"\n성공: {success_count}장")
    print(f"실패: {fail_count}장")
    print(f"\n평균 시간: {avg_time:.1f}ms")
    print(f"최소 시간: {min_time:.1f}ms")
    print(f"최대 시간: {max_time:.1f}ms")
    print(f"\n백분위수:")
    print(f"  P50 (중앙값): {p50:.1f}ms")
    print(f"  P90: {p90:.1f}ms")
    print(f"  P95: {p95:.1f}ms")
    print(f"  P99: {p99:.1f}ms")
    print("="*80)

    # 상위/하위 10개 표시
    print("\n⚡ 가장 빠른 10개:")
    for i, r in enumerate(sorted(results, key=lambda x: x["time_ms"])[:10], 1):
        print(f"  {i}. {r['image']}: {r['time_ms']:.1f}ms")

    print("\n🐌 가장 느린 10개:")
    for i, r in enumerate(sorted(results, key=lambda x: x["time_ms"], reverse=True)[:10], 1):
        print(f"  {i}. {r['image']}: {r['time_ms']:.1f}ms")

    # 결과 저장
    output_file = project_root / "benchmark_thumbnail_results.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump({
            "environment": {
                "os": sys.platform,
                "cpu_count": os.cpu_count(),
                "thumbnail_format": config.THUMBNAIL_FORMAT,
                "thumbnail_quality": config.THUMBNAIL_QUALITY,
                "thumbnail_size": config.THUMBNAIL_SIZE_DEFAULT,
                "thumbnail_sem": config.THUMBNAIL_SEM,
                "io_threads": config.IO_THREADS,
                "vips_concurrency": config.VIPS_CONCURRENCY,
                "use_turbojpeg": getattr(config, "USE_TURBOJPEG", False),
            },
            "summary": {
                "total_images": len(images),
                "success_count": success_count,
                "fail_count": fail_count,
                "total_time_sec": total_elapsed,
                "throughput_per_sec": len(images) / total_elapsed,
                "avg_time_ms": avg_time,
                "min_time_ms": min_time,
                "max_time_ms": max_time,
                "p50_ms": p50,
                "p90_ms": p90,
                "p95_ms": p95,
                "p99_ms": p99,
            },
            "results": results
        }, f, indent=2, ensure_ascii=False)

    print(f"\n💾 결과 저장: {output_file}")

    executor.shutdown()

    return {
        "total_time": total_elapsed,
        "avg_time": avg_time,
        "success_count": success_count
    }

def main():
    """메인 함수"""

    # 이미지 개수 설정 (환경변수로 조정 가능)
    test_count = int(os.getenv("TEST_IMAGE_COUNT", "300"))
    batch_size = int(os.getenv("BATCH_SIZE", "100"))

    print("="*80)
    print("🚀 썸네일 성능 대량 테스트")
    print("="*80)
    print(f"테스트 이미지 개수: {test_count}장")
    print(f"배치 크기: {batch_size}장")
    print(f"프로젝트 루트: {config.ROOT_DIR}")
    print("="*80 + "\n")

    # 테스트 이미지 찾기
    images = find_test_images(config.ROOT_DIR, test_count)

    if len(images) < 10:
        print(f"❌ 테스트 이미지가 부족합니다 (최소 10장 필요, 현재 {len(images)}장)")
        return 1

    # 벤치마크 실행
    try:
        run_benchmark(images, batch_size)
        return 0
    except Exception as e:
        print(f"\n❌ 에러 발생: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
