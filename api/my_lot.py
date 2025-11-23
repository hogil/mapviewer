"""Simple MY LOT storage helpers."""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Dict, List, Optional

MY_LOT_ROOT = Path(__file__).parent.parent / "logs" / "my-lot"
MY_LOT_ROOT.mkdir(parents=True, exist_ok=True)

_LOCK = RLock()
_SAFE_SEGMENT = re.compile(r"[^0-9A-Za-z_\-\.]+")


def _safe_login(login_id: Optional[str]) -> str:
    """LoginId를 안전한 파일명으로 변환. 없으면 'change' 반환."""
    raw = (login_id or "change").strip() or "change"
    safe = _SAFE_SEGMENT.sub("_", raw)
    return safe[:80] or "change"


def _user_dir(login_id: str) -> Path:
    """LoginId별 디렉토리 경로 반환."""
    safe = _safe_login(login_id)
    return MY_LOT_ROOT / safe


def _group_file(login_id: str, mode: str, group: str) -> Path:
    """Group별 파일 경로 반환: logs/my-lot/{LoginId}/{mode}/{group}.txt"""
    user_dir = _user_dir(login_id)
    mode_dir = user_dir / mode
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    return mode_dir / f"{safe_group}.txt"


def _normalize_mode(mode: str) -> str:
    mode = (mode or "lot").strip().lower()
    if mode not in {"lot", "wafer"}:
        return "lot"
    return mode


def _load_group_entries(login_id: str, mode: str, group: str) -> List[Dict[str, str]]:
    """Group 파일에서 엔트리 목록 로드."""
    file_path = _group_file(login_id, mode, group)
    if not file_path.exists():
        return []
    try:
        entries = []
        with file_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    # 수정: value 또는 filename, path 중 하나라도 있으면 유효한 데이터로 간주
                    if isinstance(entry, dict) and any(k in entry for k in ("value", "filename", "path")):
                        # 구버전 데이터 호환성 처리 (root가 없으면 value나 filename 사용)
                        if "root" not in entry:
                            val = entry.get("value") or entry.get("filename") or "Unknown"
                            entry["root"] = val
                        entries.append(entry)
                except json.JSONDecodeError:
                    continue
        return entries
    except Exception:
        return []


def _save_group_entries(login_id: str, mode: str, group: str, entries: List[Dict[str, str]]) -> None:
    """Group 파일에 엔트리 목록 저장."""
    file_path = _group_file(login_id, mode, group)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = file_path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    tmp.replace(file_path)


def _list_all_groups(login_id: str, mode: str) -> Dict[str, List[Dict[str, str]]]:
    """LoginId의 특정 mode에 있는 모든 group 목록 반환."""
    mode_dir = _user_dir(login_id) / mode
    if not mode_dir.exists():
        return {}
    
    groups = {}
    try:
        for file_path in mode_dir.glob("*.txt"):
            group_name = file_path.stem
            entries = _load_group_entries(login_id, mode, group_name)
            groups[group_name] = entries
    except Exception:
        pass
    return groups


def _convert_for_response(mode: str, groups: Dict[str, List[Dict[str, str]]]) -> Dict[str, object]:
    sorted_groups = []
    for name in sorted(groups.keys()):
        entries = groups.get(name) or []
        sorted_groups.append({"name": name, "entries": entries})
    return {"mode": mode, "groups": sorted_groups}


def list_my_lot(login_id: str) -> Dict[str, object]:
    login_segment = _safe_login(login_id)
    with _LOCK:
        lot_groups = _list_all_groups(login_segment, "lot")
        wafer_groups = _list_all_groups(login_segment, "wafer")
    return {
        "login_id": login_segment,
        "storage_path": str(_user_dir(login_segment)),
        "lot": _convert_for_response("lot", lot_groups),
        "wafer": _convert_for_response("wafer", wafer_groups),
    }


