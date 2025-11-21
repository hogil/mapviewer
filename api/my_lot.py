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
    raw = (login_id or "change").strip() or "change"
    safe = _SAFE_SEGMENT.sub("_", raw)
    return safe[:80] or "change"


def _user_file(login_id: str) -> Path:
    safe = _safe_login(login_id)
    return MY_LOT_ROOT / f"{safe}.json"


def _normalize_mode(mode: str) -> str:
    mode = (mode or "lot").strip().lower()
    if mode not in {"lot", "wafer"}:
        return "lot"
    return mode


def _load_user_data(login_id: str) -> Dict[str, Dict[str, List[Dict[str, str]]]]:
    path = _user_file(login_id)
    if not path.exists():
        return {"lot": {}, "wafer": {}}
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {"lot": {}, "wafer": {}}
    return {
        "lot": data.get("lot", {}) or {},
        "wafer": data.get("wafer", {}) or {},
    }


def _save_user_data(login_id: str, data: Dict[str, Dict[str, List[Dict[str, str]]]]) -> None:
    path = _user_file(login_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


def _convert_for_response(mode: str, groups: Dict[str, List[Dict[str, str]]]) -> Dict[str, object]:
    sorted_groups = []
    for name in sorted(groups.keys()):
        entries = groups.get(name) or []
        sorted_groups.append({"name": name, "entries": entries})
    return {"mode": mode, "groups": sorted_groups}


def list_my_lot(login_id: str) -> Dict[str, object]:
    login_segment = _safe_login(login_id)
    with _LOCK:
        data = _load_user_data(login_segment)
    return {
        "login_id": login_segment,
        "storage_path": str(_user_file(login_segment)),
        "lot": _convert_for_response("lot", data["lot"]),
        "wafer": _convert_for_response("wafer", data["wafer"]),
    }


def create_group(login_id: str, mode: str, group: str) -> Dict[str, object]:
    if not group:
        raise ValueError("group 이름이 필요합니다.")
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", group.strip()) or "default"
    with _LOCK:
        data = _load_user_data(login_segment)
        group_map = data[mode]
        if safe_group not in group_map:
            group_map[safe_group] = []
            _save_user_data(login_segment, data)
    return {
        "login_id": login_segment,
        "mode": mode,
        "name": safe_group,
        "storage_path": str(_user_file(login_segment)),
    }


def add_entry(login_id: str, mode: str, group: str, value: str, path: str) -> Dict[str, object]:
    if not value:
        raise ValueError("value가 필요합니다.")
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    entry = {
        "value": value,
        "path": (path or "").strip(),
        "saved_at": datetime.now().strftime("%y%m%d_%H%M%S"),
    }
    with _LOCK:
        data = _load_user_data(login_segment)
        group_map = data[mode]
        entries = group_map.setdefault(safe_group, [])
        if not any(item.get("value") == value for item in entries):
            entries.append(entry)
            _save_user_data(login_segment, data)
    return {
        "login_id": login_segment,
        "mode": mode,
        "group": safe_group,
        "entry": entry,
        "storage_path": str(_user_file(login_segment)),
    }


def remove_entry(login_id: str, mode: str, group: str, value: str) -> bool:
    mode = _normalize_mode(mode)
    login_segment = _safe_login(login_id)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    removed = False
    with _LOCK:
        data = _load_user_data(login_segment)
        group_map = data[mode]
        if safe_group not in group_map:
            return False
        entries = group_map[safe_group]
        new_entries = [entry for entry in entries if entry.get("value") != value]
        if len(new_entries) != len(entries):
            group_map[safe_group] = new_entries
            removed = True
            _save_user_data(login_segment, data)
    return removed


__all__ = [
    "list_my_lot",
    "create_group",
    "add_entry",
    "remove_entry",
    "MY_LOT_ROOT",
]
