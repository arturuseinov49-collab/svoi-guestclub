#!/usr/bin/env python3
"""Fixed root-owned control plane. Never execute scripts from a downloaded release as root.

Install this file and release_contract.py in /usr/local/lib/svoi with the reviewed
bootstrap. Application archives cannot update either file or systemd/configuration.
"""
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from release_contract import APP, DATABASE_SCHEMA, MAX_ARCHIVE, MAX_FILES, MAX_UNPACKED, REPOSITORY, SHA, RejectedRelease, require, sha256_file, strict_json, validate_manifest, version_info

try:
    import fcntl
except ImportError:  # Tests of archive validation also run on Windows; deployment is Linux only.
    fcntl = None

ROOT = Path('/opt/svoi')
STATE = Path('/var/lib/svoi-deploy')
DATABASE = Path('/var/lib/svoi/svoi.sqlite')
BACKUPS = STATE/'backups'
CONFIG = Path('/etc/svoi/autodeploy.json')
HEALTH = 'http://127.0.0.1:8081/api/health'
SERVICES = ('svoi-web.service', 'svoi-bot.service')
API = 'https://api.github.com'
DOWNLOAD_HOSTS = {'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}


class RetryLater(RuntimeError):
    """Transient failure; leave the release eligible for the next timer poll."""


def sync_directory(path):
    if os.name == 'posix':
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


@contextlib.contextmanager
def exclusive_lock(path):
    require(fcntl is not None, 'Linux file locking is required')
    with open(path, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def atomic_json(path, value):
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def read_state(directory=STATE):
    path = directory/'status.json'
    return strict_json(path.read_bytes()) if path.exists() else {}


def trusted_file(path, *, directory=False):
    item = path.lstat()
    require(not stat.S_ISLNK(item.st_mode), 'Control path must not be a symlink')
    require(stat.S_ISDIR(item.st_mode) if directory else stat.S_ISREG(item.st_mode), 'Unexpected control file type')
    require(item.st_uid == 0 and item.st_mode & 0o022 == 0, 'Control path is writable by a non-root user')


def database_schema(path):
    require(path.is_file() and not path.is_symlink(), 'Database is missing or is a symlink')
    with contextlib.closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True, timeout=5)) as database:
        return database.execute('PRAGMA user_version').fetchone()[0]


def backup_database(source=DATABASE, directory=BACKUPS):
    require(source.is_file() and not source.is_symlink(), 'Database is missing or is a symlink')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not directory.is_symlink(), 'Backup directory must not be a symlink')
    expected_size = sum(p.stat().st_size for p in (source, Path(str(source)+'-wal')) if p.exists())
    require(shutil.disk_usage(directory).free >= expected_size + 64*1024*1024, 'Insufficient space for database backup; no files deleted')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = directory/f'svoi-{stamp}-{uuid.uuid4().hex[:8]}.sqlite'
    temporary = target.with_suffix('.partial')
    start = time.monotonic()
    def progress(_status, _remaining, _total):
        require(time.monotonic()-start < 90, 'Database backup timed out')
    with temporary.open('xb'):
        pass
    os.chmod(temporary, 0o600)
    with contextlib.closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro', uri=True, timeout=5)) as src, contextlib.closing(sqlite3.connect(temporary)) as dst:
        src.backup(dst, pages=128, progress=progress, sleep=.1)
        require(dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Backup integrity check failed')
    with temporary.open('r+b') as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    sync_directory(directory)
    # No automatic deletion: space is checked before deployment. Retention is an operator policy.
    return target


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        require(parsed.scheme == 'https' and parsed.hostname in DOWNLOAD_HOSTS and parsed.port in (None, 443) and not parsed.username, 'Untrusted download redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, limit, destination=None, etag=None):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname in DOWNLOAD_HOSTS and parsed.port in (None, 443) and not parsed.username, 'Untrusted download URL')
    headers = {'User-Agent': 'svoi-fixed-updater/1', 'Accept': 'application/vnd.github+json' if parsed.hostname == 'api.github.com' else 'application/octet-stream', 'X-GitHub-Api-Version': '2026-03-10'}
    if etag:
        headers['If-None-Match'] = etag
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), SafeRedirect())
    request = urllib.request.Request(url, headers=headers)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        if error.code == 304:
            return None, etag
        raise RetryLater(f'GitHub HTTP {error.code}; retry next poll') from None
    except (urllib.error.URLError, OSError, TimeoutError):
        raise RetryLater('Network unavailable; retry next poll') from None
    content, total, started = bytearray(), 0, time.monotonic()
    with response:
        if response.headers.get('Content-Length'):
            require(int(response.headers['Content-Length']) <= limit, 'Download exceeds declared limit')
        sink = destination.open('xb') if destination else contextlib.nullcontext(None)
        with sink as stream:
            for block in iter(lambda: response.read(65536), b''):
                total += len(block)
                require(total <= limit, 'Download size limit exceeded')
                if time.monotonic()-started >= 180:
                    raise RetryLater('Download timed out; retry next poll')
                if stream:
                    stream.write(block)
                else:
                    content.extend(block)
        if destination and total != limit:
            raise RetryLater('Incomplete asset download; retry next poll')
        return bytes(content) if not destination else total, response.headers.get('ETag')


