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
BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288', 'B290', 'B291']


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


def _compact_color_dicts(text: str) -> str:
    """중첩 없는 leaf 딕셔너리를 한 줄로 압축 (top/bottom 색상, composite scheme 항목 등)"""
    import re

    def replace_block(match):
        key = match.group(1)
        inner = match.group(2)
        # 문자열, boolean, null, 숫자 값만 있는 경우 압축
        pairs = re.findall(r'"([^"]+)":\s*("[^"]*"|true|false|null|-?\d+(?:\.\d+)?)', inner)
        if not pairs:
            return match.group(0)
        items = ', '.join(f'"{k}": {v}' for k, v in pairs)
        return f'"{key}": {{{items}}}'

    # 중첩 객체 없는 모든 leaf 딕셔너리를 한 줄로 압축
    return re.sub(r'"([^"]+)":\s*(\{[^{}]+\})', replace_block, text, flags=re.DOTALL)


def save_color_legends(legends: Dict[str, Any], updated_scheme_name: Optional[str] = None) -> bool:
    """Persist legends to disk.
    
    Args:
        legends: 저장할 color legends 데이터
        updated_scheme_name: 업데이트된 scheme 이름 (마지막 수정 시간 추가용)
    """
    global _color_legends_cache, _color_legends_mtime

    with COLOR_LEGENDS_LOCK:
        try:
            COLOR_LEGENDS_PATH.parent.mkdir(parents=True, exist_ok=True)
            
            # 업데이트된 scheme에 마지막 수정 시간 추가
            if updated_scheme_name and updated_scheme_name in legends:
                from datetime import datetime
                timestamp = datetime.now().strftime('%y%m%d_%H%M%S')
                legends[updated_scheme_name]['lastModified'] = timestamp
            
            tmp_path = COLOR_LEGENDS_PATH.with_suffix('.json.tmp')

            with tmp_path.open('w', encoding='utf-8') as fh:
                raw = json.dumps(legends, ensure_ascii=False, indent=2)
                fh.write(_compact_color_dicts(raw))

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

    색상 저장 시점에 처음으로 JSON 항목이 생성됩니다 (로그인 시 자동 생성 안 함).

    Returns:
        scheme key (LoginId 또는 'change')
    """
    if not login_id:
        return 'change'
    return login_id


def _hex_to_rgb_triple(hex_value: str) -> Tuple[int, int, int]:
    hex_value = normalize_hex_color(hex_value)
    return tuple(int(hex_value[i : i + 2], 16) for i in (1, 3, 5))


def _scheme_to_palette_bytes(scheme: Dict[str, Any]) -> bytes:
    """
    Convert color scheme to palette bytes.
    
    scheme의 색상을 순서대로 인덱스 0~17에 매핑:
    - top의 색상들 순서대로 (Grade0~7) → 인덱스 0~7
    - bottom의 색상들 순서대로 (Normal, Invalid, B285~8, B290, B291) → 인덱스 8~15
    - background → 인덱스 16
    - text → 인덱스 17
    - 총 18개 색상 (54 bytes = 18 * 3 RGB)
    """
    palette: List[int] = []
    top = scheme.get('top', {})
    bottom = scheme.get('bottom', {})
    background = scheme.get('background', '#000000')
    text = scheme.get('text', '#000001')

    # top의 색상들 순서대로 (Grade0~7) → 인덱스 0~7
    for key in TOP_KEYS:
        palette.extend(_hex_to_rgb_triple(top.get(key, '#000000')))
    
    # bottom의 색상들 순서대로 (Normal, Invalid, B285~8, B290, B291) → 인덱스 8~15
    for key in BOTTOM_KEYS:
        palette.extend(_hex_to_rgb_triple(bottom.get(key, '#000000')))

    # background → 인덱스 16
    palette.extend(_hex_to_rgb_triple(background))

    # text → 인덱스 17
    palette.extend(_hex_to_rgb_triple(text))

    return bytes(palette[: 18 * 3])


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
    scheme_data = legends.get(scheme) or legends.get('default')
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
            
            # 인덱스 0~17의 RGB 값 교체 (54바이트)
            new_plte = current_plte[:]
            new_plte[:54] = new_palette[:54]  # ← 여기서 색상 교체
            
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


def plte_grade_filter_memory(png_data: bytearray, grade_indices: List[int]) -> bytearray:
    """
    메모리 상태에서 PLTE Grade 필터링 (선택된 grade만 색상 유지, Grade 0-7만 필터링).

    PNG 파일의 PLTE 청크를 수정하여 선택된 Grade 인덱스만 색상을 유지하고
    선택되지 않은 Grade 인덱스(0-7)는 팔레트 인덱스 31의 색상(흰색)으로 덮어씁니다.

    중요: 팔레트 인덱스 8 이상(Normal, Invalid, B285 등)은 그대로 유지됩니다.

    Args:
        png_data: PNG 파일의 바이트 데이터 (bytearray)
        grade_indices: 유지할 Grade 인덱스 리스트 (예: [3, 5, 7])

    Returns:
        수정된 PNG 바이트 데이터 (bytearray)
    """
    # Set으로 변환하여 O(1) 조회
    grade_set = set(grade_indices)
    logger.info("🔍 Grade 필터 적용: grade_indices=%s", grade_indices)

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
            num_colors = len(current_plte) // 3
            logger.info("🎨 PLTE 청크 발견: chunk_length=%d, 팔레트 색상 수=%d", chunk_length, num_colors)

            # 🔥 팔레트 인덱스 31의 색상 가져오기 (흰색)
            # 인덱스 31이 존재하지 않으면 흰색 사용
            if num_colors > 31:
                white_color = list(current_plte[31 * 3 : 31 * 3 + 3])
            else:
                white_color = [255, 255, 255]

            if len(white_color) < 3:
                white_color = [255, 255, 255]

            logger.info("🎨 인덱스 31 색상 (Grade 필터용): %s", white_color)

            # 팔레트 필터링: Grade 0-7 중 선택되지 않은 것만 인덱스 31 색상으로 변경
            # 인덱스 8 이상(Normal, Invalid 등)은 그대로 유지
            new_plte = current_plte[:]

            # Grade 0-7만 필터링 (팔레트 인덱스 0-7)
            modified_indices = []
            for i in range(min(8, num_colors)):
                if i not in grade_set:
                    # 선택되지 않은 Grade는 팔레트 31번 색상(흰색)으로 교체
                    new_plte[i * 3] = white_color[0]      # R
                    new_plte[i * 3 + 1] = white_color[1]  # G
                    new_plte[i * 3 + 2] = white_color[2]  # B
                    modified_indices.append(i)

            logger.info("✏️  필터링된 Grade 인덱스: %s (white color=%s)", modified_indices, white_color)
            logger.info("✅ 유지된 Grade 인덱스: %s", list(grade_set))

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


def plte_bottom_filter_memory(png_data: bytearray, bottom_values: List[str]) -> bytearray:
    """
    메모리 상태에서 PLTE Bottom 필터링 (선택된 bottom 값만 색상 유지, 나머지는 인덱스 31 색상으로 변경).

    PNG 파일의 PLTE 청크를 수정하여 선택된 Bottom 값들만 색상을 유지하고
    선택되지 않은 Bottom 값들은 팔레트 인덱스 31의 색상(보통 흰색)으로 덮어씁니다.

    Bottom 값 매핑:
    - 'Normal' → 인덱스 8
    - 'Invalid' → 인덱스 9
    - '285' (B285) → 인덱스 10
    - '286' (B286) → 인덱스 11
    - '287' (B287) → 인덱스 12
    - '288' (B288) → 인덱스 13
    - '290' (B290) → 인덱스 14
    - '291' (B291) → 인덱스 15

    중요: 팔레트 인덱스 0-7 (Grade)는 그대로 유지됩니다.

    Args:
        png_data: PNG 파일의 바이트 데이터 (bytearray)
        bottom_values: 유지할 Bottom 값 리스트 (예: ['285', '287', 'Normal'])

    Returns:
        수정된 PNG 바이트 데이터 (bytearray)
    """
    # Bottom 값을 팔레트 인덱스로 매핑
    BOTTOM_MAP = {
        'Normal': 8,
        'Invalid': 9,
        '285': 10,
        '286': 11,
        '287': 12,
        '288': 13,
        '290': 14,
        '291': 15,
    }

    # 선택된 bottom 값들을 인덱스로 변환
    selected_indices = set()
    for val in bottom_values:
        if val in BOTTOM_MAP:
            selected_indices.add(BOTTOM_MAP[val])

    logger.info("🔍 Bottom 필터 적용: bottom_values=%s, selected_indices=%s", bottom_values, selected_indices)

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
            num_colors = len(current_plte) // 3
            logger.info("🎨 PLTE 청크 발견: chunk_length=%d, 팔레트 색상 수=%d", chunk_length, num_colors)

            # 팔레트 인덱스 31의 색상 가져오기 (보통 흰색)
            # 인덱스 31이 존재하지 않으면 흰색 사용
            if num_colors > 31:
                white_color = list(current_plte[31 * 3 : 31 * 3 + 3])
            else:
                white_color = [255, 255, 255]

            if len(white_color) < 3:
                white_color = [255, 255, 255]

            # 팔레트 필터링: Bottom 인덱스 8-13 중 선택되지 않은 것만 인덱스 31 색상(흰색)으로 변경
            # Grade 인덱스 0-7은 그대로 유지
            new_plte = current_plte[:]
            modified_indices = []

            for idx, palette_idx in BOTTOM_MAP.items():
                if palette_idx < num_colors and palette_idx not in selected_indices:
                    # 선택되지 않은 Bottom 값은 인덱스 31 색상으로 교체
                    new_plte[palette_idx * 3] = white_color[0]      # R
                    new_plte[palette_idx * 3 + 1] = white_color[1]  # G
                    new_plte[palette_idx * 3 + 2] = white_color[2]  # B
                    modified_indices.append(f"{idx}(idx={palette_idx})")

            logger.info("✏️  필터링된 Bottom: %s (white color=%s)", modified_indices, white_color)
            logger.info("✅ 유지된 Bottom: %s", [f"{k}({BOTTOM_MAP[k]})" for k in bottom_values if k in BOTTOM_MAP])

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
    "plte_grade_filter_memory",
    "plte_bottom_filter_memory",
]
