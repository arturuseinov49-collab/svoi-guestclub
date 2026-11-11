#!/usr/bin/env python3
"""Consistent SQLite online backup. Run as root via the systemd timer."""
import datetime
import os
from pathlib import Path
import sqlite3

source = Path('/var/lib/svoi/svoi.sqlite')
directory = Path('/var/lib/svoi/backups')
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(directory, 0o700)
if not source.is_file():
    raise SystemExit('Svoi database does not exist')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
target = directory / f'svoi-{stamp}.sqlite'
temporary = target.with_suffix('.tmp')
os.umask(0o077)
with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src, sqlite3.connect(temporary) as dst:
    src.backup(dst)
    if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise RuntimeError('Backup integrity check failed')
os.replace(temporary, target)
# Bounded retention only affects files created by this backup job.
for previous in sorted(directory.glob('svoi-????????T????????????Z.sqlite'), reverse=True)[30:]:
    previous.unlink()
print(f'Backup verified: {target.name}')
