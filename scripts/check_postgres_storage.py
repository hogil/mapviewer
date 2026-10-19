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

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api import database as db
from scripts.manage_db import bootstrap,migrate,sources
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
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'logs').mkdir();(root/'docs').mkdir()
            (root/'logs'/'color-legends.json').write_text(json.dumps({'default':{'top':{'Grade0':'#FFFFFF'}},'alice':{'top':{'Grade0':'#123456'}},'composite':{'alice':{'quantile0':'#111111'}},'measure':{'alice':{'quantile0':'#222222'}}}))
            (root/'logs'/'ui-prefs.json').write_text(json.dumps({'alice':{'gridCols':7}}))
            (root/'logs'/'stats.json').write_text(json.dumps({'users':{},'daily_stats':{},'monthly_stats':{},'department_stats':{}}))
            (root/'docs'/'announcements.json').write_text(json.dumps([{'id':'notice','date':'2026-10-19','title':'Notice'}]))
            migrate(root)
            for namespace,key,value in sources(root):assert db.get_document(namespace,key)==value
            db.patch_document('prefs','alice',{'gridCols':9})
            migrate(root)
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
        print(json.dumps({'status':'PASS','version':version,'checks':['migration roundtrip','repeat import preserves newer DB values','24 concurrent preference patches','personal/composite/measure colors','notice seen/read and LoginId isolation','transaction rollback','4-process exact visit count32','login event deduplication','legacy files unchanged','non-superuser app role']},ensure_ascii=False))
    finally:
        db.close()
        with psycopg.connect(**admin) as conn:conn.execute(sql.SQL('DROP SCHEMA IF EXISTS {} CASCADE').format(sql.Identifier(test_schema)))
        if original_schema is None:os.environ.pop('DB_SCHEMA',None)
        else:os.environ['DB_SCHEMA']=original_schema

if __name__=='__main__':main()
