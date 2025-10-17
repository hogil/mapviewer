from __future__ import annotations

import datetime as dt
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple


def fetch_commits(days: int = 30) -> List[Tuple[str, str, str, str]]:
    """Return commits within the past `days` days as tuples."""
    since = f"{days} days ago"
    format_fields = "%ad%x1f%h%x1f%s%x1f%b%x1e"
    cmd = [
        "git",
        "log",
        f"--since={since}",
        "--date=format:%Y-%m-%d %H:%M",
        f"--pretty=format:{format_fields}",
    ]
    raw = subprocess.check_output(cmd, text=True, encoding="utf-8")
    records: List[Tuple[str, str, str, str]] = []
    for chunk in raw.rstrip("\x1e").split("\x1e"):
        parts = chunk.split("\x1f")
        if len(parts) != 4:
            continue
        timestamp, short_sha, subject, body = (value.strip() for value in parts)
        records.append((timestamp, short_sha, subject, body))
    return records


def group_by_date(
    commits: List[Tuple[str, str, str, str]]
) -> Dict[str, List[Tuple[str, str, str, str]]]:
    grouped: Dict[str, List[Tuple[str, str, str, str]]] = defaultdict(list)
    for record in commits:
        timestamp = record[0]
        date_key = timestamp.split(" ", 1)[0]
        grouped[date_key].append(record)
    return grouped


def render_markdown(
    grouped: Dict[str, List[Tuple[str, str, str, str]]],
    output_path: Path,
    days: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sorted_dates = sorted(grouped.keys(), reverse=True)
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    header = [
        "# 최근 커밋 히스토리 요약",
        f"- 생성 시각: {now}",
        f"- 범위: 최근 {days}일",
        "",
    ]
    lines = header
    for date_key in sorted_dates:
        lines.append(f"## {date_key}")
        for timestamp, short_sha, subject, body in grouped[date_key]:
            time_part = timestamp.split(" ", 1)[1]
            display_subject = subject if subject else "(제목 없음)"
            lines.append(f"- **{time_part}** `{short_sha}` {display_subject.strip()}")
            if body:
                for line in body.splitlines():
                    cleaned = line.rstrip()
                    if cleaned:
                        lines.append(f"  > {cleaned}")
                    else:
                        lines.append("  >")
            else:
                lines.append("  - 상세 메시지 없음")
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    days = 30
    commits = fetch_commits(days=days)
    grouped = group_by_date(commits)
    output_path = Path("logs") / "commit_history_last_30_days.md"
    render_markdown(grouped, output_path, days=days)
    print(f"Wrote {len(commits)} commits into {output_path}")


if __name__ == "__main__":
    main()
