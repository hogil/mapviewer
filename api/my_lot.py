"""MY LOT storage - classification처럼 이미지를 폴더에 복사하여 관리."""
from __future__ import annotations

import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Dict, List, Optional

# config.py에서 IMAGES_ROOT 가져오기
try:
    from .config import IMAGES_ROOT, SUPPORTED_EXTS
except ImportError:
    # fallback
    IMAGES_ROOT = Path(__file__).parent.parent / "data"
    SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}

MY_LOT_ROOT = IMAGES_ROOT / "my-lot"
MY_LOT_ROOT.mkdir(parents=True, exist_ok=True)

_LOCK = RLock()
_SAFE_SEGMENT = re.compile(r"[^0-9A-Za-z_\-\.]+")


def _safe_login(login_id: Optional[str]) -> str:
    """LoginId를 안전한 파일명으로 변환. 없으면 'change' 반환."""
    raw = (login_id or "change").strip() or "change"
    safe = _SAFE_SEGMENT.sub("_", raw)
    return safe[:80] or "change"


def _user_dir(login_id: str) -> Path:
    """LoginId별 디렉토리 경로 반환: my-lot/{LoginId}/"""
    safe = _safe_login(login_id)
    return MY_LOT_ROOT / safe


def _normalize_mode(mode: str) -> str:
    """mode를 lot 또는 wafer로 정규화."""
    mode = (mode or "lot").strip().lower()
    if mode not in {"lot", "wafer"}:
        return "lot"
    return mode


def _group_dir(login_id: str, mode: str, group: str) -> Path:
    """Group 디렉토리 경로 반환: my-lot/{LoginId}/{mode}/{group}/"""
    user_dir = _user_dir(login_id)
    normalized_mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    return user_dir / normalized_mode / safe_group


def _parse_filename(path: str) -> Dict[str, str]:
    """파일명을 _로 split하여 ROOT(LOT), STEP, WAFER 추출."""
    if not path:
        return {"root": "", "step": "", "wafer": "", "filename": ""}

    filename = Path(path).name
    filename_without_ext = Path(filename).stem

    parts = filename_without_ext.split("_")

    root = parts[0] if len(parts) > 0 else filename_without_ext
    step = parts[1] if len(parts) > 1 else ""
    wafer = parts[2] if len(parts) > 2 else ""

    if not root:
        root = filename_without_ext

    return {
        "root": root,
        "step": step,
        "wafer": wafer,
        "filename": filename,
    }


def _load_group_entries(login_id: str, mode: str, group: str) -> List[Dict[str, str]]:
    """Group 디렉토리에서 이미지 파일 목록 로드."""
    group_dir = _group_dir(login_id, mode, group)
    if not group_dir.exists():
        return []

    entries = []
    try:
        if mode == "lot":
            # LOT 모드: LOT 폴더별로 하나의 entry 생성 (폴더 단위로 그룹화)
            for lot_folder in group_dir.iterdir():
                if not lot_folder.is_dir():
                    continue

                lot_name = lot_folder.name

                # LOT 폴더 내의 모든 이미지 파일 수집
                first_file = None
                file_count = 0
                latest_mtime = 0
                all_image_paths = []  # 🔥 LOT 폴더 내 모든 이미지 경로 저장

                for file_path in lot_folder.iterdir():
                    if not file_path.is_file():
                        continue
                    if file_path.suffix.lower() not in SUPPORTED_EXTS:
                        continue

                    file_count += 1
                    if first_file is None:
                        first_file = file_path

                    # 🔥 모든 이미지 파일의 상대 경로 수집
                    try:
                        rel_path_item = file_path.relative_to(IMAGES_ROOT).as_posix()
                        all_image_paths.append(rel_path_item)
                    except ValueError:
                        all_image_paths.append(file_path.as_posix())

                    # 최신 파일 시간 찾기
                    try:
                        mtime = file_path.stat().st_mtime
                        if mtime > latest_mtime:
                            latest_mtime = mtime
                    except Exception:
                        pass

                # 이미지 파일이 없으면 skip
                if first_file is None or file_count == 0:
                    continue

                # 대표 이미지 경로
                try:
                    rel_path = first_file.relative_to(IMAGES_ROOT).as_posix()
                except ValueError:
                    rel_path = first_file.as_posix()

                # 최신 파일 시간을 saved_at으로 사용
                if latest_mtime > 0:
                    saved_at = datetime.fromtimestamp(latest_mtime).strftime("%y%m%d_%H%M%S")
                else:
                    saved_at = datetime.now().strftime("%y%m%d_%H%M%S")

                # LOT 폴더를 하나의 entry로 표현
                entry = {
                    "path": rel_path,  # 대표 이미지 경로
                    "value": lot_name,  # LOT 이름
                    "filename": lot_name,  # LOT 이름
                    "root": lot_name,
                    "step": "",
                    "wafer": "",
                    "saved_at": saved_at,
                    "file_count": file_count,  # LOT 내 이미지 개수
                    "all_paths": all_image_paths,  # 🔥 LOT 폴더 내 모든 이미지 경로 리스트
                }
                entries.append(entry)
        else:
            # Wafer 모드: 직접 파일들 스캔
            for file_path in group_dir.iterdir():
                if not file_path.is_file():
                    continue
                if file_path.suffix.lower() not in SUPPORTED_EXTS:
                    continue

                # 파일명에서 정보 추출
                parsed = _parse_filename(file_path.name)

                # 상대 경로 생성 (IMAGES_ROOT 기준)
                try:
                    rel_path = file_path.relative_to(IMAGES_ROOT).as_posix()
                except ValueError:
                    rel_path = file_path.as_posix()

                # 파일 생성 시간 (saved_at)
                try:
                    mtime = file_path.stat().st_mtime
                    saved_at = datetime.fromtimestamp(mtime).strftime("%y%m%d_%H%M%S")
                except Exception:
                    saved_at = datetime.now().strftime("%y%m%d_%H%M%S")

                entry = {
                    "path": rel_path,
                    "value": parsed["filename"],
                    "filename": parsed["filename"],
                    "root": parsed["root"],
                    "step": parsed["step"],
                    "wafer": parsed["wafer"],
                    "saved_at": saved_at,
                }
                entries.append(entry)
    except Exception:
        pass

    # 파일명 기준 정렬
    entries.sort(key=lambda e: e.get("filename", ""))
    return entries


