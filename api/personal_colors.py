"""Helpers for loading and applying personalized color palettes."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import struct
import zlib
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

# PIL DecompressionBombWarning 제한 해제 (큰 이미지 로드 허용)
Image.MAX_IMAGE_PIXELS = None  # 제한 없음

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


def get_user_color_scheme(login_id: Optional[str], username: Optional[str] = None, dept_name: Optional[str] = None) -> str:
    """Resolve scheme key for a user. Anonymous users default to 'change'.
    
    Args:
        login_id: 사용자 LoginId
        username: 사용자 Username (선택)
        dept_name: 사용자 DeptName (선택)
    
    Returns:
        scheme key (LoginId 또는 'change')
    """
    if not login_id:
        return 'change'

    legends = load_color_legends()
    
    # LoginId가 이미 있으면 반환 (이미 존재하면 생성하지 않음)
    if login_id in legends:
        return login_id
    
    # default scheme이 없으면 생성 불가
    if 'default' not in legends:
        logger.warning("default scheme 없음, change로 대체: LoginId=%s", login_id)
        return 'change'
    
    # LoginId scheme만 생성 (존재하지 않을 때만)
    # default의 top, bottom, background, text value를 복사
    legends[login_id] = copy.deepcopy(legends['default'])
    
    # LoginId scheme에 Username과 DeptName 메타데이터 추가
    if username:
        legends[login_id]['Username'] = username
    if dept_name:
        legends[login_id]['DeptName'] = dept_name
    
    # 변경사항 저장
    save_color_legends(legends)
    logger.info("새 color scheme 생성: %s (from default, Username=%s, DeptName=%s)", 
                login_id, username or 'None', dept_name or 'None')
    
    return login_id


def _hex_to_rgb_triple(hex_value: str) -> Tuple[int, int, int]:
    hex_value = normalize_hex_color(hex_value)
    return tuple(int(hex_value[i : i + 2], 16) for i in (1, 3, 5))


def _scheme_to_palette_bytes(scheme: Dict[str, Any]) -> bytes:
    """
    Convert color scheme to palette bytes.
    
    scheme의 색상을 순서대로 인덱스 0~15에 매핑:
    - top의 색상들 순서대로 (Grade0~7) → 인덱스 0~7
    - bottom의 색상들 순서대로 (Normal, Invalid, B285~8) → 인덱스 8~13
    - background → 인덱스 14
    - text → 인덱스 15
    - 총 16개 색상 (48 bytes = 16 * 3 RGB)
    """
    palette: List[int] = []
    top = scheme.get('top', {})
    bottom = scheme.get('bottom', {})
    background = scheme.get('background', '#000000')
    text = scheme.get('text', '#000001')

    # top의 색상들 순서대로 (Grade0~7) → 인덱스 0~7
    for key in TOP_KEYS:
        palette.extend(_hex_to_rgb_triple(top.get(key, '#000000')))
    
    # bottom의 색상들 순서대로 (Normal, Invalid, B285~8) → 인덱스 8~13
    for key in BOTTOM_KEYS:
        palette.extend(_hex_to_rgb_triple(bottom.get(key, '#000000')))
    
    # background → 인덱스 14
    palette.extend(_hex_to_rgb_triple(background))
    
    # text → 인덱스 15
    palette.extend(_hex_to_rgb_triple(text))

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
    """
    Swap first 16 palette slots with provided RGB bytes.
    
    기존 팔레트의 처음 48바이트(인덱스 0~15의 RGB 값)를
    scheme에서 생성한 palette_bytes로 무조건 덮어씁니다.
    
    이미지의 픽셀 데이터는 변경하지 않고 팔레트만 교체하므로
    빠르고 메모리 효율적입니다.
    
    주의: 기존 팔레트 인덱스의 의미와 관계없이 무조건 덮어씁니다.
    """
    if img.mode != 'P':
        return None
    palette = img.getpalette()
    if not palette:
        return None
    new_palette = palette[:]
    # 무조건 처음 48바이트(인덱스 0~15)를 새로운 RGB 값으로 덮어쓰기
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


def plte_inplace_patch_memory(png_data: bytearray, scheme: str) -> bytearray:
    """
    메모리 상태에서 PLTE 인-place 패치 (O(1) 팔레트 변경).
    
    PNG 파일의 PLTE 청크만 수정하여 색상을 변경합니다.
    IDAT는 재압축하지 않으므로 매우 빠릅니다.
    
    Args:
        png_data: PNG 파일의 바이트 데이터 (bytearray)
        scheme: 색상 스킴 이름 (예: 'change', 'default')
    
    Returns:
        수정된 PNG 바이트 데이터 (bytearray)
    """
    legends = load_color_legends()
    scheme_data = legends.get(scheme)
    if not scheme_data:
        scheme_data = list(legends.values())[0] if legends else None
        if not scheme_data:
            raise ValueError(f"scheme 데이터 없음: {scheme}")
    
    palette_bytes = get_palette_for_scheme(scheme_data)
    new_palette = list(palette_bytes)
    
    # PNG 청크 찾기
    pos = 8  # PNG 시그니처 건너뛰기
    
    while pos < len(png_data):
        if pos + 4 > len(png_data):
            break
        chunk_length = struct.unpack('>I', png_data[pos:pos+4])[0]
        pos += 4
        
        if pos + 4 > len(png_data):
            break
        chunk_type = png_data[pos:pos+4]
        pos += 4
        
        if chunk_type == b'PLTE':
            # PLTE 데이터 수정
            plte_start = pos
            plte_end = pos + chunk_length
            
            # 기존 PLTE 데이터 읽기
            current_plte = list(png_data[plte_start:plte_end])
            
            # 인덱스 0~15의 RGB 값 교체 (48바이트)
            new_plte = current_plte[:]
            new_plte[:48] = new_palette[:48]  # ← 여기서 색상 교체
            
            # PLTE 데이터 교체
            png_data[plte_start:plte_end] = new_plte
            
            # CRC 재계산 및 수정
            crc_data = chunk_type + bytes(new_plte)
            crc = zlib.crc32(crc_data) & 0xffffffff
            
            if plte_end + 4 <= len(png_data):
                png_data[plte_end:plte_end+4] = struct.pack('>I', crc)
            break
        
        pos += chunk_length + 4
    
    return png_data


__all__ = [
    "load_color_legends",
    "save_color_legends",
    "get_user_color_scheme",
    "prepare_personalized_image",
    "apply_personalized_palette",
    "swap_first16_colors",
    "plte_inplace_patch_memory",
]
