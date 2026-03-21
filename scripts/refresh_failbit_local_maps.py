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
    "wafer_palette_5mb_PE_Engineer",
    "wafer_palette_10mb_EE_Test",
    "wafer_palette_15mb_PT_Engineer",
    "wafer_palette_20mb_PT_Engineer",
    "wafer_palette_25mb_EE_Test",
    "wafer_palette_30mb_EE_Engineer",
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


def _assign_grade(chip: dict, chip_idx: int, image_name: str) -> int:
    """JSON에 'g' 필드가 없으면 chip 위치 기반으로 다양한 grade(0~7) 할당."""
    grade = chip.get("g")
    if isinstance(grade, int) and 0 <= grade <= 7:
        return grade
    # chip 좌표 + 이미지 이름으로 결정적 grade 할당
    x_abs = chip.get("x_abs", chip_idx)
    y_abs = chip.get("y_abs", 0)
    seed = stable_seed(image_name, x_abs, y_abs)
    return seed % 8


MIN_CANVAS_SIZE = 6000  # 최소 canvas 크기 (pixels) — 이미지 최소 6000x6000


FTN_COUNT = 500  # 생성할 FBT 키 개수
QTN_COUNT = 500  # 생성할 QVL 키 개수


def _compact_array_encode(obj: dict) -> str:
    """positions_module.py의 compact_array 포맷과 동일한 JSON 직렬화."""
    _compact_keys = {"f", "q", "rect", "xs", "ys", "ftn_keys", "qtn_keys"}

    def _enc(o, level=0):
        indent = "  " * level
        if isinstance(o, dict):
            if not o:
                return "{}"
            items = []
            for k, v in o.items():
                if k in _compact_keys and isinstance(v, (dict, list)):
                    val_str = json.dumps(v, ensure_ascii=False, separators=(", ", ": "))
                else:
                    val_str = _enc(v, level + 1)
                items.append(f'{indent}  "{k}": {val_str}')
            return "{\n" + ",\n".join(items) + "\n" + indent + "}"
        elif isinstance(o, list):
            if not o:
                return "[]"
            items = [f"{indent}  {_enc(i, level + 1)}" for i in o]
            return "[\n" + ",\n".join(items) + "\n" + indent + "]"
        else:
            return json.dumps(o, ensure_ascii=False)

    return _enc(obj)


def scale_positions_json(json_path: Path, scale: int) -> None:
    """positions JSON을 scale배 확대 + f/q 500개 생성 + compact_array 포맷으로 저장."""
    with json_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    coord = data.get("coord") or {}
    canvas = coord.get("canvas") or {}
    cur_w = int(canvas.get("width", 0))

    # 이미 올바른 상태면 스킵
    existing_ftn = data.get("ftn_keys", [])
    if (cur_w >= MIN_CANVAS_SIZE
            and len(existing_ftn) == FTN_COUNT
            and json_path.read_text(encoding="utf-8").startswith("{\n")):
        return

    # canvas 스케일 (아직 작을 때만)
    if cur_w < MIN_CANVAS_SIZE and scale > 1:
        canvas["width"] = cur_w * scale
        canvas["height"] = int(canvas.get("height", 2304)) * scale

        grid_edges = coord.get("grid_edges") or {}
        if "xs" in grid_edges:
            grid_edges["xs"] = [x * scale for x in grid_edges["xs"]]
        if "ys" in grid_edges:
            grid_edges["ys"] = [y * scale for y in grid_edges["ys"]]

        for chip in data.get("chips", []):
            rect = chip.get("rect")
            if rect:
                rect["x0"] = int(rect.get("x0", 0)) * scale
                rect["y0"] = int(rect.get("y0", 0)) * scale
                rect["x1"] = int(rect.get("x1", 0)) * scale
                rect["y1"] = int(rect.get("y1", 0)) * scale

    # ftn_keys / qtn_keys 생성 (500개씩)
    rng = np.random.default_rng(stable_seed(json_path.stem, "ftn_qtn"))
    ftn_keys = [str(k) for k in sorted(rng.choice(9999, size=FTN_COUNT, replace=False))]
    qtn_keys = [str(k) for k in sorted(rng.choice(9999, size=QTN_COUNT, replace=False))]

    chips = data.get("chips", [])
    for chip in chips:
        x_abs = chip.get("x_abs", 0)
        y_abs = chip.get("y_abs", 0)
        chip_rng = np.random.default_rng(stable_seed(json_path.stem, x_abs, y_abs))
        chip["f"] = [str(int(v)) for v in chip_rng.integers(0, 10000, size=FTN_COUNT)]
        chip["q"] = [str(int(v)) for v in chip_rng.integers(0, 100, size=QTN_COUNT)]

    # compact_array 포맷: ftn_keys/qtn_keys를 chips 앞에 삽입
    ordered = {}
    for k, v in data.items():
        if k in ("ftn_keys", "qtn_keys"):
            continue  # 기존 키 제거 (아래서 재삽입)
        if k == "chips":
            ordered["ftn_keys"] = ftn_keys
            ordered["qtn_keys"] = qtn_keys
        ordered[k] = v

    with json_path.open("w", encoding="utf-8") as fh:
        fh.write(_compact_array_encode(ordered))


