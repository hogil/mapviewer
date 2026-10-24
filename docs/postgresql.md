# PostgreSQL 16 metadata storage

Personal/composite/measure colours, per-LoginId preferences, announcement content/read
state, access statistics and SAML access details use PostgreSQL. Images, positions,
permissions and diagnostic text logs remain in their existing locations. PostgreSQL
mode never silently falls back to stale legacy files when the DB is unavailable.

## Environment

Edit DB environment variables directly in `start.sh` on Linux or `start.ps1` on
Windows. No `.env` file is created or loaded. Both start scripts explicitly set the
connection settings, including passwords, before launching the app.
The separate `upload_json_to_db.py` reads literal DB assignments from the matching
start script without executing it. Use single-quoted values in start.ps1 and literal
quoted values without variable interpolation in start.sh. The upload wrappers run
this Python file. Settings in these tracked scripts are visible to repository readers.

| Variable | Default | Purpose |
|---|---|---|
| APP_STORAGE | postgres in start scripts | postgres or explicit legacy rollback files |
| DB_HOST | 127.0.0.1 | Loopback TCP address |
| DB_PORT | 5432 | PostgreSQL port |
| DB_NAME | l3tracker | Database name |
| DB_USER | fbm | Runtime data-only account |
| DB_PASSWORD | configured in start script | Runtime password |
| DB_ADMIN_USER | l3tracker_app | Bootstrap administrator |
| DB_ADMIN_PASSWORD | configured in start script | Administrator password |
| DB_SCHEMA | fbm | SQL schema, distinct from colour schemes |
| DB_TABLE_SETTINGS | user_settings | JSONB settings, colours, catalogue and aggregates |
| DB_TABLE_NOTICE_STATE | notice_state | Per-user seen/read flags |
| DB_TABLE_ACCESS_EVENTS | access_events | Timestamped login records |

Schema/table names must match `[a-z_][a-z0-9_]{0,62}`. Changing them selects a different
storage location: bootstrap and migrate before switching an existing deployment.
The runtime role has SELECT/INSERT/UPDATE/DELETE, without superuser/schema-creation
rights. Only the bootstrap command uses administrator credentials.

With the default configuration, the database is `l3tracker` and the schema is `fbm`:

| Fully qualified table | Stored data |
|---|---|
| fbm.user_settings | Colours, preferences, announcement catalogue, statistics (separate namespace/key rows) |
| fbm.notice_state | LoginId + notice ID, list-seen flag, detail-read flag |
| fbm.access_events | SAML access timestamp, LoginId and original record fields |

If upgrading an earlier deployment that already contains data in schema `l3tracker`,
stop the app and connect as the DB administrator to database `l3tracker`. Before
bootstrapping the new configuration, rename the existing schema (only if `fbm` does
not already exist):

```sql
ALTER SCHEMA l3tracker RENAME TO fbm;
```

This preserves the existing rows and permissions. Do not create a separate empty
schema to replace an existing populated schema. The prepared local database has
already been renamed.

## Linux with PostgreSQL 16

On Ubuntu 24.04 with the PostgreSQL 16 packages available:

```bash
sudo apt-get install postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql
python3 -m pip install -r requirements.txt
# Edit the DB settings in start.sh.
```

Using the existing PostgreSQL superuser, create `l3tracker_app` once with LOGIN,
CREATEDB and CREATEROLE. Set the same password in the start script. Then:

```bash
python3 upload_json_to_db.py
bash start.sh
```

`127.0.0.1:5432` keeps traffic inside the same server and works on Windows and Linux.
No external server IP is required. A Unix socket directory can be used as DB_HOST on
Linux, but PostgreSQL authentication must permit the configured application role.

## Windows local instance

The prepared PostgreSQL 16 cluster is in `.local/postgresql16-win/` and listens on
loopback port 5432. `start.ps1` starts this cluster when its binaries exist and the port
is not ready; otherwise it checks the configured database service. On a different PC,
install PostgreSQL 16 first. Binaries/data are not repository files; DB credentials are configured in start.ps1.

```powershell
python upload_json_to_db.py
.\start.ps1
```

## Migration and preservation

From the project folder, double-click `upload_json_to_db.cmd` on Windows. It uses
the DB settings in `start.ps1`, creates any missing DB objects, imports the JSON/CSV/SQLite sources,
checks that all JSON keys exist and prints the connection result. Its window stays
open so success or errors can be read. For automation use `--no-pause`.
On Linux use `python3 upload_json_to_db.py` or `bash upload_json_to_db.sh`; both use the settings in `start.sh`.
Whether a desktop double-click opens a terminal depends on the file manager settings.
Both launchers preserve original files and newer existing DB settings. Different
values from an old source snapshot are reported rather than overwritten.

Stop the app before the final migration to obtain a stable source snapshot. Keep
PostgreSQL running. Bootstrap is repeatable and does not change existing role passwords.

The import reads `logs/color-legends.json`, `logs/ui-prefs.json`, `logs/stats.json`,
`docs/announcements.json`, `logs/announcements.sqlite3` and `logs/detail_access.csv`.
Missing optional files are skipped; malformed present files fail the import. Original
files are never deleted or rewritten by migration.

Colours and aggregate statistics are split into owner/bucket JSONB rows to preserve
existing formats and calculations. Statistics updates use a transaction advisory lock
and publish only changed rows. They still read the aggregate namespace; very large
histories may need a later aggregation redesign.

The data import uses one transaction. Re-import preserves existing settings, OR-merges
notice flags and deduplicates legacy login events. `verify` compares catalogue/settings
JSON rows with sources immediately after initial migration. A later user edit may
legitimately differ from the old JSON snapshot; verification does not overwrite it.

Use `python3 upload_json_to_db.py --source-root /absolute/snapshot` to import a different snapshot directory. For deliberate notice
publication, export the DB_* settings in the calling shell, edit the catalogue and run:

```bash
python3 scripts/manage_db.py migrate --replace-catalogue
```

Only catalogue content is overwritten by this option. Real new notices are unread;
the `test` dummy explicitly sets `read_by_default=true`.

The legacy files are not continuously synchronized. Back up PostgreSQL after switching.
Selecting APP_STORAGE=files uses the old snapshot and is not a lossless reverse migration.

## Focused checks

```bash
python3 scripts/check_postgres_storage.py
python3 scripts/check_postgres_api.py https://127.0.0.1
```

Direct Python management/test commands require the DB_* variables to be exported
in the calling shell. Unlike the start scripts, they do not supply passwords.
The first uses an owned disposable schema and needs the administrator credentials.
The API check creates uniquely named records and removes only its own records. Neither
uses browser automation. Existing file-backend announcement checks explicitly select
APP_STORAGE=files.
