"""
Benchmark pyramid level generation strategies for a single image.

Usage:
    python scripts/level07_speedtest.py [path_to_image] [level]

If no arguments are provided, the script falls back to:
    source = ./input.png
    level = 0.7

Results (encoding time + output size) are printed and saved under
    _out/level_bench/<method>_<format>.<ext>
"""

from __future__ import annotations

import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

import pyvips
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api import config


DEFAULT_SOURCE = Path("input.png")
DEFAULT_LEVEL = 0.7
OUTPUT_ROOT = Path("_out/level_bench")

ResampleRunner = Callable[[str, Path], None]


@dataclass
class ResultRow:
    method: str
    fmt: str
    dest: Path
    elapsed_ms: float
    size_bytes: Optional[int]
    error: Optional[str] = None


def _ensure_output_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _format_bytes(size: Optional[int]) -> str:
    if size is None:
        return "-"
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            return f"{value:6.1f}{unit}"
        value /= 1024.0
    return f"{value:6.1f}{units[-1]}"


def _save_with_pyvips(image: pyvips.Image, fmt: str, dest: Path) -> None:
    dest_str = str(dest)
    fmt_upper = fmt.upper()
    if fmt_upper == "PNG":
        image.pngsave(
            dest_str,
            compression=config.PYRAMID_PNG_COMPRESSION,
            interlace=False,
            strip=True,
            effort=config.PYRAMID_PNG_EFFORT,
            keep=pyvips.enums.ForeignKeep.NONE,
        )
    elif fmt_upper in {"JPG", "JPEG"}:
        image.jpegsave(
            dest_str,
            Q=config.PYRAMID_Q,
            strip=True,
            optimize_coding=True,
            subsample_mode="auto",
        )
    elif fmt_upper == "WEBP":
        image.webpsave(
            dest_str,
            Q=config.PYRAMID_Q,
            lossless=False,
            effort=1,
            strip=True,
            smart_subsample=False,
        )
    else:
        raise ValueError(f"Unsupported format: {fmt}")


def _save_with_pillow(image: Image.Image, fmt: str, dest: Path) -> None:
    fmt_upper = fmt.upper()
    kwargs: Dict[str, object] = {}
    if fmt_upper == "PNG":
        kwargs["compress_level"] = config.PYRAMID_PNG_COMPRESSION
    elif fmt_upper in {"JPG", "JPEG"}:
        kwargs["quality"] = config.PYRAMID_Q
        kwargs["optimize"] = True
        kwargs["progressive"] = True
    elif fmt_upper == "WEBP":
        kwargs["quality"] = config.PYRAMID_Q
        kwargs["method"] = 1
        kwargs["lossless"] = False
    else:
        raise ValueError(f"Unsupported format: {fmt}")
    image.save(dest, format=fmt_upper, **kwargs)


def _build_pyvips_resize_runner(
    source: Path, level: float, kernel_name: str, reduction: bool
) -> ResampleRunner:
    def runner(fmt: str, dest: Path) -> None:
        base = pyvips.Image.new_from_file(str(source), access="sequential")
        if reduction:
            factor = 1.0 / level
            work = base.reduce(factor, factor, kernel=kernel_name)
        else:
            work = base.resize(level, kernel=kernel_name)
        _save_with_pyvips(work, fmt, dest)

    return runner


def _build_pyvips_thumbnail_runner(
    source: Path, target_w: int, target_h: int
) -> ResampleRunner:
    def runner(fmt: str, dest: Path) -> None:
        # thumbnail() always reopens the file, which is fine for benchmarking.
        thumb = pyvips.Image.thumbnail(
            str(source),
            target_w,
            height=target_h,
            size=pyvips.enums.Size.FORCE,
        )
        _save_with_pyvips(thumb, fmt, dest)

    return runner


def _build_pillow_runner(
    source: Path, size: Tuple[int, int], kernel_name: str
) -> ResampleRunner:
    resample_map = {
        "nearest": Image.Resampling.NEAREST,
        "linear": Image.Resampling.BILINEAR,
        "bilinear": Image.Resampling.BILINEAR,
        "cubic": Image.Resampling.BICUBIC,
        "bicubic": Image.Resampling.BICUBIC,
        "lanczos": Image.Resampling.LANCZOS,
        "lanczos2": Image.Resampling.LANCZOS,
        "lanczos3": Image.Resampling.LANCZOS,
    }
    resample = resample_map.get(kernel_name, Image.Resampling.BICUBIC)

    def runner(fmt: str, dest: Path) -> None:
        with Image.open(source) as img:
            if size[0] == img.width and size[1] == img.height:
                resized = img.copy()
            else:
                resized = img.resize(size, resample=resample)

            if fmt.upper() in {"JPG", "JPEG", "WEBP"} and resized.mode not in ("RGB", "L"):
                resized = resized.convert("RGB")
            elif fmt.upper() == "PNG" and resized.mode == "P" and "transparency" in resized.info:
                resized = resized.convert("RGBA")

            _save_with_pillow(resized, fmt, dest)

    return runner


