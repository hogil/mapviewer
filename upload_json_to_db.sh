#!/usr/bin/env bash
set -u
cd -- "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1
printf '%s\n' 'JSON to PostgreSQL upload' 'Settings: start.sh' 'Existing DB settings will be preserved.' ''
python3 -u ./upload_json_to_db.py
upload_status=$?
if [[ "$upload_status" -ne 0 ]]; then
    printf '\n%s\n' 'Upload failed. Read the error above before trying again.' >&2
fi
if [[ "${1:-}" != '--no-pause' && -t 0 ]]; then
    read -r -p 'Press Enter to close...' || true
fi
exit "$upload_status"
