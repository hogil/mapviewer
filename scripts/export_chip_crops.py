#!/usr/bin/env python3
"""
칩 포지션/라벨 JSON 기반으로 chip crop PNG를 생성합니다.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, List, Optional

from PIL import Image


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fp:
        return json.load(fp)


def resolve_paths(images_root: Path, positions_root: Path, annotations_root: Path, crops_root: Path) -> Dict[str, Path]:
    return {
        "images": images_root.resolve(),
        "positions": positions_root.resolve(),
        "annotations": annotations_root.resolve(),
        "crops": crops_root.resolve(),
    }


def infer_paths(image_rel: str, paths: Dict[str, Path]) -> Dict[str, Path]:
    image_path = (paths["images"] / image_rel).resolve()
    subparts = Path(image_rel).with_suffix("")
    annotations_dir = paths["annotations"] / subparts.parent
    positions_dir = paths["positions"] / subparts.parent
    crops_dir = paths["crops"] / subparts
    base_name = subparts.name
    return {
        "image": image_path,
        "positions": (positions_dir / f"{base_name}.json").resolve(),
        "annotations": (annotations_dir / f"{base_name}_chips.json").resolve(),
        "crops_dir": crops_dir.resolve(),
    }


def select_candidates(chips: List[dict], annotations: List[dict], chip_ids: Optional[List[str]], include_unlabeled: bool) -> List[dict]:
    chip_map = {chip.get("chip_id"): chip for chip in chips if chip.get("chip_id")}
    annotated = {ann["chip_id"]: ann for ann in annotations if ann.get("chip_id")}

    def combine(chip_id: str) -> Optional[dict]:
        chip = chip_map.get(chip_id)
        if not chip or not chip.get("rect"):
            return None
        merged = dict(chip)
        if chip_id in annotated:
            merged.update({k: v for k, v in annotated[chip_id].items() if k not in {"history"}})
        return merged

    results = []
    if chip_ids:
        for chip_id in chip_ids:
            entry = combine(chip_id)
            if entry:
                results.append(entry)
        return results

    labeled = [combine(cid) for cid in annotated.keys()]
    labeled = [entry for entry in labeled if entry]
    results.extend(labeled)
    if include_unlabeled or not labeled:
        for chip_id, chip in chip_map.items():
            if chip_id in annotated:
                continue
            entry = combine(chip_id)
            if entry:
                entry.setdefault("class", "unlabeled")
                results.append(entry)
    return results


def export_crops(image_rel: str, chip_ids: Optional[List[str]], include_unlabeled: bool, limit: Optional[int], paths: Dict[str, Path]) -> Path:
    resolved = infer_paths(image_rel, paths)
    if not resolved["image"].exists():
        raise FileNotFoundError(f"Image not found: {resolved['image']}")
    if not resolved["positions"].exists():
        raise FileNotFoundError(f"Positions JSON not found: {resolved['positions']}")

    positions_payload = load_json(resolved["positions"])
    annotations_payload = load_json(resolved["annotations"]) if resolved["annotations"].exists() else {}
    candidates = select_candidates(
        positions_payload.get("chips", []),
        annotations_payload.get("marked_chips", []),
        chip_ids,
        include_unlabeled,
    )
    resolved["crops_dir"].mkdir(parents=True, exist_ok=True)

    manifest = []
    count = 0
    with Image.open(resolved["image"]) as img:
        img = img.convert("RGB")
        for entry in candidates:
            if limit is not None and count >= limit:
                break
            rect = entry.get("rect") or entry.get("bbox")
            if not rect:
                continue
            x0, y0, x1, y1 = rect.get("x0"), rect.get("y0"), rect.get("x1"), rect.get("y1")
            if None in (x0, y0, x1, y1):
                continue
            crop = img.crop((x0, y0, x1, y1))
            class_name = (entry.get("class") or "unlabeled").strip() or "unlabeled"
            dest_dir = resolved["crops_dir"] / class_name
            dest_dir.mkdir(parents=True, exist_ok=True)
            file_path = dest_dir / f"{entry.get('chip_id')}.png"
            crop.save(file_path, format="PNG", optimize=True)
            manifest.append({
                "chip_id": entry.get("chip_id"),
                "class": class_name,
                "file": file_path.relative_to(paths["crops"]).as_posix(),
            })
            count += 1

    manifest_path = resolved["crops_dir"] / "manifest.json"
    with manifest_path.open("w", encoding="utf-8") as fp:
        json.dump({"image": image_rel, "entries": manifest}, fp, ensure_ascii=False, indent=2)
    return manifest_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export chip crops")
    parser.add_argument("--images-root", type=Path, default=Path("wafer/images"))
    parser.add_argument("--positions-root", type=Path, default=Path("D:/project/data/position"))
    parser.add_argument("--annotations-root", type=Path, default=Path("D:/project/data/position"))
    parser.add_argument("--crops-root", type=Path, default=Path("D:/project/data/chip_images"))
    parser.add_argument("--image", required=True, help="Image path relative to images root")
    parser.add_argument("--chip-ids", nargs="*", default=None)
    parser.add_argument("--include-unlabeled", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    paths = resolve_paths(args.images_root, args.positions_root, args.annotations_root or args.positions_root, args.crops_root)
    manifest = export_crops(args.image, args.chip_ids, args.include_unlabeled, args.limit, paths)
    print(f"[OK] Chip crops exported: {manifest}")


if __name__ == "__main__":
    main()
