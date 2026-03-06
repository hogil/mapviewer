"""MY LOT storage - classification처럼 이미지를 폴더에 복사하여 관리."""
from __future__ import annotations

import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Dict, List, Optional

# config.py에서 IMAGES_ROOT 및 POSITIONS_ROOT 가져오기
try:
    from .config import IMAGES_ROOT, POSITIONS_ROOT, SUPPORTED_EXTS
except ImportError:
    # fallback
    IMAGES_ROOT = Path(__file__).parent.parent / "data"
    POSITIONS_ROOT = Path(__file__).parent.parent / "positions"
    SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}

MY_LOT_ROOT = IMAGES_ROOT / "my-lot"
MY_LOT_ROOT.mkdir(parents=True, exist_ok=True)
PLACEHOLDER_DIR = MY_LOT_ROOT / "_placeholders"
PLACEHOLDER_DIR.mkdir(parents=True, exist_ok=True)

_LOCK = RLock()
_SAFE_SEGMENT = re.compile(r"[^0-9A-Za-z_\-\.]+")


def _safe_login(login_id: Optional[str]) -> str:
    """LoginId를 안전한 파일명으로 변환. 없으면 'change' 반환."""
    raw = (login_id or "change").strip() or "change"
    safe = _SAFE_SEGMENT.sub("_", raw)
    return safe[:80] or "change"


def create_placeholder_image(mode: str, lot_value: str, wafer_value: str = "") -> Optional[Path]:
    """
    실제 이미지가 없을 때 LOT/Wafer 정보를 담은 플레이스홀더 PNG 생성.
    사용자 요청으로 플레이스홀더 생성 기능 비활성화 (항상 None 반환).
    """
    return None

    # 기존 로직 주석 처리 (비활성화)
    # lot_value = (lot_value or "").strip()
    # wafer_value = (wafer_value or "").strip()
    # if not lot_value:
    #     return None
    # ...



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


def _find_position_file(image_rel_path: str) -> Optional[Path]:
    """
    이미지의 positions.json 파일 찾기 (composite_map.py의 로직과 동일)

    Args:
        image_rel_path: IMAGES_ROOT 기준 이미지 상대 경로 (예: "wm-811k/1.png")

    Returns:
        positions.json 경로, 없으면 None
    """
    try:
        image_path = Path(image_rel_path)
        image_stem = image_path.stem
        image_parent = image_path.parent

        # positions.json 후보 경로들
        candidate_paths = []

        # 우선순위 1: trimmed 경로 (첫 번째 경로 구성요소 제거)
        parent_parts = [p for p in image_parent.parts if p not in ("", ".")]

        if len(parent_parts) > 1:
            trimmed_parts = parent_parts[1:]
            candidate_paths.append(POSITIONS_ROOT.joinpath(*trimmed_parts) / f"{image_stem}.json")
        elif parent_parts:
            candidate_paths.append(POSITIONS_ROOT / f"{image_stem}.json")

        # 우선순위 2: 레거시 경로
        legacy_path = POSITIONS_ROOT / image_parent / f"{image_stem}.json"
        if legacy_path not in candidate_paths:
            candidate_paths.append(legacy_path)

        # 존재하는 파일 찾기
        for candidate in candidate_paths:
            if candidate.exists():
                return candidate

        return None
    except Exception:
        return None


def _copy_position_file(src_image_path: Path, dst_image_path: Path) -> None:
    """
    소스 이미지의 position 파일을 대상 이미지 위치로 복사

    Args:
        src_image_path: 원본 이미지 절대 경로
        dst_image_path: 대상 이미지 절대 경로
    """
    import json

    try:
        # 소스 이미지의 상대 경로 (IMAGES_ROOT 기준)
        try:
            src_rel_path = src_image_path.relative_to(IMAGES_ROOT).as_posix()
        except ValueError:
            return  # IMAGES_ROOT 하위가 아니면 스킵

        # 소스 position 파일 찾기
        src_positions_file = _find_position_file(src_rel_path)
        if not src_positions_file:
            return  # position 파일 없으면 스킵

        # 대상 위치 계산: POSITIONS_ROOT 하위에 이미지와 동일한 구조로 저장
        # 예: my-lot/user/lot/group/LOT/image.png → positions/my-lot/user/lot/group/LOT/image.json
        try:
            dst_rel_path = dst_image_path.relative_to(IMAGES_ROOT)
            dst_positions_file = POSITIONS_ROOT / dst_rel_path.parent / f"{dst_image_path.stem}.json"
        except ValueError:
            return

        # 대상 디렉토리 생성
        dst_positions_file.parent.mkdir(parents=True, exist_ok=True)

        # position 파일 로드 및 image_path 업데이트
        with open(src_positions_file, 'r', encoding='utf-8') as f:
            positions_data = json.load(f)

        # image_path를 새로운 경로로 업데이트
        positions_data['image_path'] = dst_rel_path.as_posix()

        # position 파일 저장
        with open(dst_positions_file, 'w', encoding='utf-8') as f:
            json.dump(positions_data, f, ensure_ascii=False, indent=2)

    except Exception:
        pass  # position 복사 실패해도 이미지 복사는 진행


