#!/usr/bin/env python3
"""
TurboJPEG vs pyvips 종합 성능 비교 벤치마크
300개 이미지를 다양한 조건으로 테스트
"""

import time
import os
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any
import shutil

# pyvips import
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
    sys.exit(1)

# TurboJPEG import
HAS_TURBOJPEG = False
TURBO_JPEG = None
TJPF_RGB = None
TJSAMP_420 = None
TJSAMP_422 = None
TJSAMP_444 = None
TJFLAG_FASTDCT = None

try:
    from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_420, TJSAMP_422, TJSAMP_444
    try:
        from turbojpeg import TJFLAG_FASTDCT
    except ImportError:
        TJFLAG_FASTDCT = None
    import numpy as np
    
    # TurboJPEG 초기화
    turbo_paths = [
        r"C:\libjpeg-turbo64\bin\turbojpeg.dll",  # Windows
        "/usr/lib/x86_64-linux-gnu/libturbojpeg.so.0",  # Ubuntu
        "/usr/local/lib/libturbojpeg.dylib",  # macOS
    ]
    
    for path in turbo_paths:
        if os.path.exists(path):
            try:
                TURBO_JPEG = TurboJPEG(path)
                HAS_TURBOJPEG = True
                print(f"TurboJPEG loaded: {path}")
                break
            except Exception as e:
                continue
    
    if not TURBO_JPEG:
        try:
            TURBO_JPEG = TurboJPEG()
            HAS_TURBOJPEG = True
            print("TurboJPEG loaded: default library")
        except Exception:
            pass
            
except ImportError:
    pass

if not HAS_TURBOJPEG:
    print("WARNING: TurboJPEG not available - will only test pyvips")

# 설정
INPUT_IMAGE = Path("input.png")
OUTPUT_BASE = Path("_bench_turbo_vs_pyvips")
TARGET_SIZE = (512, 512)
NUM_IMAGES = 300
MAX_WORKERS = 16

# 테스트 조건
TEST_CONDITIONS = [
    # TurboJPEG 조건
    {"name": "TurboJPEG_Q95_420_FASTDCT", "method": "turbojpeg", "quality": 95, "subsample": TJSAMP_420, "fastdct": True},
    {"name": "TurboJPEG_Q100_420_FASTDCT", "method": "turbojpeg", "quality": 100, "subsample": TJSAMP_420, "fastdct": True},
    {"name": "TurboJPEG_Q100_420_NoFlags", "method": "turbojpeg", "quality": 100, "subsample": TJSAMP_420, "fastdct": False},
    {"name": "TurboJPEG_Q100_422_FASTDCT", "method": "turbojpeg", "quality": 100, "subsample": TJSAMP_422, "fastdct": True},
    {"name": "TurboJPEG_Q100_444_FASTDCT", "method": "turbojpeg", "quality": 100, "subsample": TJSAMP_444, "fastdct": True},
    
    # pyvips 조건
    {"name": "pyvips_Q95_subsample1", "method": "pyvips", "quality": 95, "subsample_mode": 1, "optimize": False},
    {"name": "pyvips_Q100_subsample1", "method": "pyvips", "quality": 100, "subsample_mode": 1, "optimize": False},
    {"name": "pyvips_Q100_subsample1_opt", "method": "pyvips", "quality": 100, "subsample_mode": 1, "optimize": True},
    {"name": "pyvips_Q100_subsample2", "method": "pyvips", "quality": 100, "subsample_mode": 2, "optimize": False},
]


