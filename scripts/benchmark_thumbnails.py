"""
Thumbnail generation/serving benchmark.

Usage:
    python scripts/benchmark_thumbnails.py --server http://localhost:8080 --root wafer --limit 200 --size 512 --concurrency 32

Notes:
- Paths are resolved relative to --root (defaults to current working directory). They are sent as relative paths, matching the FastAPI /api/thumbnail contract.
- Concurrency uses ThreadPoolExecutor + requests (no extra deps). Keep --concurrency in line with THUMBNAIL_SEM/IO_THREADS on the server.
- Warmup requests are excluded from stats to avoid first-run bias.
"""

import argparse
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable, List, Tuple
from urllib.parse import quote

import requests

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
_SESSION_LOCAL = threading.local()


def get_session() -> requests.Session:
    session = getattr(_SESSION_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update({"Connection": "keep-alive"})
        _SESSION_LOCAL.session = session
    return session


def collect_paths(root: Path, limit: int) -> List[Path]:
    paths: List[Path] = []
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in IMAGE_EXTS:
            paths.append(path)
            if limit and len(paths) >= limit:
                break
    return paths


def percentile(data: List[float], pct: float) -> float:
    if not data:
        return 0.0
    k = (len(data) - 1) * pct
    f = int(k)
    c = min(f + 1, len(data) - 1)
    if f == c:
        return data[f]
    d0 = data[f] * (c - k)
    d1 = data[c] * (k - f)
    return d0 + d1


def bench_request(server: str, rel_path: str, size: int, personalized: bool, scheme: str, timeout: float) -> Tuple[float, bool, str]:
    session = get_session()
    params = f"path={quote(rel_path)}&size={size}"
    if personalized:
        params += "&personalized=true"
        if scheme:
            params += f"&scheme={quote(scheme)}"
    url = f"{server.rstrip('/')}/api/thumbnail?{params}"

    start = time.perf_counter()
    try:
        resp = session.get(url, timeout=timeout)
        resp.raise_for_status()
        _ = resp.content  # force read
        return time.perf_counter() - start, False, ""
    except Exception as exc:
        return time.perf_counter() - start, True, str(exc)


def run_batch(
    server: str,
    rel_paths: Iterable[str],
    size: int,
    personalized: bool,
    scheme: str,
    concurrency: int,
    timeout: float,
) -> Tuple[List[float], List[str]]:
    durations: List[float] = []
    errors: List[str] = []

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [
            executor.submit(bench_request, server, rel_path, size, personalized, scheme, timeout)
            for rel_path in rel_paths
        ]
        for future in as_completed(futures):
            duration, failed, message = future.result()
            if failed:
                errors.append(message)
            else:
                durations.append(duration)
    return durations, errors


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark /api/thumbnail throughput/latency.")
    parser.add_argument("--server", default="http://localhost:8080", help="Server base URL")
    parser.add_argument("--root", default=".", help="Image root (matches server ROOT_DIR)")
    parser.add_argument("--limit", type=int, default=200, help="Max number of images to benchmark")
    parser.add_argument("--size", type=int, default=512, help="Thumbnail size")
    parser.add_argument("--concurrency", type=int, default=32, help="Concurrent requests")
    parser.add_argument("--warmup", type=int, default=16, help="Warmup requests (excluded from stats)")
    parser.add_argument("--timeout", type=float, default=5.0, help="Per-request timeout (seconds)")
    parser.add_argument("--personalized", action="store_true", help="Enable personalized=true")
    parser.add_argument("--scheme", default="", help="Scheme to use when personalized=true")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.exists():
        raise SystemExit(f"[!] root not found: {root}")

    all_paths = collect_paths(root, args.limit + args.warmup)
    if not all_paths:
        raise SystemExit(f"[!] no images found under {root}")

    rel_paths = [str(p.relative_to(root)) for p in all_paths]
    warmup = rel_paths[: args.warmup]
    targets = rel_paths[args.warmup :]

    print(f"Server          : {args.server}")
    print(f"Root            : {root}")
    print(f"Size            : {args.size}")
    print(f"Concurrency     : {args.concurrency}")
    print(f"Personalized    : {args.personalized} scheme={args.scheme}")
    print(f"Warmup/Measured : {len(warmup)} warmup / {len(targets)} measured")
    print("Running warmup ...", flush=True)
    if warmup:
        run_batch(args.server, warmup, args.size, args.personalized, args.scheme, args.concurrency, args.timeout)

    print("Benchmarking ...", flush=True)
    durations, errors = run_batch(
        args.server, targets, args.size, args.personalized, args.scheme, args.concurrency, args.timeout
    )

    durations.sort()
    if durations:
        mean = sum(durations) / len(durations)
        print(f"Samples         : {len(durations)} (errors: {len(errors)})")
        print(f"Mean            : {mean*1000:.2f} ms")
        print(f"P50 / P90 / P99 : {percentile(durations,0.5)*1000:.2f} / {percentile(durations,0.9)*1000:.2f} / {percentile(durations,0.99)*1000:.2f} ms")
        print(f"Max             : {durations[-1]*1000:.2f} ms")
        throughput = len(durations) / sum(durations)
        print(f"Throughput      : {throughput:.2f} req/s (wall-clock aggregated)")
    else:
        print(f"[!] No successful samples (errors: {len(errors)})")

    if errors:
        unique = list(dict.fromkeys(errors))
        print("\nSample errors:")
        for err in unique[:5]:
            print(f"- {err}")


if __name__ == "__main__":
    main()
