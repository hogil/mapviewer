"""Integration checks against PostgreSQL16 using a disposable schema."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api import database as db
from scripts.manage_db import bootstrap,migrate,sources,verify
import upload_json_to_db as uploader
import psycopg
from psycopg import sql


def main():
    original_schema=os.environ.get('DB_SCHEMA')
    test_schema='check_'+uuid.uuid4().hex[:12]
    os.environ['DB_SCHEMA']=test_schema
    os.environ['APP_STORAGE']='postgres'
    source_paths=[db.ROOT/'logs'/name for name in ('color-legends.json','ui-prefs.json','stats.json','detail_access.csv')]
    before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths if p.exists()}
    admin=dict(db.settings(),user=os.environ['DB_ADMIN_USER'],password=os.environ['DB_ADMIN_PASSWORD'])
    try:
        bootstrap()
        with db.pool().connection() as conn:
            version=conn.execute('SHOW server_version').fetchone()[0]
            assert version.startswith('16.'),version
            assert conn.execute('SELECT current_user').fetchone()[0]=='fbm'
            assert conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname=current_user").fetchone()[0] is False
        # Upgrade an existing DB, preserving catalogue IDs, user data and read flags.
        legacy={'id':'legacy-notice','date':'2026-10-19','category':'공지','title':'기존 공지','summary':'보존 확인','paragraphs':['첫 문단','둘째 문단'],'read_by_default':False}
        db.put_document('announcements',legacy['id'],legacy)
        db.put_document('prefs','upgrade-user',{'gridCols':11})
        db.notice_rows('upgrade-user','read',[legacy['id']])
        bootstrap()
        assert db.get_announcements()[legacy['id']]==legacy
        assert db.get_namespace('announcements')=={}
        assert db.get_document('prefs','upgrade-user')=={'gridCols':11}
        assert db.notice_rows('upgrade-user')[legacy['id']]==(True,True)
        with db.pool().connection() as conn:
            conn.execute(sql.SQL('UPDATE {} SET title=%s WHERE id=%s').format(db.table('announcements')),('DB에서 수정한 제목',legacy['id']))
        db.put_document('announcements',legacy['id'],legacy)
        bootstrap()
        assert db.get_announcements()[legacy['id']]['title']=='DB에서 수정한 제목'
        assert db.get_namespace('announcements')=={}
        # A malformed legacy record must roll back without dropping its source.
        invalid=dict(legacy,id='invalid-notice',date='not-a-date')
        db.put_document('announcements',invalid['id'],invalid)
        try:
            bootstrap()
            raise AssertionError('Invalid legacy notice was accepted')
        except psycopg.DataError:
            pass
        assert db.get_document('announcements',invalid['id'])==invalid
        with db.pool().connection() as conn:
            db.delete_document('announcements',invalid['id'],conn)
        # Direct DBeaver-style column inserts/edits/deletes must reach the actual API.
        from api import announcements as notices
        from starlette.applications import Starlette
        from starlette.testclient import TestClient
        with db.pool().connection() as conn:
            conn.execute(sql.SQL("UPDATE {} SET published_on=CURRENT_DATE, created_at='2000-01-01' WHERE id=%s").format(db.table('announcements')),(legacy['id'],))
            inserted=conn.execute(sql.SQL('INSERT INTO {} (title,summary,content) VALUES (%s,%s,%s) RETURNING id,published_on,category,read_by_default').format(db.table('announcements')),('새 공지','요약','첫 문단\r\n\r\n둘째 문단')).fetchone()
            assert inserted[1]==conn.execute('SELECT CURRENT_DATE').fetchone()[0]
        new_id=inserted[0]
        uuid.UUID(new_id)
        assert inserted[2:] == ('공지',False)
        app=Starlette(routes=notices.announcement_routes(lambda request:request.query_params.get('LoginId')))
        with TestClient(app) as client:
            result=client.get('/api/announcements?LoginId=catalogue-user').json()
            assert result['items'][0]['id']==new_id,'Same-day notices are ordered by arbitrary IDs instead of creation time'
            item=next(item for item in result['items'] if item['id']==new_id)
            assert item['paragraphs']==['첫 문단','둘째 문단'] and not item['read'] and not item['seen']
            client.post('/api/announcements?LoginId=catalogue-user',json={'action':'seen','ids':[new_id]}).raise_for_status()
            item=next(item for item in client.get('/api/announcements?LoginId=catalogue-user').json()['items'] if item['id']==new_id)
            assert item['seen'] and not item['read']
            client.post('/api/announcements?LoginId=catalogue-user',json={'action':'read','ids':[new_id]}).raise_for_status()
            assert db.notice_rows('catalogue-user')[new_id]==(True,True)
            item=next(item for item in client.get('/api/announcements?LoginId=another-user').json()['items'] if item['id']==new_id)
            assert not item['seen'] and not item['read']
            with db.pool().connection() as conn:
                conn.execute(sql.SQL('UPDATE {} SET title=%s,content=%s WHERE id=%s').format(db.table('announcements')),('수정 공지','수정 본문',new_id))
            item=next(item for item in client.get('/api/announcements?LoginId=catalogue-user').json()['items'] if item['id']==new_id)
            assert item['title']=='수정 공지' and item['paragraphs']==['수정 본문'] and item['read']
            with db.pool().connection() as conn:
                conn.execute(sql.SQL('DELETE FROM {} WHERE id IN (%s,%s)').format(db.table('announcements')),(new_id,legacy['id']))
                conn.execute(sql.SQL('DELETE FROM {} WHERE login_id IN (%s,%s)').format(db.table('notice_state')),('upgrade-user','catalogue-user'))
                db.delete_document('prefs','upgrade-user',conn)
            assert client.get('/api/announcements?LoginId=catalogue-user').json()['items']==[]
        original_loader=uploader.load_start_settings
        def run_uploader(root):
            def isolated_settings():
                original_loader()
                os.environ['DB_SCHEMA']=test_schema
            with patch.object(uploader,'load_start_settings',isolated_settings), patch.object(sys,'argv',['upload_json_to_db.py','--source-root',str(root)]):
                uploader.main()
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'logs').mkdir();(root/'docs').mkdir()
            (root/'logs'/'color-legends.json').write_text(json.dumps({'default':{'top':{'Grade0':'#FFFFFF'}},'alice':{'top':{'Grade0':'#123456'}},'composite':{'alice':{'quantile0':'#111111'}},'measure':{'alice':{'quantile0':'#222222'}}}))
            (root/'logs'/'ui-prefs.json').write_text(json.dumps({'alice':{'gridCols':7}}))
            (root/'logs'/'stats.json').write_text(json.dumps({'users':{},'daily_stats':{},'monthly_stats':{},'department_stats':{}}))
            (root/'docs'/'announcements.json').write_text(json.dumps([{'id':'notice','date':'2026-10-19','title':'Notice'}]))
            run_uploader(root)
            with patch.object(db, "get_namespace", wraps=db.get_namespace) as queried:
                verify(root)
                assert queried.call_count == len({entry[0] for entry in sources(root)}-{'announcements'})
            for namespace,key,value in sources(root):
                assert (db.get_announcements().get(key) if namespace=='announcements' else db.get_document(namespace,key))==value
            assert db.get_namespace('announcements')=={}
            db.patch_document('prefs','alice',{'gridCols':9})
            with db.pool().connection() as conn:
                conn.execute(sql.SQL('UPDATE {} SET title=%s WHERE id=%s').format(db.table('announcements')),('Newer DB title','notice'))
            run_uploader(root)
            assert db.get_document('prefs','alice')['gridCols']==9
            assert db.get_announcements()['notice']['title']=='Newer DB title'
            migrate(root,replace_catalogue=True)
            assert db.get_announcements()['notice']['title']=='Notice'
            assert db.get_document('prefs','alice')['gridCols']==9
            with ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(lambda i:db.patch_document('prefs','alice',{f'field{i}':i}),range(24)))
            prefs=db.get_document('prefs','alice');assert all(prefs[f'field{i}']==i for i in range(24))
            from api import personal_colors as colors
            legends=colors.load_color_legends();legends['alice']['top']['Grade0']='#654321'
            assert colors.save_color_legends(legends,'alice')
            assert db.load_colors()['alice']['top']['Grade0']=='#654321'
            assert db.load_colors()['composite']['alice']['quantile0']=='#111111'
            assert db.load_colors()['measure']['alice']['quantile0']=='#222222'
            del legends['alice']
            assert colors.save_color_legends(legends)
            assert 'alice' not in db.load_colors()
            from api.announcements import announcement_state
            assert announcement_state('alice')['new_count']==1
            seen=announcement_state('alice','seen',['notice']);assert seen['new_count']==0 and not seen['items'][0]['read']
            assert announcement_state('alice','read',['notice'])['items'][0]['read']
            assert announcement_state('bob')['new_count']==1
            # A failed write must roll back completely.
            try:
                with db.edit_namespace('rollback') as data:
                    data['key']={'value':1}
                    raise RuntimeError('rollback')
            except RuntimeError:pass
            assert db.get_namespace('rollback')=={}
            worker="from api.access_logger import AccessLogger; from api import database as d; a=AccessLogger(); [a._update_stats('10.0.0.1','/check','GET',meta={'LoginId':'parallel','Username':'Test','DeptName':'Test'},is_page_visit=True) for _ in range(8)]; d.close()"
            with ThreadPoolExecutor(max_workers=4) as executor:
                results=list(executor.map(lambda _:subprocess.run([sys.executable,'-c',worker],cwd=db.ROOT,capture_output=True,text=True,encoding='utf-8',env=dict(os.environ,PYTHONIOENCODING='utf-8')),range(4)))
            for result in results:assert result.returncode==0,result.stderr
            assert db.load_stats()['users']['parallel']['total_requests']==32
            from api.detail_access_logger import DetailAccessLogger
            detail=DetailAccessLogger()
            assert detail.log_saml_access({'LoginId':'alice','Username':'Test'},'10.0.0.2')
            assert detail.log_saml_access({'LoginId':'alice','Username':'Test'},'10.0.0.2')
            assert len(db.recent_access())==1
            assert db.recent_access()[0][2]=='alice'
        after={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths if p.exists()}
        assert before==after,'Legacy source files changed'
        print(json.dumps({'status':'PASS','version':version,'checks':['legacy notice move preserves IDs/read flags/settings','repeat bootstrap preserves newer dedicated notice','invalid legacy notice rolls back without data loss','direct notice column insert with UUID/date/defaults','notice DB insert/edit/delete reaches API','same-day notices ordered by creation time','notice API seen/read and LoginId isolation','uploader Python entrypoint with empty data','uploader rerun preserves newer DB values','explicit catalogue replacement preserves preferences','24 concurrent preference patches','personal/composite/measure colors','notice seen/read and LoginId isolation','transaction rollback','4-process exact visit count32','login event deduplication','legacy files unchanged','non-superuser app role']},ensure_ascii=False))
    finally:
        db.close()
        with psycopg.connect(**admin) as conn:conn.execute(sql.SQL('DROP SCHEMA IF EXISTS {} CASCADE').format(sql.Identifier(test_schema)))
        if original_schema is None:os.environ.pop('DB_SCHEMA',None)
        else:os.environ['DB_SCHEMA']=original_schema

if __name__=='__main__':main()
