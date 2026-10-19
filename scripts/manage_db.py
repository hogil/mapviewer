"""Create/check PostgreSQL storage and import legacy files without deleting sources."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api import database as db


def sources(root):
    rows = []
    for filename,namespace in [('color-legends.json','colors'),('ui-prefs.json','prefs'),('stats.json','stats')]:
        path = root/'logs'/filename
        if not path.exists(): continue
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        if not isinstance(data,dict): raise ValueError(f'{filename} must contain an object')
        entries = db.flatten_colors(data) if namespace=='colors' else db.encode_stats(data) if namespace=='stats' else data
        rows.extend((namespace,key,value) for key,value in entries.items() if '__preview_' not in key)
    catalogue = root/'docs'/'announcements.json'
    if catalogue.exists():
        rows.extend(('announcements',notice['id'],notice) for notice in json.loads(catalogue.read_text(encoding='utf-8-sig')))
    return rows


def bootstrap():
    import psycopg
    from psycopg import sql
    config = db.settings()
    admin = dict(config,dbname='postgres',user=os.environ['DB_ADMIN_USER'],password=os.environ['DB_ADMIN_PASSWORD'])
    with psycopg.connect(**admin,autocommit=True) as conn:
        if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(config['user'],)).fetchone():
            conn.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(sql.Identifier(config['user']),sql.Literal(config['password'])))
        if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(config['dbname'],)).fetchone():
            conn.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(config['dbname']),sql.Identifier(admin['user'])))
    with psycopg.connect(**dict(admin,dbname=config['dbname'])) as conn:
        db.initialize(conn)
        conn.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(config['dbname']),sql.Identifier(config['user'])))
        conn.execute(sql.SQL('GRANT USAGE ON SCHEMA {} TO {}').format(sql.Identifier(db.identifier('DB_SCHEMA','l3tracker')),sql.Identifier(config['user'])))
        for name in ('settings','notice_state','access_events'):
            conn.execute(sql.SQL('GRANT SELECT,INSERT,UPDATE,DELETE ON {} TO {}').format(db.table(name),sql.Identifier(config['user'])))
    print('Database, schema and tables ready; application role has data access only.')


def migrate(root, dry_run=False, replace_catalogue=False):
    from psycopg import sql
    entries = sources(root)
    counts = {name:sum(namespace==name for namespace,_,_ in entries) for name in {r[0] for r in entries}}
    sqlite_path = root/'logs'/'announcements.sqlite3'
    notice_rows = []
    if sqlite_path.exists():
        from contextlib import closing
        with closing(sqlite3.connect(sqlite_path.as_uri()+'?mode=ro',uri=True)) as source:
            notice_rows = source.execute('SELECT login_id,notice_id,seen,is_read FROM notice_state').fetchall()
    access_rows = []
    csv_path = root/'logs'/'detail_access.csv'
    if csv_path.exists():
        with csv_path.open(encoding='utf-8-sig',newline='') as handle:
            reader = csv.reader(handle)
            next(reader,None)
            access_rows = [row for row in reader if len(row)>=8 and row[0] and row[2]]
    counts.update(notice_state=len(notice_rows),access_events=len(access_rows))
    if dry_run:
        print(json.dumps({'dry_run':True,'source_rows':counts},ensure_ascii=False));return
    with db.pool().connection() as conn:
        for namespace,key,value in entries:
            db.put_document(namespace,key,value,conn,overwrite=replace_catalogue and namespace=='announcements')
        for login_id,notice_id,seen,is_read in notice_rows:
            conn.execute(sql.SQL('INSERT INTO {} AS current (login_id,notice_id,seen,is_read) VALUES (%s,%s,%s,%s) ON CONFLICT(login_id,notice_id) DO UPDATE SET seen=current.seen OR EXCLUDED.seen,is_read=current.is_read OR EXCLUDED.is_read').format(db.table('notice_state')), (login_id,notice_id,bool(seen),bool(is_read)))
        for index,row in enumerate(access_rows):
            key = 'legacy:'+hashlib.sha256(json.dumps([index,row],ensure_ascii=False).encode()).hexdigest()
            db.insert_access(key,row[2],row[0]+'+09:00',row,conn)
    print(json.dumps({'migrated':counts,'policy':'existing DB settings preserved; sources unchanged'},ensure_ascii=False))



def verify(root):
    entries=sources(root)
    missing,different=0,0
    with db.pool().connection() as conn:
        namespaces={namespace:db.get_namespace(namespace,conn) for namespace,_,_ in entries}
    for namespace,key,value in entries:
        stored=namespaces[namespace]
        if key not in stored:missing+=1
        elif stored[key]!=value:different+=1
    print(json.dumps({'compared':len(entries),'missing':missing,'different':different}))
    if missing or different:
        raise SystemExit('Verification differs from source. Existing DB values may be newer; no values were overwritten.')


def check():
    from psycopg import sql
    with db.pool().connection() as conn:
        for kind in ('settings','notice_state','access_events'):
            conn.execute(sql.SQL('SELECT 1 FROM {} LIMIT 1').format(db.table(kind)))
        info=conn.execute("SELECT current_database(),current_user,inet_server_port(),current_setting('server_version')").fetchone()
    print(json.dumps({'database':info[0],'user':info[1],'port':info[2],'schema':db.identifier('DB_SCHEMA','l3tracker'),'version':info[3],'status':'OK'}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['bootstrap','migrate','verify','check'])
    parser.add_argument('--source-root',type=Path,default=db.ROOT)
    parser.add_argument('--dry-run',action='store_true')
    parser.add_argument('--replace-catalogue',action='store_true',help='Update notice content only; preserve user settings')
    args=parser.parse_args()
    if args.command=='bootstrap':bootstrap()
    elif args.command=='migrate':migrate(args.source_root.resolve(),args.dry_run,args.replace_catalogue)
    elif args.command=='verify':verify(args.source_root.resolve())
    else:check()

if __name__=='__main__':
    try:
        main()
    finally:
        db.close()
