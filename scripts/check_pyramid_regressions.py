"""Exercise production pyramid functions without starting the app or touching caches."""
import argparse
import ast
import json
import logging
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional
from unittest import mock

import pyvips
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    output.relative_to((repo / "output/audit-fixes-20260911").resolve())
    output.mkdir(parents=True, exist_ok=True)
    config = SimpleNamespace(PYRAMID_FORMAT="WEBP", PYRAMID_Q=100,
                             PYRAMID_PNG_COMPRESSION=6, PYRAMID_PNG_EFFORT=1,
                             PYRAMID_LOADER_MODE="random", THUMBNAIL_DIR=output)
    selected = {"_mutable_image_guard", "_mutable_image_snapshot", "_pyramid_path_lock", "_generate_pyramid_sync", "_generate_pyramid_pipeline"}
    tree = ast.parse((repo / "api/full_app.py").read_text(encoding="utf-8-sig"))
    scope = dict(ROOT_DIR=args.source.resolve().parent, Path=Path, Optional=Optional, Dict=Dict, Any=Any,
                 contextmanager=contextmanager, Lock=threading.Lock, RLock=threading.RLock,
                 MY_LOT_STORAGE_LOCK=threading.RLock(), _classification_image_locks={},
                 _classification_image_locks_guard=threading.Lock(),
                 _pyramid_lock_guard=threading.Lock(), _pyramid_generation_locks={},
                 config=config, uuid=uuid, shutil=shutil,
                 logger=logging.getLogger("pyramid-regression"),
                 _resolve_pyramid_dir=lambda level, **kwargs: output / f"pipeline-{int(level * 100)}")
    exec(compile(ast.Module(body=[node for node in tree.body
                                if isinstance(node, ast.FunctionDef) and node.name in selected],
                            type_ignores=[]), str(repo / "api/full_app.py"), "exec"), scope)
    generate = scope["_generate_pyramid_sync"]
    pipeline = scope["_generate_pyramid_pipeline"]
    with Image.open(args.source) as source:
        expected = tuple(int(value * .7) for value in source.size)
    results = []

    def verify(path, fmt, size=expected):
        with Image.open(path) as image:
            image.load()
            assert image.format == fmt, (path, image.format, fmt)
            assert image.size == size, (path, image.size, size)
            if fmt == "JPEG":
                assert all(value == 1 for table in image.quantization.values() for value in table), image.quantization
        return path.stat().st_size

    for fmt in ("WEBP", "JPEG"):
        config.PYRAMID_FORMAT = fmt
        target = output / f"demand-{fmt.lower()}.{fmt.lower()}"
        started = time.perf_counter()
        generate(args.source, target, .7)
        results.append(dict(test=f"demand-{fmt}", ms=round((time.perf_counter()-started)*1000),
                            bytes=verify(target, fmt)))

    config.PYRAMID_FORMAT = "WEBP"
    with mock.patch.object(pyvips.Image, "new_from_file", side_effect=pyvips.Error("injected decoder failure")):
        target = output / "pillow-fallback.webp"
        started = time.perf_counter()
        generate(args.source, target, .7)
        results.append(dict(test="pillow-fallback", ms=round((time.perf_counter()-started)*1000),
                            bytes=verify(target, "WEBP")))
        failed = output / f"failed-{uuid.uuid4().hex}.webp"
        with mock.patch.object(Image.Image, "save", side_effect=OSError("injected encoder failure")):
            try:
                generate(args.source, failed, .7)
            except OSError:
                pass
            else:
                raise AssertionError("encoder failure was reported as success")
        assert not failed.exists(), "Failed encoder must not publish original PNG as WebP"
        results.append(dict(test="failed-encoder-does-not-publish", passed=True))

    for fmt in ("WEBP", "JPEG"):
        config.PYRAMID_FORMAT = fmt
        stem = f"source-{fmt.lower()}-{uuid.uuid4().hex}"
        started = time.perf_counter()
        states = pipeline(args.source, [.7, .2], stem, fmt.lower())
        assert all(state[1] for state in states), states
        for level in (.7, .2):
            with Image.open(args.source) as source:
                size = tuple(int(value * level) for value in source.size)
            verify(output / f"pipeline-{int(level*100)}" / f"{stem}_L{int(level*100)}.{fmt.lower()}", fmt, size)
        results.append(dict(test=f"pipeline-{fmt}-two-levels", ms=round((time.perf_counter()-started)*1000), states=states))

    fixture = output / "concurrent-source.png"
    Image.new("RGB", (640, 640), (47, 111, 203)).save(fixture)
    config.PYRAMID_FORMAT = "JPEG"
    stem = f"concurrent-{uuid.uuid4().hex}"
    barrier = threading.Barrier(3)
    target = output / "pipeline-70" / f"{stem}_L70.jpeg"

    def worker(index):
        barrier.wait(timeout=10)
        if index == 0:
            generate(fixture, target, .7)
            return [(0.7, True, "DEMAND")]
        return pipeline(fixture, [.7], stem, "jpeg")

    with ThreadPoolExecutor(max_workers=3) as executor:
        states = list(executor.map(worker, range(3)))
    assert all(state[1] for worker_states in states for state in worker_states), states
    verify(target, "JPEG", (448, 448))
    assert not list(output.rglob("*.tmp")), "temporary files leaked"
    results.append(dict(test="concurrent-demand-background", passed=True, states=states))
    (output / "regression-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
