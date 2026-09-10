"""Exercise audit API fixes without importing either server or mutating real files."""
from __future__ import annotations

import ast
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
import math
import os
from pathlib import Path
import re
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import anyio
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Match, Route


REPO = Path(__file__).resolve().parents[1]
FULL = REPO / "api/full_app.py"
BOOT = REPO / "api/main.py"
SOURCE_TREES = {source: ast.parse(source.read_text(encoding="utf-8-sig")) for source in (FULL, BOOT)}


def load_functions(source, names, **bindings):
    tree = SOURCE_TREES[source]
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node = copy.deepcopy(node)
            node.decorator_list = []
            selected.append(node)
    if {node.name for node in selected} != set(names):
        raise AssertionError("Missing requested source function")
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
                              *selected], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = dict(Path=Path, HTTPException=HTTPException, Response=Response,
                     PlainTextResponse=PlainTextResponse, FileResponse=FileResponse,
                     JSONResponse=JSONResponse, Query=lambda default=None, **kwargs: default,
                     logger=Mock(), __file__=str(source))
    namespace.update(bindings)
    exec(compile(module, str(source), "exec"), namespace)
    return namespace


def request(path="/", query="", headers=(), filename=None):
    return Request({"type": "http", "method": "GET", "path": path,
                    "query_string": query.encode(), "headers": list(headers),
                    "path_params": {"filename": filename} if filename else {}})


