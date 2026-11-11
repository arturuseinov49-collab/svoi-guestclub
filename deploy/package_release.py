#!/usr/bin/env python3
"""Package the already-tested build. No dependencies or secrets enter the payload."""
import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

from release_contract import APP, DATABASE_SCHEMA, FORMAT, REPOSITORY, SHA, require, safe_path, sha256_file, validate_manifest, version_info


def package(root, output, repository, commit, workflow_run, built_at=None):
    require(REPOSITORY.fullmatch(repository), 'Invalid repository')
    require(SHA.fullmatch(commit), 'Invalid commit')
    built_at = built_at or dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    manifest = {'formatVersion': FORMAT, 'app': APP, 'repository': repository, 'commit': commit, 'builtAt': built_at,
                'workflowRunId': workflow_run, 'databaseSchema': DATABASE_SCHEMA, 'nodeMinimum': '22.22.0'}
    payload = {}
    for folder in ('dist', 'server', 'bot'):
        require((root / folder).is_dir() and not (root / folder).is_symlink(), f'Missing {folder}')
        for path in sorted((root / folder).rglob('*')):
            require(not path.is_symlink(), 'Symlinks are not allowed in release input')
            if path.is_file():
                name = safe_path(path.relative_to(root).as_posix())
                payload[name] = path
    payload['version.json'] = (json.dumps(version_info(manifest), sort_keys=True) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'svoi-{commit}.tar.gz'
    require(not archive.exists() and not (output/'release.json').exists(), 'Output already exists; use a fresh output directory')
    entries = []
    with tarfile.open(archive, 'x:gz', format=tarfile.PAX_FORMAT) as tar:
        for name, value in sorted(payload.items()):
            data = value if isinstance(value, bytes) else value.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.uid, info.gid, info.mtime = len(data), 0o644, 0, 0, 0
            tar.addfile(info, io.BytesIO(data))
            entries.append({'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest['archive'] = {'name': archive.name, 'sha256': sha256_file(archive), 'bytes': archive.stat().st_size}
    manifest['files'] = entries
    validate_manifest(manifest, repository, commit)
    (output/'release.json').write_text(json.dumps(manifest, sort_keys=True, indent=2)+'\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repository', default=os.environ.get('GITHUB_REPOSITORY'), required=not os.environ.get('GITHUB_REPOSITORY'))
    parser.add_argument('--commit', default=os.environ.get('GITHUB_SHA'), required=not os.environ.get('GITHUB_SHA'))
    parser.add_argument('--workflow-run', type=int, default=int(os.environ.get('GITHUB_RUN_ID', '0')))
    args = parser.parse_args()
    head = subprocess.check_output(['git', '-C', str(args.root), 'rev-parse', 'HEAD'], text=True).strip()
    require(head == args.commit, 'Checked-out commit differs from requested release')
    result = package(args.root.resolve(), args.output.resolve(), args.repository, args.commit, args.workflow_run)
    print(json.dumps({'commit': result['commit'], 'archive': result['archive']}))
