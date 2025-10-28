import os
from typing import Iterable, List, Sequence, Tuple


def scan_directories(args: Tuple[str, Sequence[str], Iterable[str]]) -> Tuple[List[Tuple[str, str]], int]:
    base_root, directories, skip_dirs = args
    base_root_norm = base_root.replace("\\", "/")
    base_len = len(base_root_norm)
    skip = {d for d in skip_dirs if d}

    files: List[Tuple[str, str]] = []
    dirs_scanned = 0

    for start_dir in directories:
        if not start_dir:
            continue
        for current_root, dirnames, filenames in os.walk(start_dir):
            dirs_scanned += 1
            try:
                dirnames[:] = [
                    d for d in dirnames
                    if d not in skip and not d.startswith(".") and d != "__pycache__"
                ]
            except Exception:
                pass

            for fname in filenames:
                if not fname or fname.startswith("."):
                    continue
                full_path = os.path.join(current_root, fname)
                normalized = full_path.replace("\\", "/")
                if normalized.startswith(base_root_norm):
                    rel_path = normalized[base_len:].lstrip("/")
                else:
                    rel_path = os.path.relpath(full_path, base_root).replace("\\", "/")
                files.append((rel_path, fname.lower()))

    return files, dirs_scanned