def _collect_methods(
    source: Path, level: float, kernel_name: str, target_size: Tuple[int, int]
) -> List[Tuple[str, ResampleRunner]]:
    return [
        ("pyvips_resize", _build_pyvips_resize_runner(source, level, kernel_name, reduction=False)),
        ("pyvips_reduce", _build_pyvips_resize_runner(source, level, kernel_name, reduction=True)),
        ("pyvips_thumbnail", _build_pyvips_thumbnail_runner(source, *target_size)),
        ("pillow_resize", _build_pillow_runner(source, target_size, kernel_name)),
    ]


def _run_benchmark(
    source: Path,
    level: float,
    methods: Iterable[Tuple[str, ResampleRunner]],
    formats: Iterable[str],
    out_root: Path,
) -> List[ResultRow]:
    rows: List[ResultRow] = []
    for method_name, runner in methods:
        for fmt in formats:
            suffix = "jpg" if fmt.upper() == "JPEG" else fmt.lower()
            dest = out_root / f"{method_name}_{fmt.lower()}.{suffix}"
            _ensure_output_dir(dest)

            start = time.perf_counter()
            error: Optional[str] = None
            size_bytes: Optional[int] = None
            try:
                runner(fmt, dest)
                size_bytes = dest.stat().st_size
            except Exception as exc:
                error = str(exc)
                if dest.exists():
                    dest.unlink(missing_ok=True)  # type: ignore[attr-defined]
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            rows.append(ResultRow(method_name, fmt.upper(), dest, elapsed_ms, size_bytes, error))
    return rows


def _print_results(rows: Iterable[ResultRow]) -> None:
    header = f"{'Method':18} {'Format':6} {'Time (ms)':>10} {'Size':>10}  Result"
    print(header)
    print("-" * len(header))
    for row in rows:
        size_text = _format_bytes(row.size_bytes)
        status = "OK" if row.error is None else f"ERROR: {row.error}"
        print(f"{row.method:18} {row.fmt:6} {row.elapsed_ms:10.1f} {size_text:>10}  {row.dest if row.error is None else status}")


def main(argv: List[str]) -> int:
    source = Path(argv[0]) if argv else DEFAULT_SOURCE
    level = float(argv[1]) if len(argv) > 1 else DEFAULT_LEVEL
    format_arg = argv[2] if len(argv) > 2 else "PNG,JPEG,WEBP"
    formats = tuple(
        fmt.strip().upper()
        for fmt in format_arg.split(",")
        if fmt.strip()
    )
    if not formats:
        print("At least one format must be provided.", file=sys.stderr)
        return 1

    if not source.is_file():
        print(f"Source image not found: {source}", file=sys.stderr)
        return 1
    if not (0.0 < level <= 1.0):
        print(f"Level must be in (0, 1], got {level}", file=sys.stderr)
        return 1

    base = pyvips.Image.new_from_file(str(source), access="sequential")
    target_w = max(1, math.floor(base.width * level))
    target_h = max(1, math.floor(base.height * level))
    kernel_name = (config.PYRAMID_KERNEL or "cubic").lower()

    print(f"Source: {source} | {base.width}x{base.height}")
    print(f"Level:  {level} -> target {target_w}x{target_h}")
    print("Kernel:", kernel_name, "| Formats:", ", ".join(formats))

    methods = _collect_methods(source, level, kernel_name, (target_w, target_h))
    rows = _run_benchmark(
        source,
        level,
        methods,
        formats=formats,
        out_root=OUTPUT_ROOT,
    )
    rows_sorted = sorted(rows, key=lambda r: r.elapsed_ms)
    _print_results(rows_sorted)

    fastest = rows_sorted[0]
    if fastest.error is None:
        print("\nFastest combination:")
        print(f"  Method: {fastest.method}")
        print(f"  Format: {fastest.fmt}")
        print(f"  Time:   {fastest.elapsed_ms:.1f} ms")
        print(f"  Size:   {_format_bytes(fastest.size_bytes)}")
        print(f"  File:   {fastest.dest}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
