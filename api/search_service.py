"""
검색 엔드포인트 전용 서비스.

IndexService를 사용해 검색 준비/실패시 폴백 스캔까지 책임진다.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .index_service import (
    IndexService,
    _tokenize_logical_query,
    _evaluate_expression,
    is_complex_query,
    search_index_logical,
    search_index_slice_parallel,
)


class SearchService:
    def __init__(
        self,
        index_service: IndexService,
        *,
        io_executor,
        logger,
        search_workers: int,
        excluded_folders: Optional[List[str]] = None,
        supported_exts: Optional[Set[str]] = None,
        fallback_max_files: int = 2000,
        fallback_timeout_sec: float = 5.0,
    ):
        self.index_service = index_service
        self.io_executor = io_executor
        self.logger = logger
        self.search_workers = max(1, search_workers)
        self.excluded_folders = excluded_folders or [
            "classification",
            "classification_chips",
            "chip_annotations",
            "thumbnails",
            "composite_map",
        ]
        # Global search(root 전체)에서는 작업/테스트용 파생 폴더를 기본 검색 결과에서 제외한다.
        # unknown은 실제 failbit 기준 데이터이므로 전역 LOT 검색 결과에 포함한다.
        # 폴더 한정 검색에서는 그대로 허용하여 개별 폴더 확인 흐름은 유지한다.
        self.global_only_excluded_folders = {"my-lot", "fq_missing_test"}
        self.supported_exts = supported_exts or set()
        self.fallback_max_files = fallback_max_files
        self.fallback_timeout_sec = fallback_timeout_sec

    def _current_prefix(self, current_folder: Path) -> Tuple[str, Path]:
        try:
            rel = str(current_folder.resolve().relative_to(self.index_service.root_dir.resolve())).replace("\\", "/")
            prefix = rel if rel != "." else ""
        except Exception:
            prefix = ""
        return prefix, self.index_service.root_dir if not prefix else current_folder

    def _filter_excluded(
        self,
        candidates: List[str],
        extra_excluded: Optional[Set[str]] = None,
    ) -> Tuple[List[str], int]:
        filtered: List[str] = []
        removed = 0
        excluded_parts = set(self.excluded_folders)
        if extra_excluded:
            excluded_parts |= set(extra_excluded)
        for rel in candidates:
            parts = rel.replace("\\", "/").split("/")
            if any(excl in parts for excl in excluded_parts):
                removed += 1
                continue
            filtered.append(rel)
        return filtered, removed

    async def search(
        self,
        *,
        query: str,
        lot_filter: Optional[Set[str]],
        lot_wafer_pairs: Optional[List[tuple]] = None,
        limit: int,
        offset: int,
        current_folder: Path,
    ) -> Dict[str, Any]:
        total_start = time.perf_counter()
        timings: Dict[str, Any] = {}
        lot_filter = lot_filter or set()
        lot_wafer_pairs = lot_wafer_pairs or []
        query_raw = (query or "").strip().lower()

        # 공백/콤마/세미콜론으로 구분된 다중 키워드 지원 (논리 연산자가 없을 때 OR 검색)
        tokens = [tok for tok in re.split(r"[,\s;]+", query_raw) if tok]
        query_for_search = query_raw
        if not is_complex_query(query_raw) and len(tokens) > 1:
            query_for_search = " or ".join(tokens)

        if not query_for_search and not lot_filter and not lot_wafer_pairs:
            timings["total_ms"] = round((time.perf_counter() - total_start) * 1000, 3)
            timings["early_exit"] = True
            timings["lot_filter_count"] = 0
            return {"success": True, "results": [], "offset": offset, "limit": limit, "timings": timings, "total": 0}

        # 인덱스 준비 (캐시 로드/빌드 트리거)
        await self.index_service.ensure_ready_for_search()

        prefix, scan_root = self._current_prefix(current_folder)
        prepare_start = time.perf_counter()
        keys_slice, names_slice = self.index_service.slice_with_prefix(prefix)
        timings["prepare_keys_ms"] = round((time.perf_counter() - prepare_start) * 1000, 3)
        timings["keys_considered"] = len(keys_slice)
        timings["search_prefix"] = prefix
        timings["total_indexed_files"] = len(self.index_service.keys)
        timings["lot_filter_count"] = len(lot_filter)

        # 인덱스가 비어 있으면 대기 후 재시도 (첫 검색 실패 방지)
        if not keys_slice:
            await self.index_service.ensure_ready_for_search(timeout=10.0)
            keys_slice, names_slice = self.index_service.slice_with_prefix(prefix)

        bucket: List[str] = []
        logical_terms: List[str] = []
        effective_workers = 0
        search_mode = "none"
        index_hits: List[str] = []
        elapsed_ms = 0.0
        loop = asyncio.get_running_loop()

        # 실제 검색
        if keys_slice:
            if query_for_search and lot_filter:
                search_start = time.perf_counter()
                # 🔥 LOT 인덱스로 먼저 후보 축소 → query 필터 적용 (501만 전체 스캔 제거)
                folder_name = prefix.split("/")[0] if prefix else ""
                lot_candidates = self.index_service.lot_search(lot_filter, folder_name)
                if lot_candidates:
                    lot_names = [k.rsplit("/", 1)[-1].lower() for k in lot_candidates]
                    complex_query = is_complex_query(query_for_search)
                    if complex_query:
                        raw_tokens = _tokenize_logical_query(query_for_search)
                        logical_terms = [
                            token for token in raw_tokens if token and token not in {"and", "or", "not"} and token not in ("(", ")")
                        ]
                        # 🔥 lot_candidates는 글로벌 _keys의 subset → 글로벌 인덱스 사용 불가
                        # None으로 전달하여 lot_candidates 내 순차 스캔 fallback 사용
                        index_hits = await loop.run_in_executor(
                            self.io_executor, search_index_logical,
                            lot_candidates, lot_names, query_for_search, None, self.search_workers,
                            None, None,
                            None, None,
                        )
                    else:
                        index_hits = await loop.run_in_executor(
                            self.io_executor, search_index_slice_parallel,
                            lot_candidates, lot_names, query_for_search, None, max(1, self.search_workers),
                        )
                    effective_workers = self.search_workers
                else:
                    index_hits = []
                search_mode = "query+lot-index"
                elapsed_ms = round((time.perf_counter() - search_start) * 1000, 3)
            elif query_for_search:
                complex_query = is_complex_query(query_for_search)
                if complex_query:
                    raw_tokens = _tokenize_logical_query(query_for_search)
                    logical_terms = [
                        token for token in raw_tokens if token and token not in {"and", "or", "not"} and token not in ("(", ")")
                    ]
                search_start = time.perf_counter()
                if complex_query:
                    # 🔥 token_index는 전체 _keys 기준 글로벌 인덱스 → folder slice와 불일치
                    # prefix가 있으면(폴더 한정) token_index 없이 순차 스캔 fallback 사용
                    tok_idx = self.index_service._token_index if not prefix else None
                    t0_idx = self.index_service._token0_index if not prefix else None
                    t2_idx = self.index_service._token2_index if not prefix else None
                    index_hits = await loop.run_in_executor(
                        self.io_executor,
                        search_index_logical,
                        keys_slice,
                        names_slice,
                        query_for_search,
                        None,
                        self.search_workers,
                        tok_idx,
                        None,
                        t0_idx,
                        t2_idx,
                    )
                    effective_workers = self.search_workers
                    search_mode = "logical"
                else:
                    # 🔥 전체 검색(prefix 없음)의 단일 키워드는 LOT 토큰(token[0]) 기준으로만 본다.
                    # suffix 토큰까지 순차 스캔으로 확장하면 `wafer_edge_ring` 같은 이름에서
                    # `ring`이 대량 매칭되어 기존 검색 기대값/LOT 의미가 깨진다.
                    if not prefix and self.index_service._token0_index:
                        from .index_service import _token_contains_search
                        hit_indices = _token_contains_search(
                            self.index_service._token0_index, query_for_search, self.index_service._keys)
                        index_hits = [self.index_service._keys[i] for i in hit_indices
                                      if i < len(self.index_service._keys)]
                        search_mode = "simple-token"
                    else:
                        # 순차 스캔 — 대량이면 executor에서 실행 (이벤트루프 블로킹 방지)
                        _q = query_for_search
                        def _seq_scan():
                            return [k for k, n in zip(keys_slice, names_slice) if _q in n]
                        if len(keys_slice) > 50000:
                            index_hits = await loop.run_in_executor(self.io_executor, _seq_scan)
                        else:
                            index_hits = _seq_scan()
                        search_mode = "simple"
                elapsed_ms = round((time.perf_counter() - search_start) * 1000, 3)
            elif lot_filter or lot_wafer_pairs:
                search_start = time.perf_counter()
                folder_name = prefix.split("/")[0] if prefix else ""
                if lot_wafer_pairs:
                    # 🔥 LOT 인덱스로 후보 추출 → wafer 필터링 (O(K) not O(N))
                    all_lots = {lot for lot, _ in lot_wafer_pairs}
                    if lot_filter:
                        all_lots |= lot_filter
                    candidates = self.index_service.lot_search(all_lots, folder_name)
                    index_hits = self._lot_wafer_filter_indexed(candidates, lot_wafer_pairs, lot_filter)
                    search_mode = "lot-wafer-indexed"
                else:
                    # 🔥 LOT 역인덱스로 O(1) 검색 (501만 순차 스캔 제거)
                    index_hits = self.index_service.lot_search(lot_filter, folder_name)
                    search_mode = "lot-index"
                elapsed_ms = round((time.perf_counter() - search_start) * 1000, 3)
            else:
                index_hits = []
                search_mode = "none"

            bucket.extend(index_hits)
        else:
            # 폴백: 파일시스템 직접 스캔 (executor에서 실행 — 이벤트루프 블로킹 방지)
            search_mode = "fallback"
            fallback_results, fallback_meta = await loop.run_in_executor(
                self.io_executor, self._fallback_scan, scan_root, query_for_search, lot_filter
            )
            bucket.extend(fallback_results)
            timings.update(fallback_meta)

        # 제외 폴더 필터링
        extra_excluded = self.global_only_excluded_folders if not prefix else None
        bucket, removed = self._filter_excluded(bucket, extra_excluded=extra_excluded)
        timings["excluded_folders_filtered"] = removed

        # 인덱스 파일 제외
        index_file_names = {".file_index_cache.txt", ".file_index_cache.lock"}
        before_index_filter = len(bucket)
        bucket = [rel for rel in bucket if Path(rel).name not in index_file_names]
        timings["index_files_filtered"] = before_index_filter - len(bucket)

        results = bucket[offset : offset + limit]
        timings["logical_eval_ms"] = elapsed_ms
        timings["search_mode"] = search_mode
        timings["index_executor_ms"] = elapsed_ms
        timings["index_hit_count"] = len(index_hits)
        timings["search_workers"] = effective_workers
        timings["logical_term_count"] = len(logical_terms)
        timings["fallback_invoked"] = search_mode == "fallback"
        timings["total_candidates"] = len(bucket)
        timings["results_count"] = len(results)
        timings["total_ms"] = round((time.perf_counter() - total_start) * 1000, 3)

        # 동일한 로그 포맷 유지
        self.logger.info(
            "SEARCH_TIMING %s",
            json.dumps(
                {"query": query_for_search, "offset": offset, "limit": limit, "timings": timings},
                ensure_ascii=False,
            ),
        )

        return {"success": True, "results": results, "offset": offset, "limit": limit, "total": len(bucket), "timings": timings}

    def _lot_only_scan(self, keys_slice: List[str], names_slice: List[str], lot_filter: Set[str]) -> List[str]:
        """LOT 필터만 적용하여 검색 (속도 최적화: 문자열 포함 검사 한 번)
        
        방식:
        1. 입력된 LOT들을 /로 연결: "/LOTA/LOTB/LOTC/"
        2. 파일명 _ split 후 첫 번째 토큰 추출
        3. 토큰을 /로 감싸서 연결 문자열에 포함되는지 확인
        """
        if not lot_filter:
            return []
        hits: List[str] = []
        for rel, name_lower in zip(keys_slice, names_slice):
            # 파일명을 _ 로 split하고 첫 번째 토큰 추출
            lot_token = name_lower.split("_", 1)[0]
            if self._lot_matches_filter(lot_token, lot_filter):
                hits.append(rel)
        return hits

    @staticmethod
    def _lot_matches_filter(lot_token: str, lot_filter: Set[str]) -> bool:
        return any(lot_token == lot or lot_token.startswith(lot) for lot in lot_filter)

    @staticmethod
    def _wafer_matches_filter(file_wafer: str, wafer_filter: str) -> bool:
        return file_wafer == wafer_filter or file_wafer.startswith(wafer_filter)

    def _matching_pair_lots(self, lot_token: str, pair_map: Dict[str, set]) -> List[str]:
        return [
            lot
            for lot in pair_map.keys()
            if lot_token == lot or lot_token.startswith(lot)
        ]

    @staticmethod
    def _filter_to_prefix(candidates: List[str], prefix: str) -> List[str]:
        if not prefix:
            return candidates
        normalized_prefix = prefix.replace("\\", "/").strip("/")
        if not normalized_prefix:
            return candidates
        base = normalized_prefix + "/"
        return [rel for rel in candidates if rel == normalized_prefix or rel.startswith(base)]

    def _apply_lot_filter(self, hits: List[str], lot_filter: Set[str]) -> List[str]:
        """검색 결과에 LOT 필터 적용 (속도 최적화: 문자열 포함 검사 한 번)"""
        if not lot_filter:
            return hits

        filtered: List[str] = []
        for rel in hits:
            name_lower = Path(rel).name.lower()
            # 파일명을 _ 로 split하고 첫 번째 토큰 추출
            lot_token = name_lower.split("_", 1)[0]
            # 토큰이 연결 문자열에 포함되는지 확인
            if self._lot_matches_filter(lot_token, lot_filter):
                filtered.append(rel)
        return filtered

    def _lot_wafer_scan(self, keys_slice: List[str], names_slice: List[str],
                        lot_wafer_pairs: List[tuple], lot_filter: Set[str]) -> List[str]:
        """LOT+WAFER 쌍 매칭 스캔 (LOT 먼저 빠르게 필터 → WAFER는 통과 파일만 체크)

        파일명 형식: LOT_BINTYPE_WAFER_TIMESTAMP.png
        - lot_wafer_pairs: [(lot, wafer), ...] → LOT(index 0) + WAFER(index 2) 모두 매칭
        - lot_filter: LOT만 매칭 (WAFER 무관)
        """
        pair_map: Dict[str, set] = {}
        for lot, wafer in lot_wafer_pairs:
            pair_map.setdefault(lot, set()).add(wafer)

        lot_only = lot_filter - set(pair_map.keys()) if lot_filter else set()

        hits: List[str] = []
        for rel, name_lower in zip(keys_slice, names_slice):
            # 🔥 1단계: LOT 빠른 프리필터 (split("_", 1)로 최소 분할)
            lot_token = name_lower.split("_", 1)[0]
            matching_pair_lots = self._matching_pair_lots(lot_token, pair_map)
            lot_only_match = self._lot_matches_filter(lot_token, lot_only) if lot_only else False
            if not matching_pair_lots and not lot_only_match:
                continue

            # 2단계: LOT 통과 → WAFER 체크 (필요한 파일만)
            if matching_pair_lots:
                parts = name_lower.split("_", 3)
                file_wafer = parts[2] if len(parts) > 2 else ""
                if any(
                    self._wafer_matches_filter(file_wafer, wafer)
                    for lot in matching_pair_lots
                    for wafer in pair_map[lot]
                ):
                    hits.append(rel)
            elif lot_only_match:
                hits.append(rel)
        return hits

    def _lot_wafer_filter_indexed(self, candidates: List[str],
                                  lot_wafer_pairs: List[tuple],
                                  lot_filter: Set[str]) -> List[str]:
        """LOT 인덱스 후보에서 wafer 필터링 (O(K) — 후보 수만큼만 처리)"""
        pair_map: Dict[str, set] = {}
        for lot, wafer in lot_wafer_pairs:
            pair_map.setdefault(lot, set()).add(wafer)
        lot_only = lot_filter - set(pair_map.keys()) if lot_filter else set()
        hits: List[str] = []
        for rel in candidates:
            name_lower = rel.rsplit("/", 1)[-1].lower() if "/" in rel else rel.lower()
            lot_token = name_lower.split("_", 1)[0]
            matching_pair_lots = self._matching_pair_lots(lot_token, pair_map)
            lot_only_match = self._lot_matches_filter(lot_token, lot_only) if lot_only else False
            if matching_pair_lots:
                parts = name_lower.split("_", 3)
                file_wafer = parts[2] if len(parts) > 2 else ""
                if any(
                    self._wafer_matches_filter(file_wafer, wafer)
                    for lot in matching_pair_lots
                    for wafer in pair_map[lot]
                ):
                    hits.append(rel)
            elif lot_only_match:
                hits.append(rel)
        return hits

    def _apply_lot_wafer_filter(self, hits: List[str], lot_wafer_pairs: List[tuple],
                                lot_filter: Set[str]) -> List[str]:
        """검색 결과에 LOT+WAFER 필터 적용 (LOT 프리필터 → WAFER 체크)"""
        pair_map: Dict[str, set] = {}
        for lot, wafer in lot_wafer_pairs:
            pair_map.setdefault(lot, set()).add(wafer)

        lot_only = lot_filter - set(pair_map.keys()) if lot_filter else set()

        filtered: List[str] = []
        for rel in hits:
            name_lower = Path(rel).name.lower()
            lot_token = name_lower.split("_", 1)[0]
            matching_pair_lots = self._matching_pair_lots(lot_token, pair_map)
            lot_only_match = self._lot_matches_filter(lot_token, lot_only) if lot_only else False
            if not matching_pair_lots and not lot_only_match:
                continue

            if matching_pair_lots:
                parts = name_lower.split("_", 3)
                file_wafer = parts[2] if len(parts) > 2 else ""
                if any(
                    self._wafer_matches_filter(file_wafer, wafer)
                    for lot in matching_pair_lots
                    for wafer in pair_map[lot]
                ):
                    filtered.append(rel)
            elif lot_only_match:
                filtered.append(rel)
        return filtered

    def _fallback_scan(
        self,
        scan_root: Path,
        query: str,
        lot_filter: Set[str],
    ) -> Tuple[List[str], Dict[str, Any]]:
        """인덱스가 비어 있을 때 폴백 스캔."""
        start = time.perf_counter()
        hits: List[str] = []
        scanned_files = 0
        scanned_dirs = 0
        meta: Dict[str, Any] = {
            "fallback_invoked": True,
            "fallback_goal": self.fallback_max_files,
            "fallback_max_files": self.fallback_max_files,
            "fallback_timeout_ms": int(self.fallback_timeout_sec * 1000),
        }
        deadline = start + self.fallback_timeout_sec if self.fallback_timeout_sec > 0 else None

        # 인덱스 파일 제외
        index_file_names = {".file_index_cache.txt", ".file_index_cache.lock"}
        
        for root, dirs, files in os.walk(scan_root):
            dirs[:] = [d for d in dirs if d not in self.excluded_folders]
            scanned_dirs += 1
            for fn in files:
                scanned_files += 1
                # 인덱스 파일 제외
                if fn in index_file_names:
                    continue
                ext = Path(fn).suffix.lower()
                if self.supported_exts and ext not in self.supported_exts:
                    continue
                name_lower = fn.lower()
                if lot_filter:
                    # 🔥 속도 최적화: 파일명 _ split 후 첫 번째 토큰이 LOT 목록에 있는지 확인
                    lot_token = name_lower.split("_", 1)[0]
                    if not self._lot_matches_filter(lot_token, lot_filter):
                        continue
                if query:
                    # 🔥 포함 검색: 파일명에 검색어가 포함되면 매칭
                    if not _evaluate_expression(name_lower, query):
                        continue
                rel = Path(root).joinpath(fn).relative_to(self.index_service.root_dir)
                hits.append(str(rel).replace("\\", "/"))
                if self.fallback_max_files and len(hits) >= self.fallback_max_files:
                    break
            if self.fallback_max_files and len(hits) >= self.fallback_max_files:
                break
            if deadline and time.perf_counter() > deadline:
                break

        meta["fallback_scan_ms"] = round((time.perf_counter() - start) * 1000, 3)
        meta["fallback_files_scanned"] = scanned_files
        meta["fallback_dirs_scanned"] = scanned_dirs
        meta["fallback_new_hits"] = len(hits)
        meta["fallback_truncated"] = bool(self.fallback_max_files and len(hits) >= self.fallback_max_files)
        meta["fallback_remaining_need"] = 0
        return hits, meta


__all__ = ["SearchService"]
