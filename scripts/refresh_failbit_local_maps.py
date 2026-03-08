from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Iterable, Optional

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api.personal_colors import get_palette_for_scheme, load_color_legends  # noqa: E402

LOCAL_IMAGES_ROOT = Path(r"D:/project/data/wm-811k")
LOCAL_POSITIONS_ROOT = Path(r"D:/project/data/positions")

PALETTE_5MB_FILES = [
    "wafer_palette_5mb",
    "wafer_palette_10mb",
    "wafer_palette_15mb",
    "wafer_palette_20mb",
    "wafer_palette_25mb",
    "wafer_palette_30mb",
]

PALETTE_3K_TEMPLATE = "wafer_p3k_0001"
PALETTE_3K_SOURCE_5MB = "wafer_palette_5mb"
PALETTE_3K_COUNT = 3000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

BACKGROUND_INDEX = 8
NORMAL_BORDER_INDEX = 10
INVALID_BORDER_INDEX = 11
GRADE0_SPARSEN_RATIO = 0.05

BIN_TO_INDEX = {
    "285": 12,
    "286": 13,
    "287": 14,
    "288": 15,
    "290": 16,
    "291": 17,
    "300": 18,
    "385": 19,
    "386": 20,
    "388": 21,
    "389": 22,
    "390": 23,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Regenerate local fail-bit dummy maps from positions JSON."
    )
    parser.add_argument(
        "--targets",
        nargs="+",
        choices=["palette_5mb", "palette_3k", "all"],
        default=["all"],
        help="Datasets to regenerate.",
    )
    parser.add_argument(
        "--scheme",
        default="default",
        help="Palette scheme to use from logs/color-legends.json.",
    )
    parser.add_argument(
        "--render-all-p3k",
        action="store_true",
        help="Render every palette_3k image from its JSON instead of copying wafer_palette_5mb.png.",
    )
    parser.add_argument(
        "--images-root",
        default=str(LOCAL_IMAGES_ROOT),
        help="Target image root.",
    )
    parser.add_argument(
        "--positions-root",
        default=str(LOCAL_POSITIONS_ROOT),
        help="Positions JSON root.",
    )
    return parser.parse_args()


def normalize_targets(targets: Iterable[str]) -> list[str]:
    values = list(targets)
    if "all" in values:
        return ["palette_5mb", "palette_3k"]
    return values


def build_palette_256(scheme_name: str) -> list[int]:
    legends = load_color_legends()
    scheme_data = legends.get(scheme_name) or legends.get("default")
    if not isinstance(scheme_data, dict):
        raise ValueError(f"Invalid palette scheme: {scheme_name}")

    palette = list(get_palette_for_scheme(scheme_data))
    if len(palette) < 256 * 3:
        palette.extend([0] * (256 * 3 - len(palette)))

    background_hex = str(scheme_data.get("background") or "#CCCCCC").strip().lstrip("#")
    if len(background_hex) == 6:
        background_rgb = [int(background_hex[i : i + 2], 16) for i in (0, 2, 4)]
        palette[31 * 3 : 31 * 3 + 3] = background_rgb

    return palette[: 256 * 3]


def border_index_from_bin(bin_value: Optional[object]) -> int:
    if bin_value is None:
        return NORMAL_BORDER_INDEX

    raw = str(bin_value).strip().upper()
    if not raw:
        return NORMAL_BORDER_INDEX
    if raw == "NORMAL":
        return NORMAL_BORDER_INDEX
    if raw == "INVALID":
        return INVALID_BORDER_INDEX
    if raw.startswith("B"):
        raw = raw[1:]
    return BIN_TO_INDEX.get(raw, NORMAL_BORDER_INDEX)


def stable_seed(*parts: object) -> int:
    joined = "|".join(str(part) for part in parts)
    digest = hashlib.sha256(joined.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "little", signed=False)


def target_size_bytes_from_stem(stem: str) -> Optional[int]:
    match = re.search(r"_(\d+)mb$", stem, flags=re.IGNORECASE)
    if not match:
        return None
    return int(match.group(1)) * 1024 * 1024


def deterministic_padding_bytes(length: int, seed_text: str) -> bytes:
    buffer = bytearray()
    counter = 0
    while len(buffer) < length:
        buffer.extend(hashlib.sha256(f"{seed_text}|{counter}".encode("utf-8")).digest())
        counter += 1
    return bytes(buffer[:length])


def add_png_padding_chunk(png_bytes: bytes, target_size: int, seed_text: str) -> bytes:
    if len(png_bytes) >= target_size:
        return png_bytes
    if not png_bytes.startswith(PNG_SIGNATURE):
        raise ValueError("Not a PNG file")

    iend_chunk = b"\x00\x00\x00\x00IEND\xaeB`\x82"
    iend_offset = png_bytes.rfind(iend_chunk)
    if iend_offset < 0:
        raise ValueError("PNG IEND chunk not found")

    growth_needed = target_size - len(png_bytes)
    if growth_needed < 12:
        return png_bytes

    chunk_type = b"paDd"
    payload = deterministic_padding_bytes(growth_needed - 12, seed_text)
    crc = binascii.crc32(chunk_type + payload) & 0xFFFFFFFF
    chunk = (
        len(payload).to_bytes(4, "big")
        + chunk_type
        + payload
        + crc.to_bytes(4, "big")
    )
    return png_bytes[:iend_offset] + chunk + png_bytes[iend_offset:]