def _parse_filename(path: str) -> Dict[str, str]:
    """파일명을 _로 split하여 ROOT(LOT), STEP, WAFER 추출."""
    if not path:
        return {"root": "", "step": "", "wafer": "", "filename": ""}

    filename = Path(path).name
    filename_without_ext = Path(filename).stem

    parts = filename_without_ext.split("_")

    root = parts[0] if len(parts) > 0 else filename_without_ext
    step = parts[1] if len(parts) > 1 else ""

    # 🔥 Wafer 추출 개선: parts[2] 우선, 없으면 W로 시작하는 부분 찾기
    wafer = ""
    if len(parts) > 2:
        wafer = parts[2]
    elif len(parts) > 1:
        # parts[2]가 없으면 W로 시작하는 부분을 역순으로 찾기 (예: ABC123_W01 → W01)
        for part in reversed(parts):
            if part and (part[0] == 'W' or part[0] == 'w'):
                wafer = part
                break

    if not root:
        root = filename_without_ext

    return {
        "root": root,
        "step": step,
        "wafer": wafer,
        "filename": filename,
    }


def _lot_folder_candidates(value: str) -> List[str]:
    """LOT 모드 삭제 시 입력값(value/path/filename)에서 LOT 폴더 후보를 생성."""
    raw = (value or "").strip()
    if not raw:
        return []

    normalized = raw.replace("\\", "/")
    basename = Path(normalized).name
    stem = Path(basename).stem

    candidates = [raw, basename, stem]
    # 파일명 규칙: LOT_STEP_WAFER_... 에서 LOT는 첫 토큰
    if stem:
        candidates.append(stem.split("_", 1)[0])

    result: List[str] = []
    seen = set()
    for c in candidates:
        token = (c or "").strip()
        if not token or token in seen:
            continue
        seen.add(token)
        result.append(token)
    return result


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

                # 이미지 파일이 없어도 LOT 폴더가 있으면 entry 생성 (이미지 없음 처리)
                if first_file is None or file_count == 0:
                    entry = {
                        "path": "",  # 이미지 없음
                        "value": lot_name,
                        "filename": lot_name,
                        "root": lot_name,
                        "step": "",
                        "wafer": "",
                        "saved_at": datetime.now().strftime("%y%m%d_%H%M%S"),  # 생성 시간 추적 어려움 -> 현재 시간
                        "file_count": 0,
                        "all_paths": [],
                    }
                    entries.append(entry)
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
            raise ValueError(f"이미 등록된 항목입니다: {src_path.name}")

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

        # 🔥 position 파일 복사
        _copy_position_file(src_path, target_file)

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
            # LOT 모드: value/path/filename 어떤 형태가 와도 LOT 폴더를 찾도록 보강
            if group_dir.exists():
                for lot_name in _lot_folder_candidates(filename):
                    lot_folder = group_dir / lot_name
                    if lot_folder.exists() and lot_folder.is_dir():
                        try:
                            shutil.rmtree(str(lot_folder))
                            removed = True
                            break
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
                    # LOT 모드: value/path/filename 어떤 형태가 와도 LOT 폴더를 찾도록 보강
                    if group_dir.exists():
                        for lot_name in _lot_folder_candidates(filename):
                            lot_folder = group_dir / lot_name
                            if lot_folder.exists() and lot_folder.is_dir():
                                shutil.rmtree(str(lot_folder))
                                success_count += 1
                                found = True
                                break
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