class AuditApiTests(unittest.IsolatedAsyncioTestCase):
    def label_namespace(self):
        return load_functions(
            FULL, ["add_labels", "delete_labels", "delete_labels_post"],
            ROOT_DIR=REPO / "__isolated_not_created__",
            relkey_from_any_path=lambda value: value,
            _lookup_original_relpath_from_classification_path=lambda value: None,
            is_supported_image=lambda path: path.suffix == ".png",
            _CLASS_NAME_RE=re.compile(r"^[A-Za-z0-9_\-]+$"),
            ClassifyRequest=SimpleNamespace, ClassifyDeleteRequest=SimpleNamespace,
            classify_images=AsyncMock(), delete_classification=AsyncMock(),
            _get_labels_for_image=Mock(return_value=["alpha", "beta"]),
            _classification_dir=Mock(return_value=REPO / "__isolated_not_created__"),
            _dircache_invalidate=Mock(), _check_folder_permission=Mock())

    async def test_batch_class_delete_denies_before_files_or_index(self):
        checker = Mock(side_effect=HTTPException(403, "denied"))
        remove = Mock()
        index = Mock()
        directory = Mock()
        ns = load_functions(FULL, ["delete_classes"], _check_folder_permission=checker,
                            shutil=SimpleNamespace(rmtree=remove), index_service=index,
                            _classification_dir=directory)
        req = request()
        with self.assertRaises(HTTPException) as result:
            await ns["delete_classes"](req, SimpleNamespace(names=["alpha", "beta"]), "wafer")
        self.assertEqual(result.exception.status_code, 403)
        checker.assert_called_once_with(req, "*", "CLASS_MANAGE")
        remove.assert_not_called()
        directory.assert_not_called()
        self.assertEqual(index.mock_calls, [])

    def chip_extract_namespace(self):
        root = REPO / "__isolated_not_created__"
        return load_functions(
            FULL, ["extract_chip_images", "safe_resolve_path", "_get_relative_path_from_image"],
            ROOT_DIR=root, current_folder=root, os=os, math=math,
            config=SimpleNamespace(CHIP_IMAGES_ROOT=root / "chip-images"),
            _CLASS_NAME_RE=re.compile(r"^[A-Za-z0-9_\-]+$"),
            _lookup_original_relpath_from_classification_path=lambda value: None,
            _check_folder_permission=Mock(), _extract_chip_images_sync=Mock(),
            anyio=SimpleNamespace(to_thread=SimpleNamespace(run_sync=AsyncMock())))

    def chip_extract_payload(self):
        return SimpleNamespace(image_path="unknown/a.png", class_name="alpha", create_label=True,
                               chips=[{"x_abs": 1, "y_abs": -2,
                                       "bbox": {"x0": 0, "y0": 0, "x1": 10, "y1": 12}}])

    async def test_chip_extract_invalid_payloads_never_reach_worker(self):
        cases = [
            ("source escape", "image_path", "../outside.png"),
            ("class escape", "class_name", "../outside"),
            ("missing bbox", "chips", [{"x_abs": 1, "y_abs": 2}]),
            ("wrong bbox type", "chips", [{"x_abs": 1, "y_abs": 2, "bbox": []}]),
            ("nonfinite bbox", "chips", [{"x_abs": 1, "y_abs": 2, "bbox": {"x0": 0, "y0": 0, "x1": math.inf, "y1": 10}}]),
            ("reversed bbox", "chips", [{"x_abs": 1, "y_abs": 2, "bbox": {"x0": 10, "y0": 0, "x1": 0, "y1": 10}}]),
            ("invalid coordinate", "chips", [{"x_abs": "../bad", "y_abs": 2, "bbox": {"x0": 0, "y0": 0, "x1": 10, "y1": 10}}]),
        ]
        for name, field, value in cases:
            with self.subTest(case=name):
                ns = self.chip_extract_namespace()
                payload = self.chip_extract_payload()
                setattr(payload, field, value)
                with patch.object(Path, "is_file", return_value=True), self.assertRaises(HTTPException) as result:
                    await ns["extract_chip_images"](payload, request())
                self.assertEqual(result.exception.status_code, 400)
                ns["anyio"].to_thread.run_sync.assert_not_awaited()
                ns["_extract_chip_images_sync"].assert_not_called()

    async def test_chip_extract_permission_denial_never_reaches_worker(self):
        ns = self.chip_extract_namespace()
        ns["_check_folder_permission"].side_effect = HTTPException(403, "denied")
        req = request()
        with patch.object(Path, "is_file", return_value=True), self.assertRaises(HTTPException) as result:
            await ns["extract_chip_images"](self.chip_extract_payload(), req)
        self.assertEqual(result.exception.status_code, 403)
        ns["_check_folder_permission"].assert_called_once_with(req, "unknown", "LABEL_WRITE")
        ns["anyio"].to_thread.run_sync.assert_not_awaited()
        ns["_extract_chip_images_sync"].assert_not_called()

    async def test_chip_extract_dispatches_same_payload_off_event_loop(self):
        ns = self.chip_extract_namespace()
        payload = self.chip_extract_payload()
        expected = {"success": True, "extracted_count": 1, "chips": [{"chip_image": "fixture.png"}]}
        loop_thread = threading.get_ident()
        worker_threads = []

        def extract(actual_payload):
            self.assertIs(actual_payload, payload)
            worker_threads.append(threading.get_ident())
            return expected

        worker = Mock(side_effect=extract)
        dispatch = AsyncMock(wraps=anyio.to_thread.run_sync)
        ns["_extract_chip_images_sync"] = worker
        ns["anyio"].to_thread.run_sync = dispatch
        with patch.object(Path, "is_file", return_value=True):
            result = await ns["extract_chip_images"](payload, request())
        dispatch.assert_awaited_once_with(worker, payload)
        worker.assert_called_once_with(payload)
        self.assertIs(result, expected)
        self.assertEqual(len(worker_threads), 1)
        self.assertNotEqual(worker_threads[0], loop_thread)

    def recolor_namespace(self, executor, invalidate):
        root = REPO / "__isolated_not_created__"
        return load_functions(
            FULL, ["recolor_composite_sum_maps_endpoint", "_composite_output_lock"],
            __package__="_audit_composite", asyncio=asyncio,
            os=os, RLock=threading.RLock, _COMPOSITE_OUTPUT_LOCKS={},
            _COMPOSITE_OUTPUT_LOCKS_GUARD=threading.Lock(),
            IMAGES_ROOT=root, COMPOSITE_ROOT=root / "composite_map",
            COMPOSITE_EXECUTOR=executor, ANONYMOUS_LOGIN_ID="guest",
            _has_numpy=lambda: True, _current_login_id=lambda req: "audit-user",
            _invalidate_composite_thumbnail_caches=invalidate, _log=Mock())

    async def test_composite_recolor_and_cache_invalidation_run_off_loop(self):
        loop_thread = threading.get_ident()
        calls = []
        entries = [{"path": "composite_map/audit-user/current/square_average.png"}]
        colors = ["#001122", "#ddeeff"]

        def invalidate(**kwargs):
            calls.append(("invalidate", threading.get_ident(), kwargs))

        def recolor(target, **kwargs):
            calls.append(("recolor", threading.get_ident(), kwargs))
            self.assertEqual(target, (REPO / "__isolated_not_created__/composite_map/audit-user/current").resolve())
            self.assertIs(kwargs["override_colors"], colors)
            self.assertEqual(kwargs["scheme"], "audit-user")
            return entries

        module = ModuleType("_audit_composite.composite_map")
        module.recolor_saved_sum_maps = recolor
        req = SimpleNamespace(json=AsyncMock(return_value={"output_dir": "composite_map/audit-user/current", "colors": colors}))
        with ThreadPoolExecutor(max_workers=1) as executor:
            ns = self.recolor_namespace(executor, invalidate)
            with patch.dict(sys.modules, {module.__name__: module}), patch.object(Path, "exists", return_value=True):
                result = await ns["recolor_composite_sum_maps_endpoint"](req)
        self.assertEqual([item[0] for item in calls], ["invalidate", "recolor"])
        self.assertTrue(all(item[1] != loop_thread for item in calls))
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertEqual(calls[0][2]["login_id"], "audit-user")
        self.assertIs(result["sum_maps"], entries)
        self.assertEqual(result["output_dir"], "composite_map/audit-user/current")

    async def test_composite_recolor_worker_errors_keep_http_mapping(self):
        for error, expected_status in ((FileNotFoundError("missing cache"), 404),
                                       (OSError("write failed"), 500),
                                       (HTTPException(409, "conflict"), 409)):
            with self.subTest(error=type(error).__name__), ThreadPoolExecutor(max_workers=1) as executor:
                module = ModuleType("_audit_composite.composite_map")
                module.recolor_saved_sum_maps = Mock(side_effect=error)
                invalidate = Mock()
                ns = self.recolor_namespace(executor, invalidate)
                req = SimpleNamespace(json=AsyncMock(return_value={"output_dir": "composite_map/audit-user/current"}))
                with patch.dict(sys.modules, {module.__name__: module}), patch.object(Path, "exists", return_value=True):
                    with self.assertRaises(HTTPException) as result:
                        await ns["recolor_composite_sum_maps_endpoint"](req)
                self.assertEqual(result.exception.status_code, expected_status)
                invalidate.assert_called_once()
                module.recolor_saved_sum_maps.assert_called_once()

    async def test_composite_recolor_rejects_nonobjects_and_sibling_paths(self):
        invalid_payloads = [[], ["output_dir"], "composite_map/user/current", 1, None,
                            {"output_dir": "composite_map_extra/current"},
                            {"output_dir": "composite_map/../outside/current"},
                            {"output_dir": str(REPO / "outside/current")}]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                executor = Mock()
                invalidate = Mock()
                ns = self.recolor_namespace(executor, invalidate)
                req = SimpleNamespace(json=AsyncMock(return_value=payload))
                with patch.object(Path, "exists", return_value=True), self.assertRaises(HTTPException) as result:
                    await ns["recolor_composite_sum_maps_endpoint"](req)
                self.assertEqual(result.exception.status_code, 400)
                executor.submit.assert_not_called()
                invalidate.assert_not_called()

    async def test_legacy_add_labels_reaches_storage_once_per_class(self):
        ns = self.label_namespace()
        req = request()
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "is_file", return_value=True):
            result = await ns["add_labels"](SimpleNamespace(image_path="source/a.png", labels=["alpha", "beta", "alpha"]), req)
        calls = ns["classify_images"].await_args_list
        self.assertEqual([call.args[1].class_name for call in calls], ["alpha", "beta"])
        self.assertTrue(all(call.args[0] is req and call.args[1].image_path == "source/a.png" for call in calls))
        self.assertEqual(result["labels"], ["alpha", "beta"])

    async def test_legacy_add_validates_all_names_before_storage(self):
        ns = self.label_namespace()
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "is_file", return_value=True):
            with self.assertRaises(HTTPException) as result:
                await ns["add_labels"](SimpleNamespace(image_path="source/a.png", labels=["alpha", "../bad"]), request())
        self.assertEqual(result.exception.status_code, 400)
        ns["classify_images"].assert_not_awaited()

    async def test_legacy_add_preserves_storage_http_error(self):
        ns = self.label_namespace()
        ns["classify_images"].side_effect = HTTPException(403, "denied")
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "is_file", return_value=True):
            with self.assertRaises(HTTPException) as result:
                await ns["add_labels"](SimpleNamespace(image_path="source/a.png", labels=["alpha"]), request())
        self.assertEqual(result.exception.status_code, 403)

    async def test_legacy_delete_and_post_alias_reach_storage(self):
        for endpoint, labels, expected in (("delete_labels", None, ["alpha", "beta"]),
                                           ("delete_labels_post", ["beta", "beta", "missing"], ["beta"])):
            with self.subTest(endpoint=endpoint):
                ns = self.label_namespace()
                req = request()
                await ns[endpoint](SimpleNamespace(image_path="source/a.png", labels=labels), req)
                calls = ns["delete_classification"].await_args_list
                self.assertEqual([call.args[0].class_name for call in calls], expected)
                self.assertTrue(all(call.args[1] is req for call in calls))
                ns["_check_folder_permission"].assert_called_once_with(req, "source", "LABEL_WRITE")

    async def test_legacy_delete_preserves_permission_and_storage_errors(self):
        for permission_failure in (True, False):
            with self.subTest(permission_failure=permission_failure):
                ns = self.label_namespace()
                target = ns["_check_folder_permission"] if permission_failure else ns["delete_classification"]
                target.side_effect = HTTPException(403, "denied")
                with self.assertRaises(HTTPException) as result:
                    await ns["delete_labels"](SimpleNamespace(image_path="source/a.png", labels=["alpha"]), request())
                self.assertEqual(result.exception.status_code, 403)
                if permission_failure:
                    ns["delete_classification"].assert_not_awaited()

    async def test_legacy_classification_delete_checks_original_folder(self):
        ns = self.label_namespace()
        ns["_lookup_original_relpath_from_classification_path"] = Mock(return_value="unknown/a.png")
        req = request()

        def source_only(_req, folder, permission):
            if folder != "unknown":
                raise HTTPException(403, "only source folder is granted")

        ns["_check_folder_permission"].side_effect = source_only
        result = await ns["delete_labels"](SimpleNamespace(image_path="classification/alpha/a.png", labels=["alpha"]), req)
        self.assertTrue(result["success"])
        ns["_check_folder_permission"].assert_called_once_with(req, "unknown", "LABEL_WRITE")
        self.assertEqual(ns["delete_classification"].await_args.args[0].image_path, "unknown/a.png")

    async def test_label_explorer_basename_delete_checks_original_folder(self):
        root = REPO / "__isolated_not_created__"
        checker = Mock()

        def source_only(_req, folder, permission):
            if folder != "unknown":
                raise HTTPException(403, "only source folder is granted")

        checker.side_effect = source_only
        lookup = Mock(return_value="unknown/a.png")
        ns = load_functions(FULL, ["delete_classification"], ROOT_DIR=root,
                            _current_username=lambda *args, **kwargs: "scoped-user",
                            _CLASS_NAME_RE=re.compile(r"^[A-Za-z0-9_\-]+$"),
                            _classification_dir=lambda **kwargs: root / "classification",
                            _lookup_original_relpath_from_classification_path=lookup,
                            relkey_from_any_path=lambda value: value, _check_folder_permission=checker,
                            _dircache_invalidate=Mock(), index_service=Mock(), log_access_row=Mock())
        req = request()
        payload = SimpleNamespace(mode="wafer", class_name="alpha", image_path=None, image_name="a.png")
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "unlink") as unlink:
            result = await ns["delete_classification"](payload, req)
        self.assertTrue(result["success"])
        lookup.assert_called_once_with("classification/alpha/a.png")
        checker.assert_called_once_with(req, "unknown", "LABEL_WRITE")
        unlink.assert_called_once()
        self.assertEqual(Path(result["removed"]).as_posix(), "classification/alpha/a.png")

    async def test_batch_label_permissions_preflight_all_sources(self):
        checked = []

        def check(_req, folder, permission):
            checked.append((folder, permission))
            if folder == "forbidden":
                raise HTTPException(403, "denied")

        directory = Mock()
        ns = load_functions(FULL, ["classify_delete_batch"],
                            _current_username=lambda *args, **kwargs: "viewer",
                            _lookup_original_relpath_from_classification_path=lambda value: "forbidden/b.png" if value.startswith("classification/") else None,
                            relkey_from_any_path=lambda value: value,
                            _check_folder_permission=check, _classification_dir=directory,
                            index_service=Mock())
        payload = SimpleNamespace(mode="wafer", class_="alpha", images=["allowed/a.png", "classification/alpha/b.png"])
        with patch.object(Path, "unlink") as unlink, self.assertRaises(HTTPException) as result:
            await ns["classify_delete_batch"](payload, request())
        self.assertEqual(result.exception.status_code, 403)
        self.assertIn(("forbidden", "LABEL_WRITE"), checked)
        directory.assert_not_called()
        unlink.assert_not_called()
        self.assertEqual(ns["index_service"].mock_calls, [])

    async def test_url_only_identity_matches_shared_resolver(self):
        ns = load_functions(FULL, ["get_current_user", "_current_login_id", "_normalize_login_id_candidate"],
                            _LOGIN_ID_SENTINELS={"guest", "none", "null"}, SAML_USER_SESSIONS={}, SAML_IP_TO_LOGIN={})
        for key in ("LoginId", "loginId", "login_id"):
            with self.subTest(key=key):
                req = request(query=f"{key}=audit-user")
                self.assertEqual(ns["get_current_user"](req), "audit-user")
                self.assertEqual(ns["get_current_user"](req), ns["_current_login_id"](req))
        self.assertIsNone(ns["get_current_user"](request()))
        for session in ({"session_user": "legacy-user"}, {"username": "legacy-user"},
                        {"session_user": {"LoginId": "legacy-user"}}):
            req = request()
            req.scope["session"] = session
            self.assertEqual(ns["get_current_user"](req), "legacy-user")

    async def test_static_asset_confinement_and_cache_behavior(self):
        for source in (BOOT, FULL):
            for kind in ("js", "css"):
                with self.subTest(source=source.name, kind=kind):
                    cache = Mock(return_value=(b"asset", b"compressed", "test-etag", 1))
                    root = REPO / kind
                    ns = load_functions(source, [f"serve_{kind}"], **{f"_{kind.upper()}_DIR": root, f"_get_{kind}_entry": cache})

                    async def invoke(filename, headers=()):
                        req = request(headers=headers, filename=filename)
                        try:
                            return await ns[f"serve_{kind}"](req) if source == BOOT else await ns[f"serve_{kind}"](filename, req)
                        except HTTPException as exc:
                            return Response(status_code=exc.status_code)

                    for bad in (f"../outside.{kind}", f"..\\outside.{kind}", "../api/main.py", "secret.json", str(REPO / f"outside.{kind}")):
                        cache.reset_mock()
                        result = await invoke(bad)
                        self.assertEqual(result.status_code, 404)
                        cache.assert_not_called()
                    result = await invoke(f"valid.{kind}")
                    self.assertEqual(result.body, b"asset")
                    self.assertEqual(result.headers["cache-control"], "no-cache")
                    result = await invoke(f"valid.{kind}", [(b"if-none-match", b'"test-etag"')])
                    self.assertEqual(result.status_code, 304)
                    result = await invoke(f"valid.{kind}", [(b"accept-encoding", b"gzip")])
                    self.assertEqual(result.body, b"compressed")
                    self.assertEqual(result.headers["content-encoding"], "gzip")
                    original = Path.resolve

                    def redirected(path, *args, **kwargs):
                        return REPO / f"outside.{kind}" if path == root / f"linked.{kind}" else original(path, *args, **kwargs)

                    cache.reset_mock()
                    with patch.object(Path, "resolve", redirected):
                        result = await invoke(f"linked.{kind}")
                    self.assertEqual(result.status_code, 404)
                    cache.assert_not_called()

    async def test_user_search_route_wins_starlette_matching(self):
        tree = SOURCE_TREES[FULL]
        routes = []

        async def unused_endpoint(_request):
            return Response()

        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
                        and decorator.func.attr == "get" and decorator.args
                        and isinstance(decorator.args[0], ast.Constant)):
                    routes.append(Route(decorator.args[0].value, unused_endpoint, name=node.name, methods=["GET"]))
        matches = [route for route in routes if route.matches(request("/api/users/search").scope)[0] == Match.FULL]
        self.assertGreaterEqual(len(matches), 2)
        self.assertEqual(matches[0].name, "search_users_from_stats")

    async def test_no_broad_static_mounts_and_color_legend_route_retained(self):
        for source in (BOOT, FULL):
            tree = SOURCE_TREES[source]
            for node in ast.walk(tree):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "mount" and node.args and isinstance(node.args[0], ast.Constant)):
                    self.assertNotIn(node.args[0].value, {"/static", "/logs"})
        tree = SOURCE_TREES[BOOT]
        routes = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == "add_route"
                  and node.args and isinstance(node.args[0], ast.Constant)
                  and node.args[0].value == "/logs/color-legends.json"]
        self.assertEqual(len(routes), 1)
        self.assertEqual(ast.literal_eval(next(keyword.value for keyword in routes[0].keywords if keyword.arg == "methods")), ["GET", "HEAD"])
        ns = load_functions(BOOT, ["serve_color_legends"])
        with patch.object(Path, "is_file", return_value=False):
            result = await ns["serve_color_legends"](request())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.body, b"{}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
