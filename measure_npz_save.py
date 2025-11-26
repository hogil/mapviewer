"""Measure NPZ save time"""
import time
import numpy as np
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from api.config import IMAGES_ROOT

# Simulate NPZ data (similar to actual composite map)
height, width = 6162, 6162
npz_data = {
    "square_mean": np.random.rand(height, width).astype(np.float32),
    "square_weighted": np.random.rand(height, width).astype(np.float32),
    "calc_mask": np.random.randint(0, 2, (height, width), dtype=bool),
    "weighted_mask": np.random.randint(0, 2, (height, width), dtype=bool),
    "base_indices": np.random.randint(0, 32, (height, width), dtype=np.uint8),
    "palette": np.random.randint(0, 256, (256, 3), dtype=np.uint8),
    "grade_counts": np.random.randint(0, 10, (8, height, width), dtype=np.uint16),
}

test_path = Path("test_npz_save.npz")

# Measure synchronous save
start = time.perf_counter()
np.savez_compressed(test_path, **npz_data)
sync_time = time.perf_counter() - start

file_size_mb = test_path.stat().st_size / 1024 / 1024
test_path.unlink()

print(f"NPZ Save Time: {sync_time:.3f}s")
print(f"File Size: {file_size_mb:.1f}MB")
print(f"\nNote: This is ASYNC in actual code (daemon thread)")
print(f"      so it doesn't block the main pipeline")
