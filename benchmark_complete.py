#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
완전한 썸네일 벤치마크: pyvips vs turbojpeg
1. 단일 이미지 처리 (시간 + 용량)
2. 대량 병렬 처리 (시간 + 용량)
"""

import sys
import time
import os
import pyvips
from pathlib import Path
from typing import List, Dict, Any, Tuple
import statistics
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import multiprocessing

# Windows 콘솔 UTF-8 설정
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# TurboJPEG 임포트
try:
    from turbojpeg import TurboJPEG
    import cv2
    TURBOJPEG_AVAILABLE = True
except ImportError:
    TURBOJPEG_AVAILABLE = False
    print("[WARNING] TurboJPEG not available (pip install PyTurboJPEG opencv-python)")


class CompleteBenchmark:
    """완전한 썸네일 벤치마크"""

    def __init__(self, test_images_dir: str, thumbnail_size: int = 512):
        self.test_images_dir = Path(test_images_dir)
        self.thumbnail_size = thumbnail_size
        self.output_dir = Path("benchmark_complete_output")
        self.output_dir.mkdir(exist_ok=True)

        # 테스트 이미지 수집
        self.test_images = self._collect_test_images(max_count=100)
        self.test_single = self.test_images[:10]  # 단일 테스트용 10개
        print(f"[INFO] Test images: {len(self.test_images)} total, {len(self.test_single)} for single test")

        # CPU 코어 수
        self.cpu_count = multiprocessing.cpu_count()
        print(f"[INFO] CPU cores: {self.cpu_count}")

    def _collect_test_images(self, max_count: int = 100) -> List[Path]:
        """테스트 이미지 수집"""
        images = []
        extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif'}

        for ext in extensions:
            found = list(self.test_images_dir.rglob(f'*{ext}'))
            images.extend(found[:max_count - len(images)])
            if len(images) >= max_count:
                break

        return images[:max_count]

    def _get_file_size_kb(self, file_path: Path) -> float:
        """파일 크기 KB 단위로 반환"""
        return file_path.stat().st_size / 1024.0

    # ================================================================
    # PYVIPS 구현
    # ================================================================

    def _process_pyvips_optimized(self, img_path: Path, output_path: Path) -> Tuple[float, float]:
        """pyvips 최적화 처리 (Lanczos3, Q100)"""
        start = time.perf_counter()

        img = pyvips.Image.new_from_file(str(img_path), access='sequential')
        scale = min(self.thumbnail_size / img.width, self.thumbnail_size / img.height)
        resized = img.resize(scale, kernel='lanczos3')

        resized.jpegsave(
            str(output_path),
            Q=100,
            strip=True,
            optimize_coding=False,
            subsample_mode=pyvips.ForeignSubsample.OFF,
            interlace=False
        )

        elapsed = (time.perf_counter() - start) * 1000
        size_kb = self._get_file_size_kb(output_path)

        return elapsed, size_kb

    def _process_pyvips_speed(self, img_path: Path, output_path: Path) -> Tuple[float, float]:
        """pyvips 속도 우선 (Nearest, Q85)"""
        start = time.perf_counter()

        img = pyvips.Image.new_from_file(str(img_path), access='sequential')
        scale = min(self.thumbnail_size / img.width, self.thumbnail_size / img.height)
        resized = img.resize(scale, kernel='nearest')

        resized.jpegsave(
            str(output_path),
            Q=85,
            strip=True,
            optimize_coding=False,
            subsample_mode=1,  # 4:2:0
            interlace=False
        )

        elapsed = (time.perf_counter() - start) * 1000
        size_kb = self._get_file_size_kb(output_path)

        return elapsed, size_kb

    def _process_pyvips_balanced(self, img_path: Path, output_path: Path) -> Tuple[float, float]:
        """pyvips 균형 설정 (Cubic, Q95)"""
        start = time.perf_counter()

        img = pyvips.Image.new_from_file(str(img_path), access='sequential')
        scale = min(self.thumbnail_size / img.width, self.thumbnail_size / img.height)
        resized = img.resize(scale, kernel='cubic')

        resized.jpegsave(
            str(output_path),
            Q=95,
            strip=True,
            optimize_coding=False,
            subsample_mode=pyvips.ForeignSubsample.AUTO,
            interlace=False
        )

        elapsed = (time.perf_counter() - start) * 1000
        size_kb = self._get_file_size_kb(output_path)

        return elapsed, size_kb

    # ================================================================
    # TURBOJPEG 구현
    # ================================================================

    def _process_turbojpeg_optimized(self, img_path: Path, output_path: Path) -> Tuple[float, float]:
        """TurboJPEG 최적화 (Lanczos4, Q100)"""
        if not TURBOJPEG_AVAILABLE:
            raise RuntimeError("TurboJPEG not available")

        if img_path.suffix.lower() not in {'.jpg', '.jpeg'}:
            raise ValueError("TurboJPEG only supports JPEG")

        start = time.perf_counter()

        turbojpeg = TurboJPEG()

        with open(img_path, 'rb') as f:
            jpeg_data = f.read()

        img = turbojpeg.decode(jpeg_data)
        h, w = img.shape[:2]
        scale = min(self.thumbnail_size / w, self.thumbnail_size / h)
        new_w = int(w * scale)
        new_h = int(h * scale)

        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
        encoded = turbojpeg.encode(resized, quality=100)

        with open(output_path, 'wb') as f:
            f.write(encoded)

        elapsed = (time.perf_counter() - start) * 1000
        size_kb = self._get_file_size_kb(output_path)

        return elapsed, size_kb

    def _process_turbojpeg_speed(self, img_path: Path, output_path: Path) -> Tuple[float, float]:
        """TurboJPEG 속도 우선 (Nearest, Q85)"""
        if not TURBOJPEG_AVAILABLE:
            raise RuntimeError("TurboJPEG not available")

        if img_path.suffix.lower() not in {'.jpg', '.jpeg'}:
            raise ValueError("TurboJPEG only supports JPEG")

        start = time.perf_counter()

        turbojpeg = TurboJPEG()

        with open(img_path, 'rb') as f:
            jpeg_data = f.read()

        img = turbojpeg.decode(jpeg_data)
        h, w = img.shape[:2]
        scale = min(self.thumbnail_size / w, self.thumbnail_size / h)
        new_w = int(w * scale)
        new_h = int(h * scale)

        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
        encoded = turbojpeg.encode(resized, quality=85)

        with open(output_path, 'wb') as f:
            f.write(encoded)

        elapsed = (time.perf_counter() - start) * 1000
        size_kb = self._get_file_size_kb(output_path)

        return elapsed, size_kb

    # ================================================================
    # 단일 이미지 벤치마크
    # ================================================================

    def benchmark_single(self) -> List[Dict[str, Any]]:
        """단일 이미지 처리 벤치마크"""
        print("\n" + "="*80)
        print("[1/2] SINGLE IMAGE BENCHMARK (Sequential Processing)")
        print("="*80)

        results = []

        # pyvips 최적화
        print("[1/5] pyvips optimized (Lanczos3, Q100)...")
        times, sizes = [], []
        for idx, img_path in enumerate(self.test_single):
            try:
                output_path = self.output_dir / f"single_pyvips_opt_{idx}.jpg"
                elapsed, size_kb = self._process_pyvips_optimized(img_path, output_path)
                times.append(elapsed)
                sizes.append(size_kb)
            except Exception as e:
                print(f"  [ERROR] {img_path.name}: {e}")

        results.append(self._make_result("pyvips_optimized", times, sizes))

        # pyvips 균형
        print("[2/5] pyvips balanced (Cubic, Q95)...")
        times, sizes = [], []
        for idx, img_path in enumerate(self.test_single):
            try:
                output_path = self.output_dir / f"single_pyvips_bal_{idx}.jpg"
                elapsed, size_kb = self._process_pyvips_balanced(img_path, output_path)
                times.append(elapsed)
                sizes.append(size_kb)
            except Exception as e:
                print(f"  [ERROR] {img_path.name}: {e}")

        results.append(self._make_result("pyvips_balanced", times, sizes))

        # pyvips 속도
        print("[3/5] pyvips speed (Nearest, Q85)...")
        times, sizes = [], []
        for idx, img_path in enumerate(self.test_single):
            try:
                output_path = self.output_dir / f"single_pyvips_speed_{idx}.jpg"
                elapsed, size_kb = self._process_pyvips_speed(img_path, output_path)
                times.append(elapsed)
                sizes.append(size_kb)
            except Exception as e:
                print(f"  [ERROR] {img_path.name}: {e}")

        results.append(self._make_result("pyvips_speed", times, sizes))

        if TURBOJPEG_AVAILABLE:
            # TurboJPEG 최적화
            print("[4/5] turbojpeg optimized (Lanczos4, Q100)...")
            times, sizes = [], []
            for idx, img_path in enumerate(self.test_single):
                try:
                    output_path = self.output_dir / f"single_turbo_opt_{idx}.jpg"
                    elapsed, size_kb = self._process_turbojpeg_optimized(img_path, output_path)
                    times.append(elapsed)
                    sizes.append(size_kb)
                except Exception as e:
                    pass  # Skip non-JPEG

            results.append(self._make_result("turbojpeg_optimized", times, sizes))

            # TurboJPEG 속도
            print("[5/5] turbojpeg speed (Nearest, Q85)...")
            times, sizes = [], []
            for idx, img_path in enumerate(self.test_single):
                try:
                    output_path = self.output_dir / f"single_turbo_speed_{idx}.jpg"
                    elapsed, size_kb = self._process_turbojpeg_speed(img_path, output_path)
                    times.append(elapsed)
                    sizes.append(size_kb)
                except Exception as e:
                    pass  # Skip non-JPEG

            results.append(self._make_result("turbojpeg_speed", times, sizes))
        else:
            print("[4-5/5] turbojpeg SKIPPED (not available)")

        return results

    # ================================================================
    # 병렬 처리 벤치마크
    # ================================================================

    def _parallel_worker_pyvips_opt(self, args):
        """병렬 처리 워커 (pyvips 최적화)"""
        img_path, idx = args
        output_path = self.output_dir / f"parallel_pyvips_opt_{idx}.jpg"
        try:
            return self._process_pyvips_optimized(img_path, output_path)
        except Exception as e:
            return None, None

    def _parallel_worker_pyvips_speed(self, args):
        """병렬 처리 워커 (pyvips 속도)"""
        img_path, idx = args
        output_path = self.output_dir / f"parallel_pyvips_speed_{idx}.jpg"
        try:
            return self._process_pyvips_speed(img_path, output_path)
        except Exception as e:
            return None, None

    def _parallel_worker_turbo_opt(self, args):
        """병렬 처리 워커 (turbojpeg 최적화)"""
        img_path, idx = args
        output_path = self.output_dir / f"parallel_turbo_opt_{idx}.jpg"
        try:
            return self._process_turbojpeg_optimized(img_path, output_path)
        except Exception:
            return None, None

    def benchmark_parallel(self) -> List[Dict[str, Any]]:
        """병렬 처리 벤치마크"""
        print("\n" + "="*80)
        print("[2/2] PARALLEL PROCESSING BENCHMARK (MultiProcessing)")
        print("="*80)

        results = []
        num_workers = min(self.cpu_count, 16)  # 최대 16 워커

        # pyvips 최적화 (ProcessPool)
        print(f"[1/3] pyvips optimized (ProcessPool, {num_workers} workers)...")
        start = time.perf_counter()
        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            args = [(img, idx) for idx, img in enumerate(self.test_images)]
            results_data = list(executor.map(self._parallel_worker_pyvips_opt, args))
        total_time = (time.perf_counter() - start) * 1000

        times = [r[0] for r in results_data if r[0] is not None]
        sizes = [r[1] for r in results_data if r[1] is not None]
        result = self._make_result("pyvips_opt_parallel", times, sizes)
        result['total_time_ms'] = total_time
        result['workers'] = num_workers
        results.append(result)

        # pyvips 속도 (ProcessPool)
        print(f"[2/3] pyvips speed (ProcessPool, {num_workers} workers)...")
        start = time.perf_counter()
        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            args = [(img, idx) for idx, img in enumerate(self.test_images)]
            results_data = list(executor.map(self._parallel_worker_pyvips_speed, args))
        total_time = (time.perf_counter() - start) * 1000

        times = [r[0] for r in results_data if r[0] is not None]
        sizes = [r[1] for r in results_data if r[1] is not None]
        result = self._make_result("pyvips_speed_parallel", times, sizes)
        result['total_time_ms'] = total_time
        result['workers'] = num_workers
        results.append(result)

        if TURBOJPEG_AVAILABLE:
            # TurboJPEG 최적화 (ProcessPool)
            print(f"[3/3] turbojpeg optimized (ProcessPool, {num_workers} workers)...")
            start = time.perf_counter()
            with ProcessPoolExecutor(max_workers=num_workers) as executor:
                args = [(img, idx) for idx, img in enumerate(self.test_images)]
                results_data = list(executor.map(self._parallel_worker_turbo_opt, args))
            total_time = (time.perf_counter() - start) * 1000

            times = [r[0] for r in results_data if r[0] is not None]
            sizes = [r[1] for r in results_data if r[1] is not None]
            result = self._make_result("turbojpeg_opt_parallel", times, sizes)
            result['total_time_ms'] = total_time
            result['workers'] = num_workers
            results.append(result)
        else:
            print("[3/3] turbojpeg SKIPPED (not available)")

        return results

    # ================================================================
    # 유틸리티
    # ================================================================

    def _make_result(self, name: str, times: List[float], sizes: List[float]) -> Dict[str, Any]:
        """결과 객체 생성"""
        if not times:
            return {"name": name, "count": 0, "error": "No data"}

        return {
            "name": name,
            "count": len(times),
            "avg_time_ms": statistics.mean(times),
            "median_time_ms": statistics.median(times),
            "min_time_ms": min(times),
            "max_time_ms": max(times),
            "avg_size_kb": statistics.mean(sizes),
            "total_size_kb": sum(sizes),
        }

    def print_summary(self, single_results: List[Dict], parallel_results: List[Dict]):
        """결과 요약 출력"""
        print("\n" + "="*80)
        print("BENCHMARK SUMMARY")
        print("="*80)

        print("\n[A] SINGLE IMAGE PROCESSING (Sequential)")
        print("-" * 80)
        print(f"{'Method':<30} {'Count':>8} {'Avg Time':>12} {'Avg Size':>12} {'Total Size':>12}")
        print("-" * 80)

        for r in sorted([r for r in single_results if 'avg_time_ms' in r], key=lambda x: x['avg_time_ms']):
            print(f"{r['name']:<30} {r['count']:>8} {r['avg_time_ms']:>11.2f}ms {r['avg_size_kb']:>11.1f}KB {r['total_size_kb']:>11.1f}KB")

        print("\n[B] PARALLEL PROCESSING (MultiProcessing)")
        print("-" * 80)
        print(f"{'Method':<30} {'Workers':>8} {'Total Time':>12} {'Avg Size':>12} {'Total Size':>12}")
        print("-" * 80)

        for r in sorted([r for r in parallel_results if 'total_time_ms' in r], key=lambda x: x['total_time_ms']):
            print(f"{r['name']:<30} {r['workers']:>8} {r['total_time_ms']:>11.2f}ms {r['avg_size_kb']:>11.1f}KB {r['total_size_kb']:>11.1f}KB")

        # 승자 발표
        if single_results:
            single_winner = min([r for r in single_results if 'avg_time_ms' in r], key=lambda x: x['avg_time_ms'])
            print(f"\n[WINNER - Single] {single_winner['name']}: {single_winner['avg_time_ms']:.2f}ms/image, {single_winner['avg_size_kb']:.1f}KB/image")

        if parallel_results:
            parallel_winner = min([r for r in parallel_results if 'total_time_ms' in r], key=lambda x: x['total_time_ms'])
            throughput = parallel_winner['count'] / (parallel_winner['total_time_ms'] / 1000.0)
            print(f"[WINNER - Parallel] {parallel_winner['name']}: {parallel_winner['total_time_ms']:.2f}ms total ({throughput:.1f} images/sec)")

        print("="*80)


def main():
    """메인 함수"""
    if len(sys.argv) > 1:
        test_dir = sys.argv[1]
    else:
        test_dir = os.getenv('PROJECT_ROOT', 'D:/appdata/appuser/images')

    if not os.path.exists(test_dir):
        print(f"[ERROR] Directory not found: {test_dir}")
        print(f"Usage: python {sys.argv[0]} <image_directory>")
        sys.exit(1)

    benchmark = CompleteBenchmark(test_dir, thumbnail_size=512)

    # 단일 처리 벤치마크
    single_results = benchmark.benchmark_single()

    # 병렬 처리 벤치마크
    parallel_results = benchmark.benchmark_parallel()

    # 결과 요약
    benchmark.print_summary(single_results, parallel_results)

    print(f"\n[INFO] Output directory: {benchmark.output_dir}")


if __name__ == "__main__":
    main()
