"""Import legacy metadata using DB settings from the platform's start script."""
import argparse
import os
from pathlib import Path
import re
import shlex

ROOT = Path(__file__).resolve().parent


def load_start_settings():
    windows = os.name == 'nt'
    script = ROOT / ('start.ps1' if windows else 'start.sh')
    settings = {}
    for line in script.read_text(encoding='utf-8-sig').splitlines():
        if windows:
            match = re.fullmatch(r"\s*\$env:(APP_STORAGE|DB_[A-Z_]+)\s*=\s*'((?:[^']|'')*)'\s*", line)
            if match:
                settings[match[1]] = match[2].replace("''", "'")
        elif re.match(r'\s*export\s+(APP_STORAGE|DB_[A-Z_]+)=', line):
            parts = shlex.split(line, comments=True)
            if len(parts) != 2:
                raise SystemExit('Use literal DB assignments in start.sh.')
            key, value = parts[1].split('=', 1)
            settings[key] = value
    required = {'APP_STORAGE', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER',
                'DB_PASSWORD', 'DB_ADMIN_USER', 'DB_ADMIN_PASSWORD', 'DB_SCHEMA',
                'DB_TABLE_SETTINGS', 'DB_TABLE_ANNOUNCEMENTS', 'DB_TABLE_NOTICE_STATE', 'DB_TABLE_ACCESS_EVENTS'}
    missing = required - settings.keys()
    if missing:
        raise SystemExit('Missing literal settings in ' + script.name + ': ' + ', '.join(sorted(missing)))
    if settings['APP_STORAGE'] != 'postgres':
        raise SystemExit('Set APP_STORAGE=postgres in ' + script.name + ' before importing.')
    os.environ.update(settings)
    print('DB settings: ' + script.name, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=ROOT)
    args = parser.parse_args()
    load_start_settings()
    from api import database as db
    from scripts.manage_db import upload
    try:
        upload(args.source_root.resolve())
    finally:
        db.close()


if __name__ == '__main__':
    main()
