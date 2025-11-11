#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
High-Performance S3 Wafer Pipeline (compact, Cython untouched/import-only)
- S3 DFS(.Z) → filename-based hour window → global chunk
- Decompress(.Z/LZW + ZIP/7z/tar nested) → Cython parse → P-mode/Index render
- Anisotropic square downscale (NEAREST) → borders/labels
- Save PNG (fixed 32-color palette, compress_level=1, no re-quantize)
- Save positions JSON next to image name under positions_root

[특기사항]
- 빈/Invalid 칩(타일 데이터 없음/불일치) 내부:
    ▶ 팔레트 인덱스 31(= 32번째 슬롯)을 전용 '순수 흰색'으로 채운다.
    ▶ 사용자별 팔레트 교체는 0~15 슬롯만 바꾸면, 31번은 그대로 유지되어 빈칩 색이 변하지 않음.
- Invalid 보더는 border_inv(인덱스 9), 결함 B285~B288은 10~13 슬롯 사용.
- 텍스트 색은 text(인덱스 15).
"""

import os, re, sys, time, json, importlib, multiprocessing, io, zipfile, tempfile, shutil, gzip, tarfile, subprocess
from dataclasses import dataclass
from typing import List, Tuple, Dict, Optional, Any, Sequence
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from pathlib import Path

import boto3, pandas as pd, numpy as np
from PIL import Image, ImageDraw, ImageFont
from tqdm import tqdm
from botocore.config import Config

# =================== Config ===================

@dataclass
class PipelineConfig:
    bucket_name: str = 'eds-ec-memory.fbm-data'
    region_name: str = ''
    aws_access_key_id: str = 'ho.choi-LakeS3-F6B0U6'            # 🔐 실배포: env 권장 (요청: 자동 치환 금지)
    aws_secret_access_key: str = 'iYb7zYDVzitt4QVkUcR2'         # 🔐 실배포: env 권장 (요청: 자동 치환 금지)
    endpoint_url: str = 'http://lakes3.dataplatform.samsungds.net:9020'
    max_pool_connections: int = 256
    download_threads: int = 128
    cpu_processes: int = min(multiprocessing.cpu_count(), 24)
    chunk_size: int = 300

    # 이미지/오버레이
    border_thickness: int = 1
    defect_border_thickness: int = 2
    output_format: str = "PNG"
    default_tile_size: Tuple[int,int] = (24,24)

    # 빈칩 텍스트
    draw_empty_chip_text: bool = True
    empty_chip_text_field: str = "b"

    # 팔레트/리샘플
    palette_colors: int = 32
    palette_dither: bool = False
    color_json: str = "/appdata/appuser/l3tracker-main/logs/color-legends.json"

    # S3 탐색 필터
    folder_filter_middle: str = "-00P_"

    # 시간창(파일명 내 날짜/시각 기반)
    hours_back_start: int = 0
    hours_back_end:   int = 2

    # 토큰↔prefix mapping CSV
    df_path: str = "/appdata/appuser/device_info.txt"
    df_positions: Tuple[int,int,int] = (4,3,1)  # (token, prefix1, prefix2) — 1-based

    # 출력 루트
    base_root: str = "/appdata/appuser/images"
    positions_root: str = "/appdata/appuser/positions"

CONFIG = PipelineConfig()

# =================== Env / Cython(import-only) ===================

def setup_environment():
    cores = multiprocessing.cpu_count()
    for k in ("NUMEXPR_MAX_THREADS","NUMEXPR_NUM_THREADS","OMP_NUM_THREADS",
              "OPENBLAS_NUM_THREADS","MKL_NUM_THREADS","VECLIB_MAXIMUM_THREADS"):
        os.environ[k] = str(cores)
    print(f"[env] Threads={cores}")

def get_cython_functions():
    """
    ⚠️ Cython 코드는 건드리지 않고 설치/빌드된 모듈만 import.
    """
    importlib.invalidate_caches()
    import cython_functions
    return cython_functions.transform_line, cython_functions.convert_hex_values_cython

# =================== Palette (keyed → ordered 32-slot) ===================

def _hex_to_rgb(hex_code: str) -> List[int]:
    s = hex_code.strip()
    if not (s.startswith("#") and len(s) == 7):
        raise ValueError(f"Invalid HEX: {hex_code}")
    return [int(s[1:3],16), int(s[3:5],16), int(s[5:7],16)]

def _flatten_palette_by_keys(color_map: Dict[str,str], index_to_key: Sequence[str], total_colors: int=32) -> List[int]:
    rgb: List[int] = []
    for key in index_to_key:
        rgb.extend(_hex_to_rgb(color_map.get(key, "#000000")))
    need = total_colors*3 - len(rgb)
    if need > 0:
        rgb.extend([0]*need)
    elif need < 0:
        raise ValueError(f"Too many keys for total_colors={total_colors}")
    return rgb

# 1) 의미 키 → HEX (외부 JSON에서 읽음)
with open(CONFIG.color_json, 'r', encoding='utf-8') as f:
    _cd = json.load(f)
_d   = _cd['default']
_top = _d['top']            # {"Grade0":"#...", ..., "Grade7":"#..."}
_btm = _d.get('bottom', {}) # {"border":"#...", "Invalid":"#...", "B285":"#...", ...}

PALETTE_HEX_MAP: Dict[str, str] = {
    # chip interior (0..7) — 반드시 0..7 유지
    "chip0": _top.get("Grade0", "#FFFFFF"),
    "chip1": _top.get("Grade1", "#9B9B9B"),
    "chip2": _top.get("Grade2", "#009619"),
    "chip3": _top.get("Grade3", "#0000FF"),
    "chip4": _top.get("Grade4", "#D91DFF"),
    "chip5": _top.get("Grade5", "#FFFF00"),
    "chip6": _top.get("Grade6", "#FF0000"),
    "chip7": _top.get("Grade7", "#000000"),

    # bottom 그룹(보더/상태)
    "border":       _btm.get("border",  "#BEBEBE"),
    "border_inv":   _btm.get("Invalid", "#FF9900"),
    "border_b285":  _btm.get("B285",    "#0099FF"),
    "border_b286":  _btm.get("B286",    "#FF714F"),
    "border_b287":  _btm.get("B287",    "#66FFCC"),
    "border_b288":  _btm.get("B288",    "#DA26CD"),

    # bg / text
    "bg":           _d.get("background", "#FEFEFE"),
    "text":         _d.get("text", "#000001"),
}

# 2) 슬롯 → 키 (팔레트 인덱스 순서 고정: 0~15만 사용자 교체 대상으로 운용)
PALETTE_INDEX_TO_KEY: List[str] = [
    "chip0","chip1","chip2","chip3","chip4","chip5","chip6","chip7",   # 0..7
    "border","border_inv","border_b285","border_b286","border_b287","border_b288",  # 8..13
    "bg",    # 14
    "text",  # 15
    # 16..31 padding (필요 시 추가 키를 여기에만 배치 권장)
]

KEY_TO_INDEX: Dict[str, int] = {k:i for i,k in enumerate(PALETTE_INDEX_TO_KEY)}
# === 인덱스 상수(가독성/안전) ===
IDX_INVALID_FILL = 31                         # 빈/Invalid 내부 전용 슬롯(0-based)
IDX_BG         = KEY_TO_INDEX["bg"]          # 14
IDX_BORDER     = KEY_TO_INDEX["border"]      # 8
IDX_BORDER_INV = KEY_TO_INDEX["border_inv"]  # 9
IDX_TEXT       = KEY_TO_INDEX["text"]        # 15

# 결함 보더(숫자 3자리) → 팔레트 슬롯 인덱스
IDX_B_DEF: Dict[str, int] = {
    "285": KEY_TO_INDEX["border_b285"],      # 10
    "286": KEY_TO_INDEX["border_b286"],      # 11
    "287": KEY_TO_INDEX["border_b287"],      # 12
    "288": KEY_TO_INDEX["border_b288"],      # 13
}

PALETTE_32: List[int] = _flatten_palette_by_keys(PALETTE_HEX_MAP, PALETTE_INDEX_TO_KEY, 32)
assert len(PALETTE_32) == 32*3
assert all(KEY_TO_INDEX[f"chip{i}"] == i for i in range(8)), "chip0..7 must occupy indices 0..7"

# ✅ 32번째 슬롯(인덱스 31)을 '순수 흰색'으로 고정
PALETTE_32[IDX_INVALID_FILL*3 : IDX_INVALID_FILL*3 + 3] = _hex_to_rgb("#FFFFFF")

# =================== Parsing ===================

def find_initial_values_from_lines(lines: List[str], file_name: str) -> Tuple[int,int,int,str,str,str,int,int]:
    wfid = lines[1].split('=')[1].strip()
    base = os.path.basename((file_name or "").split("::")[-1])
    root = (base.split('-', 1)[0] if '-' in base else base).upper()
    step, wafer = wfid.split('-',1)[1].split('.',1)
    xsize, ysize = int(lines[11].split('=')[1]), int(lines[12].split('=')[1])
    rot = 5
    if len(lines) > 8 and '=' in lines[8]:
        try: rot = int(lines[8].split('=',1)[1].strip())
        except: pass

    start, line_offset = None, 1
    for i in range(28, 40):
        if i < len(lines) and lines[i].startswith('X='):
            start = i
            if i+1 < len(lines) and lines[i+1].startswith('mft'): line_offset = 2
            break
    if start is None: raise ValueError(f"X= start not found: {file_name}")

    for i in range(start, min(start+10, len(lines))):
        if lines[i].startswith('#'):
            if i + xsize < len(lines) and lines[i+xsize].startswith('X='):
                xsize, ysize = ysize, xsize
            else:
                xsize = int((len(lines[i]) - 1)//2); start = i - line_offset
                for j in range(i, min(i+1000, len(lines))):
                    if j < len(lines) and lines[j].startswith('X='): ysize = j - i; break
            break
    return xsize, ysize, start, root, step, wafer, line_offset, rot

def process_file_content(args: Tuple[str, str]) -> List[Tuple]:
    """
    반환: (root, step, wafer, x, y, b, hex_block, stime, rot)
    동일 (x,y) 중복은 '마지막' 레코드만 남김.
    """
    file_name, file_content = args
    dataset: List[Tuple] = []
    _, convert_hex_values = get_cython_functions()
    try:
        lines = file_content.splitlines()
        if not lines:
            return dataset

        # STIME 파싱
        stime = "NA"
        if len(lines) > 9 and lines[9].startswith(':STIME='):
            raw = lines[9].split('=', 1)[1].strip()
            m = re.match(r'(\d{4})/(\d{2})/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})', raw)
            stime = (f"{m.group(1)}{m.group(2)}{m.group(3)}_{m.group(4)}{m.group(5)}{m.group(6)}"
                     if m else raw.replace('/', '').replace(':', '').replace(' ', '_'))

        xsize, ysize, start, root, step, wafer, line_offset, rot = find_initial_values_from_lines(lines, file_name)

        last_by_xy: Dict[Tuple[int, int], Tuple] = {}
        i = start
        while i < len(lines):
            if not lines[i].startswith('X='):
                i += 1
                continue

            # X, Y, b 파싱
            m = dict(re.findall(r'([XYbB])\s*=\s*([-\w]+)', lines[i].strip()))
            try:
                cx = int(m.get('X', '0')); cy = int(m.get('Y', '0'))
            except Exception:
                parts = lines[i].split()
                cx = int(parts[1]) if len(parts) > 1 else 0
                cy = int(parts[3]) if len(parts) > 3 else 0

            cb = (m.get('b') or m.get('B') or '').strip()

            # HEX 블록 시작 라인
            j = i + 1
            if j < len(lines) and lines[j].startswith('mft'):
                j += 1

            hex_block = ""
            if j < len(lines) and lines[j].startswith('#'):
                try:
                    hex_block = convert_hex_values(lines, j, xsize, ysize)
                except Exception:
                    hex_block = ""

            last_by_xy[(cx, cy)] = (root, step, wafer, cx, cy, cb, hex_block, stime, rot)
            i += 1

        dataset = list(last_by_xy.values())

    except Exception:
        return []

    return dataset

# =================== Image generation (Index/P-mode) ===================

_FONT_CACHE: Dict[Tuple[int,int,str], ImageFont.FreeTypeFont] = {}
def _ttf_cached(w:int, h:int, text:str)->ImageFont.ImageFont:
    key = (w, h, str(len(text)))
    f = _FONT_CACHE.get(key)
    if f: return f
    sz = max(8, min(w, h))
    for name in ("DejaVuSans.ttf","Arial.ttf","LiberationSans-Regular.ttf"):
        try:
            f = ImageFont.truetype(name, sz); _FONT_CACHE[key] = f; return f
        except: continue
    f = ImageFont.load_default(); _FONT_CACHE[key] = f; return f

def map_tile_after_rotation(i0, j0, rot_code, tilesW_after, tilesH_after):
    if rot_code == 7:   # 90 CCW
        return (j0, tilesH_after - 1 - i0)
    elif rot_code == 3: # 270 CCW
        return (tilesW_after - 1 - j0, i0)
    elif rot_code == 0: # 180
        return (tilesW_after - 1 - i0, tilesH_after - 1 - j0)
    else:               # no-op
        return (i0, j0)

def centerize_col(i, W):
    return i - (W//2 - 1) if (W % 2 == 0) else i - (W//2)

def centerize_row(j, H):
    return j - (H//2)

def _safe_name(s:str)->str: return re.sub(r"[^A-Za-z0-9._-]+","", (s or "NA").strip()) or "NA"
def _safe_prefix(*parts:str)->str: return "/".join(re.sub(r"[^A-Za-z0-9._-]+","",str(p)) for p in parts if str(p).strip())

def _save_indexed32_png(img: Image.Image, path: str) -> str:
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", dir=str(p.parent)); os.close(fd)
    try:
        # 재양자화 방지(optimize=False), 빠른 압축(compress_level=1)
        img.save(tmp, format="PNG", optimize=False, compress_level=1)
        if not os.path.exists(tmp) or os.path.getsize(tmp) <= 0: raise IOError("empty output")
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp): os.remove(tmp)
        except: pass
    return path

def create_sample_image_func(args):
    """
    순서:
      1) 인덱스 배열 채움(P모드 32색)
      2) 회전 → 정사각 비등방 다운스케일(NEAREST)
      3) 유효 칩만 얇은 보더(그리드)
      4) 빈칩/Invalid 칩은 내부를 '전용 흰색 슬롯'(index 31)로 클리어
      5) 결함칩 두꺼운 보더 + (옵션) 빈칩 텍스트(색=IDX_TEXT=15)
      6) 저장(PNG) + JSON(positions_root)
    """
    (samples, output_path, output_border_thickness, output_format, rot, default_tile_size,
     draw_empty_text, empty_text_field, defect_border_thickness) = args

    if not samples:
        return None

    xs = [s['x'] for s in samples]; ys = [s['y'] for s in samples]
    x_min, x_max, y_min, y_max = min(xs), max(xs), min(ys), max(ys)
    tiles_w = x_max - x_min + 1
    tiles_h = y_max - y_min + 1

    # 타일(칩) 내부 크기
    first_valid = next((s for s in samples if s.get('transformed_values')), None)
    if first_valid and first_valid['transformed_values']:
        sr = first_valid['transformed_values'].split(',')
        sh = len(sr); sw = len(sr[0]) if sh > 0 else 0
        if sh == 0 or sw == 0:
            sh, sw = default_tile_size
    else:
        sh, sw = default_tile_size

    H0, W0 = tiles_h * sh, tiles_w * sw  # (행, 열)

    # 1) 인덱스 채움
    idx0 = np.full((H0, W0), IDX_BG, dtype=np.uint8)  # 기본 BG로 초기화
    vmap, bmap, have = {}, {}, set()

    def _tile_ok(s):
        rs = s.get('transformed_values') or ""
        rows = rs.split(',') if rs else []
        return (len(rows) == sh) and (sh > 0) and all(len(r) == sw for r in rows)

    for s in samples:
        i, j = s['x'] - x_min, s['y'] - y_min
        have.add((i, j))
        ok = _tile_ok(s)
        vmap[(i, j)] = ok
        bmap[(i, j)] = (s.get('b') or s.get('B') or "").strip()
        y0, y1 = j * sh, (j + 1) * sh
        x0, x1 = i * sw, (i + 1) * sw
        if ok:
            rows = (s.get('transformed_values') or "").split(',')
            vals = np.frombuffer(''.join(rows).encode('ascii'), dtype=np.uint8) - ord('0')  # 0..7
            idx0[y0:y1, x0:x1] = vals.reshape(sh, sw)
        else:
            # === Invalid/빈칩: 내부를 '전용 흰색 슬롯'(index 31)로 확실히 채움 ===
            idx0[y0:y1, x0:x1] = IDX_INVALID_FILL

    # 2) 회전 → 정사각 다운스케일
    rot_code = int(rot) if rot is not None else 5
    if rot_code == 7:        # 90 CCW
        idxR = np.transpose(idx0, (1, 0))[::-1, :]
        tilesW_after, tilesH_after = tiles_h, tiles_w
    elif rot_code == 3:      # 270 CCW
        idxR = np.transpose(idx0, (1, 0))[:, ::-1]
        tilesW_after, tilesH_after = tiles_h, tiles_w
    elif rot_code == 0:      # 180
        idxR = idx0[::-1, ::-1]
        tilesW_after, tilesH_after = tiles_w, tiles_h
    else:                    # no-op
        idxR = idx0
        tilesW_after, tilesH_after = tiles_w, tiles_h
    del idx0

    imgP = Image.fromarray(idxR, mode='P'); imgP.putpalette(PALETTE_32)
    wR, hR = imgP.size
    if wR == hR:
        imgS = imgP; sx = sy = 1.0
    elif wR < hR:
        S = wR; imgS = imgP.resize((S, S), resample=Image.NEAREST); sx, sy = 1.0, (wR / hR)
    else:
        S = hR; imgS = imgP.resize((S, S), resample=Image.NEAREST); sx, sy = (hR / wR), 1.0

    W, H = imgS.size  # 정사각
    arr = np.array(imgS, dtype=np.uint8, copy=True); arr.setflags(write=1)

    # 정밀 타일 경계 픽셀 좌표
    xs_pix = [int(round(k * W / tilesW_after)) for k in range(tilesW_after + 1)]
    ys_pix = [int(round(k * H / tilesH_after)) for k in range(tilesH_after + 1)]

    # 3) 기본 얇은 보더(유효 칩만: 시각적 그리드)
    b = int(max(1, output_border_thickness))
    for (ii0, jj0) in have:
        ii, jj = map_tile_after_rotation(ii0, jj0, rot_code, tilesW_after, tilesH_after)
        x0, x1 = xs_pix[ii], xs_pix[ii + 1]
        y0, y1 = ys_pix[jj], ys_pix[jj + 1]
        if y0 + b <= y1: arr[y0:y0+b, x0:x1] = IDX_BORDER
        if y1 - b >= y0: arr[y1-b:y1, x0:x1] = IDX_BORDER
        if x0 + b <= x1: arr[y0:y1, x0:x0+b] = IDX_BORDER
        if x1 - b >= x0: arr[y0:y1, x1-b:x1] = IDX_BORDER

    # 4) Invalid/빈칩 내부를 '전용 흰색 슬롯'(index 31)로 클리어
    for (ii0, jj0) in have:
        if vmap.get((ii0, jj0), False):  # 유효칩 skip
            continue
        ii, jj = map_tile_after_rotation(ii0, jj0, rot_code, tilesW_after, tilesH_after)
        x0, x1 = xs_pix[ii], xs_pix[ii + 1]
        y0, y1 = ys_pix[jj], ys_pix[jj + 1]
        arr[y0:y1, x0:x1] = IDX_INVALID_FILL  # 내부 = 전용 흰색(31) 확정

    # 5) 결함/Invalid 칩 두꺼운 보더 + (옵션) 빈칩 텍스트
    base_img = Image.fromarray(arr, mode='P'); base_img.putpalette(PALETTE_32)
    draw = ImageDraw.Draw(base_img)
    d = int(max(1, defect_border_thickness))
    TEXT_FILL_RATIO = 0.35

    for s in samples:
        x_abs = int(s['x']); y_abs = int(s['y'])
        ii0, jj0 = x_abs - x_min, y_abs - y_min
        ii, jj = map_tile_after_rotation(ii0, jj0, rot_code, tilesW_after, tilesH_after)
        x0, x1 = xs_pix[ii], xs_pix[ii + 1]
        y0, y1 = ys_pix[jj], ys_pix[jj + 1]

        ok = vmap.get((ii0, jj0), False)
        bval = bmap.get((ii0, jj0), "")
        mnum = re.search(r'(\d{3})', bval or "")
        num_key = (mnum.group(1) if mnum else None)

        # Invalid/빈칩 → 보더를 무조건 border_inv(9)로 강조
        if not ok:
            cidx = IDX_BORDER_INV  # 9
        # 결함코드가 B285/286/287/288이면 해당 색상
        elif num_key in IDX_B_DEF:
            cidx = IDX_B_DEF[num_key]
        else:
            cidx = IDX_BORDER  # 정상 유효칩: 기본 얇은 보더만으로도 충분(필요 시 유지용)

        # 두꺼운 보더 적용(Invalid 및 결함)
        if (not ok) or (num_key in IDX_B_DEF):
            if y0 + d <= y1: base_img.paste(cidx, (x0, y0, x1, y0 + d))
            if y1 - d >= y0: base_img.paste(cidx, (x0, y1 - d, x1, y1))
            if x0 + d <= x1: base_img.paste(cidx, (x0, y0, x0 + d, y1))
            if x1 - d >= x0: base_img.paste(cidx, (x1 - d, y0, x1, y1))

        # 빈칩 텍스트(옵션) — 색은 IDX_TEXT(15)
        if draw_empty_text and not ok:
            rawb = str(s.get(empty_text_field) or s.get('b') or "")
            if rawb:
                text3 = rawb[1:4] if len(rawb) >= 4 else rawb[-3:]
                inner_w = max(1, int(round((x1 - x0) * TEXT_FILL_RATIO)))
                inner_h = max(1, int(round((y1 - y0) * TEXT_FILL_RATIO)))
                font = _ttf_cached(inner_w, inner_h, text3)
                try:
                    tw = int(draw.textlength(text3, font=font))
                    th = font.size
                except Exception:
                    tw, th = inner_w, inner_h
                cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
                draw.text((cx - tw // 2, cy - th // 2), text3, fill=IDX_TEXT, font=font)

    # 6) 저장(PNG) + JSON
    out_dir = os.path.dirname(output_path)
    if not out_dir:
        raise ValueError("Empty output_path")
    os.makedirs(out_dir, exist_ok=True)

    try:
        _save_indexed32_png(base_img, output_path)
    except Exception as e:
        import traceback
        print(f"[save-error] {output_path}: {e}\n{traceback.format_exc()}")
        return None

    # --- JSON: positions_root/{p1}/{p2}/{day}/<same-name>.json ---
    try:
        meta0 = samples[0]
        p1 = meta0.get("p1","NA"); p2 = meta0.get("p2","NA")
        stime = str(meta0.get("stime",""))
        day = (stime.split('_')[0] if (stime and '_' in stime) else "NA")

        Ws, Hs = base_img.size
        tiles_w_rot = tilesW_after
        tiles_h_rot = tilesH_after

        xs_edges = [int(round(k * Ws / tiles_w_rot)) for k in range(tiles_w_rot + 1)]
        ys_edges = [int(round(k * Hs / tiles_h_rot)) for k in range(tiles_h_rot + 1)]

        chips_json = []
        for s in samples:
            x_abs = int(s['x']); y_abs = int(s['y'])
            i0 = x_abs - x_min; j0 = y_abs - y_min
            i, j = map_tile_after_rotation(i0, j0, rot_code, tiles_w_rot, tiles_h_rot)
            x_cal = centerize_col(i, tiles_w_rot)
            y_cal = centerize_row(j, tiles_h_rot)
            x0, x1 = xs_edges[i], xs_edges[i+1]
            y0, y1 = ys_edges[j], ys_edges[j+1]
            rawb = str(s.get('b') or "")
            text3 = rawb[1:4] if len(rawb) >= 4 else rawb[-3:]
            chips_json.append({
                "x_abs": x_abs, "y_abs": y_abs, "b": rawb,
                "x_cal": int(x_cal), "y_cal": int(y_cal), "text3": text3,
                "rect": {
                    "x0": int(x0), "y0": int(y0), "x1": int(x1), "y1": int(y1),
                    "quad": [[int(x0),int(y0)],[int(x1),int(y0)],[int(x1),int(y1)],[int(x0),int(y1)]]
                }
            })

        json_obj = {
            "image_path": output_path,
            "root": meta0.get("root",""),
            "step": meta0.get("step",""),
            "wafer": meta0.get("wafer",""),
            "stime": stime,
            "day": day,
            "coord": {
                "rot_code": int(rot_code),
                "x_min_abs": int(x_min),
                "y_min_abs": int(y_min),
                "tiles_w_rot": int(tiles_w_rot),
                "tiles_h_rot": int(tiles_h_rot),
                "grid_edges": {"xs": xs_edges, "ys": ys_edges},
                "canvas": {"width": int(Ws), "height": int(Hs)},
                "scale": {"sx": float(sx), "sy": float(sy)},
                "border": int(output_border_thickness),
                "defect_border": int(defect_border_thickness),
                "center_rule": {"even_x_zero": "left", "even_y_zero": "down"}
            },
            "chips": chips_json
        }

        json_dir = os.path.join(CONFIG.positions_root, _safe_prefix(p1), _safe_prefix(p2), day)
        os.makedirs(json_dir, exist_ok=True)
        base_name = os.path.splitext(os.path.basename(output_path))[0]
        json_path = os.path.join(json_dir, base_name + ".json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(json_obj, f, ensure_ascii=False, indent=2)

    except Exception as e:
        print(f"[json-save-error] {output_path}: {e}")

    return output_path

# =================== S3 / Decompress ===================

class S3Manager:
    def __init__(self, cfg: PipelineConfig):
        self.cfg = cfg
        self.client = boto3.session.Session().client(
            "s3",
            region_name=cfg.region_name or None,
            aws_access_key_id=cfg.aws_access_key_id or None,
            aws_secret_access_key=cfg.aws_secret_access_key or None,
            endpoint_url=cfg.endpoint_url or None,
            config=Config(max_pool_connections=cfg.max_pool_connections, retries={'max_attempts': 8, 'mode': 'adaptive'}),
            use_ssl=False,
        )

    def get_top_level_folders(self) -> List[str]:
        p = self.client.get_paginator('list_objects_v2'); folders=[]
        for page in p.paginate(Bucket=self.cfg.bucket_name, Delimiter='/'):
            folders.extend(cp['Prefix'] for cp in page.get('CommonPrefixes', []))
        return sorted(folders)

    def get_compressed_files_meta(self, folders: List[str], file_pattern: str = '.Z') -> List[Tuple[str, datetime]]:
        from collections import deque
        def list_all(prefix: str) -> List[Tuple[str, datetime]]:
            p = self.client.get_paginator('list_objects_v2'); out=[]; st=deque([prefix])
            while st:
                cur = st.pop()
                for page in p.paginate(Bucket=self.cfg.bucket_name, Prefix=cur, Delimiter='/'):
                    for obj in page.get('Contents', []) or []:
                        key = obj['Key']
                        if key.endswith(file_pattern):
                            out.append((key, obj.get('LastModified')))
                    for cp in page.get('CommonPrefixes', []): st.append(cp.get('Prefix'))
            return out
        all_meta=[]
        with ThreadPoolExecutor(max_workers=8) as ex:
            for files in tqdm(ex.map(list_all, folders), total=len(folders), desc="List files (meta)"):
                all_meta.extend(files)
        return all_meta

    def download_and_decompress_parallel(self, keys: List[str]) -> List[Tuple[str,str]]:
        if not keys: return []
        try:
            from unlzw3 import unlzw
        except Exception:
            unlzw = None
        try:
            import py7zr
        except Exception:
            py7zr = None
        sevenz = shutil.which("7z") or shutil.which("7za") or shutil.which("7zr")

        def _decode(b: bytes) -> str:
            for enc in ("utf-8", "cp949", "euc-kr", "latin1"):
                try: return b.decode(enc)
                except Exception: pass
            return b.decode("utf-8", errors="ignore")

        def _sig_7z(b: bytes) -> bool: return len(b) >= 6 and b[:6] == b"7z\xBC\xAF\x27\x1C"
        def _sig_Z(b: bytes) -> bool:  return len(b) >= 2 and b[:2] == b"\x1f\x9d"
        def _sig_gz(b: bytes) -> bool: return len(b) >= 2 and b[:2] == b"\x1f\x8b"
        def _is_zip(b: bytes) -> bool:
            try: return zipfile.is_zipfile(io.BytesIO(b))
            except Exception: return False

        def _extract_zip(data: bytes, tag: str):
            out = []
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for n in zf.namelist():
                    if n.endswith("/"): continue
                    out.append((f"{tag}::{n}", zf.read(n)))
            return out

        def _extract_py7zr(data: bytes, tag: str):
            if not py7zr: return []
            out = []
            try:
                with py7zr.SevenZipFile(io.BytesIO(data)) as ar:
                    for n, fobj in ar.readall().items():
                        out.append((f"{tag}::{n}", fobj.read()))
            except Exception:
                pass
            return out

        def _extract_7z_cli(data: bytes, tag: str):
            out = []
            if not sevenz: return out
            with tempfile.TemporaryDirectory() as td:
                inpath = os.path.join(td, "in.bin")
                with open(inpath, "wb") as f: f.write(data)
                cmd = [sevenz, "x", inpath, f"-o{td}", "-y", "-bd", "-bso0", "-bsp0"]
                try: subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception: return out
                for root, _, files in os.walk(td):
                    for fn in files:
                        p = os.path.join(root, fn)
                        rel = os.path.relpath(p, td).replace("\\", "/")
                        with open(p, "rb") as f:
                            out.append((f"{tag}::{rel}", f.read()))
            return out

        def _extract_tar_like(data: bytes, tag: str):
            out = []
            bio = io.BytesIO(data)
            try:
                with tarfile.open(fileobj=bio, mode="r:*") as tf:
                    for m in tf.getmembers():
                        if not m.isfile(): continue
                        f = tf.extractfile(m)
                        if f: out.append((f"{tag}::{m.name}", f.read()))
            except Exception:
                pass
            return out

        def _expand(name: str, data: bytes, depth: int = 0):
            if depth > 6: return [(name, _decode(data))]
            if _is_zip(data):
                try:
                    pairs = _extract_zip(data, name)
                except Exception:
                    pairs = _extract_py7zr(data, name) or _extract_7z_cli(data, name)
                if pairs:
                    out=[]
                    for n, b in pairs: out.extend(_expand(n, b, depth + 1))
                    return out
            if _sig_7z(data):
                pairs = _extract_py7zr(data, name) or _extract_7z_cli(data, name)
                if pairs:
                    out=[]
                    for n, b in pairs: out.extend(_expand(n, b, depth + 1))
                    return out
            if _sig_gz(data):
                try:
                    u = gzip.decompress(data)
                    return _expand(name.rsplit(".gz", 1)[0], u, depth + 1)
                except Exception:
                    pass
            if name.lower().endswith(".z"):
                if unlzw is not None and _sig_Z(data):
                    try:
                        u = unlzw(data); base = name.rsplit(".Z", 1)[0]
                        return _expand(base, u, depth + 1)
                    except Exception:
                        pass
                pairs = _extract_py7zr(data, name) or _extract_7z_cli(data, name)
                if not pairs and _is_zip(data):
                    try: pairs = _extract_zip(data, name)
                    except Exception:
                        pairs = _extract_py7zr(data, name) or _extract_7z_cli(data, name)
                if not pairs:
                    pairs = _extract_tar_like(data, name)
                if pairs:
                    out=[]
                    for n, b in pairs: out.extend(_expand(n, b, depth + 1))
                    return out
            pairs = _extract_tar_like(data, name) or _extract_py7zr(data, name) or _extract_7z_cli(data, name)
            if pairs:
                out=[]
                for n, b in pairs: out.extend(_expand(n, b, depth + 1))
                return out
            return [(name, _decode(data))]

        def _one(key: str) -> List[Tuple[str, str]]:
            try:
                body = self.client.get_object(Bucket=self.cfg.bucket_name, Key=key)['Body'].read()
            except Exception as e:
                print(f"[s3] Error {key}: {e}"); return []
            try:
                flat = _expand(key, body, 0)
                return [(n, t) for n, t in flat if isinstance(t, str) and t.strip()]
            except Exception as e:
                print(f"[extract] Error {key}: {e}"); return []

        allc: List[Tuple[str, str]] = []
        with ThreadPoolExecutor(max_workers=self.cfg.download_threads) as ex:
            for part in tqdm(ex.map(_one, keys), total=len(keys), desc="Download+Decompress"):
                allc.extend(part)
        return allc

    def prefilter_keys_by_filename(
        self,
        folders: List[str],
        token2pps: Dict[str, List[Tuple[str,str]]],
        middle: str,
        start_dt: datetime,
        end_dt: datetime,
    ) -> Tuple[Dict[str,Tuple[str,str,str]], Dict[str,int]]:
        all_meta = self.get_compressed_files_meta(folders, '.Z')
        keys = [k for k, _ in all_meta]

        rx_map = {}
        for tok in token2pps.keys():
            pat = rf'^\d{{2}}_{re.escape(str(tok))}.*{re.escape(middle)}.*?(?P<d>\d{{8}})[_-]?(?P<t>\d{{6}})'
            rx_map[str(tok)] = re.compile(pat)

        stats = dict(scanned=len(keys), z=len(keys), token_hit=0, time_hit=0, assigned=0)
        key_to_assign: Dict[str, Tuple[str,str,str]] = {}
        window_on = (start_dt is not None and end_dt is not None and (start_dt != end_dt))

        for key in keys:
            bn = os.path.basename(key)
            hit_tok: Optional[str] = None
            name_dt: Optional[datetime] = None
            for tok, rx in rx_map.items():
                m = rx.search(bn)
                if not m:
                    continue
                hit_tok = tok
                d, t = m.group('d'), m.group('t')
                try:
                    name_dt = datetime.strptime(f"{d}_{t}", "%Y%m%d_%H%M%S")
                except Exception:
                    name_dt = None
                break
            if not hit_tok:
                continue
            stats['token_hit'] += 1
            if window_on:
                if name_dt is None:
                    continue
                if not (start_dt <= name_dt <= end_dt):
                    continue
            stats['time_hit'] += 1

            assigned_pair: Optional[Tuple[str,str]] = None
            for (p1, p2) in token2pps.get(hit_tok, []):
                if (p1 and p1 in key) and (p2 and p2 in key):
                    assigned_pair = (p1, p2)
                    break
            if assigned_pair is None:
                pairs = token2pps.get(hit_tok, [])
                if len(pairs) == 1:
                    assigned_pair = pairs[0]
                elif len(pairs) > 1:
                    semi = next((pp for pp in pairs if (pp[0] in key) or (pp[1] in key)), pairs[0])
                    assigned_pair = semi
                else:
                    assigned_pair = ("NA","NA")

            key_to_assign[key] = (hit_tok, assigned_pair[0], assigned_pair[1])
            stats['assigned'] += 1

        return key_to_assign, stats

# =================== Processor / Generator ===================

class DataProcessor:
    def __init__(self, cfg: PipelineConfig):
        self.cfg = cfg
        self.executor = ProcessPoolExecutor(max_workers=cfg.cpu_processes, mp_context=multiprocessing.get_context("spawn"))
    def close(self): self.executor.shutdown(wait=True)

    def process_files_parallel_tagged(self, tagged_pairs: List[Tuple[str,str,str,str,str]]) -> List[Dict]:
        if not tagged_pairs: return []
        file_contents = [(name, text) for _, _, _, name, text in tagged_pairs]
        results = list(tqdm(self.executor.map(
            process_file_content, file_contents,
            chunksize=max(1, len(file_contents)//(self.cfg.cpu_processes*4) or 1)
        ), total=len(file_contents), desc="Processing (Cython)"))
        out=[]; idx=0
        for fr in tqdm(results, desc="Merge tuples→dicts"):
            tok, p1, p2 = tagged_pairs[idx][0], tagged_pairs[idx][1], tagged_pairs[idx][2]
            idx += 1
            for t in fr:
                if len(t)==9:
                    out.append({
                        'root':t[0],'step':t[1],'wafer':t[2],'x':t[3],'y':t[4],'b':t[5],
                        'transformed_values':t[6],'stime':t[7],'rot':t[8],
                        'token':tok,'p1':p1,'p2':p2
                    })
        return out

class ImageGenerator:
    def __init__(self, cfg: PipelineConfig):
        self.cfg = cfg
        self.executor = ProcessPoolExecutor(max_workers=cfg.cpu_processes, mp_context=multiprocessing.get_context("spawn"))
    def close(self): self.executor.shutdown(wait=True)

    def generate_images_mixed(self, dataset_all: List[Dict], base_root: str):
        from collections import defaultdict, Counter
        groups = defaultdict(list)
        for s in dataset_all:
            key = (s.get('token','NA'), s['p1'], s['p2'], s['root'], s['step'], s['wafer'], s.get('stime','NA'))
            groups[key].append(s)
        tasks, task_keys = [], []
        for (tok, p1, p2, root, step, wafer, stime), samples in groups.items():
            rot = Counter([int(x.get('rot',5)) for x in samples]).most_common(1)[0][0] if samples else 5
            day = (stime.split('_')[0] if (stime and '_' in stime) else "NA")
            out_dir = os.path.join(base_root, _safe_prefix(p1), _safe_prefix(p2), day)
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, f"{_safe_name(root)}_{_safe_name(step)}_{_safe_name(wafer)}_{_safe_name(stime)}.png")
            tasks.append((
                samples, out_path,
                self.cfg.border_thickness, self.cfg.output_format, rot,
                self.cfg.default_tile_size, self.cfg.draw_empty_chip_text, self.cfg.empty_chip_text_field,
                self.cfg.defect_border_thickness
            ))
            task_keys.append((tok, p1, p2))
        if not tasks: return [], {}
        results = list(tqdm(self.executor.map(
            create_sample_image_func, tasks,
            chunksize=max(1, len(tasks)//(self.cfg.cpu_processes*4) or 1)
        ), total=len(tasks), desc="Generating images"))
        from collections import Counter
        ok_by_key = Counter()
        for key, r in zip(task_keys, results):
            if r: ok_by_key[key] += 1
        return [r for r in results if r], dict(ok_by_key)

# =================== Orchestration ===================

def _hour_window_to_day_offsets(h_start:int, h_end:int) -> Tuple[int,int]:
    if h_end < h_start: h_start, h_end = h_end, h_start
    return (h_start // 24, h_end // 24)

def _cleanup_empty_p2_and_dates(base_root: str, p1_set: set) -> int:
    removed = 0
    for p1 in sorted(p1_set):
        p1_dir = os.path.join(base_root, _safe_prefix(p1))
        if not os.path.isdir(p1_dir): continue
        for p2 in sorted(os.listdir(p1_dir)):
            p2_dir = os.path.join(p1_dir, p2)
            if not os.path.isdir(p2_dir): continue
            for day in sorted(os.listdir(p2_dir)):
                day_dir = os.path.join(p2_dir, day)
                if os.path.isdir(day_dir):
                    try:
                        if not os.listdir(day_dir): os.rmdir(day_dir); removed += 1
                    except: pass
            try:
                if not os.listdir(p2_dir): os.rmdir(p2_dir); removed += 1
            except: pass
    return removed

def load_df(path: str) -> pd.DataFrame:
    i, j, k = (p-1 for p in CONFIG.df_positions)
    df = pd.read_csv(path, sep=None, engine='python', header=0, index_col=0).iloc[:, [i, j, k]].copy()
    df.columns = ["_token","_p1","_p2"]
    return df

def run_pipeline_for_dataframe(df: pd.DataFrame):
    if df is None or len(df) == 0: return {}
    token2pps: Dict[str, List[Tuple[str,str]]] = {}
    for tok, p1, p2 in df[["_token","_p1","_p2"]].itertuples(index=False, name=None):
        token2pps.setdefault(str(tok), []).append((str(p1), str(p2)))

    s3, proc, img = S3Manager(CONFIG), DataProcessor(CONFIG), ImageGenerator(CONFIG)
    base_root, chunk_size = CONFIG.base_root, CONFIG.chunk_size
    middle = CONFIG.folder_filter_middle

    h0, h1 = CONFIG.hours_back_start, CONFIG.hours_back_end
    if h1 < h0: h0, h1 = h1, h0
    now_local = datetime.now()
    start_ts, end_ts = now_local - timedelta(hours=h1), now_local - timedelta(hours=h0)

    print(f"🚀 Start {datetime.now():%Y-%m-%d %H:%M:%S}")
    print(f"[window(name)] {start_ts:%Y-%m-%d %H:%M:%S} ~ {end_ts:%Y-%m-%d %H:%M:%S}")
    print(f"[tokens] n={len(token2pps)}")
    for tok, pairs in token2pps.items():
        print(f"  - token={tok}  pairs={pairs}")

    t0 = time.time()
    results: Dict[Tuple[str,str,str,str], Dict[str,Any]] = {}
    try:
        folders = s3.get_top_level_folders()
        print(f"[folders] total={len(folders)}")
        if not folders:
            print("No folders."); 
            return results

        dbs, dbe = _hour_window_to_day_offsets(h0, h1)
        selected = folders[-(dbe+1):] if dbs == 0 else folders[-(dbe+1):-dbs]
        print(f"[folders] selected={selected}")

        key_to_assign, pf_stats = s3.prefilter_keys_by_filename(
            selected, token2pps, middle, start_ts, end_ts,
        )
        print(f"[prefilter] scanned={pf_stats.get('scanned',0)}  token_hit={pf_stats.get('token_hit',0)}  "
              f"time_hit={pf_stats.get('time_hit',0)}  assigned={pf_stats.get('assigned',0)}")

        matched_pairs = {(p1,p2) for (_, p1, p2) in key_to_assign.values()}
        for p1, p2 in sorted(matched_pairs):
            os.makedirs(os.path.join(base_root, _safe_prefix(p1), _safe_prefix(p2)), exist_ok=True)
        print(f"[mkdir] pairs created: {len(matched_pairs)} dirs (p1/p2)")

        for (tok, p1, p2) in set(key_to_assign.values()):
            k = (f"{p1}/{p2}", str(tok), p1, p2)
            results[k] = {"file_count": 0, "dataset_size": 0, "image_count": 0, "total_time_sec": 0.0}

        matched_keys = list(key_to_assign.keys())
        if not matched_keys:
            print("[prefilter] no keys after filename prefilter; nothing to do.")
            return results

        total_chunks = (len(matched_keys) + chunk_size - 1) // chunk_size
        print(f"[chunks] global chunks={total_chunks}, chunk_size={chunk_size}")

        printed_days = set()
        for idx, off in enumerate(range(0, len(matched_keys), chunk_size), 1):
            part_keys = matched_keys[off:off+chunk_size]
            print(f"\n🔥 Global Chunk {idx}/{total_chunks} size={len(part_keys)}  ( now={datetime.now():%Y-%m-%d %H:%M:%S})")
            t_chunk = time.time()

            contents = s3.download_and_decompress_parallel(part_keys)
            if not contents:
                print("  -> empty chunk"); 
                continue

            tagged_pairs = []
            for name, text in contents:
                orig_key = name.split("::", 1)[0]
                assign = key_to_assign.get(orig_key)
                if assign is not None:
                    tok, p1, p2 = assign
                    tagged_pairs.append((tok, p1, p2, name, text))
            del contents

            dataset_all = proc.process_files_parallel_tagged(tagged_pairs)

            def _parse_stime_dt(st: str):
                if not st: return None
                m = re.match(r'^(\d{8})_(\d{6})$', st)
                if not m: return None
                try:
                    return datetime.strptime(st, "%Y%m%d_%H%M%S")
                except Exception:
                    return None

            before = len(dataset_all)
            if (h0 != 0 or h1 != 0):
                dataset_all = [s for s in dataset_all
                               if (dt := _parse_stime_dt(s.get('stime'))) is not None
                               and (start_ts <= dt <= end_ts)]
            after = len(dataset_all)
            print(f"[stime-filter] kept {after}/{before}")
            if not dataset_all:
                print("  -> no dataset in window"); 
                continue

            days_in_chunk = sorted({(s.get('stime') or 'NA').split('_')[0] for s in dataset_all if s.get('stime')})
            for d in days_in_chunk:
                if d not in printed_days:
                    print(f"  [date] {d} (now {datetime.now():%H:%M:%S})"); printed_days.add(d)

            imgs, img_ok_by_key = img.generate_images_mixed(dataset_all, base_root=base_root)

            from collections import defaultdict, Counter
            orig_by_key = defaultdict(set)   # key: (tok,p1,p2)
            for tok, p1, p2, name, _ in tagged_pairs:
                orig_by_key[(tok,p1,p2)].add(name.split("::", 1)[0])

            file_count_by_key = {k: len(s) for k, s in orig_by_key.items()}
            ds_count_by_key = Counter([(s['token'], s['p1'], s['p2']) for s in dataset_all])

            touched = set().union(file_count_by_key.keys(), ds_count_by_key.keys(), img_ok_by_key.keys())
            for (tok,p1,p2) in touched:
                k = (f"{p1}/{p2}", str(tok), p1, p2)
                if k not in results:
                    results[k] = {"file_count":0,"dataset_size":0,"image_count":0,"total_time_sec":0.0}
                results[k]["file_count"]   += file_count_by_key.get((tok,p1,p2), 0)
                results[k]["dataset_size"] += ds_count_by_key.get((tok,p1,p2), 0)
                results[k]["image_count"]  += img_ok_by_key.get((tok,p1,p2), 0)

            print(f"  -> chunk done in {round(time.time()-t_chunk, 2)}s")

        total_secs = round(time.time()-t0, 2)
        for k in results.keys(): results[k]["total_time_sec"] = total_secs

        p1_matched = {p1 for (p1, _) in matched_pairs}
        removed = _cleanup_empty_p2_and_dates(base_root, p1_matched)
        if removed: print(f"[cleanup] removed {removed} empty dirs")

        print("\n🎯 Results by (prefix, token, p1, p2)")
        for k, v in results.items():
            print(" ", k, "->", {kk: v[kk] for kk in ("file_count","dataset_size","image_count","total_time_sec")})
        print(f"\n✅ Global done in {total_secs}s")
        return results
    finally:
        try: proc.close()
        except: pass
        try: img.close()
        except: pass

# =================== Main ===================

if __name__ == "__main__":
    try: multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError: pass
    setup_environment()
    df = load_df(CONFIG.df_path)
    if df is not None and len(df) > 0:
        run_pipeline_for_dataframe(df)
    else:
        print("No tokens found in DataFrame; nothing to do.")
