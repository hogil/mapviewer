"""Focused API boundary checks that do not start a server or touch project data."""
from __future__ import annotations

import ast
import asyncio
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from urllib.parse import quote

from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse


REPO = Path(__file__).resolve().parents[1]
FULL = REPO / "api" / "full_app.py"
BOOT = REPO / "api" / "main.py"


def load_functions(source: Path, names: set[str], **bindings):
    tree = ast.parse(source.read_text(encoding="utf-8-sig"))
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node = ast.fix_missing_locations(ast.parse(ast.unparse(node)).body[0])
            node.decorator_list = []
            selected.append(node)
    if {node.name for node in selected} != names:
        raise AssertionError(f"missing functions in {source}: {names}")
    module = ast.Module(
        body=[
            ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
            *selected,
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace = {
        "Path": Path,
        "HTTPException": HTTPException,
        "JSONResponse": JSONResponse,
        "os": os,
        "logger": Mock(),
        "Query": lambda default=None, **kwargs: default,
        "Body": lambda default=None, **kwargs: default,
    }
    namespace.update(bindings)
    exec(compile(module, str(source), "exec"), namespace)
    return namespace


def request(path="/", query="") -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": query.encode(),
        "headers": [],
        "path_params": {},
    })


async def run_checks() -> None:
    with tempfile.TemporaryDirectory(prefix="l3-api-boundary-") as temp:
        temp_root = Path(temp) / "images"
        temp_root.mkdir()
        composite = temp_root / "composite" / "current"
        composite.mkdir(parents=True)
        (composite / "average.png").write_bytes(b"fixture")
        (composite / "gradient_stats.json").write_text('{"p50": 0.5}', encoding="utf-8")

        full = load_functions(
            FULL,
            {"safe_resolve_path", "get_gradient_stats"},
            ROOT_DIR=temp_root,
            IMAGES_ROOT=temp_root,
            current_folder=temp_root,
        )
        valid = await full["get_gradient_stats"](
            request(query=f"path={quote('composite/current/average.png')}")
        )
        assert valid == {"stats": {"p50": 0.5}}, valid

        secret = Path(temp) / "secret"
        secret.mkdir()
        (secret / "gradient_stats.json").write_text('{"secret": true}', encoding="utf-8")
        try:
            await full["get_gradient_stats"](request(query="path=../secret/anything.png"))
        except HTTPException as exc:
            assert exc.status_code == 403, exc
        else:
            raise AssertionError("gradient-stats accepted a path outside ROOT_DIR")

        outside_stats = Path(temp) / "outside-gradient-stats.json"
        outside_stats.write_text('{"secret": "symlink"}', encoding="utf-8")
        linked_stats = composite / "gradient_stats.json"
        linked_stats.unlink()
        try:
            linked_stats.symlink_to(outside_stats)
        except OSError as exc:
            print(f"SKIP symlink fixture: {exc}")
        else:
            try:
                await full["get_gradient_stats"](
                    request(query=f"path={quote('composite/current/average.png')}")
                )
            except HTTPException as exc:
                assert exc.status_code == 403, exc
            else:
                raise AssertionError("gradient-stats followed an external stats symlink")

        selected = Path(temp) / "selected-folder"
        selected.mkdir()
        (selected / "average.png").write_bytes(b"fixture")
        (selected / "gradient_stats.json").write_text('{"selected": true}', encoding="utf-8")
        current_folder_full = load_functions(
            FULL,
            {"safe_resolve_path", "get_gradient_stats"},
            ROOT_DIR=temp_root,
            IMAGES_ROOT=temp_root,
            current_folder=selected,
        )
        selected_result = await current_folder_full["get_gradient_stats"](
            request(query="path=average.png")
        )
        assert selected_result == {"stats": {"selected": True}}, selected_result

        folder = load_functions(
            FULL,
            {"change_folder"},
            ROOT_DIR=temp_root,
            current_folder=temp_root,
            DIRLIST_CACHE={},
            THUMB_STAT_CACHE={},
            _classification_dir=Mock(),
            log_access_row=Mock(),
        )
        bad_folder_request = SimpleNamespace(json=AsyncMock(return_value={}))
        try:
            await folder["change_folder"](bad_folder_request)
        except HTTPException as exc:
            assert exc.status_code == 400, exc
        else:
            raise AssertionError("change-folder swallowed its own HTTPException")

        full_thumbnail = load_functions(
            FULL,
            {"get_thumbnail"},
            THUMBNAIL_SIZE_DEFAULT=512,
        )
        for invalid_size in (0, -1):
            try:
                await full_thumbnail["get_thumbnail"](
                    SimpleNamespace(), path="average.png", size=invalid_size
                )
            except HTTPException as exc:
                assert exc.status_code == 400, exc
            else:
                raise AssertionError(f"full thumbnail accepted size={invalid_size}")

        bootstrap_thumbnail = load_functions(
            BOOT,
            {"get_thumbnail"},
            config=SimpleNamespace(THUMBNAIL_SIZE_DEFAULT=512),
            _parse_bool=lambda value, default=False: default if value is None else str(value).lower() in {"1", "true", "yes", "y", "on"},
        )
        for query, label in (("path=average.png&size=0", "zero size"), ("path=average.png&size=-1", "negative size"), ("path=average.png&size=bad", "malformed size"), ("size=512", "missing path")):
            response = await bootstrap_thumbnail["get_thumbnail"](request(query=query))
            assert response.status_code == 400, (label, response.status_code)

        thumbnail_module = SimpleNamespace(get_thumbnail=AsyncMock(return_value={"ok": True}))
        thumbnail_manager = SimpleNamespace(
            get_loaded_module=Mock(return_value=thumbnail_module),
            sync_runtime_state=Mock(),
            wait_until_ready=AsyncMock(),
        )
        bootstrap_thumbnail["_FULL_APP"] = thumbnail_manager
        result = await bootstrap_thumbnail["get_thumbnail"](request(query="path=average.png"))
        assert result == {"ok": True}
        assert thumbnail_module.get_thumbnail.await_args.kwargs["size"] == 512
        result = await bootstrap_thumbnail["get_thumbnail"](request(query="path=average.png&size=256"))
        assert result == {"ok": True}
        assert thumbnail_module.get_thumbnail.await_args.kwargs["size"] == 256

        measure = load_functions(FULL, {"get_measure_thumb", "get_measure_thumb_batch"})
        for invalid_size in (0, -1):
            with_error = False
            try:
                await measure["get_measure_thumb"](
                    SimpleNamespace(), path="average.png", field="f", key="1", size=invalid_size
                )
            except HTTPException as exc:
                with_error = exc.status_code == 400
            assert with_error, f"measure-thumb accepted size={invalid_size}"
            try:
                await measure["get_measure_thumb_batch"](
                    SimpleNamespace(), {"path": "average.png", "items": [{"field": "f", "key": "1"}], "size": invalid_size}
                )
            except HTTPException as exc:
                assert exc.status_code == 400, exc
            else:
                raise AssertionError(f"measure-thumb-batch accepted size={invalid_size}")
        try:
            await measure["get_measure_thumb_batch"](
                SimpleNamespace(), {"path": "average.png", "items": [{"field": "f", "key": "1"}], "size": "bad"}
            )
        except HTTPException as exc:
            assert exc.status_code == 400, exc
        else:
            raise AssertionError("measure-thumb-batch accepted malformed size")


if __name__ == "__main__":
    asyncio.run(run_checks())
    print("check_api_boundaries: PASS")