def _list_all_groups(login_id: str, mode: str) -> Dict[str, List[Dict[str, str]]]:
    """LoginId의 특정 mode에 있는 모든 group 목록 반환."""
    user_dir = _user_dir(login_id)
    mode_dir = user_dir / _normalize_mode(mode)
    if not mode_dir.exists():
        return {}

    groups = {}
    try:
        for group_path in mode_dir.iterdir():
            if not group_path.is_dir():
                continue
            group_name = group_path.name
            entries = _load_group_entries(login_id, mode, group_name)
            groups[group_name] = entries
    except Exception:
        pass
    return groups


def _convert_for_response(mode: str, groups: Dict[str, List[Dict[str, str]]]) -> Dict[str, object]:
    """그룹 데이터를 응답 형식으로 변환."""
    sorted_groups = []
    for name in sorted(groups.keys()):
        entries = groups.get(name) or []
        sorted_groups.append({"name": name, "entries": entries})
    return {"mode": mode, "groups": sorted_groups}


def list_my_lot(login_id: str) -> Dict[str, object]:
    """모든 그룹과 항목 목록 반환 (lot과 wafer 분리)."""
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
    """새 그룹 디렉토리 생성."""
    if not group:
        raise ValueError("group 이름이 필요합니다.")
    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", group.strip()) or "default"
    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)
        group_dir.mkdir(parents=True, exist_ok=True)
    return {
        "login_id": login_segment,
        "mode": mode,
        "name": safe_group,
        "storage_path": str(group_dir),
    }


def add_entry(login_id: str, mode: str, group: str, src_path: Path) -> Dict[str, object]:
    """이미지를 그룹 디렉토리에 복사/하드링크."""
    if not src_path or not src_path.exists():
        raise ValueError("유효한 이미지 경로가 필요합니다.")

    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"

    parsed = _parse_filename(src_path.name)

    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)
        group_dir.mkdir(parents=True, exist_ok=True)

        # 🔥 기존 항목 로드하여 중복 체크 제거 (파일 존재 여부로만 체크)
        # LOT 모드는 같은 LOT에 여러 wafer 이미지가 추가될 수 있어야 함

        # 대상 파일 경로: LOT 모드는 LOT별 폴더, Wafer 모드는 직접 저장
        if mode == "lot":
            # LOT 모드: my-lot/{LoginId}/lot/{group}/{LOT값}/파일명
            lot_folder = group_dir / parsed["root"]
            lot_folder.mkdir(parents=True, exist_ok=True)
            target_file = lot_folder / src_path.name
        else:
            # Wafer 모드: my-lot/{LoginId}/wafer/{group}/파일명
            target_file = group_dir / src_path.name

        # 🔥 파일이 이미 존재하면 에러 (중복 방지)
        if target_file.exists():
            raise ValueError(f"이미 등록된 파일입니다: {src_path.name}")

        # 하드링크 시도, 실패 시 복사 (classification과 동일)
        try:
            # 같은 드라이브인지 확인
            src_dev = src_path.stat().st_dev
            if mode == "lot":
                dst_dev = lot_folder.stat().st_dev
            else:
                dst_dev = group_dir.stat().st_dev
            if src_dev == dst_dev:
                # 하드링크 생성
                os.link(str(src_path.resolve()), str(target_file))
            else:
                # 다른 드라이브: 복사
                shutil.copy2(str(src_path), str(target_file))
        except (OSError, AttributeError):
            # 하드링크 실패 시 복사
            shutil.copy2(str(src_path), str(target_file))

        # 파일 타임스탬프를 현재 시간으로 업데이트 (등록 시간 기록)
        try:
            import time
            now = time.time()
            os.utime(str(target_file), (now, now))
        except Exception:
            pass  # 타임스탬프 업데이트 실패해도 진행

        # 상대 경로 생성
        try:
            rel_path = target_file.relative_to(IMAGES_ROOT).as_posix()
        except ValueError:
            rel_path = target_file.as_posix()

        entry = {
            "path": rel_path,
            "value": parsed["filename"],
            "filename": parsed["filename"],
            "root": parsed["root"],
            "step": parsed["step"],
            "wafer": parsed["wafer"],
            "saved_at": datetime.now().strftime("%y%m%d_%H%M%S"),
        }

    return {
        "login_id": login_segment,
        "mode": mode,
        "group": safe_group,
        "entry": entry,
        "storage_path": str(group_dir),
    }


