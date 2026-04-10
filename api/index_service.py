"""
Index 및 검색 핵심 로직을 담당하는 서비스 모듈.

 - 파일 인덱스 메모리 구조 관리
 - 캐시 파일 로드/저장
 - 백그라운드 인덱스 빌드 (락 파일로 다중 프로세스 동기화)
 - 단순/논리 검색 헬퍼
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import re
import threading
import time
from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock, RLock
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

_LOGICAL_OPERATORS = {"and", "or", "not"}
_LOGICAL_PRECEDENCE = {"or": 1, "and": 2, "not": 3}
_OPERATOR_PATTERNS = {
    "and": re.compile(r"\band\b", re.IGNORECASE),
    "or": re.compile(r"\bor\b", re.IGNORECASE),
    "not": re.compile(r"\bnot\b", re.IGNORECASE),
}


def _split_by_operator(text: str, operator: str) -> List[str]:
    """연산자로 문자열 분할 (단어 경계 고려)."""
    pattern = _OPERATOR_PATTERNS.get(operator)
    if not pattern:
        pattern = re.compile(r"\b" + operator + r"\b", re.IGNORECASE)
    parts = pattern.split(text)
    return [p for p in parts if p.strip()]


def _evaluate_basic_term(filename: str, term: str) -> bool:
    if not term or term in ("0", "1"):
        return term == "1"
    # 🔥 포함 검색: 파일명에 검색어가 포함되면 매칭
    return term in filename


def _evaluate_not_expression(filename: str, expression: str) -> bool:
    if expression.startswith("not "):
        term = expression[4:].strip()
        return not _evaluate_basic_term(filename, term)
    return _evaluate_basic_term(filename, expression)


def _evaluate_and_expression(filename: str, expression: str) -> bool:
    terms = _split_by_operator(expression, "and")
    for term in terms:
        if not _evaluate_not_expression(filename, term.strip()):
            return False
    return True


def _evaluate_expression(filename: str, expression: str) -> bool:
    """괄호 + AND/OR/NOT 표현식 평가."""
    while "(" in expression:
        start = expression.rfind("(")
        end = expression.find(")", start)
        if end == -1:
            break
        sub_expr = expression[start + 1 : end]
        result = _evaluate_expression(filename, sub_expr)
        expression = expression[:start] + ("1" if result else "0") + expression[end + 1 :]

    or_terms = _split_by_operator(expression, "or")
    if len(or_terms) > 1:
        return any(_evaluate_and_expression(filename, term.strip()) for term in or_terms)

    return _evaluate_and_expression(filename, expression)


def _tokenize_logical_query(query: str) -> List[str]:
    tokens: List[str] = []
    i = 0
    length = len(query)
    while i < length:
        ch = query[i]
        if ch in ("(", ")"):
            tokens.append(ch)
            i += 1
            continue
        if ch.isspace():
            i += 1
            continue
        j = i
        while j < length and query[j] not in ("(", ")") and not query[j].isspace():
            j += 1
        token = query[i:j].strip().lower()
        if token:
            tokens.append(token)
        i = j
    return tokens


def _logical_to_postfix(tokens: List[str]) -> List[str]:
    """중위 표기 → 후위 표기 변환 (Shunting-yard)."""
    stack: List[str] = []
    output: List[str] = []
    for token in tokens:
        if token == "(":
            stack.append(token)
        elif token == ")":
            while stack and stack[-1] != "(":
                output.append(stack.pop())
            if stack and stack[-1] == "(":
                stack.pop()
        elif token in _LOGICAL_OPERATORS:
            while stack and stack[-1] in _LOGICAL_OPERATORS:
                top = stack[-1]
                if token == "not":
                    if _LOGICAL_PRECEDENCE[top] > _LOGICAL_PRECEDENCE[token]:
                        output.append(stack.pop())
                    else:
                        break
                else:
                    if _LOGICAL_PRECEDENCE[top] >= _LOGICAL_PRECEDENCE[token]:
                        output.append(stack.pop())
                    else:
                        break
            stack.append(token)
        else:
            output.append(token)
    while stack:
        output.append(stack.pop())
    return output


def _token_contains_search(token_index: Dict[str, List[int]], term: str, keys_slice: List[str],
                            constraint: Optional[Set[int]] = None) -> Set[int]:
    """토큰 역인덱스에서 포함매칭 (대소문자 무시)."""
    indices: Set[int] = set()
    term_lower = term.lower()
    for token, idx_list in token_index.items():
        if term_lower in token:
            if constraint is not None:
                indices.update(i for i in idx_list if i in constraint)
            else:
                indices.update(idx_list)
    return indices


def _collect_term_hits(keys_slice: List[str], names_slice: List[str], tokens: List[str], max_workers: int,
                       names_joined: bytes = b"", names_offsets: List[int] = None) -> Dict[str, Set[str]]:
    """각 용어별 히트 집합을 구성. 토큰 인덱스 사용 시 포함매칭 + 순차 축소."""
    unique_terms = [
        token for token in tokens if token and token not in _LOGICAL_OPERATORS and token not in ("(", ")")
    ]
    unique_terms = list(dict.fromkeys(unique_terms))
    if not unique_terms:
        return {}

    # 🔥 토큰 인덱스 사용: 포함매칭 + 순차 축소 (작은 결과 먼저)
    if isinstance(names_joined, dict) and names_joined:
        token_index = names_joined
        n = len(keys_slice)
        term_hits: Dict[str, Set[int]] = {}

        # 히트 수 예측: 정확매칭 있으면 그 크기, 없으면 큰 값
        def _estimate(term: str) -> int:
            exact = token_index.get(term)
            if exact is not None:
                return len(exact)
            return n  # 포함매칭은 크기 모름 → 큰 값

        # 히트 수 적은 용어부터 검색 (순차 축소)
        sorted_terms = sorted(unique_terms, key=_estimate)

        for term in sorted_terms:
            term_hits[term] = _token_contains_search(token_index, term, keys_slice)

        # key로 변환 (인덱스 → 경로)
        result: Dict[str, Set[str]] = {}
        for term, idx_set in term_hits.items():
            result[term] = {keys_slice[i] for i in idx_set if i < n}
        return result

    # fallback: 단일 패스 순차 스캔
    term_hits_str: Dict[str, Set[str]] = {t: set() for t in unique_terms}
    for rel, name_lower in zip(keys_slice, names_slice):
        for term in unique_terms:
            if term in name_lower:
                term_hits_str[term].add(rel)
    return term_hits_str


def _evaluate_logical_query(
    keys_slice: List[str], names_slice: List[str], query: str, limit: Optional[int] = None, max_workers: int = 4,
    names_joined: bytes = b"", names_offsets: List[int] = None,
    token0_index: Optional[Dict[str, List[int]]] = None,
    token2_index: Optional[Dict[str, List[int]]] = None,
) -> List[str]:
    tokens = _tokenize_logical_query(query)
    postfix = _logical_to_postfix(tokens)

    # 🔥 토큰 인덱스가 있으면 lazy 평가
    token_index = names_joined if isinstance(names_joined, dict) else None
    n = len(keys_slice)

    if token_index:
        # 🔥 모든 검색은 token[0] 기반, AND 오른쪽만 token[2] 추가 필터
        t0_idx = token0_index if token0_index is not None else token_index
        t2_idx = token2_index if token2_index is not None else token_index

        def _search_t0(term_or_set, constraint: Optional[Set[int]] = None):
            """기본 검색: token[0] 인덱스에서 포함매칭."""
            if isinstance(term_or_set, set):
                return term_or_set if constraint is None else term_or_set & constraint
            return _token_contains_search(t0_idx, term_or_set, keys_slice, constraint)

        def _search_t2(term_or_set, constraint: Optional[Set[int]] = None):
            """AND 오른쪽: token[2] 인덱스에서 포함매칭."""
            if isinstance(term_or_set, set):
                return term_or_set if constraint is None else term_or_set & constraint
            return _token_contains_search(t2_idx, term_or_set, keys_slice, constraint)

        universe: Optional[Set[int]] = None
        if "not" in postfix:
            universe = set(range(n))
        stack: List = []
        for tok in postfix:
            if tok in _LOGICAL_OPERATORS:
                if tok == "not":
                    operand = stack.pop() if stack else set()
                    op_set = _search_t0(operand)
                    if universe is None:
                        universe = set(range(n))
                    stack.append(universe - op_set)
                elif tok == "and":
                    right = stack.pop() if stack else set()
                    left = stack.pop() if stack else set()
                    # 🔥 AND: left→token[0], right→token[2] 순차 축소
                    if isinstance(left, str) and isinstance(right, str):
                        left_set = _search_t0(left)
                        stack.append(_search_t2(right, constraint=left_set))
                    elif isinstance(left, str):
                        left_set = _search_t0(left)
                        stack.append(left_set & right)
                    elif isinstance(right, str):
                        stack.append(_search_t2(right, constraint=left))
                    else:
                        stack.append(left & right)
                elif tok == "or":
                    right = stack.pop() if stack else set()
                    left = stack.pop() if stack else set()
                    stack.append(_search_t0(left) | _search_t0(right))
            else:
                stack.append(tok)  # str 그대로 push (lazy)

        result_item = stack.pop() if stack else set()
        result_indices = _search_t0(result_item) if isinstance(result_item, str) else result_item
        ordered = [keys_slice[i] for i in sorted(result_indices) if i < n]
        if limit is not None:
            return ordered[:limit]
        return ordered

    # fallback: 기존 방식
    term_hits = _collect_term_hits(keys_slice, names_slice, tokens, max_workers)
    universe_str: Optional[Set[str]] = None
    if "not" in postfix:
        universe_str = set(keys_slice)
    stack_str: List[Set[str]] = []
    for token in postfix:
        if token in _LOGICAL_OPERATORS:
            if token == "not":
                operand = stack_str.pop() if stack_str else set()
                if universe_str is None:
                    universe_str = set(keys_slice)
                stack_str.append(universe_str - operand)
            else:
                right = stack_str.pop() if stack_str else set()
                left = stack_str.pop() if stack_str else set()
                if token == "and":
                    stack_str.append(left & right)
                elif token == "or":
                    stack_str.append(left | right)
        else:
            stack_str.append(term_hits.get(token, set()))
    result_set = stack_str.pop() if stack_str else set()
    ordered_hits: List[str] = []
    for rel in keys_slice:
        if rel in result_set:
            ordered_hits.append(rel)
            if limit is not None and len(ordered_hits) >= limit:
                break
    return ordered_hits


def is_complex_query(query: str) -> bool:
    tokens = _tokenize_logical_query(query)
    return any(tok in _LOGICAL_OPERATORS or tok in ("(", ")") for tok in tokens)


def search_index_slice(keys: List[str], names: List[str], query: str, goal: Optional[int] = None) -> List[str]:
    """단일 청크 단순 검색 (포함 검색)."""
    if not query:
        return []
    hits: List[str] = []
    for rel, name_lower in zip(keys, names):
        if query in name_lower:
            hits.append(rel)
            if goal is not None and len(hits) >= goal:
                break
    return hits


def search_index_slice_parallel(
    keys: List[str],
    names: List[str],
    query: str,
    goal: Optional[int] = None,
    num_chunks: int = 4,
) -> List[str]:
    """멀티 청크 단순 검색."""
    if not keys:
        return []
    num_chunks = max(1, num_chunks)
    if len(keys) < num_chunks * 10:
        return search_index_slice(keys, names, query, goal)

    chunk_size = len(keys) // num_chunks
    key_chunks: List[List[str]] = []
    name_chunks: List[List[str]] = []
    for i in range(num_chunks):
        start = i * chunk_size
        end = start + chunk_size if i < num_chunks - 1 else len(keys)
        key_chunks.append(keys[start:end])
        name_chunks.append(names[start:end])

    results: List[str] = []
    with ThreadPoolExecutor(max_workers=num_chunks) as executor:
        futures = [
            executor.submit(search_index_slice, key_chunk, name_chunk, query, goal)
            for key_chunk, name_chunk in zip(key_chunks, name_chunks)
        ]
        for future in as_completed(futures):
            try:
                chunk_results = future.result()
                results.extend(chunk_results)
                if goal is not None and len(results) >= goal:
                    break
            except Exception:
                continue
    return results[:goal] if goal is not None else results


def search_index_logical(
    keys: List[str], names: List[str], query: str, goal: Optional[int] = None, max_workers: int = 4,
    names_joined: bytes = b"", names_offsets: List[int] = None,
    token0_index: Optional[Dict[str, List[int]]] = None,
    token2_index: Optional[Dict[str, List[int]]] = None,
) -> List[str]:
    if not keys or not query:
        return []
    return _evaluate_logical_query(keys, names, query, goal, max_workers,
                                   names_joined=names_joined, names_offsets=names_offsets,
                                   token0_index=token0_index, token2_index=token2_index)


def _matches_search_query(filename_lower: str, query: str) -> bool:
    if not query:
        return True
    try:
        return _evaluate_expression(filename_lower, query)
    except Exception:
        return query in filename_lower


class IndexService:
    """파일 인덱스 관리 및 검색 보조 기능."""

    def __init__(
        self,
        root_dir: Path,
        skip_dirs: Set[str],
        cache_file: Path,
        lock_file: Path,
        index_workers: int,
        lock_wait_seconds: int = 600,
        logger: Optional[logging.Logger] = None,
    ):
        self.root_dir = root_dir
        self.skip_dirs = skip_dirs
        self.cache_file = cache_file
        self.lock_file = lock_file
        self.index_workers = max(1, index_workers)
        self.lock_wait_seconds = max(1, lock_wait_seconds)
        self.logger = logger or logging.getLogger("uvicorn.error")

        self._file_index: Dict[str, Dict[str, Any]] = {}
        self._keys: List[str] = []
        self._names: List[str] = []
        self._lot_index: Dict[str, List[int]] = {}   # lot_token -> [indices]
        self._folder_index: Dict[str, List[int]] = {} # folder_name -> [indices]
        self._token_index: Dict[str, List[int]] = {}    # token -> [indices] (파일명 _ split)
        self._token0_index: Dict[str, List[int]] = {}   # token[0] -> [indices] (LOT 위치)
        self._token2_index: Dict[str, List[int]] = {}   # token[2] -> [indices] (WAFER 위치)
        self._name_to_paths: Dict[str, List[str]] = {}  # filename -> [rel_paths] (classification 제외)
        self._class_to_keys: Dict[str, List[str]] = {}  # "classification/classname" -> [rel_paths]
        self._CLASSIFICATION_DIRS = {"classification", "classification_chips"}
        self._lock = RLock()
        self._async_build_lock = asyncio.Lock()
        self._io_pool: Optional[Any] = None  # 외부에서 주입 (DEFAULT executor 경합 방지)
        self._cache_loaded = False
        self.loading_cache = False

        self.ready = False
        self.building = False
        self.total_files = 0
        self.total_dirs = 0
        self.completed_dirs = 0
        self.build_started_at = 0.0
        self.build_completed_at = 0.0
        self.loading_cache = False
        self._refresh_task: Optional[asyncio.Task] = None

    # ------------- 기본 프로퍼티 -------------
    @property
    def file_index(self) -> Dict[str, Dict[str, Any]]:
        return self._file_index

    @property
    def keys(self) -> List[str]:
        return self._keys

    @property
    def names(self) -> List[str]:
        return self._names

    @property
    def lock(self) -> RLock:
        return self._lock

    @property
    def name_to_paths(self) -> Dict[str, List[str]]:
        """파일명 → 원본 경로 목록 (classification 디렉토리 제외). 인덱스 빌드 시 구축됨."""
        return self._name_to_paths

    # ------------- classification 인덱스 조회/변경 -------------

    def classification_images(self, class_prefix: str) -> List[str]:
        """classification prefix로 이미지 경로 목록 조회. e.g. 'classification/myclass' → [rel_paths]"""
        with self._lock:
            return list(self._class_to_keys.get(class_prefix, []))

    def add_classification_entry(self, rel_key: str) -> None:
        """분류 추가 시 인덱스에 즉시 반영."""
        with self._lock:
            key_parts = rel_key.split("/")
            cls_prefix = None
            if len(key_parts) >= 3 and key_parts[0] in self._CLASSIFICATION_DIRS:
                cls_prefix = key_parts[0] + "/" + key_parts[1]
            elif len(key_parts) >= 4 and key_parts[1] in self._CLASSIFICATION_DIRS:
                cls_prefix = "/".join(key_parts[:3])
            if cls_prefix:
                lst = self._class_to_keys.get(cls_prefix)
                if lst is None:
                    self._class_to_keys[cls_prefix] = [rel_key]
                elif rel_key not in lst:
                    lst.append(rel_key)

    def remove_classification_entry(self, rel_key: str) -> None:
        """분류 삭제 시 인덱스에서 즉시 제거."""
        with self._lock:
            key_parts = rel_key.split("/")
            cls_prefix = None
            if len(key_parts) >= 3 and key_parts[0] in self._CLASSIFICATION_DIRS:
                cls_prefix = key_parts[0] + "/" + key_parts[1]
            elif len(key_parts) >= 4 and key_parts[1] in self._CLASSIFICATION_DIRS:
                cls_prefix = "/".join(key_parts[:3])
            if cls_prefix:
                lst = self._class_to_keys.get(cls_prefix)
                if lst:
                    try:
                        lst.remove(rel_key)
                    except ValueError:
                        pass
                    if not lst:
                        del self._class_to_keys[cls_prefix]

    def rename_classification_prefix(self, old_prefix: str, new_prefix: str) -> None:
        """클래스 폴더 이름 변경 시 prefix 전체를 즉시 갱신."""
        with self._lock:
            old_items = self._class_to_keys.pop(old_prefix, [])
            if not old_items:
                return
            renamed_items = []
            old_base = old_prefix + "/"
            new_base = new_prefix + "/"
            for rel_key in old_items:
                if rel_key.startswith(old_base):
                    renamed_items.append(new_base + rel_key[len(old_base):])
                else:
                    renamed_items.append(rel_key)
            existing = self._class_to_keys.get(new_prefix, [])
            merged = existing + [item for item in renamed_items if item not in existing]
            self._class_to_keys[new_prefix] = merged

    def delete_classification_prefix(self, class_prefix: str) -> None:
        """클래스 폴더 전체 삭제 시 prefix 인덱스를 즉시 제거."""
        with self._lock:
            self._class_to_keys.pop(class_prefix, None)

    # ------------- 캐시 -------------
    def clear(self) -> None:
        with self._lock:
            self._file_index.clear()
            self._keys = []
            self._names = []
            self._lot_index = {}
            self._folder_index = {}
            self._token_index = {}
            self._token0_index = {}
            self._token2_index = {}
            self._name_to_paths = {}
            self._class_to_keys = {}
        self.ready = False
        self.total_files = 0
        self.total_dirs = 0
        self.completed_dirs = 0
        self.build_started_at = 0.0
        self.build_completed_at = 0.0

    def _compute_lookup_indices(
        self,
        keys: List[str],
        names: List[str],
    ) -> Tuple[Dict[str, List[int]], Dict[str, List[int]], Dict[str, List[int]], Dict[str, List[str]], float,
               Dict[str, List[int]], Dict[str, List[int]], Dict[str, List[str]]]:
        """주어진 keys/names 스냅샷으로 역인덱스를 계산한다."""
        from collections import defaultdict

        t0 = time.time()
        lot_idx: Dict[str, List[int]] = {}
        folder_idx: Dict[str, List[int]] = {}
        token_idx: Dict[str, List[int]] = defaultdict(list)
        # 🔥 위치별 토큰 인덱스: AND 검색용 (token[0]=LOT, token[2]=WAFER)
        token0_idx: Dict[str, List[int]] = defaultdict(list)
        token2_idx: Dict[str, List[int]] = defaultdict(list)
        name_to_paths: Dict[str, List[str]] = {}
        class_to_keys: Dict[str, List[str]] = defaultdict(list)
        classification_dir_names = self._CLASSIFICATION_DIRS

        for i, (key, name) in enumerate(zip(keys, names)):
            # 초기 캐시 로드가 과도하게 길어지지 않도록 yield 빈도를 낮춘다.
            if i % 50000 == 0 and i > 0:
                time.sleep(0.001)
            lot = name.split("_", 1)[0]
            if lot not in lot_idx:
                lot_idx[lot] = []
            lot_idx[lot].append(i)

            slash = key.find("/")
            folder = key[:slash] if slash > 0 else ""
            if folder:
                if folder not in folder_idx:
                    folder_idx[folder] = []
                folder_idx[folder].append(i)

            dot = name.rfind(".")
            stem = name[:dot] if dot > 0 else name
            parts = stem.split("_")
            for token in parts:
                token_idx[token.lower()].append(i)
            # 위치별 인덱스 빌드 (lowercase)
            if len(parts) > 0:
                token0_idx[parts[0].lower()].append(i)
            if len(parts) > 2:
                token2_idx[parts[2].lower()].append(i)

            # classification/classification_chips → class_to_keys 인덱스
            key_parts = key.split("/")
            is_cls = False
            if len(key_parts) >= 3 and key_parts[0] in classification_dir_names:
                # "classification/classname/image.png"
                cls_prefix = key_parts[0] + "/" + key_parts[1]
                class_to_keys[cls_prefix].append(key)
                is_cls = True
            elif len(key_parts) >= 4 and key_parts[1] in classification_dir_names:
                # "subfolder/classification/classname/image.png"
                cls_prefix = "/".join(key_parts[:3])
                class_to_keys[cls_prefix].append(key)
                is_cls = True

            if not is_cls and folder not in classification_dir_names:
                orig_name = key.rsplit("/", 1)[-1]
                if orig_name not in name_to_paths:
                    name_to_paths[orig_name] = []
                name_to_paths[orig_name].append(key)

        elapsed = time.time() - t0
        return lot_idx, folder_idx, dict(token_idx), name_to_paths, elapsed, dict(token0_idx), dict(token2_idx), dict(class_to_keys)

    def _compute_basic_indices(
        self,
        keys: List[str],
        names: List[str],
    ) -> Tuple[Dict[str, List[int]], Dict[str, List[int]], Dict[str, List[str]], float]:
        """첫 캐시 로드용 최소 인덱스(LOT/폴더/class_to_keys)만 계산한다."""
        from collections import defaultdict
        t0 = time.time()
        lot_idx: Dict[str, List[int]] = {}
        folder_idx: Dict[str, List[int]] = {}
        class_to_keys: Dict[str, List[str]] = defaultdict(list)
        classification_dir_names = self._CLASSIFICATION_DIRS

        for i, (key, name) in enumerate(zip(keys, names)):
            if i % 50000 == 0 and i > 0:
                time.sleep(0.001)

            lot = name.split("_", 1)[0]
            if lot not in lot_idx:
                lot_idx[lot] = []
            lot_idx[lot].append(i)

            slash = key.find("/")
            folder = key[:slash] if slash > 0 else ""
            if folder:
                if folder not in folder_idx:
                    folder_idx[folder] = []
                folder_idx[folder].append(i)

            # classification → class_to_keys
            key_parts = key.split("/")
            if len(key_parts) >= 3 and key_parts[0] in classification_dir_names:
                cls_prefix = key_parts[0] + "/" + key_parts[1]
                class_to_keys[cls_prefix].append(key)
            elif len(key_parts) >= 4 and key_parts[1] in classification_dir_names:
                cls_prefix = "/".join(key_parts[:3])
                class_to_keys[cls_prefix].append(key)

        elapsed = time.time() - t0
        return lot_idx, folder_idx, dict(class_to_keys), elapsed

    def load_cache(self, log: bool = True) -> bool:
        if not self.cache_file.exists():
            return False

        while True:
            with self._lock:
                if not self.loading_cache:
                    self.loading_cache = True
                    break
                if self.ready and self._keys:
                    return True
            time.sleep(0.05)

        load_start = time.time()
        if log:
            self.logger.info("📂 [INDEX] Cache load started: %s", self.cache_file.name)

        try:
            try:
                with self.cache_file.open("r", encoding="utf-8") as f:
                    keys = [line.strip() for line in f if line.strip()]
            except Exception as exc:
                self.logger.warning(f"[INDEX] 캐시 로드 실패: {exc}")
                return False
            if not keys:
                return False
            # 파일명만 검색 대상으로 사용 (폴더명 제외)
            names = [rel.rsplit("/", 1)[-1].lower() for rel in keys]
            lot_idx, folder_idx, class_to_keys, basic_elapsed = self._compute_basic_indices(keys, names)
            with self._lock:
                self._keys = keys
                self._names = names
                self._lot_index = lot_idx
                self._folder_index = folder_idx
                self._token_index = {}
                self._token0_index = {}
                self._token2_index = {}
                self._name_to_paths = {}
                self._class_to_keys = class_to_keys
            self.total_files = len(keys)
            self.total_dirs = 0
            self.completed_dirs = 0
            self.build_started_at = time.time()
            self.build_completed_at = self.build_started_at
            self.ready = True

            load_duration = time.time() - load_start
            if log and not self._cache_loaded:
                self.logger.info("✅ [INDEX] Cache load complete: %d files (%.2fs)", self.total_files, load_duration)
            if log:
                self.logger.info(
                    "✅ [INDEX] Basic indices built from cache: %d LOTs, %d folders, %d class prefixes (%.2fs)",
                    len(lot_idx),
                    len(folder_idx),
                    len(class_to_keys),
                    basic_elapsed,
                )
            self._cache_loaded = True
            return True
        finally:
            with self._lock:
                self.loading_cache = False

    def _save_cache(self, keys: List[str]) -> None:
        """인덱스 캐시 파일 저장 (원자적 쓰기)"""
        if not keys:
            self.logger.warning("[INDEX] 빈 키 리스트로 캐시 저장 시도, 건너뜀")
            return
        try:
            tmp_path = self.cache_file.with_suffix(".tmp")
            # 🔥 디렉토리가 없으면 생성
            tmp_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 임시 파일에 한번에 쓰기 (400만 줄 단위 write 대신)
            with tmp_path.open("w", encoding="utf-8") as f:
                f.write("\n".join(keys))
                f.write("\n")
            
            # 원자적 교체 (Windows에서도 안전)
            if self.cache_file.exists():
                self.cache_file.unlink()
            tmp_path.replace(self.cache_file)
            
            # 파일이 실제로 생성되었는지 확인
            if self.cache_file.exists():
                file_size = self.cache_file.stat().st_size
                self.logger.info(f"✅ [INDEX] 캐시 저장 완료: {len(keys)}개 파일, 크기: {file_size:,} bytes")
            else:
                self.logger.error(f"❌ [INDEX] 캐시 파일이 생성되지 않음: {self.cache_file}")
        except Exception as exc:
            self.logger.error(f"❌ [INDEX] 캐시 저장 실패: {exc}", exc_info=True)

    # ------------- 락 파일 -------------
    def _lock_file_stale(self) -> bool:
        if not self.lock_file.exists():
            return False
        try:
            with self.lock_file.open("r", encoding="utf-8") as f:
                content = f.read().strip()
            pid = int(content) if content else -1
        except Exception:
            try:
                self.lock_file.unlink()
            except Exception:
                pass
            return True
        try:
            os.kill(pid, 0)
        except OSError as exc:
            if exc.errno:
                try:
                    self.lock_file.unlink()
                except Exception:
                    pass
            return True
        except Exception:
            return True
        return False

    def _acquire_lock(self, timeout: int) -> Optional[int]:
        deadline = time.time() + max(1, timeout)
        wait_logged = False
        while True:
            try:
                fd = os.open(str(self.lock_file), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode("utf-8", "ignore"))
                return fd
            except FileExistsError:
                if self._lock_file_stale():
                    continue
                if not wait_logged:
                    self.logger.info("🕒 [INDEX] 잠금 대기 중 (다른 프로세스가 빌드 중)")
                    wait_logged = True
                if time.time() >= deadline:
                    return None
                time.sleep(0.5)
            except Exception as exc:
                self.logger.warning(f"[INDEX] 잠금 파일 획득 실패: {exc}")
                time.sleep(0.5)

    def _try_acquire_lock_once(self) -> Optional[int]:
        try:
            fd = os.open(str(self.lock_file), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode("utf-8", "ignore"))
            return fd
        except FileExistsError:
            return None
        except Exception:
            return None

    @staticmethod
    def _release_lock(lock_fd: Optional[int], lock_file: Path) -> None:
        if lock_fd is None:
            return
        try:
            os.close(lock_fd)
        except Exception:
            pass
        try:
            lock_file.unlink(missing_ok=True)  # type: ignore[arg-type]
        except Exception:
            if lock_file.exists():
                try:
                    lock_file.unlink()
                except Exception:
                    pass

    # ------------- 빌드 -------------
    def _walk_and_collect(self) -> Tuple[List[str], List[str], int, int]:
        """루트 전체를 os.walk로 스캔하여 경로/파일명 리스트를 만든다.

        최적화:
        - os.walk 사용 (scandir 멀티스레드보다 오버헤드 적음)
        - Lock 제거 (단일 스레드)
        - 문자열 변환 최소화
        - 정렬 생략 (검색은 순서 무관)
        """
        base_root = str(self.root_dir.resolve()).replace("\\", "/")
        base_root_len = len(base_root) + 1  # +1 for trailing /
        skip_dirs = {d for d in self.skip_dirs if d}
        cache_names = {self.cache_file.name, self.lock_file.name}

        keys: List[str] = []
        names: List[str] = []
        total_dirs = 0

        for dirpath, dirnames, filenames in os.walk(base_root):
            # skip_dirs 필터 (in-place 수정으로 하위 탐색 방지)
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]
            total_dirs += 1

            # 🔥 매 10 디렉토리마다 GIL 해제 (10ms) — 다른 스레드(API 요청)가 실행 가능
            if total_dirs % 10 == 0:
                time.sleep(0.01)

            if not filenames:
                continue

            # 디렉토리 경로를 한번만 변환
            dir_rel = dirpath.replace("\\", "/")
            if len(dir_rel) > base_root_len:
                dir_prefix = dir_rel[base_root_len:] + "/"
            elif len(dir_rel) == base_root_len - 1:
                dir_prefix = ""
            else:
                dir_prefix = ""

            for fname in filenames:
                if fname in cache_names:
                    continue
                keys.append(dir_prefix + fname)
                names.append(fname.lower())

        return keys, names, total_dirs, total_dirs

    async def build(self, force: bool = False, allow_background: bool = False) -> bool:
        """파일 인덱스 빌드. allow_background=True면 이미 빌드 중일 때 바로 반환."""
        async with self._async_build_lock:
            if self.building:
                if allow_background:
                    return False
                while self.building:
                    await asyncio.sleep(0.05)
                return self.ready

            if self.ready and not force and self._keys:
                return True

            lock_fd = self._acquire_lock(self.lock_wait_seconds) if force else self._try_acquire_lock_once()
            if lock_fd is None:
                # 다른 프로세스가 빌드 중 → 캐시 로드를 기다림
                if self._wait_for_cache():
                    return True
                return False

            loop = asyncio.get_running_loop()
            self.building = True
            # 🔥 이전 캐시가 있으면 ready 유지 (빌드 중에도 검색 가능)
            had_previous = bool(self._keys)
            if not had_previous:
                self.ready = False
            self.build_started_at = time.time()
            self.build_completed_at = 0.0
            
            self.logger.info("🔨 [INDEX] Build started: scanning %s (workers=%d)", self.root_dir, self.index_workers)
            
            try:
                sorted_keys, sorted_names, total_dirs, completed_dirs = await loop.run_in_executor(
                    self._io_pool, self._walk_and_collect
                )

                # _save_cache + _build_lookup_indices 를 executor 에서 실행 (이벤트 루프 블로킹 방지)
                def _finalize_build():
                    self._save_cache(sorted_keys)
                    if not self.cache_file.exists():
                        self.logger.error(f"❌ [INDEX] 캐시 파일 생성 실패: {self.cache_file}")
                    else:
                        cache_size = self.cache_file.stat().st_size
                        self.logger.info(f"✅ [INDEX] 캐시 파일 확인: {self.cache_file.name}, 크기: {cache_size:,} bytes")
                    lot_idx, folder_idx, token_idx, name_to_paths, lookup_elapsed, token0_idx, token2_idx, class_to_keys = self._compute_lookup_indices(
                        sorted_keys, sorted_names
                    )
                    with self._lock:
                        self._keys = sorted_keys
                        self._names = sorted_names
                        self._lot_index = lot_idx
                        self._folder_index = folder_idx
                        self._token_index = token_idx
                        self._token0_index = token0_idx
                        self._token2_index = token2_idx
                        self._name_to_paths = name_to_paths
                        self._class_to_keys = class_to_keys
                    self.logger.info(
                        "✅ [INDEX] Lookup indices built: %d LOTs, %d folders, %d tokens (pos0:%d pos2:%d), %d unique names, %d class prefixes (%.2fs)",
                        len(lot_idx),
                        len(folder_idx),
                        len(token_idx),
                        len(token0_idx),
                        len(token2_idx),
                        len(name_to_paths),
                        len(class_to_keys),
                        lookup_elapsed,
                    )

                await loop.run_in_executor(self._io_pool, _finalize_build)

                self.total_files = len(sorted_keys)
                self.total_dirs = total_dirs
                self.completed_dirs = completed_dirs
                self.build_completed_at = time.time()
                self.ready = True
                duration = self.build_completed_at - self.build_started_at
                self.logger.info(
                    "✅ [INDEX] Build complete: %d files (%.2fs)",
                    self.total_files,
                    duration,
                )
                return True
            finally:
                self.building = False
                self._release_lock(lock_fd, self.lock_file)

    def _wait_for_cache(self) -> bool:
        start = time.time()
        if not self.cache_file.exists():
            return False
        cache_mtime = self.cache_file.stat().st_mtime
        while time.time() - start < self.lock_wait_seconds:
            if not self.lock_file.exists() and self.cache_file.exists():
                if self.cache_file.stat().st_mtime != cache_mtime or cache_mtime == 0.0:
                    if self.load_cache():
                        return True
            time.sleep(0.5)
        return self.load_cache(log=not self._cache_loaded)

    async def ensure_ready_for_search(self, timeout: float = 10.0) -> bool:
        """검색 전에 인덱스가 준비되도록 캐시 로드 또는 빌드 대기.

        빌드가 진행 중이면 timeout 초까지 대기하여 첫 검색 실패를 방지한다.
        """
        if self.ready and self._keys:
            return True

        # 캐시 로드를 executor에서 실행 (이벤트루프 블로킹 방지)
        loop = asyncio.get_running_loop()
        try:
            loaded = await loop.run_in_executor(
                self._io_pool, lambda: self.load_cache(log=not self._cache_loaded)
            )
            if loaded and self._keys:
                return True
        except Exception:
            pass

        # 빌드가 진행 중이 아니면 트리거
        if not self.building:
            asyncio.create_task(self.build(force=True, allow_background=True))

        # 빌드/캐시 로드 완료를 대기 (최대 timeout 초)
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            if self.ready and self._keys:
                return True
            await asyncio.sleep(0.1)

        return bool(self.ready and self._keys)

    # ------------- 데이터 스냅샷 -------------
    def slice_with_prefix(self, prefix: str) -> Tuple[List[str], List[str]]:
        """접두사로 시작하는 경로만 슬라이스."""
        prefix = prefix or ""
        prefix_with_sep = prefix.rstrip("/") + "/" if prefix else ""
        with self._lock:
            keys_ref = self._keys
            names_ref = self._names
        if not prefix:
            return keys_ref, names_ref
        start_key = prefix_with_sep
        end_key = prefix_with_sep + "\uffff"
        start_idx = bisect_left(keys_ref, start_key)
        end_idx = bisect_right(keys_ref, end_key)
        return keys_ref[start_idx:end_idx], names_ref[start_idx:end_idx]

    def _build_lookup_indices(self) -> None:
        """LOT별/폴더별/토큰별/파일명별 역인덱스 빌드."""
        lot_idx, folder_idx, token_idx, name_to_paths, elapsed, token0_idx, token2_idx = self._compute_lookup_indices(self._keys, self._names)
        self._lot_index = lot_idx
        self._folder_index = folder_idx
        self._token_index = token_idx
        self._token0_index = token0_idx
        self._token2_index = token2_idx
        self._name_to_paths = name_to_paths
        self.logger.info("✅ [INDEX] Lookup indices built: %d LOTs, %d folders, %d tokens (pos0:%d pos2:%d), %d unique names (%.2fs)",
                         len(lot_idx), len(folder_idx), len(token_idx), len(token0_idx), len(token2_idx), len(name_to_paths), elapsed)

    def lot_search(self, lot_filter: Set[str], folder: str = "") -> List[str]:
        """LOT 필터로 O(1) 검색. folder가 있으면 해당 폴더 내만."""
        if not lot_filter:
            return []
        indices = []
        for lot in lot_filter:
            idx_list = self._lot_index.get(lot)
            if idx_list:
                indices.extend(idx_list)
        if not indices:
            return []
        if folder:
            folder_set = set(self._folder_index.get(folder, []))
            if folder_set:
                indices = [i for i in indices if i in folder_set]
        return [self._keys[i] for i in indices]

    def folder_keys(self, folder: str) -> Tuple[List[str], List[str]]:
        """폴더별 O(1) 키/이름 슬라이스."""
        idx_list = self._folder_index.get(folder)
        if not idx_list:
            return [], []
        return [self._keys[i] for i in idx_list], [self._names[i] for i in idx_list]

    def token_search(self, terms: List[str], logic: str = "and") -> Set[int]:
        """토큰 역인덱스로 O(1) 검색. logic='and'/'or'."""
        if not terms:
            return set()
        sets = []
        for term in terms:
            idx_list = self._token_index.get(term)
            if idx_list is not None:
                sets.append(set(idx_list))
            else:
                if logic == "and":
                    return set()  # AND에서 하나라도 없으면 빈 결과
                sets.append(set())
        if not sets:
            return set()
        if logic == "and":
            result = sets[0]
            for s in sets[1:]:
                result &= s
            return result
        else:
            result = set()
            for s in sets:
                result |= s
            return result

    def keys_snapshot(self) -> List[str]:
        with self._lock:
            return list(self._keys)

    # ------------- 상태/루프 -------------
    def status(self) -> Dict[str, Any]:
        percent = None
        if self.total_dirs:
            percent = round((self.completed_dirs / self.total_dirs) * 100, 2)
        duration = None
        if self.build_completed_at and self.build_started_at:
            duration = self.build_completed_at - self.build_started_at
        return {
            "indexed_files": len(self._keys),
            "index_ready": self.ready,
            "index_building": self.building,
            "index_cache_loading": self.loading_cache,
            "indexed_directories": self.completed_dirs,
            "total_directories": self.total_dirs,
            "progress_percent": percent,
            "build_duration_sec": duration,
            "build_started_at": self.build_started_at,
            "build_completed_at": self.build_completed_at,
            "timestamp": time.time(),
        }

    async def start_refresh_loop(self, interval_seconds: int) -> None:
        if interval_seconds <= 0 or self._refresh_task:
            return
        self._refresh_task = asyncio.create_task(self._refresh_loop(interval_seconds))

    async def stop_refresh_loop(self) -> None:
        if not self._refresh_task:
            return
        self._refresh_task.cancel()
        try:
            await self._refresh_task
        except asyncio.CancelledError:
            pass
        self._refresh_task = None

    async def _refresh_loop(self, interval_seconds: int) -> None:
        interval_minutes = interval_seconds // 60 or 1
        try:
            # 🔥 첫 번째 재빌드는 즉시 실행 (서버 시작 후 바로 인덱스 갱신)
            first_run = True
            while True:
                if not first_run:
                    await asyncio.sleep(interval_seconds)
                first_run = False
                
                if self.building:
                    self.logger.info("⏳ [INDEX] 이미 빌드 중이므로 재빌드 건너뜀 (다음 재빌드: %d분 후)", interval_minutes)
                    continue
                
                self.logger.info("🔁 [INDEX] 주기적 재빌드 시작 (%d분마다)", interval_minutes)
                try:
                    build_result = await self.build(force=True, allow_background=False)
                    if build_result:
                        # 🔥 인덱스 파일이 실제로 생성되었는지 확인
                        if self.cache_file.exists():
                            file_size = self.cache_file.stat().st_size
                            self.logger.info(
                                "✅ [INDEX] 주기적 재빌드 완료: files=%d, cache_size=%d bytes (다음 재빌드: %d분 후)",
                                self.total_files,
                                file_size,
                                interval_minutes,
                            )
                        else:
                            self.logger.error("❌ [INDEX] 재빌드 완료했지만 캐시 파일이 생성되지 않음: %s", self.cache_file)
                    else:
                        self.logger.warning("⚠️ [INDEX] 재빌드가 False를 반환함 (락 획득 실패 또는 다른 프로세스가 빌드 중)")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.logger.error(f"❌ [INDEX] 주기적 재빌드 실패: {exc}", exc_info=True)
        except asyncio.CancelledError:
            self.logger.info("🛑 [INDEX] 자동 재빌드 루프 종료")
            raise


__all__ = [
    "IndexService",
    "search_index_slice",
    "search_index_slice_parallel",
    "search_index_logical",
    "is_complex_query",
    "_tokenize_logical_query",
]
