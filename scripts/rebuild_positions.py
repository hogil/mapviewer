#!/usr/bin/env python3
"""
Position JSON 재생성 스크립트
- 이미지 픽셀에서 chip 테두리 읽어 실제 b (BIN) 값 결정
- ftn_keys 500개 + qtn_keys 500개 추가
- 각 chip에 f[], q[] 배열 추가 (실수값)
- compact_array 포맷 (fail-map-with-bucketb.py 동일)
- palette_3k는 한 이미지만 분석 후 b/f/q/rect 동일 적용
"""

import json, os, sys, hashlib, re
from pathlib import Path

import numpy as np
from PIL import Image

# ── 프로젝트 경로 ──
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.config import IMAGES_ROOT, POSITIONS_ROOT

# ── 팔레트 인덱스 → BIN 매핑 ──
#  0~7: Grade 0~7
#  8: bg, 9: text
# 10: Normal(border), 11: Invalid(border_inv)
# 12~17: 00P BIN → 285,286,287,288,290,291
# 18~23: 00C BIN → 300,385,386,388,389,390
BIN_INDEX_TYPE = {
    10: "normal", 11: "invalid",
    12: "285", 13: "286", 14: "287", 15: "288", 16: "290", 17: "291",
    18: "300", 19: "385", 20: "386", 21: "388", 22: "389", 23: "390",
}

NUM_FTN = 500
NUM_QTN = 500


def _detect_bin_from_border(arr: np.ndarray, rect: dict, rng: np.random.RandomState) -> str:
    """chip rect 테두리 1px에서 BIN 팔레트 인덱스(10~23) 추출 → b 값 결정.
    normal → 1~199 랜덤정수, invalid → 200~279, BIN → 실제 코드(285,286...)"""
    x0, y0, x1, y1 = rect["x0"], rect["y0"], rect["x1"], rect["y1"]
    h, w = arr.shape
    x0 = max(0, min(x0, w - 1))
    y0 = max(0, min(y0, h - 1))
    x1 = max(0, min(x1, w))
    y1 = max(0, min(y1, h))
    if x1 <= x0 or y1 <= y0:
        return str(rng.randint(1, 200))

    top = arr[y0, x0:x1]
    bottom = arr[y1 - 1, x0:x1]
    left = arr[y0:y1, x0]
    right = arr[y0:y1, x1 - 1]
    border = np.concatenate([top, bottom, left, right])

    bin_pixels = border[(border >= 10) & (border <= 23)]
    if len(bin_pixels) == 0:
        return str(rng.randint(1, 200))  # normal

    bu, bc = np.unique(bin_pixels, return_counts=True)
    dominant = int(bu[np.argmax(bc)])
    btype = BIN_INDEX_TYPE.get(dominant, "normal")

    if btype == "normal":
        return str(rng.randint(1, 200))
    elif btype == "invalid":
        return str(rng.randint(200, 280))
    else:
        return btype  # "285", "286", etc.


def _detect_grade_from_inner(arr: np.ndarray, rect: dict) -> int:
    """chip rect 내부에서 dominant grade(0~7) 추출."""
    x0, y0, x1, y1 = rect["x0"], rect["y0"], rect["x1"], rect["y1"]
    h, w = arr.shape
    x0 = max(0, min(x0, w - 1))
    y0 = max(0, min(y0, h - 1))
    x1 = max(0, min(x1, w))
    y1 = max(0, min(y1, h))
    if x1 - x0 < 3 or y1 - y0 < 3:
        return 0
    inner = arr[y0 + 1:y1 - 1, x0 + 1:x1 - 1]
    grade_pixels = inner[inner <= 7]
    if len(grade_pixels) == 0:
        return 0
    gu, gc = np.unique(grade_pixels, return_counts=True)
    return int(gu[np.argmax(gc)])


def _generate_key_ranges(num_keys: int, seed: int) -> list:
    """key별 범위 생성 — 같은 key는 모든 chip에서 동일 범위.
    ex) key[0] → 0~100, key[1] → 0~50000, key[2] → 0~30 ...
    """
    rng = np.random.RandomState(seed)
    ranges = []
    for _ in range(num_keys):
        r = rng.random()
        if r < 0.3:
            # 작은 범위 0~100
            hi = rng.randint(10, 101)
        elif r < 0.6:
            # 중간 범위 0~10000
            hi = rng.randint(100, 10001)
        else:
            # 큰 범위 0~100000
            hi = rng.randint(10000, 100001)
        ranges.append(hi)
    return ranges