def create_group(login_id: str, mode: str, group: str) -> Dict[str, object]:
    if not group:
        raise ValueError("group 이름이 필요합니다.")
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", group.strip()) or "default"
    with _LOCK:
        file_path = _group_file(login_segment, mode, safe_group)
        if not file_path.exists():
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.touch()
    return {
        "login_id": login_segment,
        "mode": mode,
        "name": safe_group,
        "storage_path": str(_group_file(login_segment, mode, safe_group)),
    }


def _parse_filename(path: str) -> Dict[str, str]:
    """파일명을 _로 split하여 ROOT, STEP, WAFER 추출."""
    if not path:
        return {"root": "", "step": "", "wafer": "", "filename": ""}
    
    filename = Path(path).name
    filename_without_ext = Path(filename).stem
    
    parts = filename_without_ext.split("_")
    
    # 수정: 빈 리스트일 경우 안전하게 처리 및 root fallback
    root = parts[0] if len(parts) > 0 else filename_without_ext
    step = parts[1] if len(parts) > 1 else ""
    wafer = parts[2] if len(parts) > 2 else ""
    
    # root가 비어있으면 파일명 전체 사용
    if not root:
        root = filename_without_ext

    return {
        "root": root,
        "step": step,
        "wafer": wafer,
        "filename": filename,
    }


def add_entry(login_id: str, mode: str, group: str, value: str, path: str) -> Dict[str, object]:
    if not path:
        raise ValueError("path가 필요합니다.")
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    
    parsed = _parse_filename(path)
    
    entry = {
        "path": (path or "").strip(),
        "value": parsed["filename"],  # 수정: value 키 필수 추가 (삭제 로직 호환성)
        "filename": parsed["filename"],
        "root": parsed["root"],
        "step": parsed["step"],
        "wafer": parsed["wafer"],
        "saved_at": datetime.now().strftime("%y%m%d_%H%M%S"),
    }
    
    with _LOCK:
        entries = _load_group_entries(login_segment, mode, safe_group)
        # 중복 체크
        is_duplicate = False
        if mode == "lot":
            # LOT Tab: LOT 값(root)만 체크
            is_duplicate = any(item.get("root") == parsed["root"] for item in entries)
        else:
            # Wafer Tab: LOT + Wafer 조합 체크
            is_duplicate = any(
                item.get("root") == parsed["root"] and item.get("wafer") == parsed["wafer"]
                for item in entries
            )
        
        if not is_duplicate:
            entries.append(entry)
            _save_group_entries(login_segment, mode, safe_group, entries)
        else:
            raise ValueError(f"이미 등록된 항목입니다. (LOT Tab: LOT만, Wafer Tab: LOT+Wafer 조합)")
    return {
        "login_id": login_segment,
        "mode": mode,
        "group": safe_group,
        "entry": entry,
        "storage_path": str(_group_file(login_segment, mode, safe_group)),
    }


def remove_entry(login_id: str, mode: str, group: str, filename: str) -> bool:
    """파일명 기준으로 엔트리 삭제."""
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    removed = False
    with _LOCK:
        entries = _load_group_entries(login_segment, mode, safe_group)
        # value 또는 filename이 일치하면 삭제
        new_entries = [
            entry for entry in entries 
            if entry.get("filename") != filename and entry.get("value") != filename
        ]
        if len(new_entries) != len(entries):
            _save_group_entries(login_segment, mode, safe_group, new_entries)
            removed = True
    return removed


def delete_group(login_id: str, mode: str, group: str) -> bool:
    """그룹 파일 삭제."""
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    deleted = False
    with _LOCK:
        file_path = _group_file(login_segment, mode, safe_group)
        if file_path.exists():
            try:
                file_path.unlink()
                deleted = True
            except Exception:
                pass
    return deleted


__all__ = [
    "list_my_lot",
    "create_group",
    "delete_group",
    "add_entry",
    "remove_entry",
    "MY_LOT_ROOT",
]
