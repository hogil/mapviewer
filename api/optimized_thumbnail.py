"""Helpers for optimized thumbnail generation and metadata caching."""

from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Tuple

from PIL import Image

__all__ = ["get_cached_image_size", "clear_image_size_cache"]

_size_cache_lock = RLock()


@lru_cache(maxsize=512)
def _read_image_size(path_str: str, mtime: float) -> Tuple[int, int]:
    with Image.open(path_str) as img:
        width, height = img.size
    return int(width), int(height)


def get_cached_image_size(image_path: Path) -> Tuple[int, int]:
    """Return cached image dimensions keyed by file mtime."""
    mtime = image_path.stat().st_mtime
    with _size_cache_lock:
        return _read_image_size(str(image_path), mtime)


def clear_image_size_cache() -> int:
    """Clear cached image metadata and return the number of entries removed."""
    with _size_cache_lock:
        current = _read_image_size.cache_info().currsize
        _read_image_size.cache_clear()
    return current

