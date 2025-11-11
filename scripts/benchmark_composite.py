#!/usr/bin/env python3
"""
Composite Map 생성 전략 벤치마크

예시:
    python scripts/benchmark_composite.py ^
        --folder D:/project/data/wm-811k/palette_5mb ^
        --limit 200 ^
        --loaders sequential thread process ^
        --workers 1 4 8
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from typing import Iterable, List, Tuple

import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api.config import IMAGES_ROOT  # type: ignore  # pylint: disable=wrong-import-position
from api.composite_map import create_composite_heatmaps  # type: ignore  # pylint: disable=wrong-import-position


def list_images(folder: Path, limit: int | None = None) -> List[str]:
    exts = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
    results: List[str] = []
    for path in folder.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in exts:
            continue
        results.append(str(path.relative_to(IMAGES_ROOT)))
        if limit and len(results) >= limit:
            break
    return results


def run_once(
    images: List[str],
    loader: str,
    workers: int,
    keep_output: bool
) -> Tuple[float, dict]:
    start = time.perf_counter()
    result = create_composite_heatmaps(
        images,
        loader_mode=loader,
        max_workers=workers
    )
    elapsed = time.perf_counter() - start

    if not keep_output:
        out_dir = IMAGES_ROOT / result.get("output_dir", "")
        if out_dir.exists():
            shutil.rmtree(out_dir, ignore_errors=True)
    return elapsed, result


def main():
    parser = argparse.ArgumentParser(description="Benchmark composite map strategies.")
    parser.add_argument("--folder", type=Path, required=True,
                        help="이미지가 있는 루트 폴더 (IMAGES_ROOT 하위 경로여야 함)")
    parser.add_argument("--limit", type=int, default=None,
                        help="테스트에 사용할 이미지 수 제한")
    parser.add_argument("--loaders", nargs="+", default=["sequential", "thread", "process"],
                        help="시험할 로더 모드 목록")
    parser.add_argument("--workers", nargs="+", type=int, default=[1, 4, 8],
                        help="각 모드에서 사용할 worker 수 목록")
    parser.add_argument("--repeat", type=int, default=1,
                        help="각 조합 반복 횟수")
    parser.add_argument("--keep-output", action="store_true",
                        help="생성된 composite 결과를 삭제하지 않음")
    parser.add_argument("--summary", type=Path, default=Path("composite_benchmark.json"),
                        help="결과를 저장할 JSON 파일 경로")
    args = parser.parse_args()

    folder = args.folder
    if not folder.is_dir():
        parser.error(f"Folder not found: {folder}")

    if IMAGES_ROOT not in folder.resolve().parents and folder.resolve() != IMAGES_ROOT:
        parser.error(f"{folder} 는 IMAGES_ROOT({IMAGES_ROOT}) 하위 경로여야 합니다.")

    images = list_images(folder, limit=args.limit)
    if not images:
        parser.error("선택된 폴더에서 사용할 이미지가 없습니다.")

    results = []
    combos: Iterable[Tuple[str, int]] = []
    combos = [
        (loader, workers)
        for loader in args.loaders
        for workers in (args.workers if loader != "sequential" else [1])
    ]

    total_runs = len(combos) * max(1, args.repeat)
    print(f"[Benchmark] 이미지 {len(images)}장, 조합 {len(combos)}개 x {args.repeat}회 = {total_runs}회 실행")

    run_idx = 0
    for loader, workers in combos:
        for run_no in range(args.repeat):
            run_idx += 1
            print(f"[{run_idx}/{total_runs}] loader={loader}, workers={workers}, run={run_no+1}")
            elapsed, result = run_once(images, loader, workers, args.keep_output)
            record = {
                "loader": loader,
                "workers": workers,
                "run": run_no + 1,
                "elapsed_seconds": elapsed,
                "source_images": result.get("source_images", len(images)),
                "output_dir": result.get("output_dir"),
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
            }
            print(f"    -> {elapsed:.2f}s, output={record['output_dir']}")
            results.append(record)

    args.summary.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"[Benchmark] 완료. 결과 저장: {args.summary}")


if __name__ == "__main__":
    main()
