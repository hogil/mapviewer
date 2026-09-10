"""Real held-open reads versus class/MY LOT mutations in temporary fixtures only."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import io
import json
import math
from pathlib import Path
import re
import shutil
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import anyio
import numpy as np
from PIL import Image

from check_mutable_thumbnail import FULL, load_functions
import check_audit_mylot as mylot_checks


class MutableImageRaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mapviewer-read-race-')
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.cleanup)
        self.source = self.root / 'classification' / 'owned' / 'image.png'
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b'x' * (16 * 1024 * 1024))

    def cleanup(self):
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temp.cleanup()

    def namespace(self, *names, **bindings):
        defaults = dict(ROOT_DIR=self.root, anyio=anyio, shutil=shutil,
                        _delete_class_positions_dir=Mock(), _rename_class_positions_dir=Mock(return_value=0))
        defaults.update(bindings)
        return load_functions(FULL, names, **defaults)

    def held_read(self, path, opened, release):
        with path.open('rb') as source:
            opened.set()
            if not release.wait(5):
                raise AssertionError('Held read release missing')
            return source.read()

    async def test_class_delete_and_rename_wait_only_for_same_class_snapshot(self):
        for operation in ('delete', 'rename'):
            with self.subTest(operation=operation):
                self.source.parent.mkdir(exist_ok=True)
                self.source.write_bytes(b'x' * (16 * 1024 * 1024))
                other = self.root / 'classification' / 'unrelated' / 'image.png'
                other.parent.mkdir(exist_ok=True)
                other.write_bytes(b'unrelated')
                ns = self.namespace('_delete_class_storage', '_rename_class_storage')
                opened, release, mutating = threading.Event(), threading.Event(), threading.Event()
                original_read = Path.read_bytes
                def read(path):
                    return self.held_read(path, opened, release) if path == self.source else original_read(path)
                def mutate():
                    mutating.set()
                    if operation == 'delete':
                        return ns['_delete_class_storage'](self.source.parent, True)
                    return ns['_rename_class_storage'](self.source.parent, self.source.parent.with_name('renamed'))
                with patch.object(Path, 'read_bytes', read), ThreadPoolExecutor(max_workers=3) as pool:
                    reader = pool.submit(ns['_mutable_image_snapshot'], self.source)
                    try:
                        self.assertTrue(opened.wait(5))
                        mutation = pool.submit(mutate)
                        self.assertTrue(mutating.wait(5))
                        self.assertEqual(pool.submit(ns['_mutable_image_snapshot'], other).result(timeout=1), b'unrelated')
                        self.assertFalse(mutation.done(), 'Mutation must wait while this source file is open')
                        self.assertTrue(self.source.exists())
                    finally:
                        release.set()
                    self.assertEqual(len(reader.result(timeout=5)), 16 * 1024 * 1024)
                    mutation.result(timeout=5)
                self.assertFalse(self.source.exists())

    async def test_mylot_snapshot_reuses_existing_storage_lock(self):
        fixture = mylot_checks.MyLotStorageTests()
        fixture.setUp()
        try:
            _, source = fixture.fixture()
            ns = self.namespace(MY_LOT_STORAGE_LOCK=fixture.store._LOCK, ROOT_DIR=fixture.store.IMAGES_ROOT)
            opened, release, mutating = threading.Event(), threading.Event(), threading.Event()
            def mutate():
                mutating.set()
                return fixture.store.delete_group('user', 'wafer', 'old')
            with patch.object(Path, 'read_bytes', lambda path: self.held_read(path, opened, release)), ThreadPoolExecutor(max_workers=2) as pool:
                reader = pool.submit(ns['_mutable_image_snapshot'], source)
                try:
                    self.assertTrue(opened.wait(5))
                    mutation = pool.submit(mutate)
                    self.assertTrue(mutating.wait(5))
                    self.assertFalse(mutation.done())
                finally:
                    release.set()
                self.assertEqual(reader.result(timeout=5), b'isolated-image-bytes')
                self.assertTrue(mutation.result(timeout=5))
            self.assertFalse(source.exists())
            self.assertFalse(fixture.store._positions_group_dir('user', 'wafer', 'old').exists())
        finally:
            fixture.doCleanups()

    async def test_class_endpoint_wait_does_not_block_event_loop(self):
        ns = self.namespace('_delete_class_storage', 'delete_class',
                            PathParam=lambda default=None, **kwargs: default,
                            _check_folder_permission=Mock(), _CLASS_NAME_RE=re.compile(r'^[a-z]+$'),
                            _classification_dir=lambda **kwargs: self.root / 'classification',
                            index_service=Mock(), _dircache_invalidate=Mock(), DIRLIST_CACHE={}, log_access_row=Mock())
        opened, release = threading.Event(), threading.Event()
        with patch.object(Path, 'read_bytes', lambda path: self.held_read(path, opened, release)), ThreadPoolExecutor(max_workers=1) as pool:
            reader = pool.submit(ns['_mutable_image_snapshot'], self.source)
            task = None
            try:
                self.assertTrue(opened.wait(5))
                task = asyncio.create_task(ns['delete_class'](object(), 'owned', True, 'wafer'))
                await asyncio.sleep(0.02)
                self.assertFalse(task.done(), 'Class mutation must wait in its worker while event loop advances')
            finally:
                release.set()
            reader.result(timeout=5)
            result = await asyncio.wait_for(task, 5)
        self.assertEqual(result['deleted'], 'owned')
        self.assertFalse(self.source.exists())

    async def test_chip_grade_decode_releases_source_before_numpy_processing(self):
        image = Image.new('P', (64, 64), 7)
        image.putpalette([value for value in range(256) for _ in range(3)])
        image.save(self.source, bits=8)
        ns = self.namespace('_attach_chip_palette_indices', Image=Image, io=io, math=math)
        positions = {'chips': [{'rect': {'x0': 0, 'y0': 0, 'x1': 64, 'y1': 64}}]}
        opened, release = threading.Event(), threading.Event()
        original_array = np.array
        def decode(*args, **kwargs):
            opened.set()
            if not release.wait(5):
                raise AssertionError('Palette decoder release missing')
            return original_array(*args, **kwargs)
        with patch.object(np, 'array', side_effect=decode), ThreadPoolExecutor(max_workers=1) as pool:
            task = pool.submit(ns['_attach_chip_palette_indices'], self.source, positions)
            try:
                self.assertTrue(opened.wait(5))
                self.source.unlink()
            finally:
                release.set()
            task.result(timeout=5)
        self.assertEqual(positions['chips'][0]['palette_index'], 7)

    async def test_palette_count_decode_can_finish_after_source_deletion(self):
        image = Image.new('P', (64, 64), 7)
        image.putpalette([value for value in range(256) for _ in range(3)])
        image.save(self.source, bits=8)
        ns = self.namespace('get_palette_counts', Image=Image, io=io, np=np,
                            _get_relative_path_from_image=lambda path: path)
        opened, release = threading.Event(), threading.Event()
        original_array = np.array
        def decode(*args, **kwargs):
            opened.set()
            if not release.wait(5):
                raise AssertionError('Palette count release missing')
            return original_array(*args, **kwargs)
        with patch.object(np, 'array', side_effect=decode):
            task = asyncio.create_task(ns['get_palette_counts'](str(self.source)))
            try:
                self.assertTrue(await asyncio.to_thread(opened.wait, 5))
                self.source.unlink()
            finally:
                release.set()
            result = await asyncio.wait_for(task, 5)
        counts = json.loads(result.body)
        self.assertEqual(counts['counts'][7], 4096)
        self.assertEqual(counts['total'], 4096)

    async def test_mutable_original_response_owns_bytes_and_head_skips_full_read(self):
        source = self.source.with_suffix('.bmp')
        source.write_bytes(b'original image bytes')
        ns = self.namespace('get_image', current_folder=self.root, compute_etag=lambda stat: 'fixture-etag')
        read = ns['_mutable_image_snapshot']
        with patch.dict(ns, _mutable_image_snapshot=Mock(wraps=read)):
            head = await ns['get_image'](SimpleNamespace(method='HEAD'), str(source))
            ns['_mutable_image_snapshot'].assert_not_called()
            self.assertEqual(Path(head.path), source)
        response = await ns['get_image'](SimpleNamespace(method='GET'), str(source))
        source.unlink()
        self.assertEqual(response.body, b'original image bytes')
        self.assertEqual(response.headers['etag'], 'fixture-etag')


if __name__ == '__main__':
    unittest.main(verbosity=2)