def generate_thumbnail_turbojpeg(input_path: Path, output_path: Path, quality: int, subsample, fastdct: bool) -> float:
    """TurboJPEG로 썸네일 생성"""
    if not HAS_TURBOJPEG:
        return -1.0
    
    start = time.time()
    
    # pyvips로 로드 및 리사이즈
    vips_image = pyvips.Image.new_from_file(
        str(input_path),
        access='sequential',
        fail_on='none',
        memory=True,
        unlimited=True
    )
    
    # 최적화된 shrink + resize
    target_w, target_h = TARGET_SIZE
    scale_w = target_w / vips_image.width
    scale_h = target_h / vips_image.height
    scale = min(scale_w, scale_h)
    
    if scale < 1.0:
        if scale < 0.5:
            shrink_factor = max(int(1.0 / scale) + 1, 1)
        else:
            shrink_factor = int(1.0 / scale)
        
        if shrink_factor > 1:
            vips_image = vips_image.shrink(shrink_factor, shrink_factor)
            scale = target_w / vips_image.width
        
        vips_image = vips_image.resize(scale, vscale=scale, kernel='cubic')
    
    # TurboJPEG 인코딩
    mem_img = vips_image.write_to_memory()
    np_array = np.frombuffer(mem_img, dtype=np.uint8).reshape(
        vips_image.height, vips_image.width, vips_image.bands
    )
    
    if vips_image.bands == 4:
        np_array = np_array[:, :, :3]
    
    base_kwargs = {"quality": quality, "pixel_format": TJPF_RGB}
    if fastdct and TJFLAG_FASTDCT is not None:
        base_kwargs["flags"] = TJFLAG_FASTDCT
    
    try:
        jpeg_buf = TURBO_JPEG.encode(np_array, jpeg_subsample=subsample, **base_kwargs)
    except TypeError:
        try:
            jpeg_buf = TURBO_JPEG.encode(np_array, chroma_subsampling=subsample, **base_kwargs)
        except TypeError:
            jpeg_buf = TURBO_JPEG.encode(np_array, **base_kwargs)
    
    with open(output_path, "wb") as f:
        f.write(jpeg_buf)
    
    return time.time() - start


def generate_thumbnail_pyvips(input_path: Path, output_path: Path, quality: int, subsample_mode: int, optimize: bool) -> float:
    """pyvips로 썸네일 생성"""
    start = time.time()
    
    vips_image = pyvips.Image.new_from_file(
        str(input_path),
        access='sequential',
        fail_on='none',
        memory=True,
        unlimited=True
    )
    
    # 최적화된 shrink + resize
    target_w, target_h = TARGET_SIZE
    scale_w = target_w / vips_image.width
    scale_h = target_h / vips_image.height
    scale = min(scale_w, scale_h)
    
    if scale < 1.0:
        if scale < 0.5:
            shrink_factor = max(int(1.0 / scale) + 1, 1)
        else:
            shrink_factor = int(1.0 / scale)
        
        if shrink_factor > 1:
            vips_image = vips_image.shrink(shrink_factor, shrink_factor)
            scale = target_w / vips_image.width
        
        vips_image = vips_image.resize(scale, vscale=scale, kernel='cubic')
    
    # pyvips JPEG 저장
    vips_image.jpegsave(
        str(output_path),
        Q=quality,
        strip=True,
        optimize_coding=optimize,
        subsample_mode=subsample_mode,
        interlace=False,
        trellis_quant=False,
        quant_table=0,
        background=255
    )
    
    return time.time() - start