def render_image_from_positions(json_path: Path, palette: list[int]) -> Image.Image:
    with json_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    coord = data.get("coord") or {}
    canvas = coord.get("canvas") or {}
    width = int(canvas.get("width") or 2304)
    height = int(canvas.get("height") or 2304)

    arr = np.full((height, width), BACKGROUND_INDEX, dtype=np.uint8)

    for chip in data.get("chips", []):
        rect = chip.get("rect") or {}
        x0 = int(rect.get("x0", 0))
        y0 = int(rect.get("y0", 0))
        x1 = int(rect.get("x1", 0))
        y1 = int(rect.get("y1", 0))
        if x1 <= x0 or y1 <= y0:
            continue

        border_index = border_index_from_bin(chip.get("b"))
        arr[y0:y1, x0:x1] = border_index

        if x1 - x0 <= 2 or y1 - y0 <= 2:
            continue

        inner = arr[y0 + 1 : y1 - 1, x0 + 1 : x1 - 1]
        grade = chip.get("g", 0)
        if not isinstance(grade, int) or not (0 <= grade <= 7):
            grade = 0

        inner[:, :] = grade

        if 1 <= grade <= 7:
            sparse_count = max(1, round(inner.size * GRADE0_SPARSEN_RATIO))
            rng = np.random.default_rng(
                stable_seed(json_path.name, x0, y0, x1, y1, grade)
            )
            picks = rng.choice(inner.size, size=sparse_count, replace=False)
            rows, cols = np.unravel_index(picks, inner.shape)
            inner[rows, cols] = 0

    img = Image.frombytes("P", (width, height), arr.tobytes())
    img.putpalette(palette)
    return img


def save_image(
    img: Image.Image,
    target_path: Path,
    *,
    target_size_bytes: Optional[int] = None,
    padding_seed: Optional[str] = None,
) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(target_path, optimize=False, compress_level=9)

    if target_size_bytes is None:
        return

    raw_bytes = target_path.read_bytes()
    padded_bytes = add_png_padding_chunk(
        raw_bytes,
        target_size=target_size_bytes,
        seed_text=padding_seed or target_path.stem,
    )
    target_path.write_bytes(padded_bytes)


def render_palette_5mb(images_root: Path, positions_root: Path, palette: list[int]) -> None:
    dataset_dir = images_root / "palette_5mb"
    positions_dir = positions_root / "palette_5mb"

    for stem in PALETTE_5MB_FILES:
        json_path = positions_dir / f"{stem}.json"
        if not json_path.exists():
            raise FileNotFoundError(f"Missing positions file: {json_path}")
        target_path = dataset_dir / f"{stem}.png"
        img = render_image_from_positions(json_path, palette)
        target_size = target_size_bytes_from_stem(stem)
        save_image(
            img,
            target_path,
            target_size_bytes=target_size,
            padding_seed=stem,
        )
        size_mb = target_path.stat().st_size / 1024 / 1024
        print(f"[palette_5mb] wrote {target_path} ({size_mb:.3f} MiB)")


def render_palette_3k(
    images_root: Path,
    positions_root: Path,
    palette: list[int],
    render_all: bool,
) -> None:
    dataset_dir = images_root / "palette_3k"
    positions_dir = positions_root / "palette_3k"
    dataset_dir.mkdir(parents=True, exist_ok=True)

    if render_all:
        for json_path in sorted(positions_dir.glob("wafer_p3k_*.json")):
            target_path = dataset_dir / f"{json_path.stem}.png"
            img = render_image_from_positions(json_path, palette)
            save_image(img, target_path)
        print("[palette_3k] rendered every PNG from its JSON")
        return

    source_path = images_root / "palette_5mb" / f"{PALETTE_3K_SOURCE_5MB}.png"
    if not source_path.exists():
        raise FileNotFoundError(f"Missing source PNG for palette_3k copy mode: {source_path}")

    for idx in range(1, PALETTE_3K_COUNT + 1):
        target_path = dataset_dir / f"wafer_p3k_{idx:04d}.png"
        shutil.copyfile(source_path, target_path)

    print(
        f"[palette_3k] copied {source_path.name} to {PALETTE_3K_COUNT} PNG files"
    )


def main() -> None:
    args = parse_args()
    targets = normalize_targets(args.targets)
    images_root = Path(args.images_root)
    positions_root = Path(args.positions_root)
    palette = build_palette_256(args.scheme)

    if "palette_5mb" in targets:
        render_palette_5mb(images_root, positions_root, palette)
    if "palette_3k" in targets:
        render_palette_3k(images_root, positions_root, palette, render_all=args.render_all_p3k)

    print("done")


if __name__ == "__main__":
    main()
