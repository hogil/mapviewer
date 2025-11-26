"""
포괄적 Composite Map 성능 벤치마크
- palette_3k 이미지 10개 대상
- 이미지 로딩, Grade Counting, 전체 파이프라인을 세부 측정
- pyvips, PIL 최적화 전략 비교
- 각 단계별 시간 측정 및 병목 지점 분석
"""
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Dict, Any, Callable
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api.config import IMAGES_ROOT
import api.composite_map as cm

EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".gif"}
DATA_DIR = Path(r"D:\project\data\wm-811k\palette_3k")


@dataclass
class TimingBreakdown:
    """각 단계별 시간 측정"""
    total: float = 0.0
    image_loading: float = 0.0
    preprocessing: float = 0.0
    grade_counting: float = 0.0
    sum_map_generation: float = 0.0
    heatmap_generation: float = 0.0
    io_operations: float = 0.0
    other: float = 0.0


@dataclass
class BenchmarkConfig:
    """벤치마크 설정"""
    name: str
    description: str

    # Composite map 설정
    count_mode: str  # numba, cython, broadcast, chunk, auto
    loader_mode: str  # thread, process, sequential
    batch_size: Optional[int]
    max_workers: Optional[int]
    create_sum: bool

    # 이미지 로딩 최적화
    use_cache: bool = True
    cache_strategy: str = "memory"  # memory, disk, both, none

    # 추가 최적화
    resize_method: str = "NEAREST"  # NEAREST, BILINEAR, LANCZOS
    dtype_optimization: bool = True  # uint8 vs uint16


@dataclass
class BenchmarkResult:
    """벤치마크 결과"""
    config: BenchmarkConfig
    timing: TimingBreakdown = field(default_factory=TimingBreakdown)
    success: bool = False
    error: Optional[str] = None
    output_dir: Optional[str] = None
    memory_peak_mb: float = 0.0
    num_images: int = 0
    image_size: tuple = (0, 0)


