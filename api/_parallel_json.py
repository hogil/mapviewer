"""ProcessPoolExecutor용 JSON 로더 — 값 추출까지 프로세스 내에서 완료"""
import json
from pathlib import Path
from typing import Optional, List, Tuple

try:
    import orjson
    def _parse(raw: bytes):
        return orjson.loads(raw)
except ImportError:
    def _parse(raw: bytes):
        return json.loads(raw)


# BIN 정규화 (measure_composite._normalize_bin 과 동일 로직)
_KNOWN_BINS = {285, 286, 287, 288, 290, 291, 300, 385, 386, 388, 389, 390}

def _normalize_bin(b) -> str:
    if b is None:
        return "Normal"
    s = str(b).strip()
    if not s:
        return "Normal"
    low = s.lower()
    if low in ("normal", "nor", "border"):
        return "Normal"
    if low in ("invalid", "inv"):
        return "Invalid"
    num = None
    if low.startswith("b") and low[1:].isdigit():
        num = int(low[1:])
    elif s.isdigit():
        num = int(s)
    if num is not None:
        if num < 200:
            return "Normal"
        if num < 280:
            return "Invalid"
        return str(num) if num in _KNOWN_BINS else "ETC"
    return s


def _normalize_positions_to_chips(data: dict):
    """positions dict(키="0","1"...) → chips list 자동 변환 (composite_map 동일 로직)."""
    if isinstance(data.get("chips"), list) and data["chips"]:
        return
    pos = data.get("positions")
    if isinstance(pos, dict) and pos:
        try:
            max_idx = max(int(k) for k in pos.keys())
            chips = [None] * (max_idx + 1)
            for k, v in pos.items():
                chips[int(k)] = v
            chips = [c if c is not None else {} for c in chips]
            data["chips"] = chips
        except (ValueError, TypeError):
            pass


def load_positions_file(path_str: str):
    return _parse(Path(path_str).read_bytes())


def extract_chip_values(args: tuple) -> Optional[List[Tuple[int, int, float]]]:
    """프로세스 내에서 JSON 파싱 + 값 추출까지 완료. 결과는 [(x_abs, y_abs, value), ...]"""
    path_str, mode, item_key, bin_types = args
    try:
        data = _parse(Path(path_str).read_bytes())
    except Exception:
        return None

    # positions dict → chips list 변환 (구형 포맷 호환)
    _normalize_positions_to_chips(data)

    chips = data.get("chips")
    if not isinstance(chips, list):
        return None

    # item 인덱스 찾기
    key_idx = None
    if mode in ("f", "q"):
        key_name = "ftn_keys" if mode == "f" else "qtn_keys"
        keys = data.get(key_name, [])
        for i, k in enumerate(keys):
            if str(k) == str(item_key):
                key_idx = i
                break

    results = []
    bin_set = set(str(b) for b in bin_types) if bin_types else None

    for chip in chips:
        # x_abs/y_abs 우선, 없으면 x/y fallback
        xa = chip.get("x_abs") if chip.get("x_abs") is not None else chip.get("x")
        ya = chip.get("y_abs") if chip.get("y_abs") is not None else chip.get("y")
        if xa is None or ya is None:
            continue

        if mode == "bin":
            b = chip.get("b")
            norm = _normalize_bin(b)
            val = 1.0 if (bin_set and norm in bin_set) else 0.0
        else:
            fd = chip.get(mode)
            if isinstance(fd, list) and key_idx is not None and key_idx < len(fd):
                raw_val = fd[key_idx]
            elif isinstance(fd, dict):
                raw_val = fd.get(item_key)
            else:
                continue
            if raw_val is None:
                continue
            try:
                val = float(raw_val)
            except (ValueError, TypeError):
                continue

        results.append((int(xa), int(ya), val))

    return results


def extract_chip_values_batch(args_list: list) -> list:
    """여러 파일을 한 프로세스에서 순차 처리 (IPC 오버헤드 감소)"""
    return [extract_chip_values(args) for args in args_list]