def _generate_fq_values(num_chips: int, key_ranges: list, seed: int) -> np.ndarray:
    """chip별 f/q 배열 생성 — key별 범위 내 정수, 0 포함."""
    rng = np.random.RandomState(seed)
    num_keys = len(key_ranges)
    vals = np.zeros((num_chips, num_keys), dtype=np.int64)
    for k, hi in enumerate(key_ranges):
        vals[:, k] = rng.randint(0, hi + 1, num_chips)
    return vals


def _make_ftn_keys(n: int) -> list:
    """4자리 ftn_keys: 1000~1000+n-1"""
    return [str(1000 + i) for i in range(n)]


def _make_qtn_keys(n: int) -> list:
    """4자리 qtn_keys: 5000~5000+n-1"""
    return [str(5000 + i) for i in range(n)]


def _compact_encode(obj: dict) -> str:
    """compact_array 포맷 직렬화 (f, q, rect, ftn_keys, qtn_keys 한 줄)."""
    _ck = {"f", "q", "rect", "quad", "xs", "ys", "ftn_keys", "qtn_keys", "grid_edges"}

    class _Enc(json.JSONEncoder):
        def encode(self, o):
            return self._enc(o, 0)

        def _enc(self, o, lv):
            ind = "  " * lv
            if isinstance(o, dict):
                if not o:
                    return "{}"
                items = []
                for k, v in o.items():
                    if k in _ck and isinstance(v, (dict, list)):
                        vs = json.dumps(v, ensure_ascii=False, separators=(", ", ": "))
                    else:
                        vs = self._enc(v, lv + 1)
                    items.append(f'{ind}  "{k}": {vs}')
                return "{\n" + ",\n".join(items) + "\n" + ind + "}"
            elif isinstance(o, list):
                if not o:
                    return "[]"
                items = [f"{ind}  {self._enc(i, lv + 1)}" for i in o]
                return "[\n" + ",\n".join(items) + "\n" + ind + "]"
            else:
                return json.dumps(o, ensure_ascii=False)

    return _Enc().encode(obj)


def process_folder(pos_dir: Path, img_dir: Path, is_palette_3k: bool = False):
    """하나의 position 폴더를 처리."""
    pos_files = sorted(pos_dir.glob("*.json"))
    if not pos_files:
        return 0

    print(f"\n{'='*60}")
    print(f"[{pos_dir.name}] {len(pos_files)} position files, palette_3k={is_palette_3k}")

    ftn_keys = _make_ftn_keys(NUM_FTN)
    qtn_keys = _make_qtn_keys(NUM_QTN)

    # key별 범위 (폴더 단위로 고정 — 같은 폴더 내 동일 key는 동일 범위)
    folder_seed = int(hashlib.md5(pos_dir.name.encode()).hexdigest()[:8], 16)
    ftn_ranges = _generate_key_ranges(NUM_FTN, folder_seed)
    qtn_ranges = _generate_key_ranges(NUM_QTN, folder_seed + 1)

    # palette_3k: 한 이미지만 분석, 결과를 모든 파일에 적용
    shared_chip_data = None
    updated = 0

    for pf in pos_files:
        # 대응 이미지 찾기
        img_path = img_dir / f"{pf.stem}.png"
        if not img_path.exists():
            for ext in (".jpg", ".jpeg", ".bmp", ".tiff", ".webp"):
                alt = img_dir / f"{pf.stem}{ext}"
                if alt.exists():
                    img_path = alt
                    break

        if not img_path.exists():
            continue

        # position 로드
        if pf.stat().st_size == 0:
            continue
        try:
            with open(pf, "r", encoding="utf-8") as f:
                pos_data = json.load(f)
        except (json.JSONDecodeError, ValueError):
            print(f"  SKIP corrupt: {pf.name}")
            continue

        chips = pos_data.get("chips", [])
        if not chips:
            continue

        # palette_3k: 첫 파일에서만 분석
        if is_palette_3k and shared_chip_data is not None:
            for i, ch in enumerate(chips):
                if i < len(shared_chip_data):
                    sd = shared_chip_data[i]
                    ch["b"] = sd["b"]
                    ch["rect"] = sd["rect"]
                    ch["f"] = sd["f"]
                    ch["q"] = sd["q"]
        else:
            # 이미지 로드
            img = Image.open(img_path)
            if img.mode != "P":
                print(f"  SKIP {pf.name}: not palette PNG (mode={img.mode})")
                continue
            arr = np.array(img)

            # seed per file (재현 가능)
            seed = int(hashlib.md5(pf.stem.encode()).hexdigest()[:8], 16)
            rng = np.random.RandomState(seed)
            f_vals = _generate_fq_values(len(chips), ftn_ranges, seed)
            q_vals = _generate_fq_values(len(chips), qtn_ranges, seed + 1)

            chip_data_list = []
            for i, ch in enumerate(chips):
                rect = ch.get("rect", {})
                if not rect or "x0" not in rect:
                    continue

                # BIN from border pixels (rng for normal/invalid random values)
                b_val = _detect_bin_from_border(arr, rect, rng)
                ch["b"] = b_val
                ch["f"] = [int(v) for v in f_vals[i]]
                ch["q"] = [int(v) for v in q_vals[i]]

                if is_palette_3k:
                    chip_data_list.append({
                        "b": ch["b"],
                        "rect": ch["rect"],
                        "f": ch["f"],
                        "q": ch["q"],
                    })

            if is_palette_3k and shared_chip_data is None:
                shared_chip_data = chip_data_list
                print(f"  [palette_3k] 기준 이미지 분석 완료: {img_path.name}")

            img.close()

        # ftn_keys/qtn_keys를 chips 앞에 삽입
        ordered = {}
        for k, v in pos_data.items():
            if k == "chips":
                ordered["ftn_keys"] = ftn_keys
                ordered["qtn_keys"] = qtn_keys
            ordered[k] = v

        # 저장
        with open(pf, "w", encoding="utf-8") as f:
            f.write(_compact_encode(ordered))

        updated += 1
        if updated % 100 == 0:
            print(f"  ... {updated}/{len(pos_files)}")

    print(f"  완료: {updated}/{len(pos_files)} files updated")
    return updated