def run_benchmark(condition: Dict[str, Any]) -> Dict[str, Any]:
    """단일 조건 벤치마크 실행"""
    name = condition["name"]
    method = condition["method"]
    
    print(f"\n{'='*80}")
    print(f"Testing: {name}")
    print(f"{'='*80}")
    
    # 출력 디렉토리 생성
    output_dir = OUTPUT_BASE / name
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)
    
    # 300개 이미지 생성 (병렬)
    times = []
    
    def process_single(i: int) -> float:
        output_path = output_dir / f"thumb_{i:04d}.jpg"
        
        if method == "turbojpeg":
            return generate_thumbnail_turbojpeg(
                INPUT_IMAGE, output_path,
                condition["quality"],
                condition["subsample"],
                condition["fastdct"]
            )
        else:
            return generate_thumbnail_pyvips(
                INPUT_IMAGE, output_path,
                condition["quality"],
                condition["subsample_mode"],
                condition["optimize"]
            )
    
    total_start = time.time()
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(process_single, i) for i in range(NUM_IMAGES)]
        
        for future in as_completed(futures):
            t = future.result()
            if t > 0:
                times.append(t)
    
    total_time = time.time() - total_start
    
    # 통계 계산
    if not times:
        return {"name": name, "error": "Failed to generate thumbnails"}
    
    avg_time = sum(times) / len(times) * 1000  # ms
    min_time = min(times) * 1000
    max_time = max(times) * 1000
    
    # 파일 크기 계산
    sizes = [f.stat().st_size for f in output_dir.glob("*.jpg")]
    avg_size = sum(sizes) / len(sizes) if sizes else 0
    
    result = {
        "name": name,
        "total_time_ms": total_time * 1000,
        "avg_time_ms": avg_time,
        "min_time_ms": min_time,
        "max_time_ms": max_time,
        "avg_size_kb": avg_size / 1024,
        "throughput": NUM_IMAGES / total_time
    }
    
    print(f"Total Time: {result['total_time_ms']:.0f}ms")
    print(f"Avg Time:   {result['avg_time_ms']:.2f}ms")
    print(f"Avg Size:   {result['avg_size_kb']:.1f}KB")
    print(f"Throughput: {result['throughput']:.1f} images/sec")
    
    return result


def main():
    if not INPUT_IMAGE.exists():
        print(f"ERROR: {INPUT_IMAGE} not found")
        sys.exit(1)
    
    print("="*80)
    print("TurboJPEG vs pyvips Benchmark")
    print("="*80)
    print(f"Input:       {INPUT_IMAGE}")
    print(f"Target Size: {TARGET_SIZE}")
    print(f"Num Images:  {NUM_IMAGES}")
    print(f"Workers:     {MAX_WORKERS}")
    print(f"TurboJPEG:   {'Available' if HAS_TURBOJPEG else 'Not Available'}")
    print("="*80)
    
    results = []
    
    for condition in TEST_CONDITIONS:
        # TurboJPEG 테스트는 라이브러리가 있을 때만
        if condition["method"] == "turbojpeg" and not HAS_TURBOJPEG:
            print(f"\nSkipping {condition['name']} (TurboJPEG not available)")
            continue
        
        try:
            result = run_benchmark(condition)
            results.append(result)
        except Exception as e:
            print(f"ERROR: {condition['name']} failed - {e}")
            continue
    
    # 결과 요약
    print("\n" + "="*80)
    print("SUMMARY RESULTS (300 images, 512x512, cubic)")
    print("="*80)
    print(f"{'Method':<35} {'Total':<10} {'Avg':<10} {'Size':<10} {'Throughput':<15}")
    print("-"*80)
    
    for r in sorted(results, key=lambda x: x.get("total_time_ms", float('inf'))):
        if "error" in r:
            print(f"{r['name']:<35} ERROR")
            continue
        
        print(f"{r['name']:<35} "
              f"{r['total_time_ms']:>8.0f}ms "
              f"{r['avg_time_ms']:>8.2f}ms "
              f"{r['avg_size_kb']:>8.1f}KB "
              f"{r['throughput']:>13.1f}/s")
    
    print("="*80)
    
    # 최고 성능
    if results:
        fastest = min(results, key=lambda x: x.get("total_time_ms", float('inf')))
        print(f"\nFASTEST: {fastest['name']}")
        print(f"  Total Time: {fastest['total_time_ms']:.0f}ms")
        print(f"  Avg Time:   {fastest['avg_time_ms']:.2f}ms")
        print(f"  Throughput: {fastest['throughput']:.1f} images/sec")


if __name__ == "__main__":
    main()

