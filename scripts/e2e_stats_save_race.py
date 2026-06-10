#!/usr/bin/env python3

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api import access_logger


def configure_stats_paths(tmp_dir: Path) -> None:
    access_logger.LOG_DIR = tmp_dir
    access_logger.STATS_LOG_FILE = tmp_dir / "stats.json"
    access_logger.ACCESS_LOG_FILE = tmp_dir / "access.log"


def write_initial_stats(tmp_dir: Path) -> None:
    configure_stats_paths(tmp_dir)
    access_logger.STATS_LOG_FILE.write_text(
        json.dumps(access_logger.AccessLogger._empty_stats_template(), ensure_ascii=False),
        encoding="utf-8",
    )


def make_stats(user_id: str, index: int) -> dict:
    day = "2026-06-10"
    return {
        "users": {
            user_id: {
                "ip_addresses": [f"127.0.0.{index + 1}"],
                "first_seen": day,
                "last_seen": day,
                "last_access_time": day,
                "unique_days": [day],
                "total_requests": index + 1,
                "daily_requests": {day: index + 1},
                "endpoints": {"/": index + 1},
                "profile": {
                    "LoginId": user_id,
                    "Username": user_id,
                    "DeptName": "E2E",
                },
            }
        },
        "daily_stats": {
            day: {
                "date": day,
                "total_requests": index + 1,
                "unique_users": 1,
                "active_sessions": 1,
            }
        },
        "monthly_stats": {},
        "department_stats": {},
    }


def run_child(tmp_dir: Path, user_id: str, index: int) -> int:
    configure_stats_paths(tmp_dir)
    logger = access_logger.AccessLogger()
    logger.stats_data = make_stats(user_id, index)
    logger._stats_dirty = True
    logger._save_stats(force=True)
    return 0


def run_thread_race(tmp_dir: Path, worker_count: int) -> None:
    configure_stats_paths(tmp_dir)

    loggers = []
    for index in range(worker_count):
        logger = access_logger.AccessLogger()
        logger.stats_data = make_stats(f"e2e_stats_thread_{index:02d}", index)
        logger._stats_dirty = True
        loggers.append(logger)

    barrier = threading.Barrier(worker_count)
    exceptions = []

    def save_once(logger):
        try:
            barrier.wait(timeout=10)
            logger._save_stats(force=True)
        except Exception as exc:
            exceptions.append(exc)

    stdout = io.StringIO()
    threads = [threading.Thread(target=save_once, args=(logger,)) for logger in loggers]
    with contextlib.redirect_stdout(stdout):
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

    output = stdout.getvalue()
    alive = [thread for thread in threads if thread.is_alive()]
    if alive:
        raise RuntimeError(f"thread race still alive: {len(alive)}")
    if exceptions:
        raise RuntimeError(f"thread race exceptions: {exceptions!r}")
    if "통계 저장 실패" in output or "stats.json.tmp" in output:
        raise RuntimeError(f"thread race emitted failure text: {output}")


def run_process_race(tmp_dir: Path, worker_count: int) -> None:
    procs = []
    for index in range(worker_count):
        user_id = f"e2e_stats_process_{index:02d}"
        procs.append(
            subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--child", str(tmp_dir), user_id, str(index)],
                cwd=str(REPO_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
        )

    failures = []
    for proc in procs:
        try:
            stdout, stderr = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate(timeout=5)
            failures.append({
                "pid": proc.pid,
                "returncode": "timeout",
                "stdout": stdout[-500:],
                "stderr": stderr[-500:],
            })
            continue
        if (
            proc.returncode != 0
            or "통계 저장 실패" in stdout
            or "stats.json.tmp" in stdout
            or "통계 저장 실패" in stderr
            or "stats.json.tmp" in stderr
        ):
            failures.append({
                "pid": proc.pid,
                "returncode": proc.returncode,
                "stdout": stdout[-500:],
                "stderr": stderr[-500:],
            })
    if failures:
        raise RuntimeError(f"process race failures: {failures!r}")


def assert_users_present(tmp_dir: Path, prefix: str, worker_count: int) -> int:
    configure_stats_paths(tmp_dir)
    data = json.loads(access_logger.STATS_LOG_FILE.read_text(encoding="utf-8"))
    users = data.get("users", {})
    missing = [
        f"{prefix}_{index:02d}"
        for index in range(worker_count)
        if f"{prefix}_{index:02d}" not in users
    ]
    if missing:
        raise RuntimeError(f"missing {prefix} users={missing[:5]} total_missing={len(missing)}")
    return len(users)


def main() -> int:
    if len(sys.argv) == 5 and sys.argv[1] == "--child":
        return run_child(Path(sys.argv[2]), sys.argv[3], int(sys.argv[4]))

    original_log_dir = access_logger.LOG_DIR
    original_stats_file = access_logger.STATS_LOG_FILE
    original_access_file = access_logger.ACCESS_LOG_FILE

    worker_count = int(os.getenv("E2E_STATS_RACE_WORKERS", "24"))
    process_worker_count = int(os.getenv("E2E_STATS_RACE_PROCESSES", "12"))
    try:
        with tempfile.TemporaryDirectory(prefix="l3-stats-race-") as tmp:
            tmp_dir = Path(tmp)
            write_initial_stats(tmp_dir)
            run_thread_race(tmp_dir, worker_count)
            assert_users_present(tmp_dir, "e2e_stats_thread", worker_count)
            run_process_race(tmp_dir, process_worker_count)
            user_count = assert_users_present(tmp_dir, "e2e_stats_process", process_worker_count)

            leftover_tmp = sorted(path.name for path in tmp_dir.glob("stats.json*.tmp"))
            leftover_lock = sorted(path.name for path in tmp_dir.glob("stats.json.lock"))
            if leftover_tmp or leftover_lock:
                print(f"FAIL leftover_tmp={leftover_tmp} leftover_lock={leftover_lock}")
                return 1

            print(
                "PASS stats_save_race "
                f"threads={worker_count} processes={process_worker_count} users={user_count}"
            )
            return 0
    except Exception as exc:
        print(f"FAIL stats_save_race {exc}")
        return 1
    finally:
        access_logger.LOG_DIR = original_log_dir
        access_logger.STATS_LOG_FILE = original_stats_file
        access_logger.ACCESS_LOG_FILE = original_access_file


if __name__ == "__main__":
    raise SystemExit(main())
