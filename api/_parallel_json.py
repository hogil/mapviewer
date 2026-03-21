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


def load_positions_file(path_str: str):
    return _parse(Path(path_str).read_bytes())


def extract_chip_values(args: tuple) -> Optional[List[Tuple[int, int, float]]]:
    """프로세스 내에서 JSON 파싱 + 값 추출까지 완료. 결과는 [(x_abs, y_abs, value), ...]"""
    path_str, mode, item_key, bin_types = args
    try:
        data = _parse(Path(path_str).read_bytes())
    except Exception:
        return None

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
        xa, ya = chip.get("x_abs"), chip.get("y_abs")
        if xa is None or ya is None:
            continue

        if mode == "bin":
            b = chip.get("b")
            norm = str(b).strip() if b else "Normal"
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
