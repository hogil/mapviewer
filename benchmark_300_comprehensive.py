"""
300개 썸네일 종합 성능 벤치마크
다양한 파라미터 조합 테스트
"""

import time
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Tuple, Dict, Any, Callable
import shutil

try:
    import pyvips
    try:
        pyvips.set_log_handler(lambda domain, level, msg: None)
    except AttributeError:
        pass
    HAS_PYVIPS = True
except ImportError:
    HAS_PYVIPS = False
    print("ERROR: pyvips not available")
    exit(1)

try:
    from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_420, TJSAMP_422, TJSAMP_444
    try:
        from turbojpeg import TJFLAG_FASTDCT
    except ImportError:
        TJFLAG_FASTDCT = None
    import numpy as np
    HAS_TURBOJPEG = True
except ImportError:
    HAS_TURBOJPEG = False
    print("WARNING: TurboJPEG not available")

# 설정
INPUT_IMAGE = Path("input.png")
OUTPUT_BASE = Path("_bench_300_comprehensive")
TARGET_SIZE = (512, 512)
NUM_IMAGES = 300
MAX_WORKERS = 16

_turbo = None
if HAS_TURBOJPEG:
    try:
        _turbo = TurboJPEG()
    except Exception as e:
        print(f"TurboJPEG init failed: {e}")


def create_test_images():
    """300개 테스트 이미지 준비"""
    test_dir = Path("_test_images_300")
    test_dir.mkdir(exist_ok=True)
    
    if not INPUT_IMAGE.exists():
        print(f"ERROR: {INPUT_IMAGE} not found!")
        exit(1)
    
    images = []
    print(f"Creating {NUM_IMAGES} test images...", end='', flush=True)
    for i in range(NUM_IMAGES):
        target = test_dir / f"test_{i:04d}.png"
        if not target.exists():
            if os.name == 'nt':
                shutil.copy2(INPUT_IMAGE, target)
            else:
                target.symlink_to(INPUT_IMAGE.resolve())
        images.append(target)
    print(" Done!")
    
    return images


def save_with_turbojpeg(vips_img, dest: str, quality: int, subsample) -> bool:
    """TurboJPEG로 저장"""
    if _turbo is None:
        return False
    
    try:
        mem_img = vips_img.write_to_memory()
        np_array = np.frombuffer(mem_img, dtype=np.uint8).reshape(
            vips_img.height, vips_img.width, vips_img.bands
        )
        
        if vips_img.bands == 1:
            np_array = np.stack([np_array] * 3, axis=-1).squeeze()
        elif vips_img.bands == 4:
            np_array = np_array[:, :, :3]
        
        kwargs = {"quality": quality, "pixel_format": TJPF_RGB}
        if TJFLAG_FASTDCT:
            kwargs["flags"] = TJFLAG_FASTDCT
        
        try:
            jpeg_buf = _turbo.encode(np_array, **kwargs, chroma_subsampling=subsample)
        except TypeError:
            try:
                jpeg_buf = _turbo.encode(np_array, **kwargs, jpeg_subsample=subsample)
            except TypeError:
                jpeg_buf = _turbo.encode(np_array, **kwargs)
        
        with open(dest, "wb") as f:
            f.write(jpeg_buf)
        
        return True
    except Exception:
        return False


class BenchmarkConfig:
    """벤치마크 설정"""
    def __init__(self, name: str, 
                 use_shrink_load: bool = False,
                 shrink_factor: int = 19,
                 quality: int = 100,
                 use_turbojpeg: bool = True,
                 turbojpeg_subsample = None,
                 use_fastdct: bool = True,
                 pyvips_optimize_coding: bool = False,
                 pyvips_subsample_mode: int = 1,
                 pyvips_trellis_quant: bool = False,
                 kernel: str = 'cubic'):
        self.name = name
        self.use_shrink_load = use_shrink_load
        self.shrink_factor = shrink_factor
        self.quality = quality
        self.use_turbojpeg = use_turbojpeg
        self.turbojpeg_subsample = turbojpeg_subsample if turbojpeg_subsample else TJSAMP_420
        self.use_fastdct = use_fastdct
        self.pyvips_optimize_coding = pyvips_optimize_coding
        self.pyvips_subsample_mode = pyvips_subsample_mode
        self.pyvips_trellis_quant = pyvips_trellis_quant
        self.kernel = kernel


