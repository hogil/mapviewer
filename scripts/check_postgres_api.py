"""Verify the running app uses PostgreSQL (no browser automation)."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sys
import uuid
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api import database as db
from psycopg import sql

user='pg_check_'+uuid.uuid4().hex[:12]
base=sys.argv[1] if len(sys.argv)>1 else 'https://127.0.0.1'
paths=[db.ROOT/'logs'/name for name in ('color-legends.json','ui-prefs.json','stats.json','detail_access.csv')]
before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.exists()}

def call(method,path,**kwargs):
    response=requests.request(method,base+path,verify=False,timeout=60,**kwargs)
    assert response.ok,(path,response.status_code,response.text[:200])
    return response

try:
    assert call('GET','/').status_code==200
    endpoint='/api/user-prefs?LoginId='+user
    assert call('GET',endpoint).json()['prefs']=={}
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda i:call('PUT',endpoint,json={f'check{i}':i}),range(16)))
    prefs=call('GET',endpoint).json()['prefs']
    assert all(prefs[f'check{i}']==i for i in range(16))
    assert db.get_document('prefs',user)==prefs
    call('POST','/api/color-scheme?LoginId='+user,json={'schemeName':user,'schemeData':{'top':{'Grade0':'#123456'}}})
    assert call('GET','/logs/color-legends.json').json()[user]['top']['Grade0']=='#123456'
    assert db.load_colors()[user]['top']['Grade0']=='#123456'
    call('DELETE','/api/color-scheme?LoginId='+user,json={'schemeName':user})
    assert user not in db.load_colors()
    notices=call('GET','/api/announcements?LoginId='+user).json()
    catalogue=db.get_announcements()
    assert {item['id']: {key:value for key,value in item.items() if key not in ('seen','read')} for item in notices['items']}==catalogue
    assert [item['id'] for item in notices['items']]==list(catalogue)
    assert db.get_namespace('announcements')=={}
    assert notices['new_count']==sum(not item['seen'] for item in notices['items'])
    assert all(item['read'] and item['seen'] for item in notices['items'] if item.get('read_by_default'))
    notice_id=notices['items'][0]['id']
    call('POST','/api/announcements?LoginId='+user,json={'action':'read','ids':[notice_id]})
    assert db.notice_rows(user)[notice_id]==(True,True)
    db.insert_access(user,user,'2026-10-19T00:00:00+09:00',['2026-10-19 00:00:00','Test',user,'','','','',''])
    exported=call('GET','/api/stats/export-csv').content.decode('utf-8-sig')
    assert user in exported
    assert before=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.exists()}
    print(json.dumps({'status':'PASS','checks':['root HTTP200','16 parallel prefs API patches persisted in DB','color API saves and deletes DB rows','legend JSON URL reads DB','announcement catalogue reads dedicated table','announcement API persists DB state','CSV download includes DB-only event','legacy files unchanged']}))
finally:
    with db.pool().connection() as conn:
        conn.execute(sql.SQL('DELETE FROM {} WHERE namespace=%s AND key=%s').format(db.table('settings')),('prefs',user))
        conn.execute(sql.SQL('DELETE FROM {} WHERE namespace=%s AND key=%s').format(db.table('settings')),('colors',json.dumps(['personal',user])))
        conn.execute(sql.SQL('DELETE FROM {} WHERE login_id=%s').format(db.table('notice_state')),(user,))
        conn.execute(sql.SQL('DELETE FROM {} WHERE event_key=%s').format(db.table('access_events')),(user,))
    db.close()
