"""Isolated production-function checks for Composite artifact readiness and NPZ writes."""
from __future__ import annotations

import ast
import copy
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import json
import logging
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import zipfile

import numpy as np
from PIL import Image


REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "output/audit-fixes-20260911/composite-persistence"
SELECTED = {
    "_save_npz_payload", "_persist_square_map_data", "_write_gradient_stats_payload",
    "_save_gradient_stats", "_build_gradient_stat_for_map", "_save_sum_map_variants",
    "create_composite_heatmaps",
    "_copy_positions_without_bin", "recolor_saved_sum_maps",
}
TREE = ast.parse((REPO / "api/composite_map.py").read_text(encoding="utf-8-sig"))
CODE = compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)] +
                         [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in SELECTED],
                         type_ignores=[])), str(REPO / "api/composite_map.py"), "exec")


class CompositePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.root = OUT / uuid.uuid4().hex
        self.root.mkdir(parents=True)
        self.palette = [channel for value in range(256) for channel in (value, value, value)]
        self.base = np.zeros((64, 64), dtype=np.uint8)
        self.scope = dict(np=np, os=os, time=time, threading=threading, uuid=uuid,
                          zipfile=zipfile, Path=Path, Image=Image, ThreadPoolExecutor=ThreadPoolExecutor,
                          logger=logging.getLogger("npz-check"), _CACHE_COMPRESS=True,
                          _CACHE_COMPRESS_LEVEL=1, SQUARE_MAP_CACHE_FILENAME="square_maps_data.npz",
                          _NPZ_REPLACE_LOCK=threading.Lock())
        exec(CODE, self.scope)
        self.persist = self.scope["_persist_square_map_data"]

    def save(self, value=0):
        self.persist(self.root, self.palette, np.full_like(self.base, value), image_count=1)

    def read(self):
        with np.load(self.root / "square_maps_data.npz") as data:
            return data["base_indices"].copy()

    def test_immediate_npz_readability(self):
        self.save(5)
        np.testing.assert_array_equal(self.read(), np.full_like(self.base, 5))
        self.assertFalse(list(self.root.glob("*_tmp.npz")))

    def test_save_failure_preserves_previous_cache(self):
        self.save(3)

        def failed_write(target, *args, **kwargs):
            Path(target).write_bytes(b"partial")
            raise OSError("injected write failure")

        with patch.dict(self.scope, {"_save_npz_payload": failed_write}), self.assertRaises(OSError):
            self.save(7)
        np.testing.assert_array_equal(self.read(), np.full_like(self.base, 3))
        self.assertFalse(list(self.root.glob("*_tmp.npz")))

    def test_replace_failure_preserves_previous_cache(self):
        self.save(2)
        with patch.object(Path, "replace", side_effect=PermissionError("injected replace failure")), self.assertRaises(PermissionError):
            self.save(6)
        np.testing.assert_array_equal(self.read(), np.full_like(self.base, 2))
        self.assertFalse(list(self.root.glob("*_tmp.npz")))

    def test_concurrent_writers_use_distinct_temporary_files(self):
        reached = threading.Barrier(4)
        targets = []
        lock = threading.Lock()
        writer = self.scope["_save_npz_payload"]

        def overlapping_write(target, *args, **kwargs):
            with lock:
                targets.append(str(target))
            reached.wait(timeout=5)
            writer(target, *args, **kwargs)

        with patch.dict(self.scope, {"_save_npz_payload": overlapping_write}), ThreadPoolExecutor(4) as pool:
            list(pool.map(self.save, range(4)))
        self.assertEqual(len(set(targets)), 4)
        values = np.unique(self.read())
        self.assertEqual(len(values), 1)
        self.assertIn(int(values[0]), range(4))
        self.assertFalse(list(self.root.glob("*_tmp.npz")))

    def configure_generation(self):
        source = self.root / "source.png"
        Image.fromarray(self.base).save(source)
        self.scope.update(
            IMAGES_ROOT=self.root, ANONYMOUS_LOGIN_ID="fixture", _HAS_NUMBA=False,
            COMPOSITE_LOADER_MODE="pil", COMPOSITE_MAX_WORKERS=1, COMPOSITE_BATCH_SIZE=1,
            _trace_enabled=lambda: False, _normalize_selected_chip_coords=lambda x: None,
            _normalize_selected_shot_groups=lambda x: [], _numba_runtime_info=lambda **kwargs: {},
            _prepare_output_dir=lambda user: (self.root, "fixture"),
            _build_palette_list=lambda value: self.palette,
            _batched_paths=lambda paths, batch: [paths],
            _iter_pixel_indices=lambda paths, **kwargs: [(paths[0], self.base)],
            _first_image_with_positions=lambda paths: "positions-source",
            _load_source_positions_data=lambda path: {},
            _build_chip_base_indices_from_positions=lambda *args, **kwargs: self.base.copy(),
            _selected_composite_value_mask=lambda **kwargs: self.base == 0,
            _clear_selected_shot_display_metadata=lambda path: None,
            _use_sum_float16=lambda: False,
            load_composite_color_settings=lambda scheme: SimpleNamespace(colors=["#000000", "#ffffff"], quantiles=None, scheme="fixture"),
            _hex_to_rgb_tuple=lambda color: (0, 0, 0),
            _interpolate_percentile_colors=lambda *args: None,
            _build_sum_map_palette=lambda palette, **kwargs: self.palette,
            _value_range_for_map=lambda *args, **kwargs: (0, 1),
            _render_sum_map_palette=lambda **kwargs: kwargs["base_indices"],
        )

        def save_png(array, palette, path):
            image = Image.fromarray(array).convert("P")
            image.putpalette(palette)
            image.save(path)
            return path, path.relative_to(self.root).as_posix()

        def positions(*args, **kwargs):
            (self.root / "positions-ready.json").write_text('{"ready":true}', encoding="utf-8")

        self.scope.update(_save_palette_png=save_png, _copy_positions_without_bin=positions)

    def assert_blocked_until_persisted(self, create):
        entered = threading.Event()
        release = threading.Event()
        original = self.scope["_persist_square_map_data"]

        def delayed_persist(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test did not release NPZ persistence")
            return original(*args, **kwargs)

        with patch.dict(self.scope, {"_persist_square_map_data": delayed_persist}), ThreadPoolExecutor(1) as pool:
            future = pool.submit(create)
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(TimeoutError):
                    future.result(timeout=.1)
            finally:
                release.set()
            future.result(timeout=5)
        self.read()
        self.assertTrue((self.root / "gradient_stats.json").is_file())

    def test_heatmap_completion_waits_for_npz_and_positions(self):
        self.configure_generation()
        create = lambda: self.scope["create_composite_heatmaps"](["source.png"], indices=[0])
        self.assert_blocked_until_persisted(create)
        self.assertTrue((self.root / "positions-ready.json").is_file())

        entered = threading.Event()
        release = threading.Event()
        positions = self.scope["_copy_positions_without_bin"]

        def delayed_positions(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test did not release positions")
            positions(*args, **kwargs)

        with patch.dict(self.scope, {"_copy_positions_without_bin": delayed_positions}), ThreadPoolExecutor(1) as pool:
            future = pool.submit(create)
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(TimeoutError):
                    future.result(timeout=.1)
            finally:
                release.set()
            future.result(timeout=5)

    def test_sum_map_completion_waits_for_npz_and_gradient(self):
        self.configure_generation()
        counts = np.zeros((8, 64, 64), dtype=np.uint16)
        counts[0] = 1
        self.assert_blocked_until_persisted(lambda: self.scope["_save_sum_map_variants"](
            None, self.root, self.palette, base_indices=self.base,
            grade_counts=counts, image_count=1))

    def test_generation_reports_persistence_failure(self):
        self.configure_generation()
        with patch.dict(self.scope, {"_save_npz_payload": lambda *args, **kwargs: (_ for _ in ()).throw(OSError("injected write failure"))}):
            with self.assertRaises(OSError):
                self.scope["create_composite_heatmaps"](["source.png"], indices=[0])
        self.assertFalse((self.root / "square_maps_data.npz").exists())

    def test_positions_write_failure_propagates_and_missing_source_remains_optional(self):
        writer = unittest.mock.Mock(side_effect=OSError("injected positions write failure"))
        self.scope.update(copy=copy, IMAGES_ROOT=self.root, POSITIONS_ROOT=self.root / "positions",
                          _load_source_positions_data=lambda path: {"chips": [{"x_abs": 1, "y_abs": 2}]},
                          _normalize_selected_chip_coords=lambda coords: None,
                          _positions_json_cache={}, _atomic_write_json=writer)
        with self.assertRaises(OSError):
            self.scope["_copy_positions_without_bin"]("source.png", self.root / "generated", ["Grade_0.png"])
        writer.assert_called_once()
        writer.reset_mock()
        self.scope["_load_source_positions_data"] = lambda path: None
        self.scope["_copy_positions_without_bin"]("without-positions.png", self.root / "generated", ["Grade_0.png"])
        writer.assert_not_called()

    def test_recolor_reports_cache_persistence_failure(self):
        self.configure_generation()
        self.persist(self.root, self.palette, self.base,
                     square_mean_map=self.base.astype(np.float32),
                     weighted_map=self.base.astype(np.float32),
                     calc_mask=self.base == 0, weighted_mask=self.base == 0,
                     image_count=1)
        cache_path = self.root / "square_maps_data.npz"
        previous_cache = cache_path.read_bytes()
        writer = unittest.mock.Mock(side_effect=OSError("injected recolor persistence failure"))
        self.scope["_bool_from_npz_array"] = lambda value, default: bool(value.item()) if value is not None else default
        with patch.dict(self.scope, {"_persist_square_map_data": writer}):
            with self.assertRaisesRegex(OSError, "injected recolor persistence failure"):
                self.scope["recolor_saved_sum_maps"](self.root)
        writer.assert_called_once()
        self.assertEqual(cache_path.read_bytes(), previous_cache)
        self.assertTrue((self.root / "square_average.png").is_file())
        self.assertTrue((self.root / "square_weighted_average.png").is_file())


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(CompositePersistenceTests))
    (OUT / "results.json").write_text(json.dumps({"pass": result.testsRun - len(result.failures) - len(result.errors),
                                                  "tests": result.testsRun, "success": result.wasSuccessful(),
                                                  "elapsedMs": round((time.perf_counter()-started)*1000)}, indent=2), encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
