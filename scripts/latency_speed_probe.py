#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Quick latency probe for pyramid level generation.

Runs a small set of combinations for both input.png and input2.png (if present)
and prints timing/size summaries for PNG and JPEG outputs.

Usage:
    python scripts/latency_speed_probe.py
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import pyvips

IMAGE_CANDIDATES = ["input.png", "input2.png"]
LEVEL = 0.7


@dataclass
class RunConfig:
    format: str
    conc: int
    loader: str
    compression: Optional[int] = None  # PNG
    quality: Optional[int] = None      # JPEG
    note: str = ""


@dataclass
class ResultRow:
    image: str
    format: str
    conc: int
    loader: str
    compression: Optional[int]
    quality: Optional[int]
    gen_ms: float
    save_ms: float
    size_kb: float
    output: Path
    note: str = ""


PNG_CONCURRENCY = [1, 2, 4, 8]
PNG_COMPRESSION = [3, 2, 1]
PNG_LOADERS = ["random_late_copy", "seq_early_copy"]

JPEG_CONCURRENCY = [1, 2, 4, 8]
JPEG_QUALITIES = [95, 90, 80]
JPEG_LOADERS = ["random_late_copy", "seq_early_copy"]


def set_concurrency(conc: int) -> None:
    conc = max(1, int(conc))
    os.environ["VIPS_CONCURRENCY"] = str(conc)
    try:
        pyvips.concurrency_set(conc)
    except Exception:
        pass


def prepare_image(path: Path, loader: str):
    access = "random" if loader == "random_late_copy" else "sequential"
    img = pyvips.Image.new_from_file(str(path), access=access)
    return img


def build_pipeline(img: pyvips.Image, target_w: int, target_h: int, loader: str) -> pyvips.Image:
    work = img
    if loader == "seq_early_copy":
        work = img.copy_memory()

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

    return work


def save_png(img: pyvips.Image, out_path: Path, compression: int) -> None:
    img.pngsave(
        str(out_path),
        compression=int(compression),
        effort=1,
        strip=True,
        filter=pyvips.enums.ForeignPngFilter.NONE,
        interlace=False,
    )


def save_jpeg(img: pyvips.Image, out_path: Path, quality: int) -> None:
    img.jpegsave(
        str(out_path),
        Q=int(quality),
        strip=True,
        optimize_coding=True,
        subsample_mode="auto",
    )


def run_single(path: Path, cfg: RunConfig, out_dir: Path) -> ResultRow:
    set_concurrency(cfg.conc)

    img = prepare_image(path, cfg.loader)
    target_w = max(1, int(round(img.width * LEVEL)))
    target_h = max(1, int(round(img.height * LEVEL)))

    # build pipeline
    t0 = time.perf_counter()
    work = build_pipeline(img, target_w, target_h, cfg.loader)
    gen_ms = (time.perf_counter() - t0) * 1000.0

    # save
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / (
        f"{path.stem}_L{int(LEVEL*100)}_{cfg.loader}_conc{cfg.conc}"
        f"{'_Q'+str(cfg.quality) if cfg.quality else ''}"
        f"{'_C'+str(cfg.compression) if cfg.compression is not None else ''}"
        f".{'png' if cfg.format == 'PNG' else 'jpg'}"
    )

    t1 = time.perf_counter()
    if cfg.format == "PNG":
        assert cfg.compression is not None, "PNG compression required"
        save_png(work, out_path, cfg.compression)
    else:
        assert cfg.quality is not None, "JPEG quality required"
        save_jpeg(work, out_path, cfg.quality)
    save_ms = (time.perf_counter() - t1) * 1000.0

    size_kb = out_path.stat().st_size / 1024.0

    return ResultRow(
        image=path.name,
        format=cfg.format,
        conc=cfg.conc,
        loader=cfg.loader,
        compression=cfg.compression,
        quality=cfg.quality,
        gen_ms=gen_ms,
        save_ms=save_ms,
        size_kb=size_kb,
        output=out_path,
        note=cfg.note,
    )


