"""MY LOT path and paired-rename regressions; only isolated temporary fixtures."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]


class MyLotStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mapviewer-mylot-check-")
        self.root = Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.clean_fixture)
        config = types.ModuleType("_audit_mylot.config")
        config.IMAGES_ROOT = self.root / "images"
        config.POSITIONS_ROOT = self.root / "positions"
        config.SUPPORTED_EXTS = {".png"}
        config.FALLBACK_LOGIN_ID = "fixture-user"
        spec = importlib.util.spec_from_file_location("_audit_mylot.my_lot", REPO / "api/my_lot.py")
        self.store = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"_audit_mylot.config": config}):
            spec.loader.exec_module(self.store)

    def clean_fixture(self):
        # Verify the exact temporary workspace boundary before recursive cleanup.
        self.assertEqual(Path(self.temp.name).resolve(), self.root)
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temp.cleanup()

    def fixture(self, mode="wafer", group="old"):
        store = self.store
        source = store.IMAGES_ROOT / "source" / "LOT_00P_03_sample.png"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"isolated-image-bytes")
        positions = store.POSITIONS_ROOT / "source" / source.with_suffix(".json").name
        positions.parent.mkdir(parents=True, exist_ok=True)
        positions.write_text(json.dumps({"image_path": "source/" + source.name,
                                         "chips": [{"x_abs": 1, "y_abs": 2}]}), encoding="utf-8")
        store.add_entry("user", mode, group, source)
        group_dir = store._group_dir("user", mode, group)
        copied = group_dir / source.name if mode == "wafer" else group_dir / "LOT" / source.name
        return source, copied

    def test_reserved_group_and_login_never_delete(self):
        _, copied = self.fixture()
        for reserved in (".", "..", "...", "old."):
            with self.subTest(name=reserved), patch.object(self.store.shutil, "rmtree") as remove:
                for operation in (
                    lambda: self.store.delete_group("user", "wafer", reserved),
                    lambda: self.store.delete_group(reserved, "wafer", "old"),
                    lambda: self.store.create_group("user", "wafer", reserved),
                    lambda: self.store.rename_group("user", "wafer", "old", reserved),
                ):
                    with self.assertRaises(ValueError):
                        operation()
                remove.assert_not_called()
        self.assertTrue(copied.exists())

    def test_rename_preserves_images_positions_and_siblings(self):
        for mode in ("lot", "wafer"):
            with self.subTest(mode=mode):
                source, copied = self.fixture(mode)
                old_group = self.store._group_dir("user", mode, "old")
                relative = copied.relative_to(old_group)
                old_positions = self.store._positions_group_dir("user", mode, "old")
                before_positions = (old_positions / relative.with_suffix(".json")).read_bytes()
                self.store.create_group("user", mode, "sibling")
                self.assertTrue(self.store.rename_group("user", mode, "old", "new"))
                renamed = self.store._group_dir("user", mode, "new") / relative
                self.assertEqual(renamed.read_bytes(), source.read_bytes())
                self.assertFalse(renamed.samefile(source))
                result = self.store._find_position_file(renamed.relative_to(self.store.IMAGES_ROOT).as_posix())
                self.assertIsNotNone(result)
                self.assertEqual(result.read_bytes(), before_positions)
                self.assertEqual(len(json.loads(result.read_bytes())["chips"]), 1)
                self.assertFalse(old_group.exists())
                self.assertFalse(old_positions.exists())
                self.assertTrue(self.store._group_dir("user", mode, "sibling").is_dir())

    def test_positions_rename_failure_restores_images(self):
        _, copied = self.fixture()
        old_positions = self.store._positions_group_dir("user", "wafer", "old")
        original = Path.rename

        def fail_positions(path, target):
            if path == old_positions:
                raise PermissionError("injected positions lock")
            return original(path, target)

        with patch.object(Path, "rename", fail_positions), self.assertRaises(PermissionError):
            self.store.rename_group("user", "wafer", "old", "new")
        self.assertTrue(copied.exists())
        self.assertTrue(old_positions.exists())
        self.assertFalse(self.store._group_dir("user", "wafer", "new").exists())

    def test_delete_failure_is_reported_and_positions_are_not_deleted(self):
        _, copied = self.fixture()
        image_group = self.store._group_dir("user", "wafer", "old")
        positions_group = self.store._positions_group_dir("user", "wafer", "old")
        with patch.object(self.store.shutil, "rmtree", side_effect=PermissionError("source is being read")) as remove:
            with self.assertRaises(PermissionError):
                self.store.delete_group("user", "wafer", "old")
            remove.assert_called_once_with(str(image_group))
        self.assertTrue(copied.exists())
        self.assertTrue(positions_group.exists())

    def test_rollback_failure_is_explicit(self):
        self.fixture()
        old_group = self.store._group_dir("user", "wafer", "old")
        original = Path.rename

        def fail_after_first_move(path, target):
            if path == old_group:
                return original(path, target)
            raise PermissionError("injected rename lock")

        with patch.object(Path, "rename", fail_after_first_move), self.assertRaises(RuntimeError):
            self.store.rename_group("user", "wafer", "old", "new")

    def test_destination_collision_does_not_move_or_overwrite(self):
        for positions_collision in (False, True):
            with self.subTest(positions_collision=positions_collision):
                mode = "lot" if positions_collision else "wafer"
                _, copied = self.fixture(mode)
                target = (self.store._positions_group_dir("user", mode, "new") if positions_collision
                          else self.store._group_dir("user", mode, "new"))
                target.mkdir(parents=True)
                sentinel = target / "sentinel.txt"
                sentinel.write_text("preserve", encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.store.rename_group("user", mode, "old", "new")
                self.assertTrue(copied.exists())
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")

    def test_image_only_group_and_same_name(self):
        self.store.create_group("user", "wafer", "old")
        self.assertTrue(self.store.rename_group("user", "wafer", "old", "old"))
        self.assertFalse(self.store.rename_group("user", "wafer", "missing", "missing"))
        self.assertTrue(self.store.rename_group("user", "wafer", "old", "new"))

    def test_delete_both_trees_preserves_other_group(self):
        self.fixture()
        self.store.create_group("user", "wafer", "sibling")
        self.assertTrue(self.store.delete_group("user", "wafer", "old"))
        self.assertFalse(self.store._group_dir("user", "wafer", "old").exists())
        self.assertFalse(self.store._positions_group_dir("user", "wafer", "old").exists())
        self.assertTrue(self.store._group_dir("user", "wafer", "sibling").exists())

    def test_entry_deletion_cannot_escape_group(self):
        _, copied = self.fixture()
        for filename in ("..", "../sentinel.png", str(self.root / "sentinel.png")):
            with self.subTest(filename=filename):
                with self.assertRaises(ValueError):
                    self.store.remove_entry("user", "wafer", "old", filename)
                result = self.store.remove_entries_batch("user", "wafer", "old", [filename])
                self.assertEqual(result["error_count"], 1)
                self.assertEqual(result["success_count"], 0)
        self.assertTrue(copied.exists())
        self.fixture("lot")
        with self.assertRaises(ValueError):
            self.store.remove_entry("user", "lot", "old", "..")

    def test_lot_path_input_keeps_basename_matching(self):
        _, copied = self.fixture("lot")
        self.assertTrue(self.store.remove_entry("user", "lot", "old", "source/" + copied.name))
        self.assertFalse(copied.exists())

    def test_resolved_group_escape_rejected(self):
        _, copied = self.fixture()
        group = self.store._group_dir("user", "wafer", "old")
        original = Path.resolve

        def redirected(path, *args, **kwargs):
            if path == group:
                return self.root / "outside"
            return original(path, *args, **kwargs)

        with patch.object(Path, "resolve", redirected), patch.object(self.store.shutil, "rmtree") as remove:
            with self.assertRaises(ValueError):
                self.store.delete_group("user", "wafer", "old")
            remove.assert_not_called()
        self.assertTrue(copied.exists())

    def test_rename_waits_for_batch_image_and_positions(self):
        for mode in ("lot", "wafer"):
            with self.subTest(mode=mode):
                source, _ = self.fixture(mode)
                image_copied = Event()
                release_positions = Event()
                rename_started = Event()
                original = self.store._copy_position_file

                def delayed_positions(*args, **kwargs):
                    image_copied.set()
                    if not release_positions.wait(5):
                        raise TimeoutError("test did not release positions copy")
                    return original(*args, **kwargs)

                def rename():
                    rename_started.set()
                    return self.store.rename_group("user", mode, "batch", "renamed")

                with patch.object(self.store, "_copy_position_file", delayed_positions), ThreadPoolExecutor(2) as pool:
                    batch = pool.submit(self.store.add_lot_batch, "user", mode, "batch", [source])
                    try:
                        self.assertTrue(image_copied.wait(5))
                        acquired = self.store._LOCK.acquire(blocking=False)
                        if acquired:
                            self.store._LOCK.release()
                        self.assertFalse(acquired, "batch must retain mutation lock between paired copies")
                        moving = pool.submit(rename)
                        self.assertTrue(rename_started.wait(5))
                        self.assertFalse(moving.done())
                    finally:
                        release_positions.set()
                    self.assertEqual(batch.result(timeout=5)["success_count"], 1)
                    self.assertTrue(moving.result(timeout=5))
                renamed = self.store._group_dir("user", mode, "renamed")
                copied = renamed / source.name if mode == "wafer" else renamed / "LOT" / source.name
                self.assertEqual(copied.read_bytes(), source.read_bytes())
                positions = self.store._find_position_file(copied.relative_to(self.store.IMAGES_ROOT).as_posix())
                self.assertEqual(len(json.loads(positions.read_bytes())["chips"]), 1)
                self.assertFalse(self.store._group_dir("user", mode, "batch").exists())
                self.assertFalse(self.store._positions_group_dir("user", mode, "batch").exists())

    def test_batch_keeps_parallel_copy_workers(self):
        source, _ = self.fixture()
        second = source.with_name("LOT_00P_04_sample.png")
        second.write_bytes(source.read_bytes())
        workers = Barrier(2)
        original = self.store._copy_image_file

        def overlapping_copy(*args):
            workers.wait(timeout=5)
            return original(*args)

        with patch.object(self.store, "_copy_image_file", overlapping_copy):
            result = self.store.add_lot_batch("user", "wafer", "parallel", [source, second])
        self.assertEqual(result["success_count"], 2)
        self.assertEqual(result["error_count"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
