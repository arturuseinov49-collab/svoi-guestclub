"""Small, dependency-free contract shared by the CI packager and fixed VPS updater."""
import datetime as dt
import hashlib
import json
import re
from pathlib import PurePosixPath

APP = 'svoi-telegram'
FORMAT = 1
DATABASE_SCHEMA = 2
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_UNPACKED = 400 * 1024 * 1024
MAX_FILE = 80 * 1024 * 1024
MAX_FILES = 8000
SHA = re.compile(r'^[0-9a-f]{40}$')
DIGEST = re.compile(r'^[0-9a-f]{64}$')
REPOSITORY = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$')
REQUIRED = {'dist/index.html', 'server/index.mjs', 'server/application.mjs', 'server/release-info.mjs', 'bot/index.mjs', 'version.json'}


class RejectedRelease(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise RejectedRelease(message)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON field')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(RejectedRelease('Non-finite JSON number')))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RejectedRelease('Invalid JSON') from error


def safe_path(name):
    require(isinstance(name, str) and 0 < len(name) <= 240, 'Invalid path length')
    require(not any(ord(c) < 32 or c in '\\:*?"<>|' for c in name), 'Invalid path character')
    parts = name.split('/')
    require(all(p and p not in ('.', '..') and not p.startswith('.') for p in parts), 'Unsafe path component')
    require(not PurePosixPath(name).is_absolute(), 'Absolute path forbidden')
    require(name == 'version.json' or (len(parts) > 1 and parts[0] in ('dist', 'server', 'bot')), 'Path outside application payload')
    if parts[0] in ('server', 'bot'):
        require(name.endswith('.mjs'), 'Runtime payload must contain only mjs modules')
    return name


def integer(value, minimum, maximum, label):
    require(type(value) is int and minimum <= value <= maximum, f'Invalid {label}')
    return value


def validate_manifest(manifest, repository, commit=None):
    require(isinstance(manifest, dict), 'Manifest must be an object')
    require(set(manifest) == {'formatVersion', 'app', 'repository', 'commit', 'builtAt', 'workflowRunId', 'databaseSchema', 'nodeMinimum', 'archive', 'files'}, 'Unexpected manifest fields')
    require(type(manifest['formatVersion']) is int and manifest['formatVersion'] == FORMAT and manifest['app'] == APP, 'Unsupported manifest format')
    require(REPOSITORY.fullmatch(repository) and manifest['repository'] == repository, 'Repository mismatch')
    require(isinstance(manifest['commit'], str) and SHA.fullmatch(manifest['commit']), 'Invalid commit')
    require(commit is None or manifest['commit'] == commit, 'Commit mismatch')
    integer(manifest['workflowRunId'], 1, 2**53 - 1, 'workflow run')
    require(manifest['databaseSchema'] == DATABASE_SCHEMA, 'Automatic database migrations are forbidden')
    require(manifest['nodeMinimum'] == '22.22.0', 'Unsupported Node runtime contract')
    try:
        value = dt.datetime.fromisoformat(manifest['builtAt'].replace('Z', '+00:00'))
        require(value.tzinfo is not None, 'Build time must include timezone')
    except (AttributeError, TypeError, ValueError) as error:
        raise RejectedRelease('Invalid build time') from error
    archive = manifest['archive']
    require(isinstance(archive, dict) and set(archive) == {'name', 'sha256', 'bytes'}, 'Invalid archive metadata')
    require(archive['name'] == f"svoi-{manifest['commit']}.tar.gz", 'Unexpected archive name')
    require(isinstance(archive['sha256'], str) and DIGEST.fullmatch(archive['sha256']), 'Invalid archive digest')
    integer(archive['bytes'], 1, MAX_ARCHIVE, 'archive size')
    files = manifest['files']
    require(isinstance(files, list) and 1 <= len(files) <= MAX_FILES, 'Invalid file count')
    entries, names, total = {}, set(), 0
    for item in files:
        require(isinstance(item, dict) and set(item) == {'path', 'size', 'sha256'}, 'Invalid file entry')
        name = safe_path(item['path'])
        require(name.casefold() not in names, 'Duplicate file path')
        names.add(name.casefold())
        integer(item['size'], 0, MAX_FILE, 'file size')
        require(isinstance(item['sha256'], str) and DIGEST.fullmatch(item['sha256']), 'Invalid file digest')
        entries[name] = item
        total += item['size']
    require(total <= MAX_UNPACKED, 'Unpacked size limit exceeded')
    require(REQUIRED <= entries.keys(), 'Required application file missing')
    return entries


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def version_info(manifest):
    return {key: manifest[key] for key in ('app', 'repository', 'commit', 'builtAt', 'databaseSchema')}
