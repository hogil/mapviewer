import argparse
import os
import time
from pathlib import Path
import importlib
import numpy as np

import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api.config import IMAGES_ROOT
import api.composite_map as cm

EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.gif'}


def collect_images(base: Path, limit: int):
    if not base.exists():
        raise SystemExit(f"Image directory not found: {base}")
    picked = []
    for entry in sorted(base.iterdir()):
        if entry.is_file() and entry.suffix.lower() in EXTS:
            try:
                rel = entry.relative_to(IMAGES_ROOT).as_posix()
            except ValueError:
                raise SystemExit(f"{entry} is outside IMAGES_ROOT {IMAGES_ROOT}")
            picked.append(rel)
            if len(picked) >= limit:
                break
    if len(picked) < limit:
        raise SystemExit(f"Need {limit} images, found {len(picked)}")
    return picked


def ensure_uint8(arr: np.ndarray) -> np.ndarray:
    if arr.dtype == np.uint8 and arr.flags.c_contiguous:
        return arr
    return np.ascontiguousarray(arr, dtype=np.uint8)


def make_mode_fn(mode: str):
    mode = mode.lower()
    if mode == 'chunk':
        return lambda arr: cm._count_low_grade_occurrences(ensure_uint8(arr))
    if mode == 'broadcast':
        return lambda arr: cm._broadcast_grade_counts(ensure_uint8(arr))
    if mode.startswith('cython'):
        import cython_grade_counts
        def fn(arr):
            contiguous = ensure_uint8(arr)
            return cython_grade_counts.count_grades(contiguous)
        return fn
    raise ValueError(f"Unknown mode: {mode}")


def run_once(label: str, compute_fn, image_paths):
    original = cm._compute_grade_counts
    cm._compute_grade_counts = compute_fn
    start = time.time()
    try:
        result = cm.create_composite_heatmaps(
            image_paths,
            login_id=f"bench_{label}",
            scheme=None,
            create_sum=True,
        )
        duration = time.time() - start
        return duration, result.get('output_dir')
    finally:
        cm._compute_grade_counts = original


def parse_sizes(value: str):
    return [int(x) for x in value.split(',') if x.strip()]


def parse_threads(value: str):
    return [int(x) for x in value.split(',') if x.strip()]


def main():
    parser = argparse.ArgumentParser(description="Benchmark composite map counting strategies")
    parser.add_argument('--image-dir', default=str(Path(IMAGES_ROOT) / 'palette_3k'))
    parser.add_argument('--sizes', default='5,10', help='Comma-separated image counts to test')
    parser.add_argument('--threads', default='4,8,16', help='OMP thread counts for cython mode')
    args = parser.parse_args()

    base = Path(args.image_dir)
    sizes = parse_sizes(args.sizes)
    thread_counts = parse_threads(args.threads)

    modes = ['chunk', 'broadcast', 'cython']
    results = []

    for size in sizes:
        image_subset = collect_images(base, size)
        for mode in modes:
            if mode == 'cython':
                for threads in thread_counts:
                    os.environ['OMP_NUM_THREADS'] = str(threads)
                    import cython_grade_counts
                    importlib.reload(cython_grade_counts)
                    fn = make_mode_fn(mode)
                    label = f"{mode}_n{size}_t{threads}"
                    duration, out_dir = run_once(label, fn, image_subset)
                    results.append((mode, size, threads, duration, out_dir))
                    print(f"[{label}] {duration:.2f}s -> {out_dir}")
            else:
                fn = make_mode_fn(mode)
                label = f"{mode}_n{size}"
                duration, out_dir = run_once(label, fn, image_subset)
                results.append((mode, size, None, duration, out_dir))
                print(f"[{label}] {duration:.2f}s -> {out_dir}")

    print("\n=== Summary ===")
    for mode, size, threads, duration, out_dir in results:
        thread_str = threads if threads is not None else '-'
        print(f"mode={mode:9s} size={size:3d} threads={thread_str:>3} time={duration:7.2f}s output={out_dir}")

if __name__ == '__main__':
    main()
