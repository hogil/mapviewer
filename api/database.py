"""PostgreSQL storage for user metadata; filesystem mode is an explicit rollback."""
from contextlib import contextmanager
from pathlib import Path
import json
import os
import re
import threading

ROOT = Path(__file__).resolve().parents[1]

def enabled():
    mode = os.environ.get('APP_STORAGE', 'files')
    if mode not in ('files', 'postgres'):
        raise ValueError('APP_STORAGE must be files or postgres')
    return mode == 'postgres'


def settings():
    values = dict(host=os.environ.get('DB_HOST', '127.0.0.1'),
                  port=int(os.environ.get('DB_PORT', '5432')),
                  dbname=os.environ.get('DB_NAME', 'l3tracker'),
                  user=os.environ.get('DB_USER', 'fbm'),
                  password=os.environ.get('DB_PASSWORD', ''),
                  connect_timeout=5, application_name='l3tracker')
    return values


def identifier(name, default):
    value = os.environ.get(name, default)
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', value):
        raise ValueError(f'{name} must be a lowercase SQL identifier (max 63 characters)')
    return value


def table(kind):
    from psycopg import sql
    names = {'settings': ('DB_TABLE_SETTINGS', 'user_settings'),
             'announcements': ('DB_TABLE_ANNOUNCEMENTS', 'announcements'),
             'notice_state': ('DB_TABLE_NOTICE_STATE', 'notice_state'),
             'access_events': ('DB_TABLE_ACCESS_EVENTS', 'access_events')}
    return sql.Identifier(identifier('DB_SCHEMA', 'fbm'), identifier(*names[kind]))

_pool = None
_pool_lock = threading.Lock()


def pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from psycopg_pool import ConnectionPool
                _pool = ConnectionPool(kwargs=settings(), min_size=0, max_size=8, timeout=10, open=True)
    return _pool


def initialize(connection):
    from psycopg import sql
    schema = sql.Identifier(identifier('DB_SCHEMA', 'fbm'))
    connection.execute(sql.SQL('CREATE SCHEMA IF NOT EXISTS {}').format(schema))
    connection.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {} (namespace TEXT NOT NULL, key TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(namespace,key))').format(table('settings')))
    connection.execute(sql.SQL("CREATE TABLE IF NOT EXISTS {} (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, published_on DATE NOT NULL DEFAULT CURRENT_DATE, category TEXT NOT NULL DEFAULT '공지', title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', read_by_default BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())").format(table('announcements')))
    legacy_notices = connection.execute(sql.SQL('SELECT key,payload FROM {} WHERE namespace=%s FOR UPDATE').format(table('settings')), ('announcements',)).fetchall()
    for key, notice in legacy_notices:
        put_announcement(notice, connection, overwrite=False)
        connection.execute(sql.SQL('DELETE FROM {} WHERE namespace=%s AND key=%s').format(table('settings')), ('announcements', key))
    connection.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {} (login_id TEXT NOT NULL, notice_id TEXT NOT NULL, seen BOOLEAN NOT NULL DEFAULT FALSE, is_read BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(login_id,notice_id))').format(table('notice_state')))
    connection.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {} (event_key TEXT PRIMARY KEY, login_id TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL)').format(table('access_events')))
    connection.execute(sql.SQL('CREATE INDEX IF NOT EXISTS {} ON {} (login_id,occurred_at DESC)').format(sql.Identifier(identifier('DB_TABLE_ACCESS_EVENTS','access_events') + '_user_time'), table('access_events')))


def get_namespace(namespace, connection=None):
    from psycopg import sql
    if connection is None:
        with pool().connection() as conn:
            return get_namespace(namespace, conn)
    return dict(connection.execute(sql.SQL('SELECT key,payload FROM {} WHERE namespace=%s').format(table('settings')), (namespace,)))


def get_announcements(connection=None):
    from psycopg import sql
    if connection is None:
        with pool().connection() as conn:
            return get_announcements(conn)
    rows = connection.execute(sql.SQL('SELECT id,published_on,category,title,summary,content,read_by_default FROM {} ORDER BY published_on DESC,id DESC').format(table('announcements')))
    return {row[0]:dict(id=row[0], date=row[1].isoformat(), category=row[2], title=row[3],
                       summary=row[4], paragraphs=row[5].replace('\r\n','\n').replace('\r','\n').split('\n\n') if row[5] else [],
                       read_by_default=row[6]) for row in rows}


def put_announcement(notice, connection, overwrite=False):
    from psycopg import sql
    conflict = sql.SQL('DO UPDATE SET published_on=EXCLUDED.published_on, category=EXCLUDED.category, title=EXCLUDED.title, summary=EXCLUDED.summary, content=EXCLUDED.content, read_by_default=EXCLUDED.read_by_default, updated_at=clock_timestamp()') if overwrite else sql.SQL('DO NOTHING')
    connection.execute(sql.SQL('INSERT INTO {} (id,published_on,category,title,summary,content,read_by_default) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) {}').format(table('announcements'),conflict),
                       (notice['id'], notice['date'], notice.get('category','공지'), notice['title'], notice.get('summary',''), '\n\n'.join(notice.get('paragraphs',[])), notice.get('read_by_default',False)))


def get_document(namespace, key, default=None):
    from psycopg import sql
    with pool().connection() as conn:
        row = conn.execute(sql.SQL('SELECT payload FROM {} WHERE namespace=%s AND key=%s').format(table('settings')), (namespace,key)).fetchone()
    return row[0] if row else default