def render_image_from_positions(
    json_path: Path,
    palette: list[int],
    min_canvas_size: int = 6000,
) -> Image.Image:
    """positions JSON으로부터 palette-indexed PNG를 렌더링한다.

    주의사항:
    - chip 영역은 직사각형 rect 그대로 사용한다. 원형 마스크 등 별도 영역을 절대 만들지 않는다.
    - chip 테두리(1px * scale)에 BIN 인덱스를 적용한다 (Normal=10, Invalid=11, BIN별 12~23).
    - chip 내부 pixel의 95%+ 를 단일 grade가 차지한다.
    """
    with json_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    coord = data.get("coord") or {}
    canvas = coord.get("canvas") or {}
    orig_w = int(canvas.get("width") or 2304)
    orig_h = int(canvas.get("height") or 2304)

    # 최소 canvas 크기 보장을 위한 스케일 팩터
    scale = max(1, -(-min_canvas_size // max(orig_w, orig_h)))  # ceil division
    width = orig_w * scale
    height = orig_h * scale

    arr = np.full((height, width), BACKGROUND_INDEX, dtype=np.uint8)
    image_name = json_path.stem
    border_width = max(1, scale)  # 스케일에 비례한 테두리 두께

    for chip_idx, chip in enumerate(data.get("chips", [])):
        rect = chip.get("rect") or {}
        x0 = int(rect.get("x0", 0)) * scale
        y0 = int(rect.get("y0", 0)) * scale
        x1 = int(rect.get("x1", 0)) * scale
        y1 = int(rect.get("y1", 0)) * scale
        if x1 <= x0 or y1 <= y0:
            continue

        # 테두리: BIN에 따른 인덱스 (Normal=10, Invalid=11, BIN별 12~23)
        bin_idx = border_index_from_bin(chip.get("b"))
        arr[y0:y1, x0:x1] = bin_idx

        if x1 - x0 <= border_width * 2 or y1 - y0 <= border_width * 2:
            continue

        # 내부: grade 인덱스 (95%+ 단일 grade)
        inner = arr[y0 + border_width : y1 - border_width, x0 + border_width : x1 - border_width]
        grade = _assign_grade(chip, chip_idx, image_name)

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

    # positions JSON 스케일 업 (첫 실행 시 1회)
    for json_path in positions_dir.glob("*.json"):
        with json_path.open("r", encoding="utf-8") as fh:
            d = json.load(fh)
        orig_w = int((d.get("coord") or {}).get("canvas", {}).get("width", 2304))
        sc = max(1, -(-MIN_CANVAS_SIZE // orig_w))
        scale_positions_json(json_path, sc)

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
        print(f"[palette_5mb] wrote {target_path} ({img.width}x{img.height}, {size_mb:.3f} MiB)")


def render_palette_3k(
    images_root: Path,
    positions_root: Path,
    palette: list[int],
    render_all: bool,
) -> None:
    dataset_dir = images_root / "palette_3k"
    positions_dir = positions_root / "palette_3k"
    dataset_dir.mkdir(parents=True, exist_ok=True)

    json_paths = sorted(positions_dir.glob("wafer_p3k_*.json"))

    if render_all or json_paths:
        # positions JSON 스케일 업 (첫 실행 시 1회)
        if json_paths:
            with json_paths[0].open("r", encoding="utf-8") as fh:
                d = json.load(fh)
            orig_w = int((d.get("coord") or {}).get("canvas", {}).get("width", 2304))
            sc = max(1, -(-MIN_CANVAS_SIZE // orig_w))
            if sc > 1:
                print(f"[palette_3k] scaling {len(json_paths)} positions JSONs by {sc}x ...")
                for jp in json_paths:
                    scale_positions_json(jp, sc)

        rendered = 0
        for json_path in json_paths:
            target_path = dataset_dir / f"{json_path.stem}.png"
            img = render_image_from_positions(json_path, palette)
            save_image(img, target_path)
            rendered += 1
            if rendered % 500 == 0:
                print(f"[palette_3k] rendered {rendered}/{len(json_paths)} ...")
        if rendered > 0:
            print(f"[palette_3k] rendered {rendered} PNG files ({img.width}x{img.height}, diverse grades+bins)")
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
