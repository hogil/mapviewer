#!/usr/bin/env python3
"""
비교 벤치 스크립트
-------------------
- 기존 선형 탐색 vs n-그램 버킷 기반 후보 축소 시의 검색 시간/후보 수를 비교합니다.
- 기본적으로 `.file_index_cache.txt`를 이용해 인덱스를 로드하며, 캐시가 없으면 ROOT_DIR을 직접 스캔합니다.
- 사용 예시:
      python scripts/benchmark_search_ngrams.py --limit 2000 ring_299 "center" "ring and 299"
"""

from __future__ import annotations

import argparse
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Set, Tuple

import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from api import config


def _extract_ngrams(text: str, sizes: Sequence[int]) -> Set[str]:
    tokens: Set[str] = set()
    if not text:
        return tokens
    cleaned = text.strip().lower()
    if not cleaned or not sizes:
        return tokens
    min_size = min(sizes)
    length = len(cleaned)
    for size in sizes:
        if size <= 0 or length < size:
            continue
        for idx in range(length - size + 1):
            token = cleaned[idx : idx + size]
            if not token or any(ch.isspace() for ch in token):
                continue
            tokens.add(token)
    if not tokens and length >= min_size:
        tokens.add(cleaned)
    return tokens


def _load_index_from_cache(root: Path) -> List[str]:
    cache_file = root / ".file_index_cache.txt"
    if not cache_file.exists():
        return []
    with cache_file.open("r", encoding="utf-8") as handle:
        return [line.strip() for line in handle if line.strip()]


def _scan_root(root: Path, skip_dirs: Iterable[str]) -> List[str]:
    skip = {d.strip() for d in skip_dirs if d.strip()}
    keys: List[str] = []
    for current_root, dirnames, filenames in os.walk(root):
        rel_root = Path(current_root).resolve()
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            full_path = (rel_root / name).resolve()
            try:
                rel = str(full_path.relative_to(root)).replace("\\", "/")
            except ValueError:
                continue
            keys.append(rel)
    keys.sort()
    return keys


def _build_meta(keys: Sequence[str]) -> Dict[str, Dict[str, str]]:
    return {rel: {"name_lower": rel.rsplit("/", 1)[-1].lower()} for rel in keys}


def _build_buckets(keys: Sequence[str], meta: Dict[str, Dict[str, str]], sizes: Sequence[int]) -> Dict[str, List[str]]:
    buckets: Dict[str, List[str]] = defaultdict(list)
    for rel in keys:
        name_lower = meta[rel]["name_lower"]
        for token in _extract_ngrams(name_lower, sizes):
            buckets[token].append(rel)
    for token, rels in list(buckets.items()):
        buckets[token] = list(dict.fromkeys(rels))
    return buckets


def _search_linear(keys: Sequence[str], meta: Dict[str, Dict[str, str]], query: str, goal: int) -> List[str]:
    results: List[str] = []
    needle = query.lower()
    for rel in keys:
        if needle in meta[rel]["name_lower"]:
            results.append(rel)
            if len(results) >= goal:
                break
    return results


def _search_with_buckets(
    keys: Sequence[str],
    meta: Dict[str, Dict[str, str]],
    buckets: Dict[str, List[str]],
    sizes: Sequence[int],
    query: str,
    goal: int,
) -> Tuple[List[str], int]:
    tokens = _extract_ngrams(query, sizes)
    if not tokens:
        return _search_linear(keys, meta, query, goal), len(keys)
    candidate: Set[str] | None = None
    for token in tokens:
        hits = buckets.get(token)
        if not hits:
            return [], 0
        hits_set = set(hits)
        if candidate is None:
            candidate = hits_set
        else:
            candidate &= hits_set
        if not candidate:
            return [], 0
    assert candidate is not None
    filtered_keys = [rel for rel in keys if rel in candidate]
    return _search_linear(filtered_keys, meta, query, goal), len(filtered_keys)


def run_benchmark(queries: Sequence[str], limit: int) -> None:
    root = config.ROOT_DIR
    keys = _load_index_from_cache(root)
    if not keys:
        keys = _scan_root(root, config.SKIP_DIRS)
    meta = _build_meta(keys)
    buckets = _build_buckets(keys, meta, config.INDEX_NGRAM_SIZES)

    print(f"# files={len(keys)} | ngram_sizes={config.INDEX_NGRAM_SIZES} | limit={limit}")
    header = f"{'query':30s} {'baseline_ms':>12s} {'bucket_ms':>10s} {'considered':>12s} {'speedup':>9s} {'match':>7s}"
    print(header)
    print("-" * len(header))

    for query in queries:
        start = time.perf_counter()
        baseline_hits = _search_linear(keys, meta, query, limit)
        baseline_ms = (time.perf_counter() - start) * 1000

        start = time.perf_counter()
        bucket_hits, considered = _search_with_buckets(keys, meta, buckets, config.INDEX_NGRAM_SIZES, query, limit)
        bucket_ms = (time.perf_counter() - start) * 1000

        matches = baseline_hits == bucket_hits
        speedup = baseline_ms / bucket_ms if bucket_ms > 0 else float("inf")
        print(
            f"{query[:30]:30s} "
            f"{baseline_ms:12.3f} "
            f"{bucket_ms:10.3f} "
            f"{considered:12d} "
            f"{speedup:9.2f} "
            f"{'yes' if matches else 'no':>7s}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare linear search vs n-gram bucket search speed.")
    parser.add_argument("queries", nargs="*", help="쿼리 문자열. 지정하지 않으면 기본 샘플을 사용합니다.")
    parser.add_argument("--limit", type=int, default=2000, help="검색 결과 제한 (기본 2000)")
    parser.add_argument("--queries-file", type=Path, help="줄 단위 쿼리 목록 파일")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    queries: List[str] = []
    if args.queries_file:
        if not args.queries_file.exists():
            raise SystemExit(f"queries file not found: {args.queries_file}")
        with args.queries_file.open("r", encoding="utf-8") as f:
            queries.extend([line.strip() for line in f if line.strip()])
    if args.queries:
        queries.extend(args.queries)
    if not queries:
        queries = [
            "ring_299",
            "scratch",
            "center",
            "donut",
            "ring and 299",
            "outer",
            "missing",
        ]
    run_benchmark(queries, args.limit)


if __name__ == "__main__":
    main()