def verify_release_metadata(release, repository):
    require(isinstance(release, dict) and type(release.get('id')) is int and release['id'] > 0, 'Invalid GitHub release')
    require(release.get('draft') is False and release.get('prerelease') is False, 'Only published stable releases are accepted')
    require(release.get('immutable') is True, 'GitHub release immutability must be enabled before automatic deployment')
    tag = release.get('tag_name', '')
    require(isinstance(tag, str) and tag.startswith('deploy-') and SHA.fullmatch(tag[7:]), 'Unexpected release tag')
    commit = tag[7:]
    require(release.get('target_commitish') == commit, 'Release must target its full commit SHA')
    require(release.get('html_url') == f'https://github.com/{repository}/releases/tag/{tag}', 'Release repository mismatch')
    require(release.get('author', {}).get('login') == 'github-actions[bot]', 'Release was not published by the workflow')
    assets = release.get('assets')
    require(isinstance(assets, list), 'Missing release assets')
    expected = {'release.json', f'svoi-{commit}.tar.gz'}
    indexed = {}
    for asset in assets:
        name = asset.get('name')
        require(name in expected and name not in indexed, 'Unexpected or duplicate release asset')
        require(asset.get('state') == 'uploaded', 'Asset upload incomplete')
        require(asset.get('browser_download_url') == f'https://github.com/{repository}/releases/download/{tag}/{name}', 'Untrusted asset location')
        require(type(asset.get('size')) is int and 0 < asset['size'] <= (2*1024*1024 if name == 'release.json' else MAX_ARCHIVE), 'Asset too large')
        indexed[name] = asset
    require(indexed.keys() == expected, 'Release asset missing')
    return commit, indexed


def verify_workflow(run, manifest, repository):
    require(isinstance(run, dict) and run.get('id') == manifest['workflowRunId'], 'Workflow identity mismatch')
    require(run.get('event') == 'push' and run.get('head_branch') == 'main' and run.get('head_sha') == manifest['commit'], 'Release must be a push to main')
    require(run.get('repository', {}).get('full_name') == repository and run.get('head_repository', {}).get('full_name') == repository, 'Workflow repository mismatch')
    require(run.get('path') == '.github/workflows/ci.yml', 'Unexpected release workflow')
    if run.get('status') != 'completed':
        raise RetryLater('Publishing workflow is still running; retry next poll')
    require(run.get('conclusion') == 'success', 'Publishing workflow did not succeed')