def remove_entry(login_id: str, mode: str, group: str, filename: str) -> bool:
    """파일명 기준으로 이미지 삭제. LOT 모드에서는 filename이 LOT 이름이므로 폴더 전체 삭제."""
    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    removed = False
    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)

        if mode == "lot":
            # 🔥 LOT 모드: filename이 LOT 이름이므로 LOT 폴더 전체 삭제
            if group_dir.exists():
                lot_folder = group_dir / filename
                if lot_folder.exists() and lot_folder.is_dir():
                    try:
                        shutil.rmtree(str(lot_folder))
                        removed = True
                    except Exception:
                        pass
        else:
            # Wafer 모드: 직접 파일 찾기
            target_file = group_dir / filename
            if target_file.exists() and target_file.is_file():
                try:
                    target_file.unlink()
                    removed = True
                except Exception:
                    pass
    return removed


def remove_entries_batch(login_id: str, mode: str, group: str, filenames: List[str]) -> Dict[str, object]:
    """
    여러 파일을 일괄 삭제. LOT 모드에서는 filename이 LOT 이름이므로 폴더 전체 삭제.

    Returns:
        {
            "success_count": int,
            "error_count": int,
            "errors": [{\"filename\": str, \"reason\": str}, ...]
        }
    """
    if not filenames:
        return {
            "success_count": 0,
            "error_count": 0,
            "errors": [],
        }

    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"

    success_count = 0
    error_count = 0
    errors = []

    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)

        for filename in filenames:
            try:
                found = False
                if mode == "lot":
                    # 🔥 LOT 모드: filename이 LOT 이름이므로 LOT 폴더 전체 삭제
                    if group_dir.exists():
                        lot_folder = group_dir / filename
                        if lot_folder.exists() and lot_folder.is_dir():
                            shutil.rmtree(str(lot_folder))
                            success_count += 1
                            found = True
                else:
                    # Wafer 모드: 직접 파일 찾기
                    target_file = group_dir / filename
                    if target_file.exists() and target_file.is_file():
                        target_file.unlink()
                        success_count += 1
                        found = True

                if not found:
                    error_count += 1
                    errors.append({"filename": filename, "reason": "파일을 찾을 수 없습니다"})
            except Exception as exc:
                error_count += 1
                errors.append({"filename": filename, "reason": str(exc)})

    return {
        "success_count": success_count,
        "error_count": error_count,
        "errors": errors,
        "login_id": login_segment,
        "mode": mode,
        "group": safe_group,
    }


def delete_group(login_id: str, mode: str, group: str) -> bool:
    """그룹 디렉토리 삭제 (내부 파일 포함)."""
    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    deleted = False
    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)
        if group_dir.exists() and group_dir.is_dir():
            try:
                shutil.rmtree(str(group_dir))
                deleted = True
            except Exception:
                pass
    return deleted


