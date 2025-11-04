"""Helpers for loading and applying personalized color palettes."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

logger = logging.getLogger(__name__)

COLOR_LEGENDS_PATH = Path(__file__).parent.parent / "logs" / "color-legends.json"
COLOR_LEGENDS_LOCK = RLock()

_color_legends_cache: Optional[Dict[str, Any]] = None
_color_legends_mtime: float = 0.0
_PALETTE_CACHE: Dict[str, bytes] = {}

TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7']
BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288']


def load_color_legends() -> Dict[str, Any]:
    """Load color legend data with simple caching."""
    global _color_legends_cache, _color_legends_mtime

    with COLOR_LEGENDS_LOCK:
        try:
            if not COLOR_LEGENDS_PATH.exists():
                return {}

            current_mtime = COLOR_LEGENDS_PATH.stat().st_mtime
            if _color_legends_cache is not None and current_mtime == _color_legends_mtime:
                return _color_legends_cache

            with COLOR_LEGENDS_PATH.open('r', encoding='utf-8') as fh:
                _color_legends_cache = json.load(fh)
                _color_legends_mtime = current_mtime
                return _color_legends_cache
        except Exception as exc:
            logger.warning("color-legends.json 로드 실패: %s", exc)
            return _color_legends_cache or {}


def save_color_legends(legends: Dict[str, Any]) -> bool:
    """Persist legends to disk."""
    global _color_legends_cache, _color_legends_mtime

    with COLOR_LEGENDS_LOCK:
        try:
            COLOR_LEGENDS_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = COLOR_LEGENDS_PATH.with_suffix('.json.tmp')

            with tmp_path.open('w', encoding='utf-8') as fh:
                json.dump(legends, fh, ensure_ascii=False, indent=2)

            tmp_path.replace(COLOR_LEGENDS_PATH)
            _color_legends_cache = legends
            _color_legends_mtime = COLOR_LEGENDS_PATH.stat().st_mtime
            _PALETTE_CACHE.clear()
            return True
        except Exception as exc:
            logger.error("color-legends.json 저장 실패: %s", exc)
            return False


def normalize_hex_color(value: str) -> str:
    if value is None:
        raise ValueError("색상 값이 비어 있습니다.")
    normalized = value.strip().upper()
    if not normalized:
        raise ValueError("색상 값이 비어 있습니다.")
    if not normalized.startswith('#'):
        normalized = f'#{normalized}'
    if not normalized or len(normalized) != 7:
        raise ValueError(f"유효하지 않은 색상: {value}")
    int(normalized[1:], 16)  # ValueError raised if invalid
    return normalized


def get_user_color_scheme(login_id: Optional[str]) -> str:
    """Resolve scheme key for a user. Anonymous users default to 'change'."""
    if not login_id:
        return 'change'

    legends = load_color_legends()
    if login_id in legends:
        return login_id

    if 'default' in legends:
        legends[login_id] = copy.deepcopy(legends['default'])
        save_color_legends(legends)
        logger.info("새 color scheme 생성: %s (from default)", login_id)
        return login_id

    logger.warning("default scheme 없음, change로 대체: LoginId=%s", login_id)
    return 'change'


def _hex_to_rgb_triple(hex_value: str) -> Tuple[int, int, int]:
    hex_value = normalize_hex_color(hex_value)
    return tuple(int(hex_value[i : i + 2], 16) for i in (1, 3, 5))


def _scheme_to_palette_bytes(scheme: Dict[str, Any]) -> bytes:
    palette: List[int] = []
    top = scheme.get('top', {})
    bottom = scheme.get('bottom', {})
    background = scheme.get('background', '#000000')

    for key in TOP_KEYS:
        palette.extend(_hex_to_rgb_triple(top.get(key, '#000000')))
    for key in BOTTOM_KEYS:
        palette.extend(_hex_to_rgb_triple(bottom.get(key, '#000000')))
    palette.extend(_hex_to_rgb_triple(background))

    # fill the remaining 16th slot if needed
    if len(palette) < 16 * 3:
        palette.extend(_hex_to_rgb_triple(background))

    # ensure total length covers first 16 palette entries (16 * 3)
    if len(palette) < 16 * 3:
        palette.extend([0, 0, 0] * (16 - len(palette) // 3))

    return bytes(palette[: 16 * 3])


def _palette_cache_key(scheme: Dict[str, Any]) -> str:
    normalized = json.dumps(scheme, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(normalized.encode('utf-8')).hexdigest()


def get_palette_for_scheme(scheme_data: Dict[str, Any]) -> bytes:
    """Return cached palette bytes for the given scheme data."""
    cache_key = _palette_cache_key(scheme_data)
    cached = _PALETTE_CACHE.get(cache_key)
    if cached:
        return cached
    palette_bytes = _scheme_to_palette_bytes(scheme_data)
    _PALETTE_CACHE[cache_key] = palette_bytes
    return palette_bytes


def swap_first16_colors(img: Image.Image, palette_bytes: bytes) -> Optional[Image.Image]:
    """Swap first 16 palette slots with provided RGB bytes."""
    if img.mode != 'P':
        return None
    palette = img.getpalette()
    if not palette:
        return None
    new_palette = palette[:]
    new_palette[: len(palette_bytes)] = list(palette_bytes)
    out = img.copy()
    out.putpalette(new_palette)
    return out


def apply_personalized_palette(img: Image.Image, scheme_data: Dict[str, Any]) -> Optional[Image.Image]:
    """Return a palette-swapped copy of the given image."""
    if img.mode != 'P':
        return None
    if not scheme_data:
        return None
    palette_bytes = get_palette_for_scheme(scheme_data)
    return swap_first16_colors(img, palette_bytes)


def prepare_personalized_image(image_path: Path, scheme: str, legends: Dict[str, Any]) -> Optional[Image.Image]:
    """Load an image and apply the palette for the requested scheme."""
    scheme_data = legends.get(scheme)
    if not scheme_data:
        return None
    try:
        with Image.open(image_path) as src:
            personalized = apply_personalized_palette(src, scheme_data)
            if personalized is None:
                return None
            return personalized
    except Exception as exc:
        logger.warning("개인색 팔레트 적용 실패 (%s): %s", image_path, exc)
        return None


__all__ = [
    "load_color_legends",
    "save_color_legends",
    "get_user_color_scheme",
    "prepare_personalized_image",
    "apply_personalized_palette",
    "swap_first16_colors",
]
