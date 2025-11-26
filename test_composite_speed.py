"""Test composite map generation speed"""
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

print(f"Testing with {len(image_paths)} images")
print(f"First: {image_paths[0]}\n")

# Test current configuration
os.environ["COMPOSITE_COUNT_MODE"] = "cython"

start = time.perf_counter()

result = cm.create_composite_heatmaps(
    image_paths,
    login_id="speed_test",
    scheme=None,
    create_sum=True,
    loader_mode="thread",
    max_workers=20,
    batch_size=10,
)

total_time = time.perf_counter() - start

print(f"\n{'='*60}")
print(f"Total Time: {total_time:.3f}s")
print(f"{'='*60}")

if 'timings' in result:
    print("\nDetailed Timings:")
    for k, v in result['timings'].items():
        print(f"  {k:25s}: {v:.3f}s ({v/total_time*100:.1f}%)")
