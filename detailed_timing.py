"""Detailed timing of create_composite_heatmaps with instrumentation"""
import time
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from api.config import IMAGES_ROOT
import api.composite_map as cm

# Collect 10 images
image_dir = Path("D:/project/data/wm-811k/palette_3k")
image_paths = []
for f in sorted(image_dir.iterdir())[:10]:
    if f.suffix.lower() == '.png':
        image_paths.append(f.relative_to(IMAGES_ROOT).as_posix())

print(f"Testing with {len(image_paths)} images\n")

os.environ["COMPOSITE_COUNT_MODE"] = "cython"

# Instrument the code with timing
original_copy_positions = cm._copy_positions_without_bin
original_save_sum_map = cm._save_sum_map_variants
original_prepare_output = cm._prepare_output_dir

timings = {}

def timed_copy_positions(*args, **kwargs):
    t = time.perf_counter()
    result = original_copy_positions(*args, **kwargs)
    timings['copy_positions'] = time.perf_counter() - t
    return result

def timed_save_sum_map(*args, **kwargs):
    t = time.perf_counter()
    result = original_save_sum_map(*args, **kwargs)
    timings['save_sum_map'] = time.perf_counter() - t
    return result

def timed_prepare_output(*args, **kwargs):
    t = time.perf_counter()
    result = original_prepare_output(*args, **kwargs)
    timings['prepare_output'] = time.perf_counter() - t
    return result

cm._copy_positions_without_bin = timed_copy_positions
cm._save_sum_map_variants = timed_save_sum_map
cm._prepare_output_dir = timed_prepare_output

# Run with detailed timing
print("Running create_composite_heatmaps...")
overall_start = time.perf_counter()

result = cm.create_composite_heatmaps(
    image_paths,
    login_id="timing_test",
    scheme=None,
    create_sum=True,
    loader_mode="thread",
    max_workers=20,
    batch_size=10,
)

overall_time = time.perf_counter() - overall_start

print(f"\nOverall time: {overall_time:.3f}s")
print(f"Reported processing_time: {result.get('processing_time', 'N/A')}s")

print("\n" + "="*60)
print("DETAILED BREAKDOWN")
print("="*60)

if 'prepare_output' in timings:
    print(f"Prepare output dir:  {timings['prepare_output']:.3f}s")

if 'save_sum_map' in timings:
    print(f"Save sum maps:       {timings['save_sum_map']:.3f}s")

if 'copy_positions' in timings:
    print(f"Copy positions:      {timings['copy_positions']:.3f}s")

accounted = sum(timings.values())
print(f"{'='*60}")
print(f"Instrumented total:  {accounted:.3f}s")
print(f"Overall measured:    {overall_time:.3f}s")
print(f"Unaccounted:         {overall_time - accounted:.3f}s")

# Restore
cm._copy_positions_without_bin = original_copy_positions
cm._save_sum_map_variants = original_save_sum_map
cm._prepare_output_dir = original_prepare_output