def run_for_image(img_path: Path) -> List[ResultRow]:
    results: List[ResultRow] = []
    out_root = Path("_latency_probe") / img_path.stem

    for conc in PNG_CONCURRENCY:
        for loader in PNG_LOADERS:
            for comp in PNG_COMPRESSION:
                cfg = RunConfig(
                    format="PNG",
                    conc=conc,
                    loader=loader,
                    compression=comp,
                    note=f"C={comp}",
                )
                try:
                    res = run_single(img_path, cfg, out_root / cfg.format.lower())
                    results.append(res)
                except Exception as exc:
                    results.append(
                        ResultRow(
                            image=img_path.name,
                            format=cfg.format,
                            conc=cfg.conc,
                            loader=cfg.loader,
                            compression=cfg.compression,
                            quality=None,
                            gen_ms=float("nan"),
                            save_ms=float("nan"),
                            size_kb=0.0,
                            output=out_root / "error",
                            note=f"ERROR: {exc}",
                        )
                    )

    for conc in JPEG_CONCURRENCY:
        for loader in JPEG_LOADERS:
            for quality in JPEG_QUALITIES:
                cfg = RunConfig(
                    format="JPEG",
                    conc=conc,
                    loader=loader,
                    quality=quality,
                    note=f"Q={quality}",
                )
                try:
                    res = run_single(img_path, cfg, out_root / cfg.format.lower())
                    results.append(res)
                except Exception as exc:
                    results.append(
                        ResultRow(
                            image=img_path.name,
                            format=cfg.format,
                            conc=cfg.conc,
                            loader=cfg.loader,
                            compression=None,
                            quality=cfg.quality,
                            gen_ms=float("nan"),
                            save_ms=float("nan"),
                            size_kb=0.0,
                            output=out_root / "error",
                            note=f"ERROR: {exc}",
                        )
                    )

    return results


def print_summary(title: str, rows: Iterable[ResultRow]) -> None:
    rows = list(rows)
    if not rows:
        print(f"\n{title}: (no data)")
        return

    print(f"\n{title}")
    print("-" * len(title))
    header = f"{'format':6} {'conc':4} {'loader':17} {'extra':8} {'gen(ms)':>9} {'save(ms)':>9} {'size(KB)':>10}  output"
    print(header)
    print("-" * len(header))

    def extra(r: ResultRow) -> str:
        if r.format == "PNG":
            return f"C={r.compression}"
        if r.format == "JPEG":
            return f"Q={r.quality}"
        return ""

    for r in rows:
        gen = f"{r.gen_ms:6.1f}" if r.gen_ms == r.gen_ms else "  n/a"
        save = f"{r.save_ms:6.1f}" if r.save_ms == r.save_ms else "  n/a"
        size = f"{r.size_kb:7.1f}" if r.size_kb else "   -  "
        note = f" ({r.note})" if r.note else ""
        print(f"{r.format:6} {r.conc:4d} {r.loader:17} {extra(r):8} {gen:>9} {save:>9} {size:>10}  {r.output}{note}")

    best = [r for r in rows if r.save_ms == r.save_ms]
    if best:
        best_row = min(best, key=lambda r: r.save_ms)
        print(
            f"--> Fastest {best_row.format}: save_ms={best_row.save_ms:.1f} ms "
            f"(conc={best_row.conc}, loader={best_row.loader}, {extra(best_row)})"
        )


def main() -> None:
    existing = [Path(p) for p in IMAGE_CANDIDATES if Path(p).is_file()]
    if not existing:
        print("No input images found (expected input.png or input2.png).")
        return

    all_rows: List[ResultRow] = []
    for img_path in existing:
        print(f"Running latency probe for {img_path.name} (level {LEVEL}) ...")
        rows = run_for_image(img_path)
        all_rows.extend(rows)

        png_rows = [r for r in rows if r.format == "PNG"]
        jpg_rows = [r for r in rows if r.format == "JPEG"]
        print_summary(f"Results for {img_path.name} - PNG", png_rows)
        print_summary(f"Results for {img_path.name} - JPEG", jpg_rows)

    print("\nDone. Outputs stored under ./_latency_probe/")


if __name__ == "__main__":
    main()
