"""
Quick composite benchmark: Numba vs Cython
Measures: image loading, grade counting, NPZ save separately
"""
import time
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from api.config import IMAGES_ROOT
import api.composite_map as cm
import numpy as np

# Collect 10 images
image_dir = Path("D:/project/data/wm-811k/palette_3k")
image_paths = []
for f in sorted(image_dir.iterdir())[:10]:
    if f.suffix.lower() == '.png':
        image_paths.append(f.relative_to(IMAGES_ROOT).as_posix())

print(f"Testing with {len(image_paths)} images")
print(f"First: {image_paths[0]}\n")

# Test configurations
configs = [
    ("numba", 16, 10),
    ("numba", 20, 10),
    ("numba", 24, 12),
    ("cython", 16, 10),
    ("cython", 20, 10),
    ("cython", 24, 12),
]

results = []

for count_mode, workers, batch in configs:
    label = f"{count_mode}_w{workers}_b{batch}"
    print(f"Testing {label}...", flush=True)

    os.environ["COMPOSITE_COUNT_MODE"] = count_mode

    # Measure total time
    start = time.perf_counter()

    try:
        result = cm.create_composite_heatmaps(
            image_paths,
            login_id=f"qbench_{label}",
            scheme=None,
            create_sum=True,
            loader_mode="thread",
            max_workers=workers,
            batch_size=batch,
        )

        total_time = time.perf_counter() - start

        # Wait a bit for NPZ async save
        time.sleep(0.5)

        # Check NPZ file size
        output_dir = IMAGES_ROOT / result['output_dir']
        npz_path = output_dir / "square_maps_data.npz"
        npz_size = npz_path.stat().st_size / 1024 / 1024 if npz_path.exists() else 0

        print(f"  Total: {total_time:.3f}s | NPZ: {npz_size:.1f}MB")

        results.append({
            'mode': count_mode,
            'workers': workers,
            'batch': batch,
            'time': total_time,
            'npz_mb': npz_size,
        })

    except Exception as e:
        print(f"  FAILED: {e}")
        results.append({
            'mode': count_mode,
            'workers': workers,
            'batch': batch,
            'time': -1,
            'npz_mb': 0,
        })

print("\n" + "="*80)
print("RESULTS")
print("="*80)
print(f"{'Mode':<8} {'Workers':<8} {'Batch':<6} {'Time (s)':<10} {'NPZ (MB)':<10}")
print("-"*80)

# Sort by time
results_sorted = sorted(results, key=lambda x: x['time'] if x['time'] > 0 else 999)

for r in results_sorted:
    if r['time'] > 0:
        print(f"{r['mode']:<8} {r['workers']:<8} {r['batch']:<6} {r['time']:<10.3f} {r['npz_mb']:<10.1f}")
    else:
        print(f"{r['mode']:<8} {r['workers']:<8} {r['batch']:<6} {'FAILED':<10} {'-':<10}")

print("="*80)

if results_sorted and results_sorted[0]['time'] > 0:
    best = results_sorted[0]
    print(f"\nBEST: {best['mode']} w{best['workers']} b{best['batch']} = {best['time']:.3f}s")
