"""
Composite Map 생성 모듈
여러 웨이퍼 맵의 인덱스별 빈도를 히트맵으로 시각화
"""
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from datetime import datetime
from functools import partial, lru_cache
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Sequence, Callable
import numpy as np
from PIL import Image
from PIL.Image import DecompressionBombWarning

from .config import (
    IMAGES_ROOT,
    COMPOSITE_MAX_WORKERS,
    COMPOSITE_LOADER_MODE,
    COMPOSITE_BATCH_SIZE,
    POSITIONS_ROOT,
)
from .personal_colors import load_color_legends, _scheme_to_palette_bytes, normalize_hex_color
from .composite_colors import load_composite_color_settings

try:
    from cython_grade_counts import count_grades as _cython_count_grades
except Exception:
    _cython_count_grades = None

if not os.environ.get("OMP_NUM_THREADS"):
    _OMP_DEFAULT_THREADS = max(4, min(8, os.cpu_count() or 8))
    os.environ["OMP_NUM_THREADS"] = str(_OMP_DEFAULT_THREADS)

Image.MAX_IMAGE_PIXELS = None
warnings.simplefilter("ignore", DecompressionBombWarning)

# Composite 맵 저장 디렉토리 (사용자별 하위 폴더)
COMPOSITE_ROOT = IMAGES_ROOT / "composite_map"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)
SQUARE_MAP_CACHE_FILENAME = "square_maps_data.npz"
COMPOSITE_CACHE_ROOT = IMAGES_ROOT / "composite_cache_v1"
COMPOSITE_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
_GRADE_RANGE = np.arange(8, dtype=np.uint8)


def _copy_positions_without_bin(first_image_rel_path: str, output_dir: Path, composite_images: List[str]) -> None:
    """
    첫 번째 이미지의 positions.json을 찾아서 bin(b) 정보를 제거한 후
    composite map 이미지들에 대응하는 positions 파일로 복사

    Args:
        first_image_rel_path: 첫 번째 소스 이미지 상대 경로 (예: "wm-811k/1.png")
        output_dir: Composite map 출력 디렉토리 (예: composite_map/change/20251126_140343)
        composite_images: 생성된 composite 이미지 파일명 리스트 (예: ["Grade_0.png", "square_average.png"])
    """
    import json

    print(f"[COMPOSITE] _copy_positions_without_bin 호출됨")
    print(f"  first_image_rel_path: {first_image_rel_path}")
    print(f"  output_dir: {output_dir}")
    print(f"  composite_images count: {len(composite_images)}")

    # 1. 첫 번째 이미지의 positions.json 찾기
    first_image_path = Path(first_image_rel_path)
    first_image_stem = first_image_path.stem
    first_image_parent = first_image_path.parent

    # positions.json 후보 경로들 (main.py의 _candidate_positions_paths와 동일 로직)
    candidate_paths = []

    # 우선순위 1: trimmed 경로 (첫 번째 경로 구성요소 제거)
    parent_parts = [p for p in first_image_parent.parts if p not in ("", ".")]
    print(f"  parent_parts: {parent_parts}")

    if len(parent_parts) > 1:
        trimmed_parts = parent_parts[1:]
        candidate_paths.append(POSITIONS_ROOT.joinpath(*trimmed_parts) / f"{first_image_stem}.json")
    elif parent_parts:
        candidate_paths.append(POSITIONS_ROOT / f"{first_image_stem}.json")

    # 우선순위 2: 레거시 경로
    legacy_path = POSITIONS_ROOT / first_image_parent / f"{first_image_stem}.json"
    if legacy_path not in candidate_paths:
        candidate_paths.append(legacy_path)

    print(f"  candidate_paths:")
    for idx, path in enumerate(candidate_paths):
        print(f"    [{idx}] {path} (exists: {path.exists()})")

    # 존재하는 파일 찾기
    source_positions_path = None
    for candidate in candidate_paths:
        if candidate.exists():
            source_positions_path = candidate
            break

    if not source_positions_path:
        print(f"[COMPOSITE] positions.json not found for: {first_image_rel_path}")
        print(f"[COMPOSITE] POSITIONS_ROOT: {POSITIONS_ROOT}")
        return

    print(f"[COMPOSITE] Found positions.json: {source_positions_path}")

    # 2. positions.json 로드 및 "b" 필드 제거
    try:
        with open(source_positions_path, 'r', encoding='utf-8') as f:
            positions_data = json.load(f)

        # chips 배열에서 "b" 필드 제거
        if 'chips' in positions_data and isinstance(positions_data['chips'], list):
            for chip in positions_data['chips']:
                if isinstance(chip, dict) and 'b' in chip:
                    del chip['b']

            print(f"[COMPOSITE] Removed 'b' field from {len(positions_data['chips'])} chips")

        # 3. composite map 출력 디렉토리에 positions 폴더 생성
        # output_dir: IMAGES_ROOT/composite_map/change/20251126_140343
        # positions 저장 위치: POSITIONS_ROOT/composite_map/change/20251126_140343
        print(f"  IMAGES_ROOT: {IMAGES_ROOT}")
        print(f"  output_dir: {output_dir}")

        output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
        print(f"  output_dir_rel: {output_dir_rel}")

        positions_output_dir = POSITIONS_ROOT / output_dir_rel
        print(f"  positions_output_dir (before mkdir): {positions_output_dir}")

        positions_output_dir.mkdir(parents=True, exist_ok=True)
        print(f"[COMPOSITE] Creating positions in: {positions_output_dir}")
        print(f"  Directory exists: {positions_output_dir.exists()}")

        # 4. 각 composite 이미지마다 positions 파일 생성
        for img_filename in composite_images:
            img_stem = Path(img_filename).stem

            # image_path 업데이트 (composite map 경로로)
            composite_rel_path = output_dir_rel / img_filename
            positions_data_copy = positions_data.copy()
            positions_data_copy['image_path'] = composite_rel_path.as_posix()
            positions_data_copy['wafer'] = img_stem
            if 'step' in positions_data_copy:
                positions_data_copy['step'] = img_filename

            # positions 파일 저장
            positions_file_path = positions_output_dir / f"{img_stem}.json"
            print(f"  Saving position file: {positions_file_path}")

            with open(positions_file_path, 'w', encoding='utf-8') as f:
                json.dump(positions_data_copy, f, ensure_ascii=False, indent=2)

            print(f"[COMPOSITE] Created positions: {positions_file_path.relative_to(POSITIONS_ROOT)}")
            print(f"  File exists: {positions_file_path.exists()}")

    except Exception as e:
        print(f"[COMPOSITE] Failed to copy positions: {e}")
        import traceback
        traceback.print_exc()