def add_lot_batch(login_id: str, mode: str, group: str, image_paths: List[Path]) -> Dict[str, object]:
    """
    여러 이미지를 그룹에 일괄 추가.

    Returns:
        {
            "success_count": int,
            "duplicate_count": int,
            "error_count": int,
            "errors": [{"path": str, "reason": str}, ...]
        }
    """
    if not image_paths:
        return {
            "success_count": 0,
            "duplicate_count": 0,
            "error_count": 0,
            "errors": [],
        }

    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"

    success_count = 0
    duplicate_count = 0
    error_count = 0
    errors = []

    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)
        group_dir.mkdir(parents=True, exist_ok=True)

        # 기존 항목 로드하여 중복 체크용 Set 생성
        existing_entries = _load_group_entries(login_segment, mode, safe_group)
        existing_keys = set()
        existing_files = set()  # 🔥 파일명 기준 중복 체크 (업데이트 시 타임스탬프 유지용)

        # 🔥 LOT Tab: LOT 값만으로 중복 체크, Wafer Tab: LOT + Wafer 조합
        for entry in existing_entries:
            root = entry.get("root")
            wafer = entry.get("wafer")
            
            if mode == "lot":
                # LOT 모드: root(LOT) 값만으로 중복 체크
                if root:
                    existing_keys.add(root)
            else:
                # Wafer 모드: root + wafer 조합으로 중복 체크
                key = f"{root}_{wafer}"
                if key:
                    existing_keys.add(key)
            
            # 파일명도 별도로 저장 (기존 파일 타임스탬프 유지용)
            filename = entry.get("filename")
            if filename:
                existing_files.add(filename)

        # 드라이브 체크는 한 번만 수행 (성능 최적화)
        try:
            dst_dev = group_dir.stat().st_dev
        except Exception:
            dst_dev = None

        for src_path in image_paths:
            try:
                if not src_path.exists() or not src_path.is_file():
                    error_count += 1
                    errors.append({"path": str(src_path), "reason": "파일을 찾을 수 없습니다"})
                    continue

                # 파일명 파싱
                parsed = _parse_filename(src_path.name)

                # 🔥 mode에 따라 중복 체크
                if mode == "lot":
                    # LOT 모드: root(LOT) 값만으로 중복 체크
                    key = parsed['root']
                else:
                    # Wafer 모드: root + wafer 조합으로 중복 체크
                    key = f"{parsed['root']}_{parsed['wafer']}"
                
                is_duplicate = key in existing_keys

                if is_duplicate:
                    duplicate_count += 1
                    continue

                # 대상 파일 경로: LOT 모드는 LOT별 폴더, Wafer 모드는 직접 저장
                if mode == "lot":
                    # LOT 모드: my-lot/{LoginId}/lot/{group}/{LOT값}/파일명
                    lot_folder = group_dir / parsed["root"]
                    lot_folder.mkdir(parents=True, exist_ok=True)
                    target_file = lot_folder / src_path.name
                    # 드라이브 체크
                    try:
                        lot_dst_dev = lot_folder.stat().st_dev
                    except Exception:
                        lot_dst_dev = None
                else:
                    # Wafer 모드: my-lot/{LoginId}/wafer/{group}/파일명
                    target_file = group_dir / src_path.name
                    lot_dst_dev = dst_dev

                # 🔥 파일이 이미 존재하면 skip (등록 일시 유지)
                if target_file.exists():
                    duplicate_count += 1
                    continue

                # 하드링크 시도, 실패 시 복사
                try:
                    if lot_dst_dev is not None:
                        src_dev = src_path.stat().st_dev
                        if src_dev == lot_dst_dev:
                            os.link(str(src_path.resolve()), str(target_file))
                        else:
                            shutil.copy2(str(src_path), str(target_file))
                    else:
                        shutil.copy2(str(src_path), str(target_file))
                except (OSError, AttributeError):
                    shutil.copy2(str(src_path), str(target_file))

                # 🔥 파일 타임스탬프를 현재 시간으로 업데이트 (최초 등록 시만)
                try:
                    import time
                    now = time.time()
                    os.utime(str(target_file), (now, now))
                except Exception:
                    pass  # 타임스탬프 업데이트 실패해도 진행

                success_count += 1

                # 🔥 성공한 항목을 existing_keys에 추가 (같은 배치 내 중복 방지)
                if mode == "lot":
                    existing_keys.add(parsed['root'])
                else:
                    key = f"{parsed['root']}_{parsed['wafer']}"
                    existing_keys.add(key)

            except Exception as exc:
                error_count += 1
                errors.append({"path": str(src_path), "reason": str(exc)})

    return {
        "success_count": success_count,
        "duplicate_count": duplicate_count,
        "error_count": error_count,
        "errors": errors,
        "login_id": login_segment,
        "mode": mode,
        "group": safe_group,
        "storage_path": str(group_dir),
    }


__all__ = [
    "list_my_lot",
    "create_group",
    "delete_group",
    "add_entry",
    "add_lot_batch",
    "remove_entry",
    "remove_entries_batch",
    "MY_LOT_ROOT",
]
