import importlib
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api.config import IMAGES_ROOT
import api.composite_map as cm

EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.gif'}
BASE = Path(IMAGES_ROOT) / 'palette_3k'


def collect(limit=10):
    files = []
    for entry in sorted(BASE.iterdir()):
        if entry.is_file() and entry.suffix.lower() in EXTS:
            files.append(entry.relative_to(IMAGES_ROOT).as_posix())
            if len(files) >= limit:
                break
    if len(files) < limit:
        raise SystemExit(f"Need {limit} files under {BASE}")
    return files


def run(mode, paths):
    os.environ['COMPOSITE_COUNT_MODE'] = mode
    import api.config as config
    import api.composite_map as composite_map
    importlib.reload(config)
    importlib.reload(composite_map)
    start = time.time()
    result = composite_map.create_composite_heatmaps(
        paths,
        login_id=f"bench_{mode}",
        scheme=None,
        create_sum=True,
    )
    duration = time.time() - start
    print(f"[{mode}] {duration:.2f}s output={result['output_dir']}")
    return duration


if __name__ == '__main__':
    images = collect(10)
    print('Selected images:')
    for p in images:
        print(' -', p)
    chunk_time = run('chunk', images)
    cython_time = run('cython', images)
    print(f"\nchunk={chunk_time:.2f}s, cython={cython_time:.2f}s")