def process_image(img_path: Path, output_path: Path, config: BenchmarkConfig) -> Tuple[float, int]:
    """이미지 처리"""
    t0 = time.time()
    
    # 1. 로드
    load_kwargs = {
        'access': 'sequential',
        'fail_on': 'none',
        'memory': True,
        'unlimited': True
    }
    if config.use_shrink_load:
        load_kwargs['shrink'] = config.shrink_factor
    
    vips_img = pyvips.Image.new_from_file(str(img_path), **load_kwargs)
    
    # 2. 리사이즈
    target_w, target_h = TARGET_SIZE
    scale = min(target_w / vips_img.width, target_h / vips_img.height)
    
    if not config.use_shrink_load and scale < 0.5:
        # shrink + resize 조합
        shrink_factor = max(int(1.0 / scale) + 1, 1)
        if shrink_factor > 1:
            resized = vips_img.shrink(shrink_factor, shrink_factor)
            remaining_scale = scale * shrink_factor
            if abs(remaining_scale - 1.0) > 0.01:
                resized = resized.resize(remaining_scale, vscale=remaining_scale, kernel=config.kernel)
        else:
            resized = vips_img.resize(scale, vscale=scale, kernel=config.kernel)
    else:
        # resize만
        resized = vips_img.resize(scale, vscale=scale, kernel=config.kernel)
    
    # 3. 저장
    if config.use_turbojpeg and HAS_TURBOJPEG:
        saved = save_with_turbojpeg(resized, str(output_path), config.quality, config.turbojpeg_subsample)
        if not saved:
            config.use_turbojpeg = False  # 폴백
    
    if not config.use_turbojpeg or not HAS_TURBOJPEG:
        # pyvips 저장
        resized.jpegsave(
            str(output_path),
            Q=config.quality,
            strip=True,
            optimize_coding=config.pyvips_optimize_coding,
            subsample_mode=config.pyvips_subsample_mode,
            interlace=False,
            trellis_quant=config.pyvips_trellis_quant,
        )
    
    elapsed = time.time() - t0
    size = output_path.stat().st_size
    return elapsed, size


def benchmark(config: BenchmarkConfig, image_paths, output_dir: Path) -> Dict[str, Any]:
    """벤치마크 실행"""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"\nTesting: {config.name}...", end='', flush=True)
    
    def process_one(idx: int, img_path: Path):
        output_path = output_dir / f"thumb_{idx:04d}.jpg"
        return process_image(img_path, output_path, config)
    
    start_time = time.time()
    results = []
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(process_one, i, img) for i, img in enumerate(image_paths)]
        
        for future in as_completed(futures):
            try:
                elapsed, size = future.result()
                results.append((elapsed, size))
            except Exception as e:
                print(f"\n  ERROR: {e}")
    
    total_time = time.time() - start_time
    
    times = [r[0] for r in results]
    sizes = [r[1] for r in results]
    
    print(f" {total_time*1000:.0f}ms")
    
    return {
        "config": config,
        "total_time": total_time,
        "avg_time": sum(times) / len(times) if times else 0,
        "min_time": min(times) if times else 0,
        "max_time": max(times) if times else 0,
        "avg_size": sum(sizes) / len(sizes) if sizes else 0,
        "throughput": len(results) / total_time if total_time > 0 else 0,
        "success": len(results),
    }


