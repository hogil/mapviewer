"""Isolated thumbnail publication/cache race regressions; no server or E2E."""
import ast
import asyncio
import os
import shutil
import tempfile
import threading
import time
import uuid
import unittest
from pathlib import Path
from contextlib import contextmanager
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, Mock, patch

import pyvips
from PIL import Image
from check_audit_api import FULL, load_functions


class ThumbnailPublicationTests(unittest.TestCase):
    def namespace(self, render, root=None):
        ns = load_functions(FULL, ['_generate_thumbnail_sync', '_thumbnail_cache_stat', '_read_thumbnail_bytes',
                                  '_thumbnail_cache_guard', '_remove_thumbnail_cache_path'],
                            os=os, uuid=uuid, _thumbnail_publish_lock=threading.Lock(),
                            _render_thumbnail_sync=render, threading=threading, shutil=shutil,
                            config=SimpleNamespace(THUMBNAIL_DIR=root or Path(tempfile.gettempdir())),
                            _thumbnail_cache_condition=threading.Condition(), _thumbnail_cache_states={})
        ns['_thumbnail_cache_guard'] = contextmanager(ns['_thumbnail_cache_guard'])
        return ns

    def test_real_encoders_retry_deleted_output_parent(self):
        for fmt in ('JPEG', 'WEBP', 'PNG'):
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = root / 'source.png'
                Image.new('RGB', (80, 60), 'blue').save(source)
                target = root / 'cache' / ('thumb.' + fmt.lower())
                attempts = []

                def render(image, output, *args):
                    output.parent.mkdir(parents=True, exist_ok=True)
                    attempts.append(output)
                    if len(attempts) == 1:
                        shutil.rmtree(output.parent)
                    native = pyvips.Image.new_from_file(str(image))
                    if fmt == 'JPEG':
                        native.jpegsave(str(output))
                    elif fmt == 'WEBP':
                        native.webpsave(str(output))
                    else:
                        native.pngsave(str(output))

                self.namespace(render)['_generate_thumbnail_sync'](source, target, (80, 60))
                self.assertEqual(len(attempts), 2)
                with Image.open(target) as image:
                    image.load()
                    self.assertEqual(image.size, (80, 60))
                self.assertEqual(list(target.parent.iterdir()), [target])

    def test_partial_write_failure_preserves_old_cache_and_propagates(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source', Path(tmp) / 'thumb.jpg'
            source.write_bytes(b'source')
            target.write_bytes(b'old complete image')
            def render(image, output, *args):
                output.write_bytes(b'partial')
                self.assertEqual(target.read_bytes(), b'old complete image')
                raise ValueError('encoder failed')
            render_mock = Mock(side_effect=render)
            with self.assertRaisesRegex(ValueError, 'encoder failed'):
                self.namespace(render_mock)['_generate_thumbnail_sync'](source, target, (80, 60))
            self.assertEqual(render_mock.call_count, 1)
            self.assertEqual(target.read_bytes(), b'old complete image')
            self.assertEqual(len(list(Path(tmp).iterdir())), 2)

    def test_cleanup_recreated_parent_before_error_is_still_retried_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source.png', Path(tmp) / 'cache' / 'thumb.png'
            Image.new('RGB', (8, 6), 'blue').save(source)
            attempts = []

            def render(image, output, *args):
                output.parent.mkdir(parents=True, exist_ok=True)
                attempts.append(output)
                if len(attempts) == 1:
                    shutil.rmtree(output.parent)
                    output.parent.mkdir()
                    raise pyvips.Error('unable to call jpegsave: No such file or directory')
                Image.new('RGB', (8, 6), 'blue').save(output)

            self.namespace(render)['_generate_thumbnail_sync'](source, target, (8, 6))
            self.assertEqual(len(attempts), 2)
            with Image.open(target) as image:
                image.load()

    def test_persistent_missing_output_fails_after_two_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source', Path(tmp) / 'cache' / 'thumb.jpg'
            source.write_bytes(b'source')
            render = Mock(side_effect=FileNotFoundError('output removed'))
            with self.assertRaises(FileNotFoundError):
                self.namespace(render)['_generate_thumbnail_sync'](source, target, (8, 6))
            self.assertEqual(render.call_count, 2)

    def test_missing_native_operation_is_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source', Path(tmp) / 'thumb.jpg'
            source.write_bytes(b'source')
            render = Mock(side_effect=pyvips.Error("no property named 'jpegsave'"))
            with self.assertRaises(pyvips.Error):
                self.namespace(render)['_generate_thumbnail_sync'](source, target, (8, 6))
            self.assertEqual(render.call_count, 1)

    def test_empty_encoder_output_does_not_replace_valid_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source', Path(tmp) / 'thumb.jpg'
            source.write_bytes(b'source')
            target.write_bytes(b'complete previous image')
            render = Mock(side_effect=lambda image, output, *args: output.write_bytes(b''))
            with self.assertRaisesRegex(RuntimeError, 'empty file'):
                self.namespace(render)['_generate_thumbnail_sync'](source, target, (8, 6))
            self.assertEqual(target.read_bytes(), b'complete previous image')
            self.assertEqual(render.call_count, 1)
            self.assertEqual(len(list(Path(tmp).iterdir())), 2)

    def test_concurrent_writers_use_unique_complete_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, target = root / 'source', root / 'thumb.jpg'
            source.write_bytes(b'source')
            def render(image, output, *args):
                Image.new('RGB', (80, 60), 'blue').save(output, 'JPEG')
            generate = self.namespace(render)['_generate_thumbnail_sync']
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: generate(source, target, (80, 60)), range(40)))
            with Image.open(target) as image:
                image.load()
            self.assertEqual(len(list(root.iterdir())), 2)

    def test_publication_waits_for_active_cache_reader(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source', Path(tmp) / 'thumb.jpg'
            source.write_bytes(b'source')
            target.write_bytes(b'old complete image')
            reading, release, rendered = threading.Event(), threading.Event(), threading.Event()
            original_read = Path.read_bytes

            def read(path):
                if path != target:
                    return original_read(path)
                with path.open('rb') as stream:
                    reading.set()
                    if not release.wait(5):
                        raise AssertionError('reader release not signaled')
                    return stream.read()

            def render(image, output, *args):
                output.write_bytes(b'new complete image')
                rendered.set()

            ns = self.namespace(render)
            with patch.object(Path, 'read_bytes', read), ThreadPoolExecutor(max_workers=2) as pool:
                reader = pool.submit(ns['_read_thumbnail_bytes'], target)
                writer = None
                try:
                    self.assertTrue(reading.wait(5))
                    writer = pool.submit(ns['_generate_thumbnail_sync'], source, target, (8, 6))
                    self.assertTrue(rendered.wait(5))
                    self.assertFalse(writer.done())
                finally:
                    release.set()
                self.assertEqual(reader.result(timeout=5), b'old complete image')
                writer.result(timeout=5)
            self.assertEqual(target.read_bytes(), b'new complete image')

    def test_invalidation_waits_for_cache_reader(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'alice' / 'v1' / 'thumb.jpg'
            target.parent.mkdir(parents=True)
            target.write_bytes(b'complete cache')
            entered, release = threading.Event(), threading.Event()
            ns = self.namespace(Mock(), root)
            original_read = Path.read_bytes
            def blocked_read(path):
                if path == target:
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('Cache reader was not released')
                return original_read(path)
            with patch.object(Path, 'read_bytes', blocked_read), ThreadPoolExecutor(max_workers=2) as pool:
                reader = pool.submit(ns['_read_thumbnail_bytes'], target)
                try:
                    self.assertTrue(entered.wait(5))
                    remover = pool.submit(ns['_remove_thumbnail_cache_path'], root / 'alice')
                    deadline = time.monotonic() + 5
                    while True:
                        with ns['_thumbnail_cache_condition']:
                            queued = any(state['waiting'] for state in ns['_thumbnail_cache_states'].values())
                        if queued:
                            break
                        self.assertLess(time.monotonic(), deadline, 'Invalidation was not queued')
                        time.sleep(.005)
                    self.assertFalse(remover.done())
                finally:
                    release.set()
                self.assertEqual(reader.result(timeout=5), b'complete cache')
                self.assertEqual(remover.result(timeout=5), 1)
            self.assertFalse(target.exists())

    def test_encoder_failure_releases_cache_owner_for_invalidation_and_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            source.write_bytes(b'fixture')
            target = root / 'alice' / 'v1' / 'thumb.jpg'
            def failed_render(image, output, *args):
                output.parent.mkdir(parents=True, exist_ok=True)
                raise ValueError('injected encoder failure')
            ns = self.namespace(failed_render, root)
            with self.assertRaisesRegex(ValueError, 'injected encoder failure'):
                ns['_generate_thumbnail_sync'](source, target, (8, 6))
            with ThreadPoolExecutor(max_workers=1) as pool:
                self.assertEqual(pool.submit(ns['_remove_thumbnail_cache_path'], root / 'alice').result(timeout=5), 1)
            def valid_render(image, output, *args):
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new('RGB', (8, 6), 'blue').save(output, 'JPEG')
            ns['_render_thumbnail_sync'] = valid_render
            ns['_generate_thumbnail_sync'](source, target, (8, 6))
            with Image.open(target) as image:
                image.load()
                self.assertEqual(image.size, (8, 6))

    def test_all_original_image_fallbacks_preserve_gradient_filter(self):
        tree = ast.parse(FULL.read_text(encoding='utf-8-sig'))
        route = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                     and node.name == 'get_thumbnail')
        calls = [node for node in ast.walk(route) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == 'get_image']
        self.assertEqual(len(calls), 4)
        for call in calls:
            with self.subTest(line=call.lineno):
                fallback = AsyncMock(return_value='original')
                bindings = dict(request=object(), path='source.png', personalized=True,
                                scheme='user', grade_filter='A', bottom_filter='B',
                                border_normalize=True, gradient_filter='2,5', get_image=fallback)
                result = eval(compile(ast.Expression(body=call), '<fallback>', 'eval'), bindings)
                self.assertEqual(asyncio.run(result), 'original')
                self.assertEqual(fallback.call_args.kwargs['gradient_filter'], '2,5')

    def test_cache_deleted_during_stat_is_a_miss(self):
        path = Mock()
        path.stat.side_effect = FileNotFoundError('deleted concurrently')
        self.assertIsNone(self.namespace(Mock())['_thumbnail_cache_stat'](path))


if __name__ == '__main__':
    unittest.main()
