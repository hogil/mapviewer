#!/usr/bin/env python3
"""
Composite Map 생성 전략 벤치마크

예시 (히트맵 모드):
    python scripts/benchmark_composite.py ^
        --folder D:/project/data/wm-811k/palette_5mb ^
        --limit 200 ^
        --loaders sequential thread process ^
        --workers 1 4 8 ^
        --batch-sizes 1 2 4

예시 (팔레트 오버레이 모드 - 빠른 단색 합성):
    python scripts/benchmark_composite.py ^
        --folder D:/project/data/wm-811k/palette_5mb ^
        --limit 200 ^
        --palette-mode ^
        --focus-index 3 ^
        --highlight-threshold 8 ^
        --loaders thread ^
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
from api.composite_map import create_composite_heatmaps, create_palette_overlay  # type: ignore  # pylint: disable=wrong-import-position


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
    batch_size: int,
    keep_output: bool,
    palette_mode: bool = False,
    focus_index: int = 3,
    highlight_threshold: int = 8
) -> Tuple[float, dict]:
    start = time.perf_counter()
    if palette_mode:
        result = create_palette_overlay(
            images,
            focus_index=focus_index,
            highlight_threshold=highlight_threshold,
            loader_mode=loader,
            max_workers=workers,
        )
    else:
        result = create_composite_heatmaps(
            images,
            loader_mode=loader,
            max_workers=workers,
            batch_size=batch_size,
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
    parser.add_argument("--batch-sizes", nargs="+", type=int, default=[1, 2, 4],
                        help="누적시 사용할 배치 크기 목록 (heatmap 모드만)")
    parser.add_argument("--repeat", type=int, default=1,
                        help="각 조합 반복 횟수")
    parser.add_argument("--keep-output", action="store_true",
                        help="생성된 composite 결과를 삭제하지 않음")
    parser.add_argument("--summary", type=Path, default=Path("composite_benchmark.json"),
                        help="결과를 저장할 JSON 파일 경로")
    parser.add_argument("--palette-mode", action="store_true",
                        help="팔레트 오버레이 모드 사용 (빠른 단색 합성)")
    parser.add_argument("--focus-index", type=int, default=3,
                        help="팔레트 모드에서 관심 인덱스 (기본값: 3)")
    parser.add_argument("--highlight-threshold", type=int, default=8,
                        help="팔레트 모드에서 고인덱스 임계값 (기본값: 8)")
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
    combos: Iterable[Tuple[str, int, int]] = []
    combos = []
    
    if args.palette_mode:
        # 팔레트 모드: batch_size 무시
        for loader in args.loaders:
            worker_set = args.workers if loader != "sequential" else [1]
            for workers in worker_set:
                combos.append((loader, workers, 0))  # batch_size=0은 palette 모드 표시
    else:
        # 히트맵 모드: 기존 로직
        for loader in args.loaders:
            worker_set = args.workers if loader != "sequential" else [1]
            for workers in worker_set:
                for batch in args.batch_sizes:
                    combos.append((loader, workers, max(1, batch)))

    total_runs = len(combos) * max(1, args.repeat)
    mode_str = "palette" if args.palette_mode else "heatmap"
    print(f"[Benchmark] 모드={mode_str}, 이미지 {len(images)}장, 조합 {len(combos)}개 x {args.repeat}회 = {total_runs}회 실행")
    if args.palette_mode:
        print(f"  focus_index={args.focus_index}, highlight_threshold={args.highlight_threshold}")

    run_idx = 0
    for loader, workers, batch in combos:
        for run_no in range(args.repeat):
            run_idx += 1
            if args.palette_mode:
                print(f"[{run_idx}/{total_runs}] mode=palette, loader={loader}, workers={workers}, run={run_no+1}")
            else:
                print(f"[{run_idx}/{total_runs}] mode=heatmap, loader={loader}, workers={workers}, batch={batch}, run={run_no+1}")
            elapsed, result = run_once(
                images, loader, workers, batch, args.keep_output,
                palette_mode=args.palette_mode,
                focus_index=args.focus_index,
                highlight_threshold=args.highlight_threshold
            )
            record = {
                "mode": mode_str,
                "loader": loader,
                "workers": workers,
                "batch_size": batch if not args.palette_mode else None,
                "run": run_no + 1,
                "elapsed_seconds": elapsed,
                "source_images": result.get("source_images", len(images)),
                "output_dir": result.get("output_dir"),
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
            }
            if args.palette_mode:
                record["focus_index"] = args.focus_index
                record["highlight_threshold"] = args.highlight_threshold
                record["overlay_path"] = result.get("overlay_path")
            print(f"    -> {elapsed:.2f}s, output={record['output_dir']}")
            results.append(record)

    args.summary.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"[Benchmark] 완료. 결과 저장: {args.summary}")


if __name__ == "__main__":
    main()