def extract_verified(archive, destination, manifest):
    entries = validate_manifest(manifest, manifest['repository'])
    require(archive.stat().st_size == manifest['archive']['bytes'], 'Archive size mismatch')
    require(sha256_file(archive) == manifest['archive']['sha256'], 'Archive digest mismatch')
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    seen, total = set(), 0
    # Do not use extract/extractall: no paths, owners, modes, links or special files are trusted.
    with tarfile.open(archive, mode='r|gz') as tar:
        for member in tar:
            require(len(seen) < MAX_FILES and member.isreg() and not member.issparse(), 'Unsupported archive entry')
            name = member.name
            require(name in entries and name not in seen, 'Unexpected or duplicate archive path')
            require(member.size == entries[name]['size'], 'Archive member size mismatch')
            seen.add(name)
            target = destination.joinpath(*name.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            require(target.parent.resolve().is_relative_to(destination.resolve()), 'Archive escaped release directory')
            digest, size = hashlib.sha256(), 0
            with tar.extractfile(member) as src, target.open('xb') as dst:
                for block in iter(lambda: src.read(65536), b''):
                    size += len(block)
                    total += len(block)
                    require(size <= member.size and total <= MAX_UNPACKED, 'Unpacked size limit exceeded')
                    digest.update(block)
                    dst.write(block)
                dst.flush()
                os.fsync(dst.fileno())
            require(size == member.size and digest.hexdigest() == entries[name]['sha256'], 'File digest mismatch')
            os.chmod(target, 0o644)
    require(seen == entries.keys(), 'Archive is incomplete')
    require(strict_json((destination/'version.json').read_bytes()) == version_info(manifest), 'Embedded version metadata mismatch')
    # mkdir obeys the updater's restrictive umask; explicitly allow app traversal
    # only after all files have passed verification. No archive mode is copied.
    for directory in sorted((p for p in destination.rglob('*') if p.is_dir()), reverse=True):
        os.chmod(directory, 0o755)
        sync_directory(directory)
    os.chmod(destination, 0o755)
    sync_directory(destination)
    return destination


def checked_current(root=ROOT):
    current = root/'current'
    require(current.is_symlink(), 'current must be a symlink; migrate the existing installation first')
    previous = current.resolve(strict=True)
    require(previous.parent == (root/'releases').resolve() and previous.is_dir(), 'Current release is outside releases')
    return previous


def cleanup_owned_staging(path, root=ROOT, *, owner_uid=None):
    """Remove only the private UUID directory created by this invocation."""
    require(path.parent == root/'.staging' and re.fullmatch(r'[0-9a-f]{40}-[0-9a-f]{32}', path.name), 'Refusing cleanup outside own staging directory')
    require(os.name == 'posix' and shutil.rmtree.avoids_symlink_attacks, 'Safe Linux directory removal is required')
    owner_uid = os.geteuid() if owner_uid is None else owner_uid  # main requires UID 0; CI fixtures run unprivileged.
    for ancestor in (root, root/'.staging', path):
        value = ancestor.lstat()
        require(stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode) and value.st_uid == owner_uid and value.st_mode & 0o022 == 0, 'Unsafe staging ownership or ancestry')
    require(not any(item.is_symlink() for item in path.rglob('*')), 'Unexpected symlink in private staging; inspect manually')
    shutil.rmtree(path)
    sync_directory(path.parent)


def stopped_database_schema(source, root=ROOT):
    """Only after every writer is stopped: inspect a private DB+WAL copy.

    A readonly WAL-mode source may have no SHM after clean shutdown. Opening the
    original would try to create SHM on a readonly mount. immutable=1 is unsafe
    when a surviving WAL contains a newer schema, so recover SHM on a copy only.
    """
    require(source.is_file() and not source.is_symlink(), 'Database is missing or is a symlink')
    wal = Path(str(source)+'-wal')
    require(not wal.is_symlink(), 'Database WAL must not be a symlink')
    required_space = 2*database_size(source) + 64*1024*1024
    require(shutil.disk_usage(root).free >= required_space, 'Insufficient space for stopped database inspection')
    temporary = root/'.staging'/('0'*40+'-'+uuid.uuid4().hex)
    temporary.mkdir(mode=0o700)
    try:
        copied = temporary/'schema.sqlite'
        shutil.copyfile(source,copied)
        if wal.exists():
            require(wal.is_file(), 'Unexpected WAL file type')
            shutil.copyfile(wal,Path(str(copied)+'-wal'))
        with contextlib.closing(sqlite3.connect(copied,timeout=5)) as database:
            return database.execute('PRAGMA user_version').fetchone()[0]
    finally:
        cleanup_owned_staging(temporary,root)


def switch_link(target, root=ROOT):
    require(target.parent.resolve() == (root/'releases').resolve() and target.is_dir(), 'Invalid release switch target')
    temporary = root/f'.current-{uuid.uuid4().hex}'
    os.symlink(str(target), temporary, target_is_directory=True)
    os.replace(temporary, root/'current')
    sync_directory(root)