def create_manual_entry(login_id: str, mode: str, group: str, lot: str, wafer: str = "") -> Dict[str, object]:
    """
    이미지 없이 수동으로 항목(LOT 폴더 등) 생성.
    LOT 모드: LOT 이름의 폴더만 생성.
    """
    if not lot:
        raise ValueError("LOT 이름이 필요합니다.")
        
    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_group = _SAFE_SEGMENT.sub("_", (group or "").strip()) or "default"
    
    # LOT 이름 안전하게 변환
    safe_lot = _SAFE_SEGMENT.sub("_", lot.strip())
    
    with _LOCK:
        group_dir = _group_dir(login_segment, mode, safe_group)
        group_dir.mkdir(parents=True, exist_ok=True)
        
        entry = {}
        
        if mode == "lot":
            # LOT 모드: 폴더만 생성
            lot_folder = group_dir / safe_lot
            if not lot_folder.exists():
                lot_folder.mkdir(parents=True, exist_ok=True)
                
            entry = {
                "path": "",  # 이미지 없음
                "value": safe_lot,
                "filename": safe_lot,
                "root": safe_lot,
                "step": "",
                "wafer": "",
                "saved_at": datetime.now().strftime("%y%m%d_%H%M%S"),
                "file_count": 0,
                "all_paths": [],
            }
        else:
            # Wafer 모드: 이미지 없이 항목 생성이 파일 기반이라 어려움.
            # 0바이트 파일 생성 (확장자 없이)
            # wafer_value가 없으면 LOT 이름만으로 파일 생성
            filename = f"{safe_lot}"
            if wafer:
                safe_wafer = _SAFE_SEGMENT.sub("_", wafer.strip())
                filename = f"{safe_lot}_{safe_wafer}"
            
            # .noimg 확장자로 생성하여 이미지 아님을 표시 (SUPPORTED_EXTS에 없으므로 로드 시 무시될 수 있음 -> 로직 수정 필요할수도)
            # 하지만 _load_group_entries는 SUPPORTED_EXTS만 읽는다.
            # 따라서 .png로 만들되 1x1 투명 픽셀로 만드는게 낫다 (기존 placeholder 로직 재활용?)
            # 아니면 사용자가 '이미지 연결하지 말고'라고 했으므로,
            # 로딩 로직을 수정해서 .json 같은 메타데이터 파일을 읽게 하거나 해야 하는데 복잡도가 높음.
            # 일단 LOT 모드 위주 대응: Wafer 모드는 지원 제한.
            raise ValueError("Wafer 모드에서 이미지 없는 항목 생성은 지원되지 않습니다.")

    return {
        "login_id": login_segment,
        "mode": mode,
        "group": safe_group,
        "entry": entry,
        "storage_path": str(group_dir),
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


def rename_group(login_id: str, mode: str, old_name: str, new_name: str) -> bool:
    """그룹 디렉토리 이름 변경."""
    login_segment = _safe_login(login_id)
    mode = _normalize_mode(mode)
    safe_old = _SAFE_SEGMENT.sub("_", (old_name or "").strip()) or "default"
    safe_new = _SAFE_SEGMENT.sub("_", (new_name or "").strip()) or "default"
    
    if safe_old == safe_new:
        return True
    
    renamed = False
    with _LOCK:
        old_dir = _group_dir(login_segment, mode, safe_old)
        new_dir = _group_dir(login_segment, mode, safe_new)
        
        if not old_dir.exists() or not old_dir.is_dir():
            return False
        
        if new_dir.exists():
            return False  # 새 이름이 이미 존재
        
        try:
            old_dir.rename(new_dir)
            renamed = True
        except Exception:
            pass
    
    return renamed


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

        # 🔥 기존 wafer 조합(LOT+Wafer) 추적: 동일 wafer를 다른 파일명으로 중복 추가하는 것 방지
        existing_wafer_keys = set()
        if mode == "wafer":
            for entry in _load_group_entries(login_segment, mode, safe_group):
                key = f"{entry.get('root')}_{entry.get('wafer')}"
                if key and key != "_":
                    existing_wafer_keys.add(key)

        # 같은 배치 내 중복 방지를 위한 파일/wafer 추적 Set
        processed_files = set()
        processed_wafer_keys = set()

        # 드라이브 체크는 한 번만 수행 (성능 최적화)
        try:
            dst_dev = group_dir.stat().st_dev
        except Exception:
            dst_dev = None

        for src_path in image_paths:
            try:
                # 🔥 _NO_IMAGE_ 마커 처리
                path_str = str(src_path)
                is_no_image = '_NO_IMAGE_' in path_str
                
                if not is_no_image and (not src_path.exists() or not src_path.is_file()):
                    error_count += 1
                    errors.append({"path": str(src_path), "reason": "파일을 찾을 수 없습니다"})
                    continue

                # 파일명 파싱
                if is_no_image:
                    # 마커 형식: _NO_IMAGE_:LOT[:WAFER]
                    parts = path_str.split(':')
                    lot_val = parts[1] if len(parts) > 1 else "Unknown"
                    wafer_val = parts[2] if len(parts) > 2 else ""
                    # 가짜 파일명 생성
                    filename = f"{lot_val}.png"
                    if wafer_val:
                        filename = f"{lot_val}_{wafer_val}.png"
                    parsed = {
                        "root": lot_val,
                        "step": "",
                        "wafer": wafer_val,
                        "filename": filename
                    }
                else:
                    parsed = _parse_filename(src_path.name)
                
                wafer_key = None

                # 대상 파일 경로: LOT 모드는 LOT별 폴더, Wafer 모드는 직접 저장
                if mode == "lot":
                    # LOT 모드: my-lot/{LoginId}/lot/{group}/{LOT값}/파일명
                    lot_folder = group_dir / parsed["root"]
                    lot_folder.mkdir(parents=True, exist_ok=True)
                    target_file = lot_folder / parsed["filename"]
                    # 드라이브 체크
                    try:
                        if not is_no_image:
                            lot_dst_dev = lot_folder.stat().st_dev
                        else:
                            lot_dst_dev = None
                    except Exception:
                        lot_dst_dev = None
                else:
                    # Wafer 모드: my-lot/{LoginId}/wafer/{group}/파일명
                    target_file = group_dir / parsed["filename"]
                    lot_dst_dev = dst_dev
                    wafer_key = f"{parsed['root']}_{parsed['wafer']}"
                    if wafer_key and wafer_key in existing_wafer_keys:
                        duplicate_count += 1
                        continue
                    if wafer_key and wafer_key in processed_wafer_keys:
                        duplicate_count += 1
                        continue

                # 🔥 중복 체크: 파일명 기준 (같은 배치 내 중복 방지)
                file_key = target_file.as_posix()
                if file_key in processed_files:
                    duplicate_count += 1
                    continue

                # 🔥 파일이 이미 존재하면 skip (등록 일시 유지)
                if target_file.exists():
                    duplicate_count += 1
                    processed_files.add(file_key)  # 배치 내 중복 방지
                    continue

                # 하드링크 시도, 실패 시 복사
                try:
                    # 이미지 없는 경우 (특수 마커) -> 1x1 투명 PNG 생성
                    if str(src_path).startswith('_NO_IMAGE_'):
                        # src_path는 "_NO_IMAGE_:LOT" 또는 "_NO_IMAGE_:LOT:WAFER" 형태가 됨
                        # 하지만 add_lot_batch 호출 전에 이미 필터링되거나,
                        # 여기서는 src_path가 Path 객체이므로 exist() 체크에서 걸러졌을 것임.
                        # 따라서 이 블록에 도달하려면 src_path가 실제 파일이어야 함.
                        # 하지만 handleManualSubmit에서 _NO_IMAGE_... 문자열을 보냈다면,
                        # FastAPI/Pydantic 모델이나 요청 처리에서 문자열 리스트로 받을 것임.
                        # add_lot_batch의 image_paths 인자는 List[Path] 타입 힌트가 있지만,
                        # 실제로는 문자열 리스트가 넘어올 수도 있음 (FastAPI가 자동 변환하거나 직접 호출 시).
                        # 하지만 main.py에서 어떻게 호출하는지 확인 필요.
                        pass
                    
                    if lot_dst_dev is not None:
                        src_dev = src_path.stat().st_dev
                        if src_dev == lot_dst_dev:
                            os.link(str(src_path.resolve()), str(target_file))
                        else:
                            shutil.copy2(str(src_path), str(target_file))
                    else:
                        shutil.copy2(str(src_path), str(target_file))
                except (OSError, AttributeError):
                    # 파일이 없거나(OSError) 복사 실패 시
                    # 특수 마커(_NO_IMAGE_) 확인
                    path_str = str(src_path)
                    if '_NO_IMAGE_' in path_str:
                        # 1x1 투명 PNG 생성
                        try:
                            # 타겟 파일명은 이미 위에서 결정됨 (parsed['root'] 등 사용)
                            # 하지만 src_path.name이 이상할 수 있음.
                            # _parse_filename이 마커 문자열을 어떻게 처리했는지에 따라 다름.
                            
                            # 1x1 투명 PNG 데이터
                            empty_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
                            target_file.write_bytes(empty_png)
                        except Exception:
                            pass
                    else:
                        try:
                            shutil.copy2(str(src_path), str(target_file))
                        except Exception:
                            # 복사 실패 시 0바이트 파일 생성 (최후의 수단)
                            # 사용자가 "이미지 없이 리스트만 저장"을 원함
                            target_file.touch()

                # 🔥 파일 타임스탬프를 현재 시간으로 업데이트 (최초 등록 시만)
                try:
                    import time
                    now = time.time()
                    os.utime(str(target_file), (now, now))
                except Exception:
                    pass  # 타임스탬프 업데이트 실패해도 진행

                # 🔥 position 파일 복사 (실제 이미지 파일인 경우에만)
                if not is_no_image:
                    _copy_position_file(src_path, target_file)

                success_count += 1
                processed_files.add(file_key)  # 성공한 파일 추적
                if wafer_key:
                    existing_wafer_keys.add(wafer_key)
                    processed_wafer_keys.add(wafer_key)

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
    "create_placeholder_image",
    "create_manual_entry",
    "MY_LOT_ROOT",
]
