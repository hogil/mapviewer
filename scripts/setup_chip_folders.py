#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chip classification/annotation 관련 기본 폴더 생성 스크립트
단일 IMAGES_ROOT 트리 아래에서 필요한 파생 디렉터리를 모두 만든다.
"""

from pathlib import Path
import json
import sys

# Add parent directory to import path
sys.path.insert(0, str(Path(__file__).parent.parent))

from api.config import (  # pylint: disable=wrong-import-position
    IMAGES_ROOT,
    POSITIONS_ROOT,
    LABELS_DIR,
    CHIP_LABELS_DIR,
    CHIP_ANNOTATIONS_ROOT,
    CHIP_IMAGES_ROOT,
    LABELS_FILE,
    CHIP_LABELS_FILE,
)


def _ensure_dir(path: Path, description: str) -> None:
    if not path.exists():
        print(f"[CREATE] {description}: {path}")
        path.mkdir(parents=True, exist_ok=True)
    else:
        print(f"[OK] {description} exists: {path}")


def _ensure_labels_file(path: Path, description: str) -> None:
    if not path.exists():
        print(f"[CREATE] {description}: {path}")
        default_payload = {"classes": {}, "labels": {}}
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(default_payload, handle, ensure_ascii=False, indent=2)
    else:
        print(f"[OK] {description} exists: {path}")


def setup_folders() -> None:
    print("[INFO] Chip classification folder setup...")
    print(f"   IMAGES_ROOT          : {IMAGES_ROOT}")
    print(f"   POSITIONS_ROOT       : {POSITIONS_ROOT}")
    print(f"   LABELS_DIR           : {LABELS_DIR}")
    print(f"   CHIP_LABELS_DIR      : {CHIP_LABELS_DIR}")
    print(f"   CHIP_ANNOTATIONS_ROOT: {CHIP_ANNOTATIONS_ROOT}")
    print(f"   CHIP_IMAGES_ROOT     : {CHIP_IMAGES_ROOT}")
    print()

    _ensure_dir(IMAGES_ROOT, "IMAGES_ROOT")
    _ensure_dir(POSITIONS_ROOT, "POSITIONS_ROOT")
    _ensure_dir(LABELS_DIR, "Wafer classification dir")
    _ensure_dir(CHIP_LABELS_DIR, "Chip classification dir")
    _ensure_dir(CHIP_ANNOTATIONS_ROOT, "Chip annotations dir")
    _ensure_dir(CHIP_IMAGES_ROOT, "Chip images dir")

    _ensure_labels_file(LABELS_FILE, "labels.json")
    _ensure_labels_file(CHIP_LABELS_FILE, "chip labels.json")

    print()
    print("[SUCCESS] Folder structure created/verified!")
    print("Tree summary:")
    print(f"   {IMAGES_ROOT}/")
    print("      ├── classification/        # Wafer labels + labels.json")
    print("      ├── classification_chips/  # Chip labels + labels.json")
    print("      ├── chip_annotations/      # Chip annotation JSON files")
    print("      ├── chip_images/           # Extracted chip crops")
    print("      └── ...")
    print(f"   {POSITIONS_ROOT}/             # Chip position JSON")


if __name__ == "__main__":
    setup_folders()
