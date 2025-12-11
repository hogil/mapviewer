import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from api.index_service import IndexService
from api.search_service import SearchService


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_services(tmp_path: Path) -> tuple[IndexService, SearchService, ThreadPoolExecutor]:
    index_service = IndexService(
        root_dir=tmp_path,
        skip_dirs=set(),
        cache_file=tmp_path / ".file_index_cache.txt",
        lock_file=tmp_path / ".file_index_cache.lock",
        index_workers=2,
        lock_wait_seconds=1,
        logger=logging.getLogger("test.index"),
    )
    executor = ThreadPoolExecutor(max_workers=2)
    search_service = SearchService(
        index_service=index_service,
        io_executor=executor,
        logger=logging.getLogger("test.search"),
        search_workers=2,
        supported_exts={".png", ".tif"},
        fallback_max_files=100,
        fallback_timeout_sec=1.0,
    )
    return index_service, search_service, executor


def _write_samples(tmp_path: Path) -> list[str]:
    names = [
        "lota_1.png",
        "lota_2.tif",
        "lotb_extra.png",
        "misc.txt",  # 확장자 미지원 → 검색 제외
    ]
    for name in names:
        target = tmp_path / name
        target.write_text("data", encoding="utf-8")
    return names


@pytest.mark.anyio
async def test_index_build_and_simple_search(tmp_path: Path):
    _write_samples(tmp_path)
    index_service, search_service, executor = _make_services(tmp_path)
    try:
        await index_service.build(force=True, allow_background=False)
        assert index_service.ready
        assert len(index_service.keys) == 4

        result = await search_service.search(
            query="lota",
            lot_filter=set(),
            limit=10,
            offset=0,
            current_folder=tmp_path,
        )
        assert result["total"] == 2
        assert set(result["results"]) == {"lota_1.png", "lota_2.tif"}
    finally:
        executor.shutdown(wait=True)


@pytest.mark.anyio
async def test_logical_and_lot_filter(tmp_path: Path):
    _write_samples(tmp_path)
    index_service, search_service, executor = _make_services(tmp_path)
    try:
        await index_service.build(force=True, allow_background=False)
        logical = await search_service.search(
            query="lota or lotb",
            lot_filter=set(),
            limit=10,
            offset=0,
            current_folder=tmp_path,
        )
        assert logical["total"] == 3

        lot_only = await search_service.search(
            query="",
            lot_filter={"lota"},
            limit=5,
            offset=0,
            current_folder=tmp_path,
        )
        assert lot_only["total"] == 2
        assert set(lot_only["results"]) == {"lota_1.png", "lota_2.tif"}
    finally:
        executor.shutdown(wait=True)


@pytest.mark.anyio
async def test_fallback_scan_when_index_empty(tmp_path: Path):
    _write_samples(tmp_path)
    index_service, search_service, executor = _make_services(tmp_path)
    try:
        # 인덱스 빌드 이전에도 폴백 스캔으로 결과를 반환해야 한다.
        result = await search_service.search(
            query="lota",
            lot_filter=set(),
            limit=5,
            offset=0,
            current_folder=tmp_path,
        )
        assert result["total"] == 2
        assert set(result["results"]) == {"lota_1.png", "lota_2.tif"}
        # 백그라운드 빌드가 돌고 있다면 완료까지 기다려 클린업
        await index_service.build(force=False, allow_background=False)
    finally:
        executor.shutdown(wait=True)
