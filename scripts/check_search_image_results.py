"""Real cached-index search excludes non-images before count and pagination."""
import logging
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.index_service import IndexService
from api.search_service import SearchService


class SearchImageResultsTests(unittest.IsolatedAsyncioTestCase):
    async def test_comparison_maps_are_global_only_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            derived = 'object_id_map_compare_260914/maps/LOT1_00P_01.png'
            source = 'unknown/source/LOT1_00P_01.png'
            cache = root / 'index.txt'
            cache.write_text('\n'.join([derived, source]), encoding='utf-8')
            index = IndexService(root, set(), cache, root/'index.lock', 1)
            self.assertTrue(index.load_cache(log=False))
            service = SearchService(index, io_executor=None, logger=logging.getLogger('check'),
                                    search_workers=1, supported_exts={'.png'})
            for query in ('lot1', 'lot1 or absent', ''):
                result = await service.search(query=query, lot_filter={'lot1'},
                                              offset=0, limit=100, current_folder=root)
                self.assertEqual(result['results'], [source])
                scoped = await service.search(query=query, lot_filter={'lot1'}, offset=0,
                                              limit=100, current_folder=root/'object_id_map_compare_260914')
                self.assertEqual(scoped['results'], [derived])

    async def test_cached_search_modes_filter_metadata_before_pagination(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            keys = ['maps/LOT1_00P_01_20260101.npy', 'maps/LOT1_00P_01_20260101.PNG',
                    'maps/LOT1_00P_02_20260101.json', 'maps/LOT1_00P_02_20260101.jpg']
            cache = root / 'index.txt'
            cache.write_text('\n'.join(keys), encoding='utf-8')
            index = IndexService(root, set(), cache, root/'index.lock', 1)
            self.assertTrue(index.load_cache(log=False))
            service = SearchService(index, io_executor=None, logger=logging.getLogger('check'),
                                    search_workers=1, supported_exts={'.png', '.jpg'})
            modes = [dict(query='lot1', lot_filter=set()),
                     dict(query='lot1 or absent', lot_filter=set()),
                     dict(query='', lot_filter={'lot1'}),
                     dict(query='', lot_filter=set(), lot_wafer_pairs=[('lot1', '01'), ('lot1', '02')])]
            for folder in (root, root/'maps'):
                for mode in modes:
                    for offset in (0, 1):
                        with self.subTest(folder=folder.name, mode=mode, offset=offset):
                            result = await service.search(**mode, offset=offset, limit=1, current_folder=folder)
                            self.assertEqual(result['total'], 2)
                            self.assertEqual(result['results'], [keys[1 if offset == 0 else 3]])
                            self.assertEqual(result['timings']['unsupported_files_filtered'], 2)


if __name__ == '__main__':
    unittest.main()