def put_document(namespace, key, payload, connection=None, overwrite=True):
    from psycopg import sql
    from psycopg.types.json import Jsonb
    if connection is None:
        with pool().connection() as conn:
            return put_document(namespace,key,payload,conn,overwrite)
    conflict = sql.SQL('DO UPDATE SET payload=EXCLUDED.payload, updated_at=clock_timestamp()') if overwrite else sql.SQL('DO NOTHING')
    connection.execute(sql.SQL('INSERT INTO {} (namespace,key,payload) VALUES (%s,%s,%s) ON CONFLICT(namespace,key) {}').format(table('settings'),conflict), (namespace,key,Jsonb(payload)))


def patch_document(namespace, key, patch):
    from psycopg import sql
    from psycopg.types.json import Jsonb
    with pool().connection() as conn:
        row = conn.execute(sql.SQL('INSERT INTO {} AS current (namespace,key,payload) VALUES (%s,%s,%s) ON CONFLICT(namespace,key) DO UPDATE SET payload=current.payload || EXCLUDED.payload,updated_at=clock_timestamp() RETURNING payload').format(table('settings')), (namespace,key,Jsonb(patch))).fetchone()
    return row[0]


@contextmanager
def edit_namespace(namespace):
    """Serialize legacy aggregate updates; publish only changed rows, atomically."""
    from psycopg import sql
    with pool().connection() as conn:
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('l3tracker:'+identifier('DB_SCHEMA','fbm')+':'+namespace,))
        original = get_namespace(namespace,conn)
        current = json.loads(json.dumps(original))
        yield current
        for key, value in current.items():
            if key not in original or original[key] != value:
                put_document(namespace,key,value,conn)
        for key in original.keys() - current.keys():
            conn.execute(sql.SQL('DELETE FROM {} WHERE namespace=%s AND key=%s').format(table('settings')), (namespace,key))


def flatten_colors(legends):
    result = {}
    for key,value in legends.items():
        if key in ('composite','measure') and isinstance(value,dict) and not any(str(k).startswith('quantile') for k in value):
            for owner,scheme in value.items(): result[json.dumps([key,owner])] = scheme
        else:
            result[json.dumps(['personal',key])] = value
    return result


def load_colors():
    result = {}
    for key,value in get_namespace('colors').items():
        kind,owner = json.loads(key)
        if kind == 'personal': result[owner] = value
        else: result.setdefault(kind,{})[owner] = value
    return result


def notice_rows(login_id, action=None, ids=()):
    from psycopg import sql
    with pool().connection() as conn:
        for notice_id in ids:
            conn.execute(sql.SQL('INSERT INTO {} AS current (login_id,notice_id,seen,is_read) VALUES (%s,%s,TRUE,%s) ON CONFLICT(login_id,notice_id) DO UPDATE SET seen=TRUE,is_read=current.is_read OR EXCLUDED.is_read').format(table('notice_state')), (login_id,notice_id,action=='read'))
        return {row[0]:(row[1],row[2]) for row in conn.execute(sql.SQL('SELECT notice_id,seen,is_read FROM {} WHERE login_id=%s').format(table('notice_state')), (login_id,))}


def insert_access(event_key, login_id, occurred_at, payload, connection=None):
    from psycopg import sql
    from psycopg.types.json import Jsonb
    if connection is None:
        with pool().connection() as conn: return insert_access(event_key,login_id,occurred_at,payload,conn)
    connection.execute(sql.SQL('INSERT INTO {} (event_key,login_id,occurred_at,payload) VALUES (%s,%s,%s,%s) ON CONFLICT(event_key) DO NOTHING').format(table('access_events')), (event_key,login_id,occurred_at,Jsonb(payload)))


def recent_access(limit=10):
    from psycopg import sql
    with pool().connection() as conn:
        return [row[0] for row in conn.execute(sql.SQL('SELECT payload FROM {} ORDER BY occurred_at DESC LIMIT %s').format(table('access_events')), (limit,))]

def decode_stats(rows):
    stats = {'users':{},'daily_stats':{},'monthly_stats':{},'department_stats':{}}
    for key,value in rows.items():
        section,item = json.loads(key)
        stats.setdefault(section,{})[item] = value
    return stats


def encode_stats(stats):
    return {json.dumps([section,key]):value for section,items in stats.items() for key,value in items.items()}


def load_stats():
    return decode_stats(get_namespace('stats'))


@contextmanager
def edit_stats():
    with edit_namespace('stats') as rows:
        stats = decode_stats(rows)
        yield stats
        rows.clear()
        rows.update(encode_stats(stats))


def close():
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def delete_document(namespace,key,connection):
    from psycopg import sql
    connection.execute(sql.SQL('DELETE FROM {} WHERE namespace=%s AND key=%s').format(table('settings')), (namespace,key))


def access_csv():
    import csv
    import io
    from psycopg import sql
    output=io.StringIO()
    writer=csv.writer(output)
    writer.writerow(['접속일시','Username','LoginId','Sabun','DeptName','x-ms-forwarded-client-ip','GrdName_EN','GrdName'])
    with pool().connection() as conn:
        for row in conn.execute(sql.SQL('SELECT payload FROM {} ORDER BY occurred_at').format(table('access_events'))):
            writer.writerow(row[0])
    return output.getvalue().encode('utf-8-sig')
