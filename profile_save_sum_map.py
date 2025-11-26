"""Profile _save_sum_map_variants in detail with per-step timings."""
import time
import os
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from api.config import IMAGES_ROOT
import api.composite_map as cm
from PIL import Image

# Allow forcing PNG compress level via env for quick what-if tests
force_compress_level = os.environ.get("FORCE_COMPRESS_LEVEL")
if force_compress_level is not None:
    try:
        force_compress_level = int(force_compress_level)
    except ValueError:
        force_compress_level = None

# Collect 10 images and load them
image_dir = Path("D:/project/data/wm-811k/palette_3k")
image_paths = []
for f in sorted(image_dir.iterdir())[:10]:
    if f.suffix.lower() == '.png':
        image_paths.append(f.relative_to(IMAGES_ROOT).as_posix())

first_img = Image.open(IMAGES_ROOT / image_paths[0])
width, height = first_img.size
source_palette = first_img.getpalette() if first_img.mode == 'P' else None
first_img.close()

print(f"Loading {len(image_paths)} images...")
raw_indices_list = []
for path in image_paths:
    indices = cm._load_pixel_indices_with_cache(path, width, height)
    if indices is not None:
        raw_indices_list.append(indices)

print("Processing indices...")
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

print("Computing grade counts (cython)...")
os.environ["COMPOSITE_COUNT_MODE"] = "cython"
grade_counts = cm._compute_grade_counts(stacked_indices)

print("Computing masks...")
valid_0_7_mask = (stacked_indices >= 0) & (stacked_indices <= 7)
has_valid_0_7 = valid_0_7_mask.any(axis=0)
has_8_13_after = ((stacked_indices >= 8) & (stacked_indices <= 13)).any(axis=0)
only_0_7_mask = has_valid_0_7 & ~has_8_13_after & ~invalid_mask

# Prepare for save
output_dir, _ = cm._prepare_output_dir("profile_test")
palette_list = cm._build_palette_list(source_palette)
palette_list[31 * 3:31 * 3 + 3] = [255, 255, 255]

float_indices = stacked_indices.astype(np.float32)
median_map = np.median(float_indices, axis=0)
median_indices = np.clip(np.rint(median_map), 0, 13).astype(np.uint8)
base_indices = np.full_like(median_indices, 31, dtype=np.uint8)
base_indices[only_0_7_mask] = median_indices[only_0_7_mask]
base_indices[idx_8_13_only] = 8
base_indices[invalid_mask] = 31

print(f"\n{'='*60}")
print("Profiling _save_sum_map_variants")
print(f"{'='*60}\n")

timings = {
    "render": [],
    "render_steps": [],
    "save": [],
    "persist": 0.0,
}

# Instrument rendering and saving
original_render = cm._render_sum_map_image
original_save = Image.Image.save
original_persist = cm._persist_square_map_data
original_interpolate = cm._interpolate_percentile_colors
original_percentile = cm._percentile_ranks
interpolate_calls = []
percentile_calls = []


def timed_percentile(values):
    t = time.perf_counter()
    result = original_percentile(values)
    percentile_calls.append(time.perf_counter() - t)
    return result


def timed_interpolate(*args, **kwargs):
    t = time.perf_counter()
    result = original_interpolate(*args, **kwargs)
    interpolate_calls.append(time.perf_counter() - t)
    return result


def timed_render(*args, **kwargs):
    interp_start = len(interpolate_calls)
    perc_start = len(percentile_calls)
    t0 = time.perf_counter()
    img = original_render(*args, **kwargs)
    duration = time.perf_counter() - t0
    interp_time = sum(interpolate_calls[interp_start:])
    perc_time = sum(percentile_calls[perc_start:])
    timings["render_steps"].append({
        "percentile": perc_time,
        "interpolate": interp_time,
        "other": duration - interp_time - perc_time,
    })
    timings["render"].append(duration)
    return img


def timed_save(self, fp, format=None, **params):
    if force_compress_level is not None and "compress_level" not in params:
        params["compress_level"] = force_compress_level
    t = time.perf_counter()
    result = original_save(self, fp, format=format, **params)
    duration = time.perf_counter() - t
    name = Path(fp).name if isinstance(fp, (str, Path)) else str(fp)
    timings["save"].append((name, duration, params.get("compress_level")))
    return result


def timed_persist(*args, **kwargs):
    t = time.perf_counter()
    result = original_persist(*args, **kwargs)
    timings["persist"] = time.perf_counter() - t
    return result


cm._render_sum_map_image = timed_render
cm._interpolate_percentile_colors = timed_interpolate
cm._percentile_ranks = timed_percentile
Image.Image.save = timed_save
cm._persist_square_map_data = timed_persist

# Now profile the actual save function
t_total = time.perf_counter()

try:
    result = cm._save_sum_map_variants(
        stacked_indices,
        output_dir,
        palette_list,
        invalid_mask=invalid_mask,
        base_indices=base_indices,
        idx_8_mask=idx_8_13_only,
        scheme=None,
        grade_counts=grade_counts,
        only_low_mask=only_0_7_mask,
    )
finally:
    cm._render_sum_map_image = original_render
    cm._interpolate_percentile_colors = original_interpolate
    cm._percentile_ranks = original_percentile
    Image.Image.save = original_save
    cm._persist_square_map_data = original_persist

total_time = time.perf_counter() - t_total

render_total = sum(timings["render"])
save_total = sum(t for _, t, _ in timings["save"])
other = total_time - render_total - save_total - timings["persist"]

print(f"\n{'='*60}")
print(f"_save_sum_map_variants total: {total_time:.3f}s")
print(f"{'='*60}")
print(f"Render total:   {render_total:.3f}s (per-image: {[round(t,3) for t in timings['render']]})")
if timings["render_steps"]:
    step_names = ["percentile", "interpolate", "other"]
    print("Render step averages (per image):")
    for name in step_names:
        avg = sum(step[name] for step in timings["render_steps"]) / len(timings["render_steps"])
        print(f"  {name:12s}: {avg:.3f}s")
print("Save details:")
for name, duration, compress in timings["save"]:
    print(f"  {name}: {duration:.3f}s (compress_level={compress})")
print(f"Save total:     {save_total:.3f}s")
print(f"Persist (npz):  {timings['persist']:.3f}s")
print(f"Other (setup):  {other:.3f}s")
if force_compress_level is not None:
    print(f"Forcing compress_level={force_compress_level}")
