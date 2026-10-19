"""Announcement catalogue and per-LoginId seen/read state."""
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Route

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = ROOT / 'docs' / 'announcements.json'
DATABASE = ROOT / 'logs' / 'announcements.sqlite3'


def load_announcements():
    return sorted(json.loads(CATALOGUE.read_text(encoding='utf-8')), key=lambda item: (item['date'], item['id']), reverse=True)


def announcement_state(login_id, action=None, ids=(), database=DATABASE):
    notices = load_announcements()
    valid_ids = {item['id'] for item in notices}
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database, timeout=15)) as connection, connection:
        connection.execute('CREATE TABLE IF NOT EXISTS notice_state (login_id TEXT NOT NULL, notice_id TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, is_read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (login_id, notice_id))')
        for notice_id in ids:
            if notice_id not in valid_ids:
                raise ValueError('Unknown announcement')
            connection.execute('INSERT OR IGNORE INTO notice_state(login_id, notice_id) VALUES (?, ?)', (login_id, notice_id))
            if action == 'seen':
                connection.execute('UPDATE notice_state SET seen=1 WHERE login_id=? AND notice_id=?', (login_id, notice_id))
            elif action == 'read':
                connection.execute('UPDATE notice_state SET seen=1, is_read=1 WHERE login_id=? AND notice_id=?', (login_id, notice_id))
        rows = {row[0]: row[1:] for row in connection.execute('SELECT notice_id, seen, is_read FROM notice_state WHERE login_id=?', (login_id,))}
    items = [dict(item,
                  seen=bool(item.get('read_by_default') or rows.get(item['id'], (0, 0))[0]),
                  read=bool(item.get('read_by_default') or rows.get(item['id'], (0, 0))[1]))
             for item in notices]
    return {'items': items, 'new_count': sum(not item['seen'] for item in items)}


def announcement_routes(resolve_login_id):
    async def endpoint(request):
        login_id = resolve_login_id(request) or 'notsaml'
        action, ids = None, []
        if request.method == 'POST':
            try:
                body = await request.json()
            except (ValueError, UnicodeDecodeError):
                return JSONResponse({'detail': 'Invalid JSON'}, status_code=400)
            if not isinstance(body, dict) or body.get('action') not in ('seen', 'read'):
                return JSONResponse({'detail': 'Invalid action'}, status_code=400)
            action, ids = body['action'], body.get('ids')
            if not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(value, str) for value in ids):
                return JSONResponse({'detail': 'Invalid announcement IDs'}, status_code=400)
        try:
            result = await run_in_threadpool(announcement_state, login_id, action, ids)
        except ValueError:
            return JSONResponse({'detail': 'Unknown announcement'}, status_code=400)
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})

    return [Route('/api/announcements', endpoint, methods=['GET', 'POST'])]
