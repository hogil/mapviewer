"""
Compare encoding speed and output size for multiple thumbnail formats.

Edit `SOURCE_IMAGE_PATH` and `LEVEL` at the top, then run:
    python scripts/pyramid_format_probe.py
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from PIL import Image

# === Configuration (edit these) ============================================
SOURCE_IMAGE_PATH = Path(
    r"D:\project\data\wm-811k\wafer_center_hot\wafer_center_hot_0113.png"
)
LEVEL = 0.7  # 1.0 keeps original resolution, <1.0 downsamples
OUTPUT_DIR = Path("_out/format_tests")  # created automatically
# ============================================================================


@dataclass
class EncodeResult:
    label: str
    path: Path
    size_bytes: int
    elapsed_ms: float


def _time_call(func: Callable[[], None]) -> float:
    start = time.perf_counter()
    func()
    end = time.perf_counter()
    return (end - start) * 1000.0


def generate_variants(image_path: Path, level: float, target_dir: Path) -> Iterable[EncodeResult]:
    Image.MAX_IMAGE_PIXELS = None  # avoid DecompressionBombWarning for 10k x 10k inputs

    with Image.open(image_path) as src:
        print(f"Original: mode={src.mode}, size={src.size[0]}x{src.size[1]}, bytes={image_path.stat().st_size:,}")

        rgb = src.convert("RGB")
        new_size = (
            max(1, math.floor(rgb.width * level)),
            max(1, math.floor(rgb.height * level)),
        )
        if new_size == rgb.size:
            resized = rgb
        else:
            resized = rgb.resize(new_size, Image.Resampling.BICUBIC)
        print(f"Resized:  size={resized.width}x{resized.height} (level={level})")

        target_dir.mkdir(parents=True, exist_ok=True)

        def encode(label: str, filename: str, save_kwargs: dict) -> EncodeResult:
            dest = target_dir / filename
            elapsed_ms = _time_call(lambda: resized.save(dest, **save_kwargs))
            size_bytes = dest.stat().st_size
            return EncodeResult(label=label, path=dest, size_bytes=size_bytes, elapsed_ms=elapsed_ms)

        yield encode("PNG lvl3", f"{image_path.stem}_L{int(level*100)}_png.png", {"format": "PNG", "compress_level": 3})
        yield encode("JPEG q95", f"{image_path.stem}_L{int(level*100)}_q95.jpg", {"format": "JPEG", "quality": 95, "optimize": True})
        yield encode("JPEG q100", f"{image_path.stem}_L{int(level*100)}_q100.jpg", {"format": "JPEG", "quality": 100, "optimize": True})
        yield encode("WEBP q95", f"{image_path.stem}_L{int(level*100)}_q95.webp", {"format": "WEBP", "quality": 95, "method": 1})
        yield encode("WEBP q100", f"{image_path.stem}_L{int(level*100)}_q100.webp", {"format": "WEBP", "quality": 100, "method": 1})


def main() -> None:
    if not SOURCE_IMAGE_PATH.is_file():
        raise FileNotFoundError(f"Source image not found: {SOURCE_IMAGE_PATH}")

    print(f"Running pyramid format probe on: {SOURCE_IMAGE_PATH}")
    results = list(generate_variants(SOURCE_IMAGE_PATH, LEVEL, OUTPUT_DIR))

    print("\n=== Results ===")
    for result in results:
        print(f"{result.label:<12} {result.size_bytes:>12,} bytes | {result.elapsed_ms:>7.1f} ms | {result.path}")


if __name__ == "__main__":
    main()