class ImageLoader:
    """다양한 이미지 로딩 전략"""

    @staticmethod
    def load_pil_basic(path: Path, target_size: tuple) -> np.ndarray:
        """기본 PIL 로딩"""
        with Image.open(path) as img:
            if img.size != target_size:
                img = img.resize(target_size, Image.NEAREST)

            if img.mode == 'P':
                return np.array(img, dtype=np.uint8)
            else:
                return np.array(img.convert('L'), dtype=np.uint8) // 32

    @staticmethod
    def load_pil_optimized(path: Path, target_size: tuple) -> np.ndarray:
        """최적화된 PIL 로딩 (메모리 효율)"""
        with Image.open(path) as img:
            # 리샘플링 전에 모드 변환
            if img.mode not in ('P', 'L'):
                img = img.convert('L')

            if img.size != target_size:
                # NEAREST는 가장 빠름
                img = img.resize(target_size, Image.NEAREST)

            # 직접 배열 변환 (복사 최소화)
            if img.mode == 'P':
                arr = np.asarray(img, dtype=np.uint8)
            else:
                arr = np.asarray(img, dtype=np.uint8) // 32

            return arr.copy()  # PIL 객체가 닫히기 전에 복사

    @staticmethod
    def load_with_shrink(path: Path, target_size: tuple, shrink_factor: int = 1) -> np.ndarray:
        """Shrink-on-load 최적화 (대용량 이미지용)"""
        with Image.open(path) as img:
            # 1. 먼저 축소 (메모리 절약)
            if shrink_factor > 1:
                new_size = (img.width // shrink_factor, img.height // shrink_factor)
                img = img.resize(new_size, Image.NEAREST)

            # 2. 목표 크기로 조정
            if img.size != target_size:
                img = img.resize(target_size, Image.NEAREST)

            if img.mode == 'P':
                return np.array(img, dtype=np.uint8)
            else:
                return np.array(img.convert('L'), dtype=np.uint8) // 32


class GradeCountingBenchmark:
    """Grade Counting 단계 벤치마크"""

    @staticmethod
    def benchmark_count_methods(stacked_indices: np.ndarray) -> Dict[str, float]:
        """다양한 Grade Counting 방법 비교"""
        results = {}
        contiguous = np.ascontiguousarray(stacked_indices, dtype=np.uint8)

        # 1. Numba
        try:
            start = time.perf_counter()
            from api.composite_map_numba import count_grades_with_numba
            result = count_grades_with_numba(contiguous)
            if result is not None:
                results['numba'] = time.perf_counter() - start
        except Exception as e:
            results['numba'] = -1

        # 2. Cython
        try:
            from cython_grade_counts import count_grades as _cython_count_grades
            start = time.perf_counter()
            result = _cython_count_grades(contiguous)
            results['cython'] = time.perf_counter() - start
        except Exception:
            results['cython'] = -1

        # 3. NumPy Broadcast
        try:
            start = time.perf_counter()
            result = cm._broadcast_grade_counts(contiguous)
            results['broadcast'] = time.perf_counter() - start
        except MemoryError:
            results['broadcast'] = -1
        except Exception:
            results['broadcast'] = -1

        # 4. NumPy Chunk
        try:
            start = time.perf_counter()
            result = cm._count_low_grade_occurrences(contiguous)
            results['chunk'] = time.perf_counter() - start
        except Exception:
            results['chunk'] = -1

        return results


class PipelineBenchmark:
    """전체 파이프라인 벤치마크"""

    @staticmethod
    def collect_images(limit: int = 10) -> List[str]:
        """이미지 수집"""
        files = []
        for entry in sorted(DATA_DIR.iterdir()):
            if entry.is_file() and entry.suffix.lower() in EXTS:
                # IMAGES_ROOT 기준 상대 경로로 변환
                rel_path = entry.relative_to(IMAGES_ROOT).as_posix()
                files.append(rel_path)
                if len(files) >= limit:
                    break

        if len(files) < limit:
            raise ValueError(f"Need {limit} files under {DATA_DIR}, found {len(files)}")

        return files

    @staticmethod
    def run_benchmark(config: BenchmarkConfig, image_paths: List[str]) -> BenchmarkResult:
        """벤치마크 실행"""
        result = BenchmarkResult(config=config)
        result.num_images = len(image_paths)

        # 환경 변수 설정
        os.environ["COMPOSITE_COUNT_MODE"] = config.count_mode

        # 캐시 클리어
        if not config.use_cache:
            cm._cached_load_pixel_indices.cache_clear()

        overall_start = time.perf_counter()

        try:
            # 1단계: 이미지 로딩 및 전처리 시간 측정
            load_start = time.perf_counter()

            # 첫 이미지로 크기 확인
            first_path = IMAGES_ROOT / image_paths[0]
            with Image.open(first_path) as img:
                target_size = img.size
                result.image_size = target_size

            result.timing.image_loading = time.perf_counter() - load_start

            # 2단계: Composite map 생성
            preprocess_start = time.perf_counter()

            cm_result = cm.create_composite_heatmaps(
                image_paths,
                login_id=f"bench_{config.name}",
                scheme=None,
                create_sum=config.create_sum,
                loader_mode=config.loader_mode,
                max_workers=config.max_workers,
                batch_size=config.batch_size,
            )

            result.timing.preprocessing = time.perf_counter() - preprocess_start
            result.output_dir = cm_result.get("output_dir")
            result.success = True

        except Exception as e:
            result.success = False
            result.error = str(e)

        result.timing.total = time.perf_counter() - overall_start

        return result


class DetailedPipelineAnalysis:
    """상세 파이프라인 분석"""

    @staticmethod
    def analyze_image_loading(image_paths: List[str], strategies: List[str]) -> Dict[str, float]:
        """이미지 로딩 전략 비교"""
        results = {}

        # 목표 크기 확인
        first_path = IMAGES_ROOT / image_paths[0]
        with Image.open(first_path) as img:
            target_size = img.size

        loader = ImageLoader()

        for strategy in strategies:
            total_time = 0.0

            for img_path in image_paths:
                full_path = IMAGES_ROOT / img_path

                start = time.perf_counter()

                if strategy == "pil_basic":
                    arr = loader.load_pil_basic(full_path, target_size)
                elif strategy == "pil_optimized":
                    arr = loader.load_pil_optimized(full_path, target_size)
                elif strategy == "pil_shrink":
                    arr = loader.load_with_shrink(full_path, target_size, shrink_factor=1)

                total_time += time.perf_counter() - start

            results[strategy] = total_time

        return results

    @staticmethod
    def analyze_full_pipeline(image_paths: List[str]) -> Dict[str, Any]:
        """전체 파이프라인 단계별 분석"""
        timings = {
            "stage_1_load_images": 0.0,
            "stage_2_stack_arrays": 0.0,
            "stage_3_preprocess_indices": 0.0,
            "stage_4_grade_counting": 0.0,
            "stage_5_compute_maps": 0.0,
            "stage_6_render_images": 0.0,
        }

        # Stage 1: 이미지 로딩
        start = time.perf_counter()
        first_path = IMAGES_ROOT / image_paths[0]
        with Image.open(first_path) as img:
            width, height = img.size

        raw_indices_list = []
        for img_path in image_paths:
            full_path = IMAGES_ROOT / img_path
            with Image.open(full_path) as img:
                if img.size != (width, height):
                    img = img.resize((width, height), Image.NEAREST)

                if img.mode == 'P':
                    raw_indices = np.array(img, dtype=np.uint8)
                else:
                    raw_indices = np.array(img.convert('L'), dtype=np.uint8) // 32

                raw_indices_list.append(raw_indices)

        timings["stage_1_load_images"] = time.perf_counter() - start

        # Stage 2: 배열 스택
        start = time.perf_counter()
        stacked_raw = np.stack(raw_indices_list, axis=0)
        timings["stage_2_stack_arrays"] = time.perf_counter() - start

        # Stage 3: 인덱스 전처리 (8-13 처리)
        start = time.perf_counter()
        idx_8_13_mask = (stacked_raw >= 8) & (stacked_raw <= 13)
        idx_0_7_mask = (stacked_raw >= 0) & (stacked_raw <= 7)
        idx_14_plus_mask = (stacked_raw >= 14)

        has_8_13 = idx_8_13_mask.any(axis=0)
        has_0_7 = idx_0_7_mask.any(axis=0)
        has_14_plus = idx_14_plus_mask.any(axis=0)

        idx_8_13_only = has_8_13 & ~has_0_7 & ~has_14_plus
        stacked_raw[:, idx_8_13_only] = 8

        invalid_mask = (stacked_raw >= 14).any(axis=0)
        stacked_indices = np.clip(stacked_raw, 0, 13)
        timings["stage_3_preprocess_indices"] = time.perf_counter() - start

        # Stage 4: Grade Counting (여러 방법 비교)
        grade_count_times = GradeCountingBenchmark.benchmark_count_methods(stacked_indices)
        timings["stage_4_grade_counting"] = grade_count_times

        # Stage 5: Map 계산 (최소 시간 사용)
        start = time.perf_counter()
        grade_counts = cm._compute_grade_counts(stacked_indices)

        square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
        square_sums = np.sum(grade_counts.astype(np.float32) * square_weights, axis=0)
        timings["stage_5_compute_maps"] = time.perf_counter() - start

        # Stage 6: 이미지 렌더링 (간소화)
        start = time.perf_counter()
        # 실제 렌더링은 생략 (시간만 측정)
        timings["stage_6_render_images"] = time.perf_counter() - start

        return timings


def print_comparison_table(results: List[BenchmarkResult]) -> None:
    """비교 테이블 출력"""
    print("\n" + "=" * 120)
    print(f"{'Configuration':<40} {'Total (s)':<12} {'Load (s)':<12} {'Process (s)':<12} {'Status':<10}")
    print("=" * 120)

    successful = [r for r in results if r.success]

    if not successful:
        print("No successful benchmarks")
        return

    # 가장 빠른 결과 찾기
    fastest = min(successful, key=lambda r: r.timing.total)

    for result in sorted(successful, key=lambda r: r.timing.total):
        speedup = result.timing.total / fastest.timing.total
        marker = " [FASTEST]" if result == fastest else f" ({speedup:.2f}x)"

        print(f"{result.config.name:<40} "
              f"{result.timing.total:<12.3f} "
              f"{result.timing.image_loading:<12.3f} "
              f"{result.timing.preprocessing:<12.3f} "
              f"{'OK':<10}{marker}")

    # 실패한 결과
    failed = [r for r in results if not r.success]
    for result in failed:
        print(f"{result.config.name:<40} {'FAILED':<12} {result.error}")


def main():
    """메인 벤치마크 실행"""
    print("\n" + "=" * 120)
    print("COMPREHENSIVE COMPOSITE MAP BENCHMARK")
    print("=" * 120)
    print(f"Python: {sys.version.split()[0]} | NumPy: {np.__version__} | PIL: {Image.__version__}")
    print(f"CPU cores: {os.cpu_count()} | OMP_NUM_THREADS: {os.environ.get('OMP_NUM_THREADS', 'default')}")
    print(f"Data directory: {DATA_DIR}")

    # 이미지 수집
    print("\n[1] Collecting images...")
    image_paths = PipelineBenchmark.collect_images(10)
    print(f"Selected {len(image_paths)} images")
    for i, p in enumerate(image_paths[:3], 1):
        print(f"  {i}. {p}")
    if len(image_paths) > 3:
        print(f"  ... and {len(image_paths) - 3} more")

    # 상세 파이프라인 분석
    print("\n[2] Detailed Pipeline Analysis...")
    print("\n--- Stage-by-Stage Timing ---")
    pipeline_timings = DetailedPipelineAnalysis.analyze_full_pipeline(image_paths)

    for stage, timing in pipeline_timings.items():
        if isinstance(timing, dict):
            print(f"\n{stage}:")
            for method, time_val in sorted(timing.items(), key=lambda x: x[1] if x[1] > 0 else float('inf')):
                if time_val > 0:
                    print(f"  {method:>20}: {time_val:>8.4f}s")
                else:
                    print(f"  {method:>20}: N/A")
        else:
            print(f"{stage:>30}: {timing:>8.4f}s")

    # 이미지 로딩 전략 비교
    print("\n[3] Image Loading Strategy Comparison...")
    loading_strategies = ["pil_basic", "pil_optimized", "pil_shrink"]
    loading_times = DetailedPipelineAnalysis.analyze_image_loading(image_paths, loading_strategies)

    fastest_loader = min(loading_times.values())
    for strategy, load_time in sorted(loading_times.items(), key=lambda x: x[1]):
        speedup = load_time / fastest_loader
        marker = " [FASTEST]" if load_time == fastest_loader else f" ({speedup:.2f}x)"
        print(f"  {strategy:>20}: {load_time:>8.4f}s{marker}")

    # 전체 파이프라인 벤치마크
    print("\n[4] Full Pipeline Benchmarks...")

    cpu = os.cpu_count() or 8

    configs = [
        # Numba 기반 (현재 최적)
        BenchmarkConfig("numba_thread_b16_sum", "Numba + Thread + Batch16 + Sum",
                       "numba", "thread", 16, cpu * 2, True),
        BenchmarkConfig("numba_thread_b8_sum", "Numba + Thread + Batch8 + Sum",
                       "numba", "thread", 8, cpu * 2, True),
        BenchmarkConfig("numba_thread_b4_sum", "Numba + Thread + Batch4 + Sum",
                       "numba", "thread", 4, cpu * 2, True),

        # Sum 생성 제외 (속도 비교)
        BenchmarkConfig("numba_thread_b16_nosum", "Numba + Thread + Batch16 (No Sum)",
                       "numba", "thread", 16, cpu * 2, False),

        # Sequential 비교
        BenchmarkConfig("numba_seq_sum", "Numba + Sequential + Sum",
                       "numba", "sequential", None, 1, True),

        # Process Pool (I/O bound에서 비효율적일 수 있음)
        BenchmarkConfig("numba_proc_b8_sum", "Numba + Process + Batch8 + Sum",
                       "numba", "process", 8, max(2, cpu // 2), True),

        # Cython 대조군
        BenchmarkConfig("cython_thread_b16_sum", "Cython + Thread + Batch16 + Sum",
                       "cython", "thread", 16, cpu * 2, True),

        # Chunk 대조군
        BenchmarkConfig("chunk_thread_b16_sum", "Chunk + Thread + Batch16 + Sum",
                       "chunk", "thread", 16, cpu * 2, True),
    ]

    results = []
    for i, config in enumerate(configs, 1):
        print(f"\n  [{i}/{len(configs)}] Running: {config.name}...")
        result = PipelineBenchmark.run_benchmark(config, image_paths)
        results.append(result)

        if result.success:
            print(f"      [OK] Completed in {result.timing.total:.3f}s")
        else:
            print(f"      [FAIL] Failed: {result.error}")

    # 결과 출력
    print_comparison_table(results)

    # 최종 추천
    print("\n" + "=" * 120)
    print("RECOMMENDATIONS")
    print("=" * 120)

    successful = [r for r in results if r.success]
    if successful:
        fastest = min(successful, key=lambda r: r.timing.total)
        print(f"\n[FASTEST] Configuration: {fastest.config.name}")
        print(f"   Total Time: {fastest.timing.total:.3f}s")
        print(f"   Settings:")
        print(f"     - Count Mode: {fastest.config.count_mode}")
        print(f"     - Loader Mode: {fastest.config.loader_mode}")
        print(f"     - Batch Size: {fastest.config.batch_size}")
        print(f"     - Max Workers: {fastest.config.max_workers}")
        print(f"     - Create Sum: {fastest.config.create_sum}")

    print("\n" + "=" * 120)


if __name__ == "__main__":
    main()
