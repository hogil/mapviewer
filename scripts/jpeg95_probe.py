#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JPEG Q95 latency probe comparing pyvips jpegsave() and TurboJPEG.

Usage:
    python scripts/jpeg95_probe.py
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List

import numpy as np
import pyvips
from turbojpeg import TurboJPEG, TJSAMP_420

IMAGE_CANDIDATES = ["input.png", "input2.png"]
LEVEL = 0.7
CONCURRENCY = [1, 2, 4, 8]
LOADERS = ["random_late_copy", "seq_early_copy"]

TURBO_DLL = r"C:\libjpeg-turbo64\bin\turbojpeg.dll"

jpeg = TurboJPEG(lib_path=TURBO_DLL)


@dataclass
class ResultRow:
    image: str
    conc: int
    loader: str
    encoder: str  # "pyvips" or "turbojpeg"
    save_ms: float
    size_kb: float
    output: Path
    note: str = ""


def set_concurrency(conc: int) -> None:
    conc = max(1, conc)
    os.environ["VIPS_CONCURRENCY"] = str(conc)
    try:
        pyvips.concurrency_set(conc)
    except Exception:
        pass


def build_pipeline(path: Path, conc: int, loader: str):
    set_concurrency(conc)
    access = "random" if loader == "random_late_copy" else "sequential"
    img = pyvips.Image.new_from_file(str(path), access=access)

    level = LEVEL
    target_w = max(1, int(round(img.width * level)))
    target_h = max(1, int(round(img.height * level)))

    work = img
    if loader == "seq_early_copy":
        work = work.copy_memory()

    shrink_ratio = min(work.width / target_w, work.height / target_h)
    shrink_factor = max(int(shrink_ratio), 1)
    if shrink_factor > 1:
        work = work.shrink(shrink_factor, shrink_factor)

    scale_w = target_w / work.width
    scale_h = target_h / work.height
    if abs(scale_w - 1.0) > 1e-6 or abs(scale_h - 1.0) > 1e-6:
        work = work.resize(scale_w, vscale=scale_h, kernel="cubic")

    if loader == "random_late_copy":
        work = work.copy_memory()

    if work.bands == 4:
        work = work.extract_band(0, n=3)
    if work.interpretation != "srgb":
        work = work.colourspace("srgb")
    if work.format != "uchar":
        work = work.cast("uchar")

    return work


def to_numpy_rgb(work: pyvips.Image) -> np.ndarray:
    mem = work.write_to_memory()
    array = np.frombuffer(mem, dtype=np.uint8).reshape(work.height, work.width, work.bands)
    if work.bands == 1:
        array = np.repeat(array, 3, axis=2)
    elif work.bands == 3:
        pass
    else:
        raise ValueError(f"Unsupported band count: {work.bands}")
    return array


def run_pyvips_encoder(work: pyvips.Image, out_path: Path) -> ResultRow:
    start = time.perf_counter()
    work.jpegsave(
        str(out_path),
        Q=95,
        strip=True,
        optimize_coding=True,
        subsample_mode="auto",
    )
    save_ms = (time.perf_counter() - start) * 1000.0
    size_kb = out_path.stat().st_size / 1024.0
    return ResultRow("", 0, "", "pyvips", save_ms, size_kb, out_path, "")


def run_turbo_encoder(array: np.ndarray, out_path: Path) -> ResultRow:
    start = time.perf_counter()
    buffer = jpeg.encode(array, quality=95)
    save_ms = (time.perf_counter() - start) * 1000.0
    out_path.write_bytes(buffer)
    size_kb = len(buffer) / 1024.0
    return ResultRow("", 0, "", "turbojpeg", save_ms, size_kb, out_path, "")


def run_single(image_path: Path, conc: int, loader: str, out_root: Path) -> List[ResultRow]:
    work = build_pipeline(image_path, conc, loader)
    out_dir = out_root / f"conc{conc}_{loader}"
    out_dir.mkdir(parents=True, exist_ok=True)

    results: List[ResultRow] = []

    # pyvips encoder
    out_py = out_dir / f"{image_path.stem}_pyvips.jpg"
    py_res = run_pyvips_encoder(work, out_py)
    py_res.image = image_path.name
    py_res.conc = conc
    py_res.loader = loader
    results.append(py_res)

    # turbojpeg encoder
    out_tj = out_dir / f"{image_path.stem}_turbo.jpg"
    try:
        array = to_numpy_rgb(work)
        tj_res = run_turbo_encoder(array, out_tj)
        tj_res.image = image_path.name
        tj_res.conc = conc
        tj_res.loader = loader
        results.append(tj_res)
    except Exception as exc:
        results.append(
            ResultRow(
                image=image_path.name,
                conc=conc,
                loader=loader,
                encoder="turbojpeg",
                save_ms=float("nan"),
                size_kb=0.0,
                output=out_tj,
                note=f"ERROR: {exc}",
            )
        )

    return results


def print_summary(rows: List[ResultRow]) -> None:
    header = f"{'image':12} {'conc':4} {'loader':17} {'encoder':10} {'save_ms':>9} {'size(KB)':>10}  note                output"
    print(header)
    print("-" * len(header))
    for row in rows:
        print(
            f"{row.image:12} {row.conc:4d} {row.loader:17} {row.encoder:10} "
            f"{row.save_ms:9.1f} {row.size_kb:10.1f}  {row.note:18} {row.output}"
        )


def main() -> None:
    existing = [Path(p) for p in IMAGE_CANDIDATES if Path(p).is_file()]
    if not existing:
        print("No input images found (input.png, input2.png).")
        return

    all_rows: List[ResultRow] = []

    for img_path in existing:
        print(f"\n=== Image: {img_path.name} ===")
        out_root = Path("_jpeg95_probe") / img_path.stem
        for conc in CONCURRENCY:
            for loader in LOADERS:
                try:
                    rows = run_single(img_path, conc, loader, out_root)
                    all_rows.extend(rows)
                except Exception as exc:
                    print(f"[ERROR] {img_path.name}, conc={conc}, loader={loader}: {exc}")

        image_rows = [r for r in all_rows if r.image == img_path.name]
        print_summary(image_rows)

    print("\nTurboJPEG path:", TURBO_DLL)
    print("Outputs under ./_jpeg95_probe/")


if __name__ == "__main__":
    main()
