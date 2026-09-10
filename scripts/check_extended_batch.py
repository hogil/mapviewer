"""MY LOT input accounting through the actual endpoint with isolated files."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
import anyio

from check_audit_api import FULL, HTTPException, load_functions


class BatchAccountingTests(unittest.IsolatedAsyncioTestCase):
    async def run_batch(self, paths, worker_result):
        with tempfile.TemporaryDirectory() as directory, ThreadPoolExecutor(1) as pool:
            root = Path(directory)
            (root / 'valid.png').write_bytes(b'isolated source')
            worker = Mock(return_value=worker_result.copy())
            namespace = load_functions(
                FULL, ['add_my_lot_batch_endpoint'],
                ROOT_DIR=root, _resolve_my_lot_login=lambda req: 'test',
                relkey_from_any_path=lambda value: value,
                asyncio=asyncio, IO_POOL=pool, my_lot_add_lot_batch=worker,
                _clone_my_lot_thumbnail_caches_async=AsyncMock(return_value=0),
            )
            request = SimpleNamespace(json=AsyncMock(return_value={
                'mode': 'wafer', 'group': 'owned', 'paths': paths,
            }))
            return await namespace['add_my_lot_batch_endpoint'](request), worker

    async def test_missing_mixed_with_valid_and_duplicate_is_counted(self):
        result, worker = await self.run_batch(['valid.png', 'valid.png', 'missing.png'], {
            'success_count': 1, 'duplicate_count': 1, 'error_count': 0, 'errors': [],
        })
        self.assertEqual((result['success_count'], result['duplicate_count'], result['error_count']), (1, 1, 1))
        self.assertEqual(result['errors'][0]['path'], 'missing.png')
        worker.assert_called_once()

    async def test_all_missing_returns_per_input_failure(self):
        result, worker = await self.run_batch(['missing.png', 'other.png'], {})
        self.assertTrue(result['success'])
        self.assertEqual((result['success_count'], result['duplicate_count'], result['error_count']), (0, 0, 2))
        self.assertEqual(len(result['errors']), 2)
        worker.assert_not_called()

    async def test_copy_failure_and_missing_are_both_counted(self):
        result, _ = await self.run_batch(['valid.png', 'missing.png'], {
            'success_count': 0, 'duplicate_count': 0, 'error_count': 1,
            'errors': [{'path': 'valid.png', 'reason': 'copy failed'}],
        })
        self.assertEqual(result['error_count'], 2)
        self.assertEqual(len(result['errors']), 2)

    async def test_image_deleted_after_lookup_returns_404(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / 'source.bmp'
            image.write_bytes(b'isolated source')
            logger = Mock()
            logger.info.side_effect = lambda *args: image.unlink()
            namespace = load_functions(FULL, ['get_image', '_mutable_image_snapshot'], ROOT_DIR=root,
                                       current_folder=root, logger=logger, anyio=anyio)
            with self.assertRaises(HTTPException) as raised:
                await namespace['get_image'](SimpleNamespace(method='GET'), str(image))
            self.assertEqual(raised.exception.status_code, 404)
            logger.exception.assert_not_called()

    async def test_unrelated_missing_internal_file_remains_500(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / 'source.bmp'
            image.write_bytes(b'isolated source')
            logger = Mock()
            logger.info.side_effect = FileNotFoundError(2, 'missing internal file', str(root / 'internal.cache'))
            namespace = load_functions(FULL, ['get_image', '_mutable_image_snapshot'], ROOT_DIR=root,
                                       current_folder=root, logger=logger, anyio=anyio)
            with self.assertRaises(HTTPException) as raised:
                await namespace['get_image'](SimpleNamespace(method='GET'), str(image))
            self.assertEqual(raised.exception.status_code, 500)
            logger.exception.assert_called_once()


if __name__ == '__main__':
    unittest.main()