class System:
    def command(self, *args):
        return subprocess.check_output(['/usr/bin/systemctl', *args], text=True, timeout=90).strip()

    def preflight(self):
        for service in SERVICES:
            require(self.command('show', service, '--property=User', '--value') == 'svoi', 'Application service must run as svoi')
            require(self.command('is-active', service) == 'active', 'Existing application service is not active')
        node = subprocess.check_output(['/usr/bin/node', '--version'], text=True, timeout=10).strip()
        match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', node)
        require(match and tuple(map(int, match.groups())) >= (22, 22, 0), 'Node.js 22.22.0 or newer required')

    def stop(self):
        self.command('stop', *SERVICES)
        for service in SERVICES:
            require(self.command('show', service, '--property=MainPID', '--value') == '0' and self.command('show', service, '--property=ActiveState', '--value') in ('inactive', 'failed'), 'Application writer has not stopped')

    def start(self):
        self.command('start', *SERVICES)

    def healthy(self, commit=None, repository=None, timeout=75):
        deadline, stable = time.monotonic()+timeout, 0
        # Both processes must remain alive and the API must identify this exact release.
        while time.monotonic() < deadline:
            try:
                active = all(self.command('is-active', service) == 'active' for service in SERVICES)
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(HEALTH, timeout=4) as response:
                    body = strict_json(response.read(8193))
                valid = active and body.get('app') == APP and body.get('database') == 'ready'
                if commit:
                    valid = valid and body.get('release', {}).get('commit') == commit and body.get('release', {}).get('repository') == repository and body.get('databaseSchema') == DATABASE_SCHEMA
                stable = stable + 1 if valid else 0
                if stable >= 5:
                    return True
            except (OSError, ValueError, subprocess.SubprocessError):
                stable = 0
            time.sleep(3)
        return False


def previous_version(path):
    metadata = path/'version.json'
    if not metadata.exists():
        return None, None  # The initial, manually deployed version predates release metadata.
    value = strict_json(metadata.read_bytes())
    require(SHA.fullmatch(value.get('commit', '')) and REPOSITORY.fullmatch(value.get('repository', '')), 'Invalid previous release metadata')
    return value['commit'], value['repository']


def recover_pending(state, system, root=ROOT, state_dir=STATE, database=DATABASE):
    pending = state.get('pending')
    if not pending:
        return state
    previous, candidate = Path(pending['previous']), Path(pending['candidate'])
    require(previous.parent == root/'releases' and candidate.parent == root/'releases', 'Invalid recovery paths')
    require(checked_current(root) in (previous, candidate), 'Unexpected active release during recovery')
    system.stop()
    require(stopped_database_schema(database,root) == DATABASE_SCHEMA, 'Unexpected database schema after failure; services stopped and pending journal preserved for manual recovery')
    switch_link(previous, root)
    system.start()
    commit, repository = previous_version(previous)
    restored = system.healthy(commit, repository)
    state.pop('pending')
    state.update({'failedReleaseId': pending['releaseId'], 'rollbackHealthy': restored, 'lastError': 'Recovered interrupted deployment; database was not rolled back'})
    atomic_json(state_dir/'status.json', state)
    require(restored, 'Code rollback completed, but previous release health failed; manual intervention required')
    return state


def activate(candidate, manifest, release_id, state, system, *, root=ROOT, state_dir=STATE, database=DATABASE, backups=BACKUPS):
    previous = checked_current(root)
    require(database_schema(database) == DATABASE_SCHEMA, 'Database schema requires manual migration')
    system.preflight()
    backup = backup_database(database, backups)
    state['pending'] = {'previous': str(previous), 'candidate': str(candidate), 'releaseId': release_id, 'commit': manifest['commit'], 'backup': str(backup)}
    atomic_json(state_dir/'status.json', state)  # Recovery survives process termination or a VPS reboot.
    try:
        system.stop()
        switch_link(candidate, root)
        system.start()
        require(system.healthy(manifest['commit'], manifest['repository']), 'New release did not become healthy')
    except Exception:
        recover_pending(state, system, root, state_dir, database)
        raise RejectedRelease('New release rejected; previous code restored; database preserved') from None
    state.pop('pending')
    state.update({'activeCommit': manifest['commit'], 'activeReleaseId': release_id, 'previous': str(previous), 'backup': str(backup), 'lastSuccess': dt.datetime.now(dt.timezone.utc).isoformat(), 'rollbackHealthy': None})
    state.pop('lastError', None)
    atomic_json(state_dir/'status.json', state)
    return state


