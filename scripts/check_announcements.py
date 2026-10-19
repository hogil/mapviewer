"""Focused announcement persistence/API checks, isolated from production state."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import os
os.environ["APP_STORAGE"] = "files"
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from starlette.applications import Starlette
from starlette.testclient import TestClient
from api import announcements as notices

with tempfile.TemporaryDirectory() as td:
    db = Path(td) / 'notices.sqlite3'
    state = notices.announcement_state
    def isolated(login_id, action=None, ids=()):
        return state(login_id, action, ids, database=db)
    catalogue = notices.load_announcements()
    assert isolated('new-user')['new_count'] == 0
    assert all(item['read'] and item['seen'] for item in isolated('new-user')['items'])
    isolated('existing-user', 'seen', [catalogue[0]['id']])
    assert isolated('existing-user')['items'][0]['read']
    # Exercise real new-notice behavior independently of the read-by-default dummy.
    fixture = [dict(item, read_by_default=False) for item in catalogue]
    with patch.object(notices, 'load_announcements', return_value=fixture), patch.object(notices, 'announcement_state', isolated):
        app = Starlette(routes=notices.announcement_routes(lambda request: request.query_params.get('LoginId')))
        with TestClient(app) as client:
            first = client.get('/api/announcements?LoginId=alice')
            assert first.status_code == 200 and first.headers['cache-control'] == 'no-store'
            data = first.json()
            ids = [item['id'] for item in data['items']]
            assert ids and data['new_count'] == len(ids)
            seen = client.post('/api/announcements?LoginId=alice', json={'action':'seen', 'ids':ids}).json()
            assert seen['new_count'] == 0 and all(not item['read'] for item in seen['items'])
            read = client.post('/api/announcements?LoginId=alice', json={'action':'read', 'ids':[ids[0]]}).json()
            assert read['items'][0]['read'] and read['new_count'] == 0
            assert client.get('/api/announcements?LoginId=bob').json()['new_count'] == len(ids)
            assert client.get('/api/announcements?LoginId=alice').json()['items'][0]['read']
            for body in [[], {}, {'action':'delete','ids':ids}, {'action':'read','ids':'bad'}, {'action':'read','ids':['missing']}, {'action':'seen','ids':[{}]}]:
                assert client.post('/api/announcements?LoginId=alice',json=body).status_code == 400
            assert client.post('/api/announcements',content='{bad').status_code == 400
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: isolated('parallel','read',[ids[0]]),range(24)))
            assert isolated('parallel')['items'][0]['read']
    # Reopen the database via fresh connections, simulating a restart.
    assert state('alice',database=db)['items'][0]['read']
    with patch.object(notices, 'load_announcements', return_value=fixture+[{'id':'new-after-seen','date':'2026-10-20','title':'New'}]):
        assert state('alice',database=db)['new_count'] == 1
        assert state('alice','seen',ids,database=db)['new_count'] == 1
print(json.dumps({'status':'PASS','checks':['badge vs read distinction','LoginId isolation','persistent reopen','new publication','snapshot seen IDs','concurrent read writes','invalid input API 400','no-store']},ensure_ascii=False))
