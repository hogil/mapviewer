"""Real native thumbnail decode after isolated source rename/delete; no app import."""
import io
import os
from pathlib import Path
import tempfile
import threading
import uuid
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image
import pyvips

from check_audit_api import FULL, load_functions as _load_functions


def load_functions(source, names, **bindings):
    namespace = dict(os=os, uuid=uuid, _thumbnail_publish_lock=threading.Lock(), contextmanager=contextmanager, RLock=threading.RLock,
                     MY_LOT_STORAGE_LOCK=threading.RLock(),
                     _classification_image_locks={}, _classification_image_locks_guard=threading.Lock())
    if "_generate_thumbnail_sync" in names:
        names = [*names, "_render_thumbnail_sync", "_read_thumbnail_bytes"]
    namespace.update(bindings)
    namespace = _load_functions(source, ["_mutable_image_guard", "_mutable_image_snapshot", *names], **namespace)
    namespace['_mutable_image_guard'] = contextmanager(namespace['_mutable_image_guard'])
    return namespace


class MutableThumbnailTests(unittest.TestCase):
    def test_demand_and_background_pyramid_decode_after_source_is_deleted(self):
        for kind in ('demand', 'pipeline'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='mapviewer-thumbnail-') as tmp:
                root = Path(tmp).resolve()
                source = root / 'my-lot' / 'user' / 'wafer' / 'owned' / 'image.png'
                source.parent.mkdir(parents=True)
                image = Image.new('RGB', (600, 400), 'white')
                image.paste('blue', (50, 50, 450, 325))
                image.save(source)
                entered, release = threading.Event(), threading.Event()
                original_decode = pyvips.Image.new_from_buffer

                def decode(*args, **kwargs):
                    native = original_decode(*args, **kwargs)
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('Source deletion was not signaled')
                    return native

                config = SimpleNamespace(PYRAMID_FORMAT='WEBP', PYRAMID_Q=100,
                                         PYRAMID_PNG_COMPRESSION=6, PYRAMID_PNG_EFFORT=1,
                                         PYRAMID_LOADER_MODE='random', THUMBNAIL_DIR=root / 'thumbs')
                ns = load_functions(FULL, ['_pyramid_path_lock', '_generate_pyramid_sync', '_generate_pyramid_pipeline'],
                                    ROOT_DIR=root, config=config, uuid=uuid, contextmanager=contextmanager,
                                    Lock=threading.Lock, _pyramid_lock_guard=threading.Lock(), _pyramid_generation_locks={},
                                    _resolve_pyramid_dir=lambda level, **kwargs: root / f'pyramid-{level}')
                ns['_pyramid_path_lock'] = contextmanager(ns['_pyramid_path_lock'])
                output = root / 'pyramid.webp'
                with patch.object(pyvips.Image, 'new_from_buffer', side_effect=decode), ThreadPoolExecutor(max_workers=1) as pool:
                    if kind == 'demand':
                        task = pool.submit(ns['_generate_pyramid_sync'], source, output, 0.7)
                    else:
                        task = pool.submit(ns['_generate_pyramid_pipeline'], source, [0.7, 0.2], 'test', 'webp')
                    try:
                        self.assertTrue(entered.wait(5))
                        source.unlink()
                    finally:
                        release.set()
                    result = task.result(timeout=5)
                if kind == 'pipeline':
                    self.assertTrue(all(item[1] for item in result), result)
                    output = root / 'pyramid-0.7' / 'test_L70.webp'
                with Image.open(output) as rendered:
                    self.assertEqual(rendered.size, (420, 280))
                    self.assertGreater(len(rendered.getcolors(rendered.width * rendered.height)), 1)
                self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))

    def test_mutable_thumbnail_survives_source_rename_and_delete_during_decode(self):
        for folder in ('classification', 'classification_chips', 'my-lot'):
            with self.subTest(folder=folder), tempfile.TemporaryDirectory(prefix='mapviewer-thumbnail-') as tmp:
                root = Path(tmp).resolve()
                source = root / folder / 'owned' / 'image.png'
                source.parent.mkdir(parents=True)
                image = Image.new('RGB', (1200, 800), 'white')
                image.paste('blue', (100, 100, 900, 650))
                image.save(source)
                output = root / 'thumbnail.webp'
                entered, release = threading.Event(), threading.Event()

                def encode(native, target, quality):
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('Decoder release was not signaled')
                    native.webpsave(str(target), Q=quality)

                ns = load_functions(FULL, ['_generate_thumbnail_sync'], ROOT_DIR=root,
                                    THUMBNAIL_FORMAT='WEBP', THUMBNAIL_QUALITY=90,
                                    _webpsave_fast_to_file=encode, Image=Image, io=io)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(ns['_generate_thumbnail_sync'], source, output, (256, 256))
                    try:
                        self.assertTrue(entered.wait(5), 'Native image must exist before source mutation')
                        renamed = source.parent.with_name('owned_renamed')
                        self.assertTrue(source.parent.resolve().is_relative_to(root))
                        self.assertTrue(renamed.resolve().is_relative_to(root))
                        source.parent.rename(renamed)
                        (renamed / source.name).unlink()
                        renamed.rmdir()
                    finally:
                        release.set()
                    pending.result(timeout=5)
                with Image.open(output) as rendered:
                    self.assertGreater(rendered.width, 0)
                    self.assertGreater(len(rendered.getcolors(rendered.width * rendered.height)), 1)
                self.assertFalse(source.exists())
                self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))

    def test_immutable_source_retains_file_decoder_path(self):
        with tempfile.TemporaryDirectory(prefix='mapviewer-thumbnail-') as tmp:
            root = Path(tmp).resolve()
            source = root / 'unknown' / 'sample.png'
            source.parent.mkdir()
            Image.new('RGB', (32, 32), 'blue').save(source)
            ns = load_functions(FULL, ['_generate_thumbnail_sync'], ROOT_DIR=root,
                                THUMBNAIL_FORMAT='WEBP', THUMBNAIL_QUALITY=90,
                                _webpsave_fast_to_file=lambda native, target, quality: native.webpsave(str(target), Q=quality),
                                Image=Image, io=io)
            with patch.object(pyvips.Image, 'thumbnail', wraps=pyvips.Image.thumbnail) as file_decode:
                ns['_generate_thumbnail_sync'](source, root / 'out.webp', (16, 16))
                file_decode.assert_called_once_with(str(source), 16)
            self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))

    def test_source_deleted_between_existence_check_and_snapshot(self):
        with tempfile.TemporaryDirectory(prefix='mapviewer-thumbnail-') as tmp:
            root = Path(tmp).resolve()
            source = root / 'classification' / 'owned' / 'sample.png'
            source.parent.mkdir(parents=True)
            Image.new('RGB', (32, 32), 'blue').save(source)
            output = root / 'out.webp'
            ns = load_functions(FULL, ['_generate_thumbnail_sync'], ROOT_DIR=root)
            original_read = Path.read_bytes

            def removed_before_read(path):
                if path == source:
                    path.unlink()
                return original_read(path)

            with patch.object(Path, 'read_bytes', removed_before_read):
                self.assertIsNone(ns['_generate_thumbnail_sync'](source, output, (16, 16)))
            self.assertFalse(output.exists())
            ns['logger'].error.assert_not_called()
            self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