def poll(repository, *, system=None, root=ROOT, state_dir=STATE, database=DATABASE, backups=BACKUPS):
    system = system or System()
    state = recover_pending(read_state(state_dir), system, root, state_dir, database)
    raw, etag = fetch(f'{API}/repos/{repository}/releases/latest', 2*1024*1024, etag=state.get('etag'))
    if raw is None:
        return 'No release change'
    release = strict_json(raw)
    commit, assets = verify_release_metadata(release, repository)
    release_id = release['id']
    if release_id <= max(state.get('activeReleaseId', 0), state.get('failedReleaseId', 0)) or commit == state.get('activeCommit'):
        state['etag'] = etag
        atomic_json(state_dir/'status.json', state)
        return 'Release already active, rejected, or older'
    manifest_raw, _ = fetch(assets['release.json']['browser_download_url'], 2*1024*1024)
    manifest = strict_json(manifest_raw)
    validate_manifest(manifest, repository, commit)
    archive_asset = assets[manifest['archive']['name']]
    require(archive_asset['size'] == manifest['archive']['bytes'], 'GitHub asset size mismatch')
    require(archive_asset.get('digest') == 'sha256:'+manifest['archive']['sha256'], 'GitHub asset digest mismatch')
    workflow_raw, _ = fetch(f"{API}/repos/{repository}/actions/runs/{manifest['workflowRunId']}", 2*1024*1024)
    verify_workflow(strict_json(workflow_raw), manifest, repository)
    needed = manifest['archive']['bytes'] + sum(item['size'] for item in manifest['files']) + 3*database_size(database) + 128*1024*1024
    require(shutil.disk_usage(root).free >= needed, 'Insufficient disk space; no releases or backups were deleted')
    require(shutil.disk_usage(backups).free >= database_size(database) + 128*1024*1024, 'Insufficient backup filesystem space; no files deleted')
    require(database_schema(database) == DATABASE_SCHEMA, 'Database schema requires manual migration')
    staging = root/'.staging'/f'{commit}-{uuid.uuid4().hex}'
    staging.mkdir(mode=0o700, parents=False)
    archive = staging/manifest['archive']['name']
    try:
        fetch(archive_asset['browser_download_url'], manifest['archive']['bytes'], archive)
        try:
            extracted = extract_verified(archive, staging/'payload', manifest)
        except (tarfile.TarError, EOFError):
            raise RejectedRelease('Invalid or truncated archive') from None
        candidate = root/'releases'/commit
        require(not candidate.exists(), 'Release directory already exists; inspect it manually before retrying')
        os.rename(extracted, candidate)
        sync_directory(root/'releases')
        activate(candidate, manifest, release_id, state, system, root=root, state_dir=state_dir, database=database, backups=backups)
    except RejectedRelease:
        # Validation failures must not lead to repeated downloads/restarts every five minutes.
        state = read_state(state_dir)
        if not state.get('pending'):
            state.update({'failedReleaseId': release_id, 'lastError': 'Release validation or activation failed; inspect journal'})
            atomic_json(state_dir/'status.json', state)
        raise
    finally:
        cleanup_owned_staging(staging, root)
    state = read_state(state_dir)
    state['etag'] = etag
    atomic_json(state_dir/'status.json', state)
    return f'Deployed {commit}'


def database_size(database=DATABASE):
    return sum(path.stat().st_size for path in (database, Path(str(database)+'-wal')) if path.exists())


def main():
    require(os.name == 'posix' and os.geteuid() == 0 and fcntl is not None, 'Run installed updater as root on Linux')
    os.umask(0o077)
    if sys.argv[1:] == ['--backup-only']:
        print('Verified backup: '+backup_database().name)
        return
    require(not sys.argv[1:], 'Unexpected arguments')
    if Path('/etc/svoi/autodeploy.disabled').exists():
        print('Automatic deployment is paused')
        return
    for path in (CONFIG, Path(__file__).resolve(), Path(__file__).with_name('release_contract.py')):
        trusted_file(path)
    for path in (ROOT, ROOT/'releases', ROOT/'.staging', STATE, BACKUPS):
        trusted_file(path, directory=True)
    trusted_file(checked_current(), directory=True)
    config = strict_json(CONFIG.read_bytes())
    require(isinstance(config, dict) and set(config) == {'repository'} and REPOSITORY.fullmatch(config['repository']), 'Invalid updater configuration')
    with exclusive_lock('/run/svoi-autodeploy/update.lock') as acquired:
        if not acquired:
            print('Another updater holds the lock')
            return
        print(poll(config['repository']))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print response bodies, environment, tokens, or signed asset URLs.
        print(f'Update stopped: {type(error).__name__}: {str(error)[:220]}', file=sys.stderr)
        sys.exit(1)