def main():
    total = 0

    # 포지션 폴더들 순회 (composite_map, my-lot 제외)
    for pos_dir in sorted(POSITIONS_ROOT.iterdir()):
        if not pos_dir.is_dir():
            continue
        if pos_dir.name in ("composite_map", "my-lot"):
            continue

        img_dir = IMAGES_ROOT / pos_dir.name
        if not img_dir.exists():
            print(f"SKIP {pos_dir.name}: no matching image dir")
            continue

        is_3k = (pos_dir.name == "palette_3k")
        total += process_folder(pos_dir, img_dir, is_palette_3k=is_3k)

    print(f"\n{'='*60}")
    print(f"Total: {total} position files updated")

    # my-lot position 파일도 업데이트 (원본 기준 복사)
    print("\n[my-lot] position 파일 재복사 시작...")
    rebuild_mylot_positions(total)


def rebuild_mylot_positions(src_updated: int):
    """my-lot position 파일을 원본에서 재복사 (image_path만 갱신)."""
    mylot_pos = POSITIONS_ROOT / "my-lot"
    if not mylot_pos.exists():
        print("  my-lot positions not found, skip")
        return

    updated = 0
    for root, dirs, files in os.walk(str(mylot_pos)):
        for fname in files:
            if not fname.endswith(".json"):
                continue
            dst_path = Path(root) / fname
            stem = Path(fname).stem

            # 원본 position 찾기 (filter_test, palette_3k, palette_5mb)
            src_pos = None
            for src_dir_name in ("filter_test", "palette_3k", "palette_5mb"):
                candidate = POSITIONS_ROOT / src_dir_name / fname
                if candidate.exists():
                    src_pos = candidate
                    break

            if not src_pos:
                continue

            # 원본 로드
            with open(src_pos, "r", encoding="utf-8") as f:
                data = json.load(f)

            # image_path 갱신 (my-lot 경로)
            try:
                dst_rel = dst_path.relative_to(POSITIONS_ROOT)
                # positions/my-lot/... → my-lot/... (IMAGES_ROOT 기준)
                img_rel = str(dst_rel).replace("\\", "/")
                # stem만 교체: .json → .png
                img_rel = img_rel.rsplit(".", 1)[0] + ".png"
                data["image_path"] = img_rel
            except Exception:
                pass

            with open(dst_path, "w", encoding="utf-8") as f:
                if isinstance(data.get("ftn_keys"), list):
                    f.write(_compact_encode(data))
                else:
                    json.dump(data, f, ensure_ascii=False, indent=2)

            updated += 1

    print(f"  my-lot: {updated} position files re-synced")


if __name__ == "__main__":
    main()
