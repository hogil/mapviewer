"""Profile each stage of composite map generation"""
import time
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from api.config import IMAGES_ROOT
from api import composite_map as cm
from PIL import Image
import numpy as np

# Collect 10 images
image_dir = Path("D:/project/data/wm-811k/palette_3k")
image_paths = []
for f in sorted(image_dir.iterdir())[:10]:
    if f.suffix.lower() == '.png':
        image_paths.append(f.relative_to(IMAGES_ROOT).as_posix())

print(f"Profiling with {len(image_paths)} images\n")

# Get image dimensions
first_img = Image.open(IMAGES_ROOT / image_paths[0])
width, height = first_img.size
first_img.close()

print(f"Image size: {width}x{height} = {width*height:,} pixels\n")

# Best config
os.environ["COMPOSITE_COUNT_MODE"] = "cython"
workers = 20
batch = 10

print("="*60)
print("STAGE-BY-STAGE PROFILING")
print("="*60)

# Stage 1: Image Loading
print("\n[1/5] Image Loading (with caching)...")
t1 = time.perf_counter()

raw_indices_list = []
for path in image_paths:
    indices = cm._load_pixel_indices_with_cache(path, width, height)
    if indices is not None:
        raw_indices_list.append(indices)

load_time = time.perf_counter() - t1
print(f"      {load_time:.3f}s ({len(raw_indices_list)} images)")

# Stage 2: Stack and Process
print("\n[2/5] Stack and mask processing...")
t2 = time.perf_counter()

stacked_raw = np.stack(raw_indices_list, axis=0)
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

stack_time = time.perf_counter() - t2
print(f"      {stack_time:.3f}s")

# Stage 3: Grade Counting (Cython)
print("\n[3/5] Grade counting (Cython)...")
t3 = time.perf_counter()

grade_counts = cm._compute_grade_counts(stacked_indices)

count_time = time.perf_counter() - t3
print(f"      {count_time:.3f}s")

# Stage 4: Map Calculation
print("\n[4/5] Square map calculation...")
t4 = time.perf_counter()

valid_0_7_mask = (stacked_indices >= 0) & (stacked_indices <= 7)
has_valid_0_7 = valid_0_7_mask.any(axis=0)
has_8_13_after = ((stacked_indices >= 8) & (stacked_indices <= 13)).any(axis=0)
only_0_7_mask = has_valid_0_7 & ~has_8_13_after & ~invalid_mask

grade_counts_float = grade_counts.astype(np.float32)
square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
square_sums = np.sum(grade_counts_float * square_weights, axis=0)

weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32).reshape(8, 1, 1)
weight_map = np.sum(grade_counts_float * weight_factors, axis=0)

calc_time = time.perf_counter() - t4
print(f"      {calc_time:.3f}s")

# Stage 5: Image Rendering (PNG save)
print("\n[5/5] Image rendering and PNG save (8 Grade + 2 Sum)...")
t5 = time.perf_counter()

# Simulate 10 image saves (8 grade + 2 sum maps)
from PIL import Image
test_arr = np.random.randint(0, 256, (height, width), dtype=np.uint8)
test_img = Image.fromarray(test_arr, mode='L')

save_times = []
for i in range(10):
    ts = time.perf_counter()
    test_img.save(f"test_save_{i}.png", format='PNG', optimize=False, compress_level=0)
    save_times.append(time.perf_counter() - ts)

for i in range(10):
    Path(f"test_save_{i}.png").unlink(missing_ok=True)

avg_save = np.mean(save_times)
total_save = sum(save_times)

print(f"      {total_save:.3f}s ({avg_save:.3f}s per image)")

# Total
total = load_time + stack_time + count_time + calc_time + total_save

print("\n" + "="*60)
print("SUMMARY")
print("="*60)
print(f"Image Loading:       {load_time:7.3f}s  ({load_time/total*100:5.1f}%)")
print(f"Stack Processing:    {stack_time:7.3f}s  ({stack_time/total*100:5.1f}%)")
print(f"Grade Counting:      {count_time:7.3f}s  ({count_time/total*100:5.1f}%)")
print(f"Map Calculation:     {calc_time:7.3f}s  ({calc_time/total*100:5.1f}%)")
print(f"PNG Save (10 imgs):  {total_save:7.3f}s  ({total_save/total*100:5.1f}%)")
print("-"*60)
print(f"TOTAL:               {total:7.3f}s")
print("="*60)

print("\n* NPZ save (~75s) runs ASYNC and is NOT included above")
