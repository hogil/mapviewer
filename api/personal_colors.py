"""Helpers for loading and applying personalized color palettes."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import logging
import struct
import zlib
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional, Set, Tuple

from PIL import Image
from .config import FALLBACK_LOGIN_ID, IMAGES_ROOT, POSITIONS_ROOT

# PIL DecompressionBombWarning 제한 해제 (큰 이미지 로드 허용)
Image.MAX_IMAGE_PIXELS = None  # 제한 없음

logger = logging.getLogger(__name__)

COLOR_LEGENDS_PATH = Path(__file__).parent.parent / "logs" / "color-legends.json"
COLOR_LEGENDS_LOCK = RLock()

_color_legends_cache: Optional[Dict[str, Any]] = None
_color_legends_mtime: float = 0.0
_PALETTE_CACHE: Dict[str, bytes] = {}

TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7']
BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288', 'B290', 'B291',
               'B300', 'B385', 'B386', 'B388', 'B389', 'B390', 'ETC']
BIN_KEYS = ['B285', 'B286', 'B287', 'B288', 'B290', 'B291',
            'B300', 'B385', 'B386', 'B388', 'B389', 'B390', 'ETC']
ANONYMOUS_SCHEME = FALLBACK_LOGIN_ID
LEGACY_ANONYMOUS_SCHEMES = ("anon", "anonymous")

DEFAULT_TOP_COLORS = {
    "Grade0": "#FFFFFF",
    "Grade1": "#9B9B9B",
    "Grade2": "#009619",
    "Grade3": "#0000FF",
    "Grade4": "#D91DFF",
    "Grade5": "#FFFF00",
    "Grade6": "#FF0000",
    "Grade7": "#000000",
}

DEFAULT_BOTTOM_COLORS = {
    "Normal": "#BEBEBE",
    "Invalid": "#FF9900",
    "B285": "#0099FF",
    "B286": "#FF714F",
    "B287": "#66FFCC",
    "B288": "#DA26CD",
    "B290": "#FFD700",
    "B291": "#32CD32",
    "B300": "#AAAAAA",
    "B385": "#00C8FF",
    "B386": "#FF00C8",
    "B388": "#00FF66",
    "B389": "#FF6666",
    "B390": "#6666FF",
    "ETC": "#C0C0C0",
}

# Measure / Composite 공통 기본 그라디언트: 흰(#FFFFFF) → 검(#000000)
DEFAULT_RATIO_GRADIENT = {
    "quantile0": "#FFFFFF",
    "quantile10": "#E6E6E6",
    "quantile20": "#CCCCCC",
    "quantile30": "#B3B3B3",
    "quantile40": "#999999",
    "quantile50": "#808080",
    "quantile60": "#666666",
    "quantile70": "#4D4D4D",
    "quantile80": "#333333",
    "quantile90": "#1A1A1A",
    "quantile100": "#000000",
}

# 팔레트 인덱스 정의 (이미지 생성 코드와 반드시 일치해야 함)
# 0-7  : Grade0-Grade7 (chip 내부 값, 고정)
# 8    : background (고정)
# 9    : text (고정)
# 10   : Normal border (bottom.Normal)
# 11   : Invalid border (bottom.Invalid)
# 12+  : BINs (B285-B291, B300-series)
IDX_BG = 8
IDX_TEXT = 9
IDX_BORDER = 10       # Normal
IDX_BORDER_INV = 11   # Invalid
IDX_BOTTOM_START = 12 # BIN colors start here
FILTERED_COLOR_RGB = [255, 255, 255]


def _default_personal_scheme() -> Dict[str, Any]:
    return {
        "top": copy.deepcopy(DEFAULT_TOP_COLORS),
        "bottom": copy.deepcopy(DEFAULT_BOTTOM_COLORS),
        "ratio": copy.deepcopy(DEFAULT_RATIO_GRADIENT),
        "background": "#CCCCCC",
        "text": "#000001",
    }


def _default_composite_scheme() -> Dict[str, str]:
    """Composite 기본 그라디언트: 흰(#FFFFFF) → 검(#000000) — Measure와 동일"""
    return copy.deepcopy(DEFAULT_RATIO_GRADIENT)


def _ensure_anonymous_entries(legends: Dict[str, Any]) -> bool:
    """Ensure base anonymous keys exist for personal/composite colors."""
    if not isinstance(legends, dict):
        return False

    mutated = False

    if not isinstance(legends.get("default"), dict):
        legends["default"] = _default_personal_scheme()
        mutated = True

    if not isinstance(legends.get(ANONYMOUS_SCHEME), dict):
        source = None
        for key in (*LEGACY_ANONYMOUS_SCHEMES, "default"):
            candidate = legends.get(key)
            if isinstance(candidate, dict):
                source = candidate
                break
        if not isinstance(source, dict):
            source = _default_personal_scheme()
        legends[ANONYMOUS_SCHEME] = copy.deepcopy(source)
        mutated = True

    composite = legends.get("composite")
    if not isinstance(composite, dict):
        composite = {}
        legends["composite"] = composite
        mutated = True

    # Legacy format: legends["composite"] 가 바로 quantile 딕셔너리인 경우
    if composite and any(str(k).startswith("quantile") for k in composite.keys()):
        composite = {ANONYMOUS_SCHEME: copy.deepcopy(composite)}
        legends["composite"] = composite
        mutated = True

    if not isinstance(composite.get(ANONYMOUS_SCHEME), dict):
        legacy = composite.get("anonymous")
        composite[ANONYMOUS_SCHEME] = copy.deepcopy(legacy) if isinstance(legacy, dict) else _default_composite_scheme()
        mutated = True

    # 🔥 composite.default — Composite 기본색 (코드 하드코딩 대신 JSON 관리)
    if not isinstance(composite.get("default"), dict):
        composite["default"] = _default_composite_scheme()
        mutated = True

    # 🔥 measure 섹션 — Measure 기본색
    measure = legends.get("measure")
    if not isinstance(measure, dict):
        measure = {}
        legends["measure"] = measure
        mutated = True

    if not isinstance(measure.get("default"), dict):
        measure["default"] = copy.deepcopy(DEFAULT_RATIO_GRADIENT)
        mutated = True

    if not isinstance(measure.get(ANONYMOUS_SCHEME), dict):
        measure[ANONYMOUS_SCHEME] = copy.deepcopy(DEFAULT_RATIO_GRADIENT)
        mutated = True

    return mutated


def load_color_legends() -> Dict[str, Any]:
    """Load color legend data with simple caching."""
    global _color_legends_cache, _color_legends_mtime

    with COLOR_LEGENDS_LOCK:
        try:
            if not COLOR_LEGENDS_PATH.exists():
                initial = {
                    "default": _default_personal_scheme(),
                    ANONYMOUS_SCHEME: _default_personal_scheme(),
                    "composite": {ANONYMOUS_SCHEME: _default_composite_scheme()},
                }
                save_color_legends(initial)
                return initial

            current_mtime = COLOR_LEGENDS_PATH.stat().st_mtime
            if _color_legends_cache is not None and current_mtime == _color_legends_mtime:
                return _color_legends_cache

            with COLOR_LEGENDS_PATH.open('r', encoding='utf-8') as fh:
                loaded = json.load(fh)

            if not isinstance(loaded, dict):
                loaded = {}

            if _ensure_anonymous_entries(loaded):
                save_color_legends(loaded)
                current_mtime = COLOR_LEGENDS_PATH.stat().st_mtime

            _color_legends_cache = loaded
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
    """Resolve scheme key for a user. Anonymous users default to 'anonymous'.

    색상 저장 시점에 처음으로 JSON 항목이 생성됩니다 (로그인 시 자동 생성 안 함).

    Returns:
        scheme key (LoginId 또는 'anonymous')
    """
    if not login_id:
        return ANONYMOUS_SCHEME
    return login_id


def _hex_to_rgb_triple(hex_value: str) -> Tuple[int, int, int]:
    hex_value = normalize_hex_color(hex_value)
    return tuple(int(hex_value[i : i + 2], 16) for i in (1, 3, 5))


def _scheme_to_palette_bytes(scheme: Dict[str, Any]) -> bytes:
    """
    Convert color scheme to palette bytes.

    팔레트 인덱스 구조 (이미지 파일과 반드시 일치):
    - 0~7  : Grade0~7 (chip 내부 값)
    - 8    : background
    - 9    : text
    - 10   : Normal border (bottom.Normal)
    - 11   : Invalid border (bottom.Invalid)
    - 12+  : BINs (B285~B291, B300-series)

    총 (12 + len(BIN_KEYS)) * 3 bytes 반환.
    """
    palette: List[int] = []
    top = scheme.get('top', {})
    bottom = scheme.get('bottom', {})
    background = scheme.get('background', '#000000')
    text = scheme.get('text', '#000001')

    # 0~7: Grade0~7
    for key in TOP_KEYS:
        palette.extend(_hex_to_rgb_triple(top.get(key, '#000000')))

    # 8: background
    palette.extend(_hex_to_rgb_triple(background))

    # 9: text
    palette.extend(_hex_to_rgb_triple(text))

    # 10: Normal, 11: Invalid
    normal_hex = bottom.get('Normal') or bottom.get('Border') or '#BEBEBE'
    invalid_hex = bottom.get('Invalid') or '#FF9900'
    palette.extend(_hex_to_rgb_triple(normal_hex))
    palette.extend(_hex_to_rgb_triple(invalid_hex))

    # 12+: BINs
    for key in BIN_KEYS:
        palette.extend(_hex_to_rgb_triple(bottom.get(key, '#000000')))

    # 25~30: 미사용 인덱스 패딩 (index 31까지 도달하기 위해)
    current_entries = len(palette) // 3  # 현재 팔레트 항목 수
    while current_entries < 31:
        palette.extend([0, 0, 0])
        current_entries += 1

    # 31: composite/heatmap 배경색 (chip 바깥 영역)
    palette.extend(_hex_to_rgb_triple(background))

    return bytes(palette)


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
    Apply scheme palette to image using fixed palette index mapping.

    팔레트 인덱스 구조에 맞게 색상을 교체합니다:
    - 0~7  : Grade0~7
    - 8    : background
    - 9    : text
    - 10   : Normal border
    - 11   : Invalid border
    - 12+  : BINs

    이미지 픽셀 데이터는 변경하지 않고 팔레트만 교체합니다.
    """
    if img.mode != 'P':
        return None
    palette = img.getpalette()
    if not palette:
        return None
    new_palette = palette[:]
    # palette_bytes 범위만 덮어쓴다.
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
        scheme: 색상 스킴 이름 (예: 'anonymous', 'default')
    
    Returns:
        수정된 PNG 바이트 데이터 (bytearray)
    """
    legends = load_color_legends()
    scheme_data = legends.get(scheme) or legends.get(ANONYMOUS_SCHEME) or legends.get('default')
    if not scheme_data:
        # scheme 데이터 없으면 원본 그대로 반환 (에러 대신 graceful fallback)
        return png_data
    
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

            # 새 팔레트 적용 (scheme 범위까지만)
            new_plte = current_plte[:]
            n_bytes = min(len(new_palette), len(current_plte))
            new_plte[:n_bytes] = new_palette[:n_bytes]

            # PLTE 데이터 교체
            png_data[plte_start:plte_end] = new_plte

            # CRC 재계산 및 수정
            crc_data = chunk_type + bytes(new_plte)
            crc = zlib.crc32(crc_data) & 0xffffffff

            if plte_end + 4 <= len(png_data):
                png_data[plte_end:plte_end + 4] = struct.pack('>I', crc)
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

            # 필터에서 제외된 포인트는 항상 흰색으로 고정한다.
            # 일부 소스는 팔레트 인덱스 31이 흰색이 아니어서 필터 시 시각적으로 남아보일 수 있다.
            white_color = FILTERED_COLOR_RGB
            logger.info("🎨 Grade 필터 제외 색상: %s", white_color)

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


def _normalize_bottom_filter_key(raw_value: Any) -> Optional[str]:
    key = str(raw_value).strip()
    if not key:
        return None

    lowered = key.lower()
    aliases = {
        "normal": "Normal",
        "nor": "Normal",
        "border": "Normal",
        "invalid": "Invalid",
        "inv": "Invalid",
        "etc": "ETC",
    }

    if lowered in aliases:
        return aliases[lowered]

    num = None
    if lowered.startswith('b') and lowered[1:].isdigit():
        num = int(lowered[1:])
    elif lowered.isdigit():
        num = int(lowered)

    if num is not None:
        if num < 200:
            return "Normal"
        if num < 280:
            return "Invalid"
        return str(num)

    return key


def plte_bottom_filter_memory(
    png_data: bytearray,
    bottom_values: List[str],
    grade_indices: Optional[List[int]] = None,
) -> bytearray:
    """
    메모리 상태에서 PLTE Bottom 필터링 (선택된 bottom 값만 색상 유지, 나머지는 인덱스 31 색상으로 변경).

    PNG 파일의 PLTE 청크를 수정하여 선택된 Bottom 값들만 색상을 유지하고
    선택되지 않은 Bottom 값들은 팔레트 인덱스 31의 색상(보통 흰색)으로 덮어씁니다.

    Bottom 값 매핑 (고정 인덱스):
    - 'Normal'  → 인덱스 10
    - 'Invalid' → 인덱스 11
    - '285' (B285) → 인덱스 12
    - '286' (B286) → 인덱스 13
    - '287' (B287) → 인덱스 14
    - '288' (B288) → 인덱스 15
    - '290' (B290) → 인덱스 16
    - '291' (B291) → 인덱스 17
    - '300' (B300) → 인덱스 18
    - '385' (B385) → 인덱스 19
    - '386' (B386) → 인덱스 20
    - '388' (B388) → 인덱스 21
    - '389' (B389) → 인덱스 22
    - '390' (B390) → 인덱스 23

    동작 규칙:
    - 선택된 Bottom 인덱스(10~23)는 원래 색(개인색 포함) 유지
    - 선택되지 않은 Bottom 인덱스(10~23)는 흰색으로 치환
    - grade_indices가 있으면 선택되지 않은 Grade(0~7)만 흰색 처리
    - grade_indices가 없으면 Grade(0~7)는 모두 흰색 처리
    - 배경/텍스트 인덱스(8, 9)는 유지

    Args:
        png_data: PNG 파일의 바이트 데이터 (bytearray)
        bottom_values: 유지할 Bottom 값 리스트 (예: ['285', '287', 'Normal'])

    Returns:
        수정된 PNG 바이트 데이터 (bytearray)
    """
    # Bottom 값을 팔레트 인덱스로 매핑 (Normal/Invalid 포함 고정 인덱스)
    BOTTOM_MAP = {
        'Normal': 10,
        'Invalid': 11,
        '285': 12,
        '286': 13,
        '287': 14,
        '288': 15,
        '290': 16,
        '291': 17,
        '300': 18,
        '385': 19,
        '386': 20,
        '388': 21,
        '389': 22,
        '390': 23,
        'ETC': 24,
    }

    # 선택된 bottom 값들을 인덱스로 변환
    selected_indices = set()
    for val in bottom_values:
        key = _normalize_bottom_filter_key(val)
        if not key:
            continue
        if key in BOTTOM_MAP:
            selected_indices.add(BOTTOM_MAP[key])

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

            # 필터에서 제외된 포인트는 항상 흰색으로 고정한다.
            white_color = FILTERED_COLOR_RGB

            # 팔레트 필터링:
            # 1) Grade(0~7)는 grade filter가 활성화된 경우에만 필터링 (없으면 유지)
            # 2) Bottom(10~23)은 선택된 값만 유지하고 나머지는 흰색
            # 3) bg/text(8,9)는 유지
            # ※ grade filter 없이 bottom filter만 활성화된 경우, grade 인덱스는 그대로
            #   유지한다. Normal/Invalid 칩의 내부가 grade 색으로 칠해져 있어서, grade를
            #   흰색으로 치환하면 Normal/Invalid 칩이 사라지는 버그가 발생한다.
            new_plte = current_plte[:]
            modified_indices = []
            grade_set = set(grade_indices or [])

            # Grade 0~7 처리 (grade filter가 있을 때만 적용)
            for grade_idx in range(0, min(8, num_colors)):
                if not grade_set:
                    continue  # grade filter 없음: grade 인덱스 유지
                if grade_idx in grade_set:
                    continue  # 선택된 grade: 유지
                new_plte[grade_idx * 3] = white_color[0]
                new_plte[grade_idx * 3 + 1] = white_color[1]
                new_plte[grade_idx * 3 + 2] = white_color[2]
                modified_indices.append(f"Grade{grade_idx}(idx={grade_idx})")

            for idx, palette_idx in BOTTOM_MAP.items():
                if palette_idx < num_colors and palette_idx not in selected_indices:
                    # 선택되지 않은 Bottom 값은 인덱스 31 색상으로 교체
                    new_plte[palette_idx * 3] = white_color[0]      # R
                    new_plte[palette_idx * 3 + 1] = white_color[1]  # G
                    new_plte[palette_idx * 3 + 2] = white_color[2]  # B
                    modified_indices.append(f"{idx}(idx={palette_idx})")

            logger.info("✏️  필터링된 Bottom: %s (white color=%s)", modified_indices, white_color)
            normalized_bottoms = []
            for raw in bottom_values:
                key = _normalize_bottom_filter_key(raw)
                normalized_bottoms.append(key)
            logger.info("✅ 유지된 Bottom: %s", [f"{k}({BOTTOM_MAP[k]})" for k in normalized_bottoms if k in BOTTOM_MAP])

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


def plte_normalize_border_memory(png_data: bytearray) -> bytearray:
    """모든 border 팔레트 인덱스(11~23)를 Normal 색(인덱스 10)으로 통일한다.

    Border 정규화 모드: chip 테두리 색을 구분 없이 Normal 색으로 표시한다.
    - 인덱스 10 (Normal border) 색을 읽어 인덱스 11~23에 복사한다.
    - 인덱스 0~9, 24+ 는 건드리지 않는다.
    """
    pos = 8  # PNG 시그니처 건너뛰기
    while pos < len(png_data):
        if pos + 4 > len(png_data):
            break
        chunk_length = struct.unpack('>I', png_data[pos:pos + 4])[0]
        pos += 4
        if pos + 4 > len(png_data):
            break
        chunk_type = png_data[pos:pos + 4]
        pos += 4

        if chunk_type == b'PLTE':
            plte_start = pos
            plte_end = pos + chunk_length
            if plte_end > len(png_data):
                break
            plte = list(png_data[plte_start:plte_end])
            num_colors = len(plte) // 3
            # Normal border color (index 10)
            if num_colors > 10:
                nr, ng, nb = plte[30], plte[31], plte[32]
                for idx in range(11, min(24, num_colors)):
                    plte[idx * 3]     = nr
                    plte[idx * 3 + 1] = ng
                    plte[idx * 3 + 2] = nb
                png_data[plte_start:plte_end] = plte
                crc_data = chunk_type + bytes(plte)
                crc = zlib.crc32(crc_data) & 0xffffffff
                if plte_end + 4 <= len(png_data):
                    png_data[plte_end:plte_end + 4] = struct.pack('>I', crc)
            break

        pos += chunk_length + 4

    return png_data


def get_ratio_gradient_for_scheme(scheme: str) -> List[Tuple[int, int, int]]:
    """Return 11 RGB tuples for quantile 0,10,...100 from measure colors.

    Reads from ``legends["measure"][scheme]`` first (FBT/QVL overlay),
    then falls back to ``legends["composite"][scheme]`` (composite map),
    then DEFAULT_RATIO_GRADIENT.
    """
    gradient_dict: Optional[Dict[str, str]] = None
    try:
        legends = load_color_legends()
        # 🔥 measure[LoginId] → measure["default"] (anonymous 거치지 않음)
        measure = legends.get("measure")
        if isinstance(measure, dict):
            entry = measure.get(scheme)
            if not isinstance(entry, dict):
                entry = measure.get("default")
            if isinstance(entry, dict) and any(k.startswith("quantile") for k in entry):
                gradient_dict = entry
        # Fallback: composite[LoginId] → composite["default"]
        if not gradient_dict:
            composite = legends.get("composite")
            if isinstance(composite, dict):
                entry = composite.get(scheme)
                if not isinstance(entry, dict):
                    entry = composite.get("default")
                if isinstance(entry, dict) and any(k.startswith("quantile") for k in entry):
                    gradient_dict = entry
    except Exception:
        pass

    if not gradient_dict:
        gradient_dict = DEFAULT_RATIO_GRADIENT

    result: List[Tuple[int, int, int]] = []
    for step in range(0, 101, 10):
        key = f"quantile{step}"
        hex_val = gradient_dict.get(key)
        if hex_val:
            try:
                result.append(_hex_to_rgb_triple(hex_val))
            except Exception:
                result.append((0, 0, 0))
        else:
            result.append((0, 0, 0))
    return result


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
    "plte_normalize_border_memory",
    "DEFAULT_RATIO_GRADIENT",
    "get_ratio_gradient_for_scheme",
]