def _build_palette_list(source_palette: Optional[Sequence[int]]) -> List[int]:
    if source_palette:
        palette = list(source_palette)
    else:
        palette = []
    if not palette:
        # grayscale fallback
        for i in range(256):
            palette.extend([i, i, i])
    if len(palette) < 256 * 3:
        palette.extend([0, 0, 0] * (256 - len(palette) // 3))
    return palette[: 256 * 3]


def _sanitize_login_id(login_id: Optional[str]) -> str:
    candidate = (login_id or "change").strip()
    if not candidate:
        candidate = "change"
    safe_chars = []
    for ch in candidate:
        if ch.isalnum() or ch in ("-", "_"):
            safe_chars.append(ch)
        else:
            safe_chars.append("_")
    sanitized = "".join(safe_chars).strip("_") or "change"
    return sanitized[:64]


def _prepare_output_dir(login_id: Optional[str]) -> Tuple[Path, str]:
    safe_login = _sanitize_login_id(login_id)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / safe_login / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir, timestamp


def _summarize_map(values: np.ndarray, mask: Optional[np.ndarray]) -> Dict[str, float]:
    if mask is None:
        return {}
    data = values[mask]
    if data.size == 0:
        return {}
    return {
        "min": float(np.min(data)),
        "max": float(np.max(data)),
        "mean": float(np.mean(data)),
        "std": float(np.std(data)),
    }


def _cache_path_for_image(rel_path: str, width: int, height: int) -> Path:
    sanitized = rel_path.strip("/\\")
    cache_rel = Path(sanitized).with_suffix(f".{width}x{height}.npy")
    return COMPOSITE_CACHE_ROOT / cache_rel


# 메모리 캐시 (LRU): 최근 256개 이미지를 메모리에 캐싱
@lru_cache(maxsize=256)
def _cached_load_pixel_indices(image_rel_path: str, width: int, height: int, mtime: float) -> Optional[bytes]:
    """
    메모리 캐시 레이어 (LRU)
    - mtime을 키로 사용하여 파일 변경 시 자동으로 캐시 무효화
    - numpy 배열을 bytes로 저장 (picklable)
    """
    try:
        result = _load_pixel_indices(image_rel_path, width, height)
        if result is not None:
            # numpy 배열을 bytes로 직렬화
            return result.tobytes()
        return None
    except Exception as e:
        print(f"[MEMORY CACHE] Load failed: {image_rel_path}, {e}")
        return None


def _load_pixel_indices_with_cache(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """
    3단계 캐싱 전략:
    1. 메모리 캐시 (LRU) - 가장 빠름
    2. 디스크 캐시 (NPY 파일)
    3. 원본 이미지 로드
    """
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None

    try:
        # 파일 mtime 확인
        mtime = full_path.stat().st_mtime

        # 메모리 캐시 체크
        cached_bytes = _cached_load_pixel_indices(image_rel_path, width, height, mtime)
        if cached_bytes is not None:
            # bytes를 numpy 배열로 역직렬화
            return np.frombuffer(cached_bytes, dtype=np.uint8).reshape(height, width)

        return None
    except Exception as e:
        print(f"[CACHE] Error loading {image_rel_path}: {e}")
        return None


def _count_low_grade_occurrences(
    stacked_indices: np.ndarray,
    chunk_size: Optional[int] = None,
) -> np.ndarray:
    """
    (N, H, W) 인덱스 배열에서 grade 0~7의 등장 횟수를 계산.
    4차원 브로드캐스트 대신 np.add.at 기반 누적로직을 사용하여
    메모리 사용량을 8배 이상 줄이고 CPU 캐시 효율을 높인다.
    """
    if stacked_indices.ndim != 3:
        raise ValueError("stacked_indices must be a 3D array (N, H, W)")

    total_images, height, width = stacked_indices.shape
    if total_images == 0 or height == 0 or width == 0:
        return np.zeros((8, height, width), dtype=np.uint16)

    inferred_chunk = chunk_size or COMPOSITE_BATCH_SIZE or 8
    chunk = max(1, min(total_images, max(4, min(64, inferred_chunk))))

    flat_pixels = height * width
    counts = np.zeros((8, flat_pixels), dtype=np.uint32)
    base_pixels = np.arange(flat_pixels, dtype=np.int64)
    pixel_cache: Dict[int, np.ndarray] = {}

    for start in range(0, total_images, chunk):
        chunk_arr = stacked_indices[start:start + chunk]
        current_len = chunk_arr.shape[0]
        flat_chunk = chunk_arr.reshape(-1)
        valid_mask = flat_chunk < 8
        if not valid_mask.any():
            continue
        if current_len not in pixel_cache:
            pixel_cache[current_len] = np.tile(base_pixels, current_len)
        pixel_ids = pixel_cache[current_len][valid_mask]
        grade_ids = flat_chunk[valid_mask].astype(np.int64, copy=False)
        np.add.at(counts, (grade_ids, pixel_ids), 1)

    clipped = np.clip(counts, 0, np.iinfo(np.uint16).max).astype(np.uint16, copy=False)
    return clipped.reshape(8, height, width)


def _broadcast_grade_counts(stacked_indices: np.ndarray) -> np.ndarray:
    grade_counts_vec = (stacked_indices[..., None] == _GRADE_RANGE).sum(axis=0)
    return grade_counts_vec.transpose(2, 0, 1).astype(np.uint16, copy=False)


def _compute_grade_counts(stacked_indices: np.ndarray) -> np.ndarray:
    if stacked_indices.ndim != 3:
        raise ValueError("stacked_indices must be a 3D array (N, H, W)")
    contiguous = np.ascontiguousarray(stacked_indices, dtype=np.uint8)

    if _cython_count_grades is not None:
        try:
            return _cython_count_grades(contiguous)
        except Exception as exc:
            print(f"[COMPOSITE] cython grade count failed: {exc}")

    try:
        return _broadcast_grade_counts(contiguous)
    except MemoryError:
        print("[COMPOSITE] broadcast counting OOM, falling back to chunk mode")
    except Exception as exc:
        print(f"[COMPOSITE] broadcast counting failed: {exc}, using chunk mode")
    return _count_low_grade_occurrences(contiguous)


def _hex_to_rgb_tuple(value: str) -> Tuple[int, int, int]:
    value = value.lstrip("#")
    if len(value) != 6:
        return (255, 255, 255)
    r = int(value[0:2], 16)
    g = int(value[2:4], 16)
    b = int(value[4:6], 16)
    return (r, g, b)


def _percentile_ranks(values: np.ndarray) -> np.ndarray:
    """
    주어진 값 배열을 0~100 범위로 선형 정규화(Min-Max Scaling).
    기존 Percentile(순위) 방식 대신 값의 크기를 그대로 반영하여
    0은 0%, Max는 100%가 되도록 함.
    """
    if values.size == 0:
        return np.zeros_like(values, dtype=np.float32)

    v_min = np.min(values)
    v_max = np.max(values)

    if v_min == v_max:
        return np.zeros_like(values, dtype=np.float32)

    # Min-Max Scaling: (x - min) / (max - min) * 100
    # float32로 변환하여 계산
    values_f = values.astype(np.float32, copy=False)
    
    return (values_f - v_min) / (v_max - v_min) * 100.0


def _interpolate_percentile_colors(
    percentiles: np.ndarray,
    color_array: np.ndarray,
    quantile_positions: Optional[np.ndarray] = None,
) -> np.ndarray:
    """
    Percentile (0~100)을 색상으로 변환

    Args:
    percentiles: 0~100 범위의 percentile 값들
    color_array: 11개의 RGB 색상 [quantile0, quantile10, ..., quantile100]
    quantile_positions: 각 색상에 해당하는 백분위 지점 (0~100 값의 배열)

    Returns:
        RGB 색상 배열
    """
    if percentiles.size == 0 or color_array.size == 0:
        return np.zeros((0, 3), dtype=np.uint8)

    colors_f = color_array.astype(np.float32, copy=False)
    if colors_f.shape[0] == 1:
        return np.repeat(colors_f, percentiles.size, axis=0).astype(np.uint8, copy=False)

    if quantile_positions is None or len(quantile_positions) != len(color_array):
        quantile_positions = np.linspace(0.0, 100.0, len(color_array), dtype=np.float32)
    else:
        quantile_positions = np.clip(
            quantile_positions.astype(np.float32, copy=False),
            0.0,
            100.0,
        )
    percentiles = np.clip(percentiles.astype(np.float32, copy=False), 0.0, 100.0)
    norm_indices = np.interp(
        percentiles,
        quantile_positions,
        np.arange(len(color_array), dtype=np.float32),
    )
    buckets = np.floor(norm_indices).astype(np.int32)
    buckets = np.clip(buckets, 0, len(color_array) - 1)
    next_idx = np.clip(buckets + 1, 0, len(color_array) - 1)
    t = (norm_indices - buckets).reshape(-1, 1)

    start_colors = colors_f[buckets]
    end_colors = colors_f[next_idx]
    blended = start_colors + (end_colors - start_colors) * t
    return np.clip(np.round(blended), 0, 255).astype(np.uint8)


def _load_pixel_indices(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """
    캐싱 개선:
    1. 캐시 히트 시 즉시 반환 (파일 I/O 최소화)
    2. 캐시 미스 시에만 이미지 로드
    3. 원자적 캐시 저장 (임시 파일 사용)
    """
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None

    cache_path: Optional[Path] = None
    try:
        cache_path = _cache_path_for_image(image_rel_path, width, height)
        # 캐시 체크 (파일 mtime 비교)
        if cache_path and cache_path.exists():
            try:
                cache_mtime = cache_path.stat().st_mtime
                file_mtime = full_path.stat().st_mtime
                if cache_mtime >= file_mtime:
                    # 캐시가 최신 - 바로 반환
                    return np.load(cache_path)
            except Exception:
                # 캐시 읽기 실패 - 재생성
                pass
    except Exception as exc:
        print(f"[COMPOSITE CACHE] load skipped ({image_rel_path}): {exc}")
        cache_path = None

    # 캐시 미스 - 이미지 로드 및 캐싱
    try:
        with Image.open(full_path) as img:
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)

            # 투명도(Alpha) 확인을 위한 마스크 생성
            is_transparent = None
            if 'A' in img.getbands():
                alpha = np.array(img.getchannel('A'))
                is_transparent = (alpha == 0)
            elif 'transparency' in img.info:
                # GIF/PNG 투명색 처리
                transparency = img.info['transparency']
                if isinstance(transparency, bytes):
                     # 단순 처리를 위해 생략하거나, 필요한 경우 구현
                     pass
                else:
                    # 팔레트 인덱스 투명
                    temp_arr = np.array(img)
                    is_transparent = (temp_arr == transparency)

            if img.mode == 'P':
                pixel_indices = np.array(img, dtype=np.uint8)
            else:
                img_l = img.convert('L')
                pixels = np.array(img_l, dtype=np.uint8)
                pixel_indices = pixels // 32

            # 투명한 영역은 31(Empty)로 강제 변환
            if is_transparent is not None:
                pixel_indices[is_transparent] = 31

            # 캐시 저장 (원자적 저장)
            if cache_path is not None:
                try:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    tmp_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
                    np.save(tmp_path, pixel_indices, allow_pickle=False)
                    # 원자적 이동 (Windows에서도 작동)
                    try:
                        tmp_path.replace(cache_path)
                    except Exception:
                        # Windows에서 replace 실패 시 강제 삭제 후 재시도
                        if cache_path.exists():
                            cache_path.unlink()
                        tmp_path.rename(cache_path)
                except Exception as exc:
                    print(f"[COMPOSITE CACHE] save failed ({cache_path}): {exc}")
            return pixel_indices
    except Exception as exc:
        print(f"[FAST] Composite image load failed: {image_rel_path}, {exc}")
        return None


def _iter_pixel_indices(
    image_paths: List[str],
    width: int,
    height: int,
    loader_mode: str,
    max_workers: Optional[int],
    progress_callback: Optional[Callable[[int, int], None]] = None
):
    """
    병렬 처리 최적화:
    - ThreadPoolExecutor는 I/O bound 작업에 효율적 (기본값)
    - chunksize로 작업 분배 효율화
    - 메모리 캐시 (LRU) 사용으로 속도 향상
    - progress_callback: 진행률 콜백 (current, total)
    """
    if not image_paths:
        return []
    normalized_mode = (loader_mode or "thread").lower()
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    worker_count = min(max(1, max_workers), len(image_paths))
    loader = partial(_load_pixel_indices_with_cache, width=width, height=height)

    total = len(image_paths)
    processed = 0

    if normalized_mode in {"sequential", "none"} or worker_count <= 1:
        for rel_path in image_paths:
            result = loader(rel_path)
            processed += 1
            if progress_callback:
                progress_callback(processed, total)
            yield rel_path, result
        return

    # ThreadPoolExecutor를 기본으로 사용 (I/O bound에 효율적)
    executor_cls = ThreadPoolExecutor
    if normalized_mode in {"process", "proc", "multiprocess"}:
        executor_cls = ProcessPoolExecutor

    # chunksize 계산: 작업 분배 최적화
    chunksize = max(1, len(image_paths) // (worker_count * 4))

    with executor_cls(max_workers=worker_count) as executor:
        for rel_path, result in zip(
            image_paths,
            executor.map(loader, image_paths, chunksize=chunksize)
        ):
            processed += 1
            if progress_callback:
                progress_callback(processed, total)
            yield rel_path, result


def _batched_paths(paths: Sequence[str], batch_size: int) -> Sequence[Sequence[str]]:
    """
    Yield path slices to cap concurrent decode jobs.
    """
    if batch_size <= 0:
        batch_size = 1
    for start in range(0, len(paths), batch_size):
        yield paths[start : start + batch_size]


def _render_sum_map_image(
    base_indices: np.ndarray,
    value_map: np.ndarray,
    mask: np.ndarray,
    palette_list: List[int],
    quantiles: Sequence[float],
    color_stops: np.ndarray,
) -> Image.Image:
    rgb_palette = np.array(palette_list, dtype=np.uint8).reshape(256, 3)
    
    # 1. [Base Layer] 먼저 base_indices 색상(8번, 31번 등)으로 전체를 칠함
    rgb_array = rgb_palette[base_indices].copy()
    calc_values = value_map[mask].astype(np.float32, copy=False)

    if calc_values.size > 0 and len(color_stops) >= 1:
        quantile_positions = None
        if quantiles:
            quantile_positions = np.asarray(quantiles, dtype=np.float32) * 100.0
        percentiles = _percentile_ranks(calc_values)
        colors = _interpolate_percentile_colors(percentiles, color_stops, quantile_positions)
        
        # 2. [Composite Layer] 계산 대상(0-7만 있는 곳)만 Composite 색상으로 덮어씀
        rgb_array[mask] = colors

    return Image.fromarray(rgb_array.astype(np.uint8), mode='RGB')


def _persist_square_map_data(
    output_dir: Path,
    palette_list: Sequence[int],
    base_indices: np.ndarray,
    square_mean_map: np.ndarray,
    weighted_map: np.ndarray,
    calc_mask: np.ndarray,
    weighted_mask: np.ndarray,
    grade_counts: Optional[np.ndarray] = None,
    invalid_mask: Optional[np.ndarray] = None,
    idx_8_mask: Optional[np.ndarray] = None,
    image_count: Optional[int] = None,
    color_scheme: Optional[str] = None,
    colors: Optional[Sequence[str]] = None,
) -> None:
    """
    Cache square-map arrays for fast recoloring.
    """
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    palette_array = np.array(palette_list, dtype=np.uint8).reshape(256, 3)
    save_payload: Dict[str, np.ndarray] = {
        "square_mean": square_mean_map.astype(np.float32, copy=False),
        "square_weighted": weighted_map.astype(np.float32, copy=False),
        "calc_mask": calc_mask.astype(bool, copy=False),
        "weighted_mask": weighted_mask.astype(bool, copy=False),
        "base_indices": base_indices.astype(np.uint8, copy=False),
        "palette": palette_array,
    }
    if grade_counts is not None:
        save_payload["grade_counts"] = grade_counts.astype(np.uint16, copy=False)
    if invalid_mask is not None:
        save_payload["invalid_mask"] = invalid_mask.astype(bool, copy=False)
    if idx_8_mask is not None:
        save_payload["idx_8_mask"] = idx_8_mask.astype(bool, copy=False)
    if image_count is not None:
        save_payload["source_image_count"] = np.array(image_count, dtype=np.uint32)
    if color_scheme:
        save_payload["color_scheme"] = np.array([color_scheme], dtype="U32")
    if colors:
        save_payload["colors"] = np.array(list(colors), dtype="U16")

    np.savez_compressed(cache_path, **save_payload)


def _recompute_square_maps_from_counts(
    grade_counts: np.ndarray,
    only_low_mask: Optional[np.ndarray],
    invalid_mask: Optional[np.ndarray],
    idx_8_mask: Optional[np.ndarray],
    image_count: Optional[int],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    square_average / square_weighted_average를 grade별 카운트로부터 재계산.
    composite_map 폴더에 캐시된 point별 인덱스 카운트(및 optional mask)를 활용한다.
    """
    if grade_counts.ndim != 3:
        raise ValueError("grade_counts must be a 3D array (grade, H, W)")
    grade_dim = grade_counts.shape[0]
    if grade_dim == 0:
        raise ValueError("grade_counts must include at least one grade axis")

    selected_grades = list(range(min(grade_dim, 8)))
    if not selected_grades:
        raise ValueError("No grade indices available to recompute square maps")

    bool_low_mask = only_low_mask.astype(bool, copy=False) if only_low_mask is not None else None
    bool_invalid_mask = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    bool_idx8_mask = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None

    square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
        grade_counts=grade_counts,
        selected_grades=selected_grades,
        invalid_mask=bool_invalid_mask,
        idx_8_mask=bool_idx8_mask,
        only_low_mask=bool_low_mask,
        image_count=image_count,
    )
    return square_mean_map, weighted_map, calc_mask, weighted_mask


def recolor_saved_sum_maps(
    output_dir: Path,
    override_colors: Optional[Sequence[str]] = None,
    scheme: Optional[str] = None,
) -> List[Dict[str, str]]:
    """
    Reload cached square-map arrays and regenerate PNGs with updated colors.
    """
    print(f"[recolor_saved_sum_maps] 호출됨")
    print(f"  output_dir: {output_dir}")
    print(f"  override_colors: {override_colors}")

    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    print(f"  cache_path: {cache_path}")
    print(f"  cache_path.exists(): {cache_path.exists()}")

    if not cache_path.exists():
        raise FileNotFoundError(f"Square map cache not found: {cache_path}")

    with np.load(cache_path) as data:
        cached_square_mean = data["square_mean"]
        cached_weighted = data["square_weighted"]
        calc_mask = data["calc_mask"].astype(bool)
        weighted_mask = data["weighted_mask"].astype(bool)
        base_indices = data["base_indices"].astype(np.uint8)
        palette_array = data["palette"].astype(np.uint8)
        grade_counts = data.get("grade_counts")
        invalid_mask = data.get("invalid_mask")
        idx_8_mask = data.get("idx_8_mask")
        image_count_arr = data.get("source_image_count")
        source_image_count = int(image_count_arr.item()) if image_count_arr is not None else None
        color_scheme_arr = data.get("color_scheme")
        colors_arr = data.get("colors")
    grade_counts_arr = grade_counts.astype(np.uint16, copy=False) if grade_counts is not None else None
    invalid_mask_arr = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    idx_8_mask_arr = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None
    cached_scheme = None
    if color_scheme_arr is not None:
        try:
            cached_scheme = str(np.atleast_1d(color_scheme_arr).ravel()[0])
        except Exception:
            cached_scheme = None

    if grade_counts_arr is not None:
        try:
            square_mean_map, weighted_map, calc_mask, weighted_mask = _recompute_square_maps_from_counts(
                grade_counts=grade_counts_arr,
                only_low_mask=calc_mask,
                invalid_mask=invalid_mask_arr,
                idx_8_mask=idx_8_mask_arr,
                image_count=source_image_count,
            )
        except Exception as exc:
            print(f"[recolor_saved_sum_maps] Recompute from counts failed, fallback to cached values: {exc}")
            square_mean_map = cached_square_mean
            weighted_map = cached_weighted
    else:
        square_mean_map = cached_square_mean
        weighted_map = cached_weighted
    palette_list = palette_array.reshape(-1).tolist()
    resolved_scheme = (scheme or cached_scheme or "change").strip() or "change"
    settings = load_composite_color_settings(resolved_scheme)
    cached_colors: Optional[List[str]] = None
    if colors_arr is not None:
        try:
            cached_colors = [normalize_hex_color(str(c)) for c in colors_arr.tolist()]
        except Exception:
            cached_colors = None
    base_colors = cached_colors if cached_colors else settings.colors
    if override_colors:
        colors_to_use: List[str] = []
        for idx, base_color in enumerate(base_colors):
            candidate = override_colors[idx] if idx < len(override_colors) else None
            if candidate:
                try:
                    colors_to_use.append(normalize_hex_color(candidate))
                    continue
                except ValueError:
                    pass
            colors_to_use.append(base_color)
    else:
        colors_to_use = base_colors

    color_stops = np.array([_hex_to_rgb_tuple(c) for c in colors_to_use], dtype=np.float32)

    variants = [
        ("square_average.png", "square_mean", "Composite SqMean", square_mean_map, calc_mask),
        ("square_weighted_average.png", "weighted_square_mean", "Composite Weighted SqMean", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=data_map,
            mask=mask,
            palette_list=palette_list,
            quantiles=settings.quantiles,
            color_stops=color_stops,
        )
        img.save(sum_map_path, format='PNG', optimize=False)
        rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": filename,
        })

    print(f"[recolor_saved_sum_maps] outputs: {outputs}")
    print(f"[recolor_saved_sum_maps] outputs 개수: {len(outputs)}")
    return outputs



def _save_sum_map_variants(
    all_indices: np.ndarray,
    output_dir: Path,
    palette_list: Optional[Sequence[int]] = None,
    invalid_mask: Optional[np.ndarray] = None,
    base_indices: Optional[np.ndarray] = None,
    idx_8_mask: Optional[np.ndarray] = None,
    scheme: Optional[str] = None,
    name_suffix: str = "",
    persist_cache: bool = True,
    grade_counts: Optional[np.ndarray] = None,
    only_low_mask: Optional[np.ndarray] = None,
    colors: Optional[Sequence[str]] = None,
) -> List[Dict[str, str]]:
    if all_indices.ndim != 3:
        raise ValueError("all_indices must be (N, H, W)")
    if all_indices.shape[0] == 0:
        return []

    # all_indices는 (N, H, W) 형태이므로 height와 width 추출
    _, height, width = all_indices.shape

    image_count = all_indices.shape[0]
    if image_count == 0:
        return []
    float_indices = all_indices.astype(np.float32, copy=False)

    if grade_counts is None:
        grade_counts = _compute_grade_counts(all_indices)
    grade_counts_float = grade_counts.astype(np.float32, copy=False)

    # 제곱합 계산: 각 인덱스 값을 제곱한 후 카운트와 곱함
    square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
    square_sums = np.sum(grade_counts_float * square_weights, axis=0, dtype=np.float32)

    # calc_mask: 인덱스 0-7만 있는 포인트
    if only_low_mask is not None:
        calc_mask = only_low_mask.astype(bool, copy=False).copy()
    else:
        calc_mask = grade_counts_float.sum(axis=0) > 0
        if idx_8_mask is not None:
            calc_mask &= ~idx_8_mask
        if invalid_mask is not None:
            calc_mask &= ~invalid_mask

    # square_average: 제곱합 / 이미지 개수
    square_mean_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        square_mean_map[calc_mask] = square_sums[calc_mask] / float(image_count)

    # square_weighted_average: 제곱합 / (0개수*1 + 1개수*1 + 2개수*2 + ... + 7개수*7)
    weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32).reshape(8, 1, 1)
    weight_map = np.sum(grade_counts_float * weight_factors, axis=0, dtype=np.float32)
    weighted_mask = calc_mask & (weight_map > 0)

    weighted_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        weighted_map[weighted_mask] = square_sums[weighted_mask] / weight_map[weighted_mask]

    # 디버그 로그
    print(f"[SQUARE MAP DEBUG]")
    print(f"  calc_mask points: {calc_mask.sum()}")
    print(f"  weighted_mask points: {weighted_mask.sum()}")
    print(f"  calc_mask == weighted_mask: {np.array_equal(calc_mask, weighted_mask)}")
    if calc_mask.any():
        print(f"  square_mean range: [{square_mean_map[calc_mask].min():.2f}, {square_mean_map[calc_mask].max():.2f}]")
    if weighted_mask.any():
        print(f"  weighted_map range: [{weighted_map[weighted_mask].min():.2f}, {weighted_map[weighted_mask].max():.2f}]")
        print(f"  weighted_map has nan/inf: {np.isnan(weighted_map[weighted_mask]).any()} / {np.isinf(weighted_map[weighted_mask]).any()}")

    if base_indices is None:
        median_map = np.median(float_indices, axis=0)
        base_indices = np.clip(np.rint(median_map), 0, 13).astype(np.uint8)  # 0-13 범위
    base_indices = base_indices.copy()
    if invalid_mask is not None:
        base_indices[invalid_mask] = 31

    palette = _build_palette_list(palette_list)
    settings = load_composite_color_settings(scheme)
    resolved_colors = list(colors) if colors else settings.colors
    color_stops = np.array([_hex_to_rgb_tuple(c) for c in resolved_colors], dtype=np.float32)

    if persist_cache:
        _persist_square_map_data(
            output_dir=output_dir,
            palette_list=palette,
            base_indices=base_indices,
            square_mean_map=square_mean_map,
            weighted_map=weighted_map,
            calc_mask=calc_mask,
            weighted_mask=weighted_mask,
            grade_counts=grade_counts,
            invalid_mask=invalid_mask,
            idx_8_mask=idx_8_mask,
            image_count=image_count,
            color_scheme=settings.scheme,
            colors=resolved_colors,
        )

    display_suffix = f" [{name_suffix.lstrip('_')}]" if name_suffix else ""
    variants = [
        (f"square_average{name_suffix}.png", "square_mean", f"Composite SqMean{display_suffix}", square_mean_map, calc_mask),
        (f"square_weighted_average{name_suffix}.png", "weighted_square_mean", f"Composite Weighted SqMean{display_suffix}", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        print(f"[SAVE] Saving {filename}, mask points: {mask.sum()}")
        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=data_map,
            mask=mask,
            palette_list=palette,
            quantiles=settings.quantiles,
            color_stops=color_stops,
        )
        img.save(sum_map_path, format='PNG', optimize=False)
        rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()
        print(f"[SAVE] Saved to: {rel_path}")
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": filename,
        })

    print(f"[SAVE] Total outputs: {len(outputs)}")
    return outputs


def _compute_maps_from_counts(
    grade_counts: np.ndarray,
    selected_grades: Sequence[int],
    invalid_mask: Optional[np.ndarray],
    idx_8_mask: Optional[np.ndarray],
    only_low_mask: Optional[np.ndarray] = None,
    image_count: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    grade_counts에서 선택되지 않은 Grade의 카운트를 인덱스 0으로 이동한 뒤
    동일 수식으로 square_sum, weight_sum 계산.

    예: selected_grades=[3, 5]
    - grade 1, 2, 4, 6, 7의 카운트를 인덱스 0에 합산
    - 인덱스 0은 제곱값이 0이므로 분자(square_sums)에 영향 없음
    - 가중치가 1이므로 분모(weight_map)는 증가
    """
    if grade_counts.ndim != 3:
        raise ValueError("grade_counts 배열 형식이 올바르지 않습니다.")

    # 1. 데이터 복사 및 비선택 Grade를 인덱스 0으로 이동
    # float32로 변환 (계산을 위해)
    counts_float = grade_counts.astype(np.float32, copy=True)

    # 선택된 grade가 아닌 인덱스의 카운트를 인덱스 0에 합산
    # 예: selected=[3, 5] -> 1, 2, 4, 6, 7의 카운트를 0에 합산
    all_grades = set(range(8))
    target_grades = set(selected_grades)
    grades_to_move = list(all_grades - target_grades - {0})  # 0은 제외 (이미 0이므로)

    if grades_to_move:
        for grade_idx in grades_to_move:
            counts_float[0, :, :] += counts_float[grade_idx, :, :]  # ⭐ 인덱스 0에 합산
            counts_float[grade_idx, :, :] = 0.0  # 원래 위치는 0으로

    # 2. Full Map과 동일한 방식(벡터화)으로 계산
    # 제곱 가중치: [0, 1, 4, 9, 16, 25, 36, 49]
    square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
    square_sums = np.sum(counts_float * square_weights, axis=0, dtype=np.float32)

    # 가중치: [1, 1, 2, 3, 4, 5, 6, 7]
    weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32).reshape(8, 1, 1)
    weight_map_sum = np.sum(counts_float * weight_factors, axis=0, dtype=np.float32)

    # 3. 마스크 설정
    if only_low_mask is not None:
        calc_mask = only_low_mask.astype(bool, copy=False).copy()
    else:
        # zero 처리된 counts_float 기준으로 마스크 생성 (선택된 grade가 하나라도 있는 포인트만 포함)
        calc_mask = counts_float.sum(axis=0) > 0
        if idx_8_mask is not None:
            calc_mask &= ~idx_8_mask
        if invalid_mask is not None:
            calc_mask &= ~invalid_mask

    if image_count is None or image_count <= 0:
        # 이미지 개수 추정 (원본 데이터 기준)
        raw_counts_float = grade_counts.astype(np.float32, copy=False)
        inferred = raw_counts_float.sum(axis=0).max()
        image_count_value = float(inferred if inferred > 0 else 1.0)
    else:
        image_count_value = float(image_count)

    # 4. 최종 맵 계산
    # Square Average: 제곱합 / 전체 이미지 개수
    square_mean_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        square_mean_map[calc_mask] = square_sums[calc_mask] / image_count_value

    # Square Weighted Average: 제곱합 / 가중치 합
    weighted_mask = calc_mask & (weight_map_sum > 0)
    weighted_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        weighted_map[weighted_mask] = square_sums[weighted_mask] / weight_map_sum[weighted_mask]

    return square_mean_map, weighted_map, calc_mask, weighted_mask


def create_composite_heatmaps(
    image_paths: List[str],
    indices: List[int] = None,
    create_sum: bool = True,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    batch_size: Optional[int] = None,
    scheme: Optional[str] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    start_time = time.time()
    if not image_paths:
        raise ValueError("image_paths is empty")

    output_dir, timestamp = _prepare_output_dir(login_id)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None

    loader_mode = loader_mode or COMPOSITE_LOADER_MODE
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    batch_size = batch_size or COMPOSITE_BATCH_SIZE

    palette_list = _build_palette_list(source_palette)
    if scheme:
        legends = load_color_legends()
        scheme_data = legends.get(scheme)
        if scheme_data:
            palette_bytes = _scheme_to_palette_bytes(scheme_data)
            limit = min(len(palette_bytes) // 3, 256)
            for i in range(limit):
                palette_list[i * 3:(i + 1) * 3] = palette_bytes[i * 3:(i + 1) * 3]
    palette_list[31 * 3:31 * 3 + 3] = [255, 255, 255]

    if indices is None:
        indices = list(range(8))

    # 1단계: 모든 raw indices 수집
    raw_indices_list: List[np.ndarray] = []
    processed_count = 0

    for batch_paths in _batched_paths(image_paths, batch_size):
        for rel_path, raw_indices in _iter_pixel_indices(
            batch_paths,
            width=width,
            height=height,
            loader_mode=loader_mode,
            max_workers=max_workers,
        ):
            if raw_indices is None:
                continue
            raw_indices_list.append(raw_indices.astype(np.uint8, copy=False))
            processed_count += 1

    if not raw_indices_list:
        raise ValueError("처리할 이미지가 없습니다.")

    # 2단계: 인덱스 8-13 처리 (특정 point가 8-13만 있는 경우만 8로 변경)
    stacked_raw = np.stack(raw_indices_list, axis=0)  # (N, H, W)
    raw_indices_list.clear()
    idx_8_13_mask = (stacked_raw >= 8) & (stacked_raw <= 13)  # (N, H, W)
    idx_0_7_mask = (stacked_raw >= 0) & (stacked_raw <= 7)  # (N, H, W)
    idx_14_plus_mask = (stacked_raw >= 14)  # (N, H, W)
    
    # 각 포인트에서 8-13이 있는지, 0-7이 있는지, 14 이상이 있는지 확인
    has_8_13 = idx_8_13_mask.any(axis=0)  # (H, W)
    has_0_7 = idx_0_7_mask.any(axis=0)  # (H, W)
    has_14_plus = idx_14_plus_mask.any(axis=0)  # (H, W)
    
    # 8-13만 있고 0-7이나 14 이상이 없는 포인트
    idx_8_13_only = has_8_13 & ~has_0_7 & ~has_14_plus  # (H, W)

    # 해당 픽셀을 모든 이미지에서 8로 변경
    stacked_raw[:, idx_8_13_only] = 8
    
    # 3단계: invalid mask 생성 및 clipping
    # 인덱스 14 이상만 invalid (31로)
    invalid_mask = (stacked_raw >= 14).any(axis=0)
    stacked_indices = np.clip(stacked_raw, 0, 13, out=stacked_raw)  # 0-13 범위 (8-13만 남김)
    float_indices = stacked_indices.astype(np.float32)
    _, height, width = stacked_indices.shape

    grade_counts = _compute_grade_counts(stacked_indices)

    # (invalid_mask와 idx_8_13_only를 제외한 포인트 중 0-7만 있는 것)
    valid_0_7_mask = (stacked_indices >= 0) & (stacked_indices <= 7)  # (N, H, W)
    has_valid_0_7 = valid_0_7_mask.any(axis=0)  # (H, W)
    has_8_13_after = (stacked_indices >= 8) & (stacked_indices <= 13)  # (N, H, W)
    has_8_13_after = has_8_13_after.any(axis=0)  # (H, W)
    
    # 0-7만 있고 8-13이나 invalid가 없는 포인트
    only_0_7_mask = has_valid_0_7 & ~has_8_13_after & ~invalid_mask  # (H, W)
    
    median_map = np.median(float_indices, axis=0)
    median_indices = np.clip(np.rint(median_map), 0, 13).astype(np.uint8)  # 0-13 범위
    
    # [규칙 적용]
    # 1. 나머지 포인트(Mixed 포함)는 기본적으로 인덱스 31(흰색)
    base_indices = np.full_like(median_indices, 31, dtype=np.uint8)
    
    # 2. 0-7만 있는 곳은 일단 median 값을 넣지만, 렌더링 시 Composite 색상으로 덮어씌워짐
    base_indices[only_0_7_mask] = median_indices[only_0_7_mask]
    
    # 3. 8-13만 있는 곳은 인덱스 8 색상으로 고정 (계산 대상 아님)
    base_indices[idx_8_13_only] = 8
    
    # 4. Invalid 영역도 31(흰색)
    base_indices[invalid_mask] = 31

    heatmaps: List[Dict[str, Any]] = []
    palette_bytes = palette_list[:]
    grade_presence = grade_counts > 0
    invalid_mask_bool = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    idx_8_overlay = idx_8_13_only & ~invalid_mask_bool if invalid_mask_bool is not None else idx_8_13_only.copy()
    for idx in indices:
        if idx >= 8:
            continue
        result = np.full((height, width), 31, dtype=np.uint8)
        presence_mask = grade_presence[idx].copy()
        if invalid_mask_bool is not None:
            presence_mask &= ~invalid_mask_bool
        result[presence_mask] = idx
        result[idx_8_overlay] = 8
        heatmap_path = output_dir / f"Grade_{idx}.png"
        heatmap_img = Image.fromarray(result, mode='P')
        heatmap_img.putpalette(palette_bytes)
        heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=1)
        rel_path = heatmap_path.relative_to(IMAGES_ROOT).as_posix()
        total_pixels = width * height
        pixel_count = int(np.count_nonzero(presence_mask))
        percentage = round(pixel_count / total_pixels * 100, 2) if total_pixels else 0
        heatmaps.append({
            "index": idx,
            "path": rel_path,
            "pixel_count": pixel_count,
            "max_count": processed_count,
            "percentage": percentage,
        })

    sum_map_entries: List[Dict[str, str]] = []
    sum_map_rel_path = None
    if create_sum:
        sum_map_entries = _save_sum_map_variants(
            stacked_indices,
            output_dir,
            palette_bytes,
            invalid_mask=invalid_mask,
            base_indices=base_indices,
            idx_8_mask=idx_8_13_only,
            scheme=scheme,
            grade_counts=grade_counts,
            only_low_mask=only_0_7_mask,
        )
        print(f"[API] sum_map_entries after _save_sum_map_variants: {sum_map_entries}")
        print(f"[API] sum_map_entries length: {len(sum_map_entries)}")
        print(f"[API] sum_map_entries bool: {bool(sum_map_entries)}")
        if sum_map_entries:
            sum_map_rel_path = sum_map_entries[0]["path"]

    # 🔥 첫 번째 이미지의 positions.json을 복사 (bin 정보 제거)
    composite_image_filenames = []
    for heatmap in heatmaps:
        filename = heatmap["path"].split("/")[-1]
        composite_image_filenames.append(filename)
    for entry in sum_map_entries:
        filename = entry.get("filename") or entry["path"].split("/")[-1]
        composite_image_filenames.append(filename)

    if composite_image_filenames and image_paths:
        _copy_positions_without_bin(
            first_image_rel_path=image_paths[0],
            output_dir=output_dir,
            composite_images=composite_image_filenames
        )

    processing_time = time.time() - start_time
    result = {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "heatmaps": heatmaps,
        "source_images": processed_count,
        "source_image_paths": image_paths,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2),
    }
    if sum_map_rel_path:
        result["sum_map_path"] = sum_map_rel_path
    if sum_map_entries:
        result["sum_maps"] = sum_map_entries
    print(f"[API] Final result keys: {result.keys()}")
    print(f"[API] 'sum_maps' in result: {'sum_maps' in result}")
    return result
def create_palette_overlay(
    image_paths: List[str],
    focus_index: Optional[int] = 3,
    highlight_threshold: int = 8,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    지정된 팔레트 인덱스와 고인덱스만 빠르게 합성하는 경량 모드.
    - focus_index: 관심 팔레트 인덱스 (None이면 저인덱스 무시)
    - highlight_threshold: 이 값 이상인 인덱스는 원본 색으로 유지
    """
    start_time = time.time()
    if not image_paths:
        raise ValueError("image_paths is empty")

    output_dir, timestamp = _prepare_output_dir(login_id)

    first_path = IMAGES_ROOT / image_paths[0]
    first_img = Image.open(first_path)
    width, height = first_img.size
    source_palette = first_img.getpalette() if first_img.mode == 'P' else None
    first_img.close()

    # 최종 결과: 각 픽셀에서 최대 인덱스만 유지
    aggregated = np.zeros((height, width), dtype=np.uint8)
    pixel_loader = _iter_pixel_indices(
        image_paths,
        width,
        height,
        loader_mode or COMPOSITE_LOADER_MODE,
        max_workers or COMPOSITE_MAX_WORKERS
    )

    processed_count = 0
    for _, pixel_indices in pixel_loader:
        if pixel_indices is None:
            continue
        processed_count += 1
        
        # 필터링: 0~7 중 focus_index만 남기고 나머지는 0으로, 8 이상은 그대로
        filtered = np.zeros_like(pixel_indices)
        
        # 8 이상 인덱스는 그대로 유지
        high_mask = (pixel_indices >= highlight_threshold)
        filtered[high_mask] = pixel_indices[high_mask]
        
        # focus_index만 남김 (0~7 범위 내)
        if focus_index is not None and 0 <= focus_index < highlight_threshold:
            focus_mask = (pixel_indices == focus_index)
            filtered[focus_mask] = focus_index
        
        # 겹치면 max index로 (높은 인덱스 우선)
        aggregated = np.maximum(aggregated, filtered)

    overlay_img = Image.fromarray(aggregated, mode='P')
    if source_palette:
        overlay_img.putpalette(source_palette)
    overlay_path = output_dir / f"palette_focus_{focus_index if focus_index is not None else 'none'}.png"
    overlay_img.save(overlay_path)

    return {
        "mode": "palette",
        "output_dir": overlay_path.parent.relative_to(IMAGES_ROOT).as_posix(),
        "overlay_path": overlay_path.relative_to(IMAGES_ROOT).as_posix(),
        "focus_index": focus_index,
        "highlight_threshold": highlight_threshold,
        "source_images": processed_count,
        "processing_time": round(time.time() - start_time, 2)
    }


def create_sum_map(
    image_paths: List[str],
    scheme: Optional[str] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    start_time = time.time()
    if not image_paths:
        raise ValueError("이미지 목록이 비어 있습니다.")

    output_dir, timestamp = _prepare_output_dir(login_id)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None

    palette_list = _build_palette_list(source_palette)
    palette_list[31 * 3:31 * 3 + 3] = [255, 255, 255]

    # 1단계: 모든 raw indices 수집
    raw_indices_list = []
    processed_count = 0

    for img_path in image_paths:
        full_path = IMAGES_ROOT / img_path
        if not full_path.exists():
            continue
        try:
            with Image.open(full_path) as img:
                if img.size != (width, height):
                    img = img.resize((width, height), Image.NEAREST)
                
                # 투명도 확인
                is_transparent = None
                if 'A' in img.getbands():
                    alpha = np.array(img.getchannel('A'))
                    is_transparent = (alpha == 0)

                if img.mode == 'P':
                    raw_indices = np.array(img, dtype=np.int16)
                else:
                    raw_indices = np.array(img.convert('L'), dtype=np.int16) // 32
                
                # 투명 영역 31 처리
                if is_transparent is not None:
                    raw_indices[is_transparent] = 31
                    
                raw_indices_list.append(raw_indices)
                processed_count += 1
        except Exception as exc:
            print(f"[SUM_MAP] image load failed: {img_path}, {exc}")
            continue

    if not raw_indices_list:
        raise ValueError("처리할 이미지가 없습니다.")

    # 2단계: 인덱스 8-13 처리 (특정 point가 8-13만 있는 경우만 8로 변경)
    stacked_raw = np.stack(raw_indices_list, axis=0)  # (N, H, W)
    idx_8_13_mask = (stacked_raw >= 8) & (stacked_raw <= 13)  # (N, H, W)
    idx_0_7_mask = (stacked_raw >= 0) & (stacked_raw <= 7)  # (N, H, W)
    idx_14_plus_mask = (stacked_raw >= 14)  # (N, H, W)
    
    # 각 포인트에서 8-13이 있는지, 0-7이 있는지, 14 이상이 있는지 확인
    has_8_13 = idx_8_13_mask.any(axis=0)  # (H, W)
    has_0_7 = idx_0_7_mask.any(axis=0)  # (H, W)
    has_14_plus = idx_14_plus_mask.any(axis=0)  # (H, W)
    
    # 8-13만 있고 0-7이나 14 이상이 없는 포인트
    idx_8_13_only = has_8_13 & ~has_0_7 & ~has_14_plus  # (H, W)

    # 해당 픽셀을 모든 이미지에서 8로 변경
    for i in range(len(raw_indices_list)):
        raw_indices_list[i][idx_8_13_only] = 8

    # 3단계: invalid mask 생성 및 clipping
    # 인덱스 14 이상만 invalid (31로)
    invalid_mask = np.zeros((height, width), dtype=bool)
    all_indices_list = []

    for raw_indices in raw_indices_list:
        invalid_mask |= (raw_indices >= 14)  # 14 이상만 invalid
        clipped = np.clip(raw_indices, 0, 13).astype(np.uint8)  # 0-13 범위 (8-13은 유지)
        all_indices_list.append(clipped)

    stacked_indices = np.stack(all_indices_list, axis=0)
    _, height, width = stacked_indices.shape

    grade_counts = _compute_grade_counts(stacked_indices)

    valid_0_7_mask = (stacked_indices >= 0) & (stacked_indices <= 7)
    has_valid_0_7 = valid_0_7_mask.any(axis=0)
    has_8_13_after = ((stacked_indices >= 8) & (stacked_indices <= 13)).any(axis=0)
    only_0_7_mask = has_valid_0_7 & ~has_8_13_after & ~invalid_mask

    float_indices = stacked_indices.astype(np.float32)
    median_map = np.median(float_indices, axis=0)
    median_indices = np.clip(np.rint(median_map), 0, 13).astype(np.uint8)  # 0-13 범위
    
    # [규칙 적용]
    # 1. 나머지 포인트는 기본적으로 31(흰색)
    base_indices = np.full_like(median_indices, 31, dtype=np.uint8)
    
    # 2. 0-7만 있는 곳 (Composite 계산 대상)
    base_indices[only_0_7_mask] = median_indices[only_0_7_mask]
    
    # 3. 8-13만 있는 곳은 인덱스 8 색상 고정
    base_indices[idx_8_13_only] = 8  
    
    # 4. Invalid 영역은 31(흰색)
    base_indices[invalid_mask] = 31

    entries = _save_sum_map_variants(
        stacked_indices,
        output_dir,
        palette_list,
        invalid_mask=invalid_mask,
        base_indices=base_indices,
        idx_8_mask=idx_8_13_only,
        scheme=scheme,
        grade_counts=grade_counts,
        only_low_mask=only_0_7_mask,
    )
    if not entries:
        raise RuntimeError("Sum Map 생성을 완료하지 못했습니다.")

    primary = entries[0]["path"]
    processing_time = time.time() - start_time
    return {
        "sum_map_path": primary,
        "sum_maps": entries,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2),
    }
def create_subset_map(
    output_dir: Path,
    selected_grades: List[int],
    scheme: Optional[str] = None,
    override_colors: Optional[Sequence[str]] = None,
) -> List[Dict[str, str]]:
    """
    NPZ 파일에서 grade_counts를 로드하여 선택된 grade만으로 Subset Map 생성.

    Args:
        output_dir: Composite map이 저장된 디렉토리 (NPZ 파일 위치)
        selected_grades: 선택된 grade 리스트 (예: [3, 5])
        scheme: Color scheme (optional)
        override_colors: 색상 오버라이드 (optional)

    Returns:
        생성된 Subset Map 정보 리스트
    """
    print(f"[create_subset_map] 호출됨")
    print(f"  output_dir: {output_dir}")
    print(f"  selected_grades: {selected_grades}")

    if not selected_grades:
        raise ValueError("선택된 grade가 없습니다.")

    # 선택된 grade를 정렬하여 파일명 suffix 생성 (예: [3, 5] -> "_35")
    sorted_grades = sorted(selected_grades)
    suffix = "_" + "".join(str(g) for g in sorted_grades)

    # NPZ 파일 로드
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    if not cache_path.exists():
        raise FileNotFoundError(f"Square map cache not found: {cache_path}")

    with np.load(cache_path) as data:
        base_indices = data["base_indices"].astype(np.uint8)
        palette_array = data["palette"].astype(np.uint8)
        grade_counts = data.get("grade_counts")
        invalid_mask = data.get("invalid_mask")
        idx_8_mask = data.get("idx_8_mask")
        only_low_mask = data.get("calc_mask")  # 0-7만 있는 포인트 마스크
        image_count_arr = data.get("source_image_count")
        source_image_count = int(image_count_arr.item()) if image_count_arr is not None else None
        color_scheme_arr = data.get("color_scheme")
        colors_arr = data.get("colors")

    if grade_counts is None:
        raise ValueError("grade_counts가 NPZ 파일에 없습니다.")

    grade_counts_arr = grade_counts.astype(np.uint16, copy=False)
    invalid_mask_arr = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    idx_8_mask_arr = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None
    only_low_mask_arr = only_low_mask.astype(bool, copy=False) if only_low_mask is not None else None

    # Subset Map 계산
    square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
        grade_counts=grade_counts_arr,
        selected_grades=selected_grades,
        invalid_mask=invalid_mask_arr,
        idx_8_mask=idx_8_mask_arr,
        only_low_mask=only_low_mask_arr,
        image_count=source_image_count,
    )

    # 색상 설정
    cached_scheme = None
    if color_scheme_arr is not None:
        try:
            cached_scheme = str(np.atleast_1d(color_scheme_arr).ravel()[0])
        except Exception:
            cached_scheme = None

    resolved_scheme = (scheme or cached_scheme or "change").strip() or "change"
    settings = load_composite_color_settings(resolved_scheme)

    cached_colors: Optional[List[str]] = None
    if colors_arr is not None:
        try:
            cached_colors = [normalize_hex_color(str(c)) for c in colors_arr.tolist()]
        except Exception:
            cached_colors = None

    base_colors = cached_colors if cached_colors else settings.colors

    if override_colors:
        colors_to_use: List[str] = []
        for idx, base_color in enumerate(base_colors):
            candidate = override_colors[idx] if idx < len(override_colors) else None
            if candidate:
                try:
                    colors_to_use.append(normalize_hex_color(candidate))
                    continue
                except ValueError:
                    pass
            colors_to_use.append(base_color)
    else:
        colors_to_use = base_colors

    color_stops = np.array([_hex_to_rgb_tuple(c) for c in colors_to_use], dtype=np.float32)
    palette_list = palette_array.reshape(-1).tolist()

    # Subset Map 이미지 생성
    grade_str = "".join(str(g) for g in sorted_grades)
    variants = [
        (f"square_average_{grade_str}.png", "square_mean", f"Composite SqMean [Grade {', '.join(map(str, sorted_grades))}]", square_mean_map, calc_mask),
        (f"square_weighted_average_{grade_str}.png", "weighted_square_mean", f"Composite Weighted SqMean [Grade {', '.join(map(str, sorted_grades))}]", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        print(f"[SUBSET] Saving {filename}, mask points: {mask.sum()}")
        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=data_map,
            mask=mask,
            palette_list=palette_list,
            quantiles=settings.quantiles,
            color_stops=color_stops,
        )
        img.save(sum_map_path, format='PNG', optimize=False)
        rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()
        print(f"[SUBSET] Saved to: {rel_path}")
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": filename,
            "selected_grades": sorted_grades,
        })

    # 🔥 기존 positions 파일을 subset 파일에도 복사
    # output_dir에 이미 생성된 Grade_0 positions 파일을 찾아서 subset 파일에도 복사
    output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
    positions_output_dir = POSITIONS_ROOT / output_dir_rel

    # Grade_0.json 파일을 찾아서 템플릿으로 사용
    grade_0_positions = positions_output_dir / "Grade_0.json"
    if grade_0_positions.exists():
        try:
            import json
            with open(grade_0_positions, 'r', encoding='utf-8') as f:
                positions_template = json.load(f)

            # subset 파일마다 positions 파일 생성
            for output in outputs:
                filename = output.get("filename")
                if not filename:
                    continue

                img_stem = Path(filename).stem
                positions_data_copy = positions_template.copy()

                # composite map 경로로 업데이트
                composite_rel_path = output_dir_rel / filename
                positions_data_copy['image_path'] = composite_rel_path.as_posix()
                positions_data_copy['wafer'] = img_stem
                if 'step' in positions_data_copy:
                    positions_data_copy['step'] = filename

                # positions 파일 저장
                positions_file_path = positions_output_dir / f"{img_stem}.json"
                with open(positions_file_path, 'w', encoding='utf-8') as f:
                    json.dump(positions_data_copy, f, ensure_ascii=False, indent=2)

                print(f"[SUBSET] Created positions: {positions_file_path.relative_to(POSITIONS_ROOT)}")
        except Exception as e:
            print(f"[SUBSET] Failed to copy positions: {e}")

    print(f"[create_subset_map] outputs: {outputs}")
    return outputs


def accumulate_pixel_counts(
    img_path: Path,
    counts: Dict[int, np.ndarray],
    indices: List[int],
    expected_size: Tuple[int, int]
):
    """
    단일 이미지의 픽셀값을 인덱스별 카운트에 누적

    Args:
        img_path: 이미지 파일 경로
        counts: 인덱스별 카운트 배열 딕셔너리
        indices: 처리할 인덱스 리스트
        expected_size: (width, height) 예상 크기
    """
    img = Image.open(img_path)

    # 크기가 다르면 리샘플링
    if img.size != expected_size:
        img = img.resize(expected_size, Image.NEAREST)

    # 🔥 팔레트 이미지 처리 (웨이퍼맵은 주로 P 모드)
    if img.mode == 'P':
        # 팔레트 모드: 픽셀값이 이미 0~7 (또는 0~255) 인덱스
        pixels = np.array(img)
        pixel_indices = pixels
    else:
        # RGB나 L 모드: 0~255를 0~7로 매핑
        pixels = np.array(img.convert('L'))
        # 0~31 → 0, 32~63 → 1, ..., 224~255 → 7
        pixel_indices = pixels // 32

    # 안전하게 0~7 범위로 클립
    pixel_indices = np.clip(pixel_indices, 0, 7)

    # 각 인덱스별 카운트 증가 (NumPy 벡터화)
    for idx in indices:
        mask = (pixel_indices == idx)

    img.close()


def generate_heatmap_image(
    count_array: np.ndarray,
    max_count: int,
    colormap: str = 'custom_white_red'
) -> Image.Image:
    """
    카운트 배열을 색상 히트맵으로 변환 (팔레트 방식)

    팔레트 방식 사용 이유:
    - 메모리 사용량: RGB 48MB → Palette 16MB (1/3 감소)
    - 처리 속도: RGB 48M ops → Palette 16M ops (3배 빠름)
    - PNG 파일 크기: RGB 20-30MB → Palette 5-10MB (1/3 감소)

    Args:
        count_array: [height, width] 카운트 배열
        max_count: 정규화 기준 (선택된 이미지 총 개수)
        colormap: 'custom_white_red' (흰색→빨강)

    Returns:
        PIL.Image: 팔레트 모드 히트맵 이미지
    """
    # 정규화 (0.0 ~ 1.0)
    if max_count > 0:
        normalized = count_array.astype(np.float32) / max_count
    else:
        normalized = count_array.astype(np.float32)

    normalized = np.clip(normalized, 0.0, 1.0)

    # 8비트 인덱스로 변환 (0~255)
    indexed = (normalized * 255).astype(np.uint8)

    # 그레이스케일 이미지 생성 (L 모드)
    img = Image.fromarray(indexed, mode='L')

    # 256색 팔레트 생성: 흰색(0) → 빨강(255)
    # count=0   → index=0   → RGB(255, 255, 255) 흰색
    # count=max → index=255 → RGB(255, 0, 0)     빨강
    palette = []
    for i in range(256):
        r = 255           # R 채널 고정
        g = 255 - i       # G 채널 감소
        b = 255 - i       # B 채널 감소
        palette.extend([r, g, b])

    # 팔레트 적용 (단 768바이트!)
    img.putpalette(palette)

    return img  # 팔레트 모드 이미지 반환
