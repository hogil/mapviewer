"""Verify gradient selection survives native thumbnail fallback; no server or E2E."""
import ast
import builtins
import io
import struct
import sys
import tempfile
import types
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from PIL import Image
import pyvips

from check_mutable_thumbnail import FULL, load_functions


class ThumbnailGradientFallbackTests(unittest.TestCase):
    def test_gradient_pixels_match_native_when_native_decode_or_import_fails(self):
        tree = ast.parse((FULL.parent / 'personal_colors.py').read_text(encoding='utf-8-sig'))
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name == 'plte_gradient_filter_patch_memory')
        colors = types.ModuleType('api.personal_colors')
        colors.__dict__.update(struct=struct, zlib=zlib)
        exec(compile(ast.Module(body=[helper], type_ignores=[]), '<palette>', 'exec'), colors.__dict__)
        for name in ('plte_inplace_patch_memory', 'plte_measure_gradient_patch_memory',
                     'plte_composite_gradient_patch_memory'):
            setattr(colors, name, lambda data, *args: data)

        real_import = builtins.__import__

        def without_vips(name, *args, **kwargs):
            if name == 'pyvips':
                raise ImportError('native library unavailable')
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {'api.personal_colors': colors}):
            root = Path(tmp)
            for stem in ('square_average', 'square_weighted', 'square_mean'):
                source = root / f'{stem}.png'
                img = Image.new('P', (2, 1))
                img.putdata([25, 255])
                palette = [0] * 768
                palette[75:78] = [0, 255, 0]
                palette[765:768] = [255, 0, 0]
                img.putpalette(palette)
                img.save(source)
                for mode in ('native', 'decode_failure', 'import_failure'):
                    with self.subTest(stem=stem, mode=mode):
                        target = root / f'{stem}-{mode}.png'
                        ns = load_functions(FULL, ['_generate_thumbnail_sync'],
                                            ROOT_DIR=root, THUMBNAIL_FORMAT='PNG', THUMBNAIL_QUALITY=90,
                                            Image=Image, io=io, __package__='api',
                                            config=types.SimpleNamespace(PNG_COMPRESSION_LEVEL=1),
                                            _resolve_composite_map_gradient_mode=lambda path: None,
                                            _force_selected_shot_empty_slot_plte=lambda path, data: data,
                                            _apply_png_filters_memory=lambda **kwargs: kwargs['png_data'])
                        def render():
                            ns['_generate_thumbnail_sync'](
                                source, target, (2, 2), gradient_filter='1',
                                border_normalize=(mode == 'import_failure'),
                            )
                        if mode == 'decode_failure':
                            with patch.object(pyvips.Image, 'thumbnail_buffer', side_effect=RuntimeError('decode failed')):
                                render()
                        elif mode == 'import_failure':
                            with patch.object(builtins, '__import__', side_effect=without_vips):
                                render()
                        else:
                            render()
                        with Image.open(target) as result:
                            self.assertEqual(list(result.convert('RGB').getdata()),
                                             [(0, 255, 0), (255, 255, 255)])


if __name__ == '__main__':
    unittest.main()