def main():
    print("="*80)
    print("300 THUMBNAILS COMPREHENSIVE BENCHMARK")
    print("="*80)
    print(f"Input: {INPUT_IMAGE} (10000x10000)")
    print(f"Output: {TARGET_SIZE}")
    print(f"Count: {NUM_IMAGES}")
    print(f"Workers: {MAX_WORKERS}")
    print(f"TurboJPEG: {'Available' if _turbo else 'NOT AVAILABLE'}")
    print("="*80)
    
    # 테스트 이미지 준비
    image_paths = create_test_images()
    OUTPUT_BASE.mkdir(exist_ok=True)
    
    # 테스트 구성
    configs = [
        # 1. 현재 방식 (baseline)
        BenchmarkConfig(
            "Current: no shrink load, Q100, TurboJPEG 420 FASTDCT",
            use_shrink_load=False,
            quality=100,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=True
        ),
        
        # 2. shrink 로딩 (가장 기대되는 개선)
        BenchmarkConfig(
            "Level1: shrink load 19, Q100, TurboJPEG 420 FASTDCT",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=True
        ),
        
        # 3. Q=95 (속도 vs 품질)
        BenchmarkConfig(
            "Level2: shrink load 19, Q95, TurboJPEG 420 FASTDCT",
            use_shrink_load=True,
            shrink_factor=19,
            quality=95,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=True
        ),
        
        # 4. FASTDCT 없음 (효과 측정)
        BenchmarkConfig(
            "shrink load 19, Q100, TurboJPEG 420 no FASTDCT",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=False
        ),
        
        # 5. 4:2:2 서브샘플링
        BenchmarkConfig(
            "shrink load 19, Q100, TurboJPEG 422 FASTDCT",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_422 if HAS_TURBOJPEG else None,
            use_fastdct=True
        ),
        
        # 6. pyvips만 (TurboJPEG 없음)
        BenchmarkConfig(
            "pyvips only: no shrink load, Q100, subsample 1",
            use_shrink_load=False,
            quality=100,
            use_turbojpeg=False,
            pyvips_subsample_mode=1
        ),
        
        # 7. pyvips + shrink load
        BenchmarkConfig(
            "pyvips only: shrink load 19, Q100, subsample 1",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=False,
            pyvips_subsample_mode=1
        ),
        
        # 8. pyvips optimize_coding
        BenchmarkConfig(
            "pyvips: shrink load 19, Q100, optimize_coding ON",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=False,
            pyvips_optimize_coding=True,
            pyvips_subsample_mode=1
        ),
        
        # 9. shrink factor 다르게
        BenchmarkConfig(
            "shrink load 10, Q100, TurboJPEG 420 FASTDCT",
            use_shrink_load=True,
            shrink_factor=10,
            quality=100,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=True
        ),
        
        # 10. lanczos3 커널
        BenchmarkConfig(
            "shrink load 19, Q100, TurboJPEG 420 FASTDCT, lanczos3",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=True,
            kernel='lanczos3'
        ),
        
        # 11. Q=90
        BenchmarkConfig(
            "shrink load 19, Q90, TurboJPEG 420 FASTDCT",
            use_shrink_load=True,
            shrink_factor=19,
            quality=90,
            use_turbojpeg=True,
            turbojpeg_subsample=TJSAMP_420,
            use_fastdct=True
        ),
        
        # 12. pyvips 4:2:2
        BenchmarkConfig(
            "pyvips: shrink load 19, Q100, subsample 2 (422)",
            use_shrink_load=True,
            shrink_factor=19,
            quality=100,
            use_turbojpeg=False,
            pyvips_subsample_mode=2
        ),
    ]
    
    results = []
    for i, config in enumerate(configs, 1):
        output_dir = OUTPUT_BASE / f"test_{i:02d}"
        result = benchmark(config, image_paths, output_dir)
        results.append(result)
    
    # 결과 출력
    print("\n" + "="*100)
    print("FINAL RESULTS (300 thumbnails, 16 workers)")
    print("="*100)
    print(f"{'Method':<60} {'Total':>8} {'Avg':>8} {'Size':>10} {'TP':>10}")
    print("-"*100)
    
    sorted_results = sorted(results, key=lambda x: x["total_time"])
    
    for r in sorted_results:
        print(f"{r['config'].name:<60} "
              f"{r['total_time']*1000:>7.0f}ms "
              f"{r['avg_time']*1000:>7.1f}ms "
              f"{r['avg_size']/1024:>9.1f}KB "
              f"{r['throughput']:>9.0f}/s")
    
    print("="*100)
    
    # TOP 3
    print("\nTOP 3 FASTEST:")
    for i, r in enumerate(sorted_results[:3], 1):
        baseline = next((x for x in results if "Current" in x['config'].name), sorted_results[-1])
        improvement = (baseline["total_time"] - r["total_time"]) / baseline["total_time"] * 100
        
        print(f"\n{i}. {r['config'].name}")
        print(f"   Total: {r['total_time']*1000:.0f}ms")
        print(f"   Improvement: {improvement:+.1f}% vs baseline")
        print(f"   Avg Size: {r['avg_size']/1024:.1f}KB")
        print(f"   Throughput: {r['throughput']:.0f} images/sec")
    
    print(f"\nOutput: {OUTPUT_BASE}")
    print("Done!")


if __name__ == "__main__":
    main()

