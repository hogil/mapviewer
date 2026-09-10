"""Isolated production cleanup/lock checks; no app startup or real caches."""
from __future__ import annotations

import ast
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
import os
from pathlib import Path
import sys
from threading import Event, Lock, RLock
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "output/audit-fixes-20260911/composite-lifecycle"


def selected_code(filename, names):
    tree = ast.parse((REPO / filename).read_text(encoding="utf-8-sig"))
    nodes = [copy.deepcopy(node) for node in tree.body
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    assert len(nodes) == len(names)
    for node in nodes:
        node.decorator_list = []
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    return compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])), filename, "exec")


class CompositeLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root = OUT / uuid.uuid4().hex
        self.root.mkdir(parents=True)
        self.pool = ThreadPoolExecutor(4)
        self.addCleanup(self.pool.shutdown, wait=True)
        self.scope = dict(__package__="api", Path=Path, os=os, Lock=Lock, RLock=RLock, asyncio=asyncio,
                          COMPOSITE_ROOT=self.root / "composite_map", _COMPOSITE_OUTPUT_LOCKS={},
                          _COMPOSITE_OUTPUT_LOCKS_GUARD=Lock(), COMPOSITE_EXECUTOR=self.pool,
                          config=SimpleNamespace(POSITIONS_ROOT=self.root / "positions"),
                          JSONResponse=lambda data: data, _current_login_id=lambda request: request)
        exec(selected_code("api/full_app.py", {"_composite_output_lock", "_composite_user_output_dir",
                                               "composite_cleanup_endpoint"}), self.scope)
        module = ModuleType("api.composite_map")
        module.ANONYMOUS_LOGIN_ID = "notsaml"
        exec(selected_code("api/composite_map.py", {"_sanitize_login_id"}), module.__dict__)
        self.module_patch = patch.dict(sys.modules, {"api.composite_map": module})
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    def test_same_user_nested_output_shares_lock_and_other_user_does_not(self):
        lock_for = self.scope["_composite_output_lock"]
        user_dir = self.scope["_composite_user_output_dir"]("alpha/user")
        self.assertEqual(user_dir.name, "alpha_user")
        self.assertIs(lock_for(user_dir), lock_for(user_dir / "legacy_timestamp"))
        self.assertIsNot(lock_for(user_dir), lock_for(user_dir.parent / "another_user"))

    def test_cleanup_waits_for_writer_without_blocking_event_loop_or_other_user(self):
        user_dir = self.scope["_composite_user_output_dir"]("writer")
        positions_dir = self.root / "positions/composite_map/writer"
        user_dir.mkdir(parents=True)
        positions_dir.mkdir(parents=True)
        entered, release = Event(), Event()

        def writing():
            with self.scope["_composite_output_lock"](user_dir):
                entered.set()
                if not release.wait(3):
                    raise TimeoutError("cleanup blocked the event loop")
                (user_dir / "last-output.txt").write_text("complete", encoding="utf-8")

        writer = self.pool.submit(writing)
        self.assertTrue(entered.wait(1))

        async def scenario():
            cleanup = asyncio.create_task(self.scope["composite_cleanup_endpoint"]("writer"))
            try:
                # If the route waits on a thread lock in the event loop this cannot run.
                for _ in range(3):
                    await asyncio.sleep(.02)
                self.assertFalse(cleanup.done())
                self.assertTrue(user_dir.exists())
                other_lock = self.scope["_composite_output_lock"](user_dir.parent / "other")
                self.assertTrue(other_lock.acquire(blocking=False))
                other_lock.release()
            finally:
                release.set()
            result = await asyncio.wait_for(cleanup, 2)
            self.assertEqual(set(result["deleted"]), {str(user_dir), str(positions_dir)})

        asyncio.run(scenario())
        writer.result(timeout=1)
        self.assertFalse(user_dir.exists())
        self.assertFalse(positions_dir.exists())

    def test_cleanup_does_not_report_success_when_removal_failed(self):
        user_dir = self.scope["_composite_user_output_dir"]("failure")
        user_dir.mkdir(parents=True)
        with patch("shutil.rmtree", side_effect=PermissionError("injected cleanup failure")):
            with self.assertRaisesRegex(PermissionError, "injected cleanup failure"):
                asyncio.run(self.scope["composite_cleanup_endpoint"]("failure"))
        self.assertTrue(user_dir.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
