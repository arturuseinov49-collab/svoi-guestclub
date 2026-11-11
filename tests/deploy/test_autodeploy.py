import copy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'deploy'))
from package_release import package
from release_contract import RejectedRelease, strict_json, validate_manifest
import update

COMMIT, REPOSITORY = 'a'*40, 'example/svoi'


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.base = Path(temporary.name)
        self.addCleanup(temporary.cleanup)
        self.source = self.base/'source'
        for name in ('dist/index.html', 'dist/assets/hello.txt', 'server/index.mjs', 'server/application.mjs', 'server/release-info.mjs', 'bot/index.mjs'):
            path = self.source/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic fixture '+name, encoding='utf-8')
        self.output = self.base/'output'
        self.manifest = package(self.source, self.output, REPOSITORY, COMMIT, 1234, '2026-11-12T00:00:00Z')
        self.archive = self.output/self.manifest['archive']['name']

    def altered_archive(self, extra=None, remove=None, change=None):
        target = self.base/'changed.tar.gz'
        with tarfile.open(self.archive, 'r:gz') as source, tarfile.open(target, 'w:gz') as output:
            for member in source:
                if member.name == remove:
                    continue
                data = source.extractfile(member).read()
                output.addfile(member, io.BytesIO(b'x'*len(data) if change == member.name else data))
            if extra:
                member, data = extra
                output.addfile(member, io.BytesIO(data) if member.isreg() else None)
        manifest = copy.deepcopy(self.manifest)
        manifest['archive'].update(bytes=target.stat().st_size, sha256=hashlib.sha256(target.read_bytes()).hexdigest())
        return target, manifest

    def poll_fixture(self):
        root, state, backups = self.base/'install', self.base/'state', self.base/'backups'
        for directory in (root/'.staging', root/'releases', state, backups): directory.mkdir(parents=True)
        database = self.base/'database.sqlite'
        with contextlib.closing(sqlite3.connect(database)) as db: db.execute('PRAGMA user_version=2')
        tag = 'deploy-'+COMMIT
        release = {'id':12,'draft':False,'prerelease':False,'immutable':True,'tag_name':tag,'target_commitish':COMMIT,'html_url':f'https://github.com/{REPOSITORY}/releases/tag/{tag}','author':{'login':'github-actions[bot]'},'assets':[]}
        for name, size, digest in [('release.json',100,None),(self.archive.name,self.archive.stat().st_size,'sha256:'+self.manifest['archive']['sha256'])]:
            release['assets'].append({'name':name,'size':size,'digest':digest,'state':'uploaded','browser_download_url':f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'})
        run = {'id':1234,'event':'push','head_branch':'main','head_sha':COMMIT,'repository':{'full_name':REPOSITORY},'head_repository':{'full_name':REPOSITORY},'path':'.github/workflows/ci.yml','status':'completed','conclusion':'success'}
        responses = [(json.dumps(release).encode(),'etag'), (json.dumps(self.manifest).encode(),None), (json.dumps(run).encode(),None)]
        return {'root':root,'state_dir':state,'database':database,'backups':backups}, responses


class ArchiveTests(Fixture):
    def test_valid_archive_preserves_payload_and_version(self):
        result = update.extract_verified(self.archive, self.base/'payload', self.manifest)
        self.assertEqual((result/'dist/index.html').read_bytes(), (self.source/'dist/index.html').read_bytes())
        self.assertEqual(json.loads((result/'version.json').read_text())['commit'], COMMIT)
        self.assertFalse((result/'deploy').exists())

    @unittest.skipUnless(os.name == 'posix', 'Linux permission semantics')
    def test_extracted_directories_are_traversable_under_root_umask(self):
        previous = os.umask(0o077)
        try:
            result = update.extract_verified(self.archive, self.base/'payload-umask', self.manifest)
        finally:
            os.umask(previous)
        for path in [result, *result.rglob('*')]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o755 if path.is_dir() else 0o644)

    def test_transient_download_failure_does_not_blacklist_release_or_activate(self):
        paths, responses = self.poll_fixture()
        responses.append(update.RetryLater('temporary network outage'))
        with patch.object(update,'fetch',side_effect=responses), patch.object(update,'activate') as activate, patch.object(update,'cleanup_owned_staging') as cleanup:
            with self.assertRaises(update.RetryLater):
                update.poll(REPOSITORY,**paths)
            activate.assert_not_called()
            cleanup.assert_called_once()
        self.assertNotIn('failedReleaseId', update.read_state(paths['state_dir']))
        self.assertEqual(list((paths['root']/'releases').iterdir()), [])

    def test_disk_gate_reserves_rollback_copy_before_download_or_stop(self):
        paths, responses = self.poll_fixture()
        # 300 MiB fits the old 1x100MiB DB reserve, but cannot also hold the
        # stopped DB+WAL recovery copy. Refuse while the old app is untouched.
        class Space: free = 300*1024*1024
        with patch.object(update,'fetch',side_effect=responses) as fetch, patch.object(update,'database_size',return_value=100*1024*1024), patch.object(update.shutil,'disk_usage',return_value=Space()), patch.object(update,'activate') as activate:
            with self.assertRaisesRegex(RejectedRelease,'Insufficient disk space'):
                update.poll(REPOSITORY,**paths)
            activate.assert_not_called()
            self.assertEqual(fetch.call_count,3)
        self.assertEqual(list((paths['root']/'.staging').iterdir()),[])

    def test_manifest_rejects_unsafe_paths(self):
        for path in ('../escape', '/etc/shadow', 'dist/../escape', 'dist//file', 'dist\\file', 'dist/.env', 'server/a.py', 'deploy/install.sh', 'data/db.sqlite', 'dist/C:secret'):
            with self.subTest(path=path):
                manifest = copy.deepcopy(self.manifest)
                manifest['files'][0]['path'] = path
                with self.assertRaises(RejectedRelease): validate_manifest(manifest, REPOSITORY)

    def test_archive_rejects_links_devices_traversal_and_duplicates(self):
        for index, kind in enumerate(('symlink', 'hardlink', 'device', 'traversal', 'absolute', 'duplicate')):
            with self.subTest(kind=kind):
                name = {'traversal':'../outside', 'absolute':'/outside', 'duplicate':'dist/index.html'}.get(kind, 'dist/unsafe')
                member = tarfile.TarInfo(name)
                if kind == 'symlink': member.type, member.linkname = tarfile.SYMTYPE, '/etc'
                elif kind == 'hardlink': member.type, member.linkname = tarfile.LNKTYPE, 'dist/index.html'
                elif kind == 'device': member.type = tarfile.CHRTYPE
                else: member.size = 1
                archive, manifest = self.altered_archive(extra=(member, b'x'))
                with self.assertRaises(RejectedRelease):
                    update.extract_verified(archive, self.base/f'bad-{index}', manifest)
        self.assertFalse((self.base/'outside').exists())

    def test_digest_mismatch_or_missing_member_never_accepted(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['archive']['sha256'] = '0'*64
        with self.assertRaises(RejectedRelease): update.extract_verified(self.archive, self.base/'bad-digest', manifest)
        for index, options in enumerate(({'remove':'dist/index.html'}, {'change':'server/index.mjs'})):
            archive, manifest = self.altered_archive(**options)
            with self.assertRaises(RejectedRelease): update.extract_verified(archive, self.base/f'bad-member-{index}', manifest)

    def test_schema_change_and_duplicate_json_fail_closed(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['databaseSchema'] = 3
        with self.assertRaises(RejectedRelease): validate_manifest(manifest, REPOSITORY)
        with self.assertRaises(RejectedRelease): strict_json('{"commit":"a","commit":"b"}')

    def test_workflow_must_be_successful_push_main_of_this_repository(self):
        run = {'id':1234, 'event':'push', 'head_branch':'main', 'head_sha':COMMIT, 'repository':{'full_name':REPOSITORY}, 'head_repository':{'full_name':REPOSITORY}, 'path':'.github/workflows/ci.yml', 'status':'completed', 'conclusion':'success'}
        update.verify_workflow(run, self.manifest, REPOSITORY)
        for field, value in [('event','pull_request'), ('head_branch','feature'), ('head_sha','b'*40), ('conclusion','failure'), ('path','.github/workflows/other.yml')]:
            with self.subTest(field=field), self.assertRaises(RejectedRelease):
                update.verify_workflow({**run, field:value}, self.manifest, REPOSITORY)
        with self.assertRaises(update.RetryLater):
            update.verify_workflow({**run, 'status':'in_progress'}, self.manifest, REPOSITORY)
        with self.assertRaises(RejectedRelease):
            update.verify_workflow({**run, 'head_repository':{'full_name':'attacker/svoi'}}, self.manifest, REPOSITORY)

    def test_untrusted_asset_location_or_author_rejected(self):
        tag = 'deploy-'+COMMIT
        release = {'id':12, 'draft':False, 'prerelease':False, 'immutable':True, 'tag_name':tag, 'target_commitish':COMMIT, 'html_url':f'https://github.com/{REPOSITORY}/releases/tag/{tag}', 'author':{'login':'github-actions[bot]'}, 'assets':[{'name':name,'state':'uploaded','size':100,'browser_download_url':f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'} for name in ['release.json',f'svoi-{COMMIT}.tar.gz']]}
        update.verify_release_metadata(release, REPOSITORY)
        bad = copy.deepcopy(release)
        bad['assets'][0]['browser_download_url'] = 'https://attacker.example/release.json'
        with self.assertRaises(RejectedRelease): update.verify_release_metadata(bad, REPOSITORY)
        with self.assertRaises(RejectedRelease): update.verify_release_metadata({**release, 'immutable':False}, REPOSITORY)
        bad = copy.deepcopy(release)
        bad['author']['login'] = 'random-person'
        with self.assertRaises(RejectedRelease): update.verify_release_metadata(bad, REPOSITORY)


class BackupTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'posix' and os.geteuid() != 0, 'Unprivileged Linux readonly directory test')
    def test_stopped_schema_reads_readonly_clean_wal_database_without_creating_source_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'.staging').mkdir(mode=0o700)
            source_dir = root/'readonly'
            source_dir.mkdir()
            source = source_dir/'svoi.sqlite'
            with contextlib.closing(sqlite3.connect(source)) as db:
                db.executescript('PRAGMA journal_mode=WAL; PRAGMA user_version=2; CREATE TABLE visits(id INTEGER);')
            self.assertFalse(Path(str(source)+'-wal').exists())
            os.chmod(source_dir,0o555)
            os.chmod(source,0o444)
            try:
                self.assertEqual(update.stopped_database_schema(source,root),2)
                self.assertEqual({p.name for p in source_dir.iterdir()},{'svoi.sqlite'})
            finally:
                os.chmod(source_dir,0o755)
                os.chmod(source,0o644)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() != 0, 'Unprivileged Linux surviving WAL test')
    def test_stopped_schema_recovers_new_schema_existing_only_in_readonly_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'.staging').mkdir(mode=0o700)
            source_dir = root/'readonly'
            source_dir.mkdir()
            source = source_dir/'svoi.sqlite'
            script = "import sqlite3,os,sys; db=sqlite3.connect(sys.argv[1]); db.executescript('PRAGMA journal_mode=WAL; PRAGMA user_version=2; CREATE TABLE visits(id INTEGER); PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0; PRAGMA user_version=3;'); os._exit(0)"
            subprocess.run([sys.executable,'-c',script,str(source)],check=True)
            # A crash leaves committed schema3 in WAL and schema2 in the main header.
            self.assertEqual(int.from_bytes(source.read_bytes()[60:64],'big'),2)
            self.assertGreater(Path(str(source)+'-wal').stat().st_size,0)
            before = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source_dir.iterdir()}
            os.chmod(source_dir,0o555)
            for file in source_dir.iterdir(): os.chmod(file,0o444)
            try:
                self.assertEqual(update.stopped_database_schema(source,root),3)
                after = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source_dir.iterdir()}
                self.assertEqual(before,after)
            finally:
                os.chmod(source_dir,0o755)
                for file in source_dir.iterdir(): os.chmod(file,0o644)

    @unittest.skipUnless(os.name == 'posix', 'Linux ownership and safe removal')
    def test_cleanup_is_limited_to_own_uuid_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root/'.staging'
            parent.mkdir(mode=0o700)
            own = parent/(COMMIT+'-'+'1'*32)
            foreign = parent/'keep'
            own.mkdir(mode=0o700)
            foreign.mkdir(mode=0o700)
            (own/'partial').write_text('discard only this temporary download')
            update.cleanup_owned_staging(own,root,owner_uid=os.getuid())
            self.assertFalse(own.exists())
            self.assertTrue(foreign.exists())
            with self.assertRaises(RejectedRelease): update.cleanup_owned_staging(foreign,root,owner_uid=os.getuid())
            os.symlink(str(foreign),own,target_is_directory=True)
            with self.assertRaises(RejectedRelease): update.cleanup_owned_staging(own,root,owner_uid=os.getuid())

    def test_online_backup_contains_committed_wal_and_does_not_change_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'svoi.sqlite'
            with contextlib.closing(sqlite3.connect(source)) as connection:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('CREATE TABLE visits (id INTEGER)')
                connection.execute('INSERT INTO visits VALUES (7)')
                connection.commit()
                backup = update.backup_database(source, root/'backups')
                connection.execute('INSERT INTO visits VALUES (8)')
                connection.commit()
                with contextlib.closing(sqlite3.connect(backup)) as copied: self.assertEqual(copied.execute('SELECT id FROM visits').fetchall(), [(7,)])
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM visits').fetchone()[0], 2)

    @unittest.skipUnless(update.fcntl is not None, 'Linux flock')
    def test_lock_excludes_second_updater_and_releases_after_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory)/'update.lock'
            with update.exclusive_lock(lock) as first:
                self.assertTrue(first)
                with update.exclusive_lock(lock) as second: self.assertFalse(second)
            with update.exclusive_lock(lock) as next_run: self.assertTrue(next_run)

    def test_health_rejects_wrong_commit_even_when_services_are_active(self):
        system = update.System()
        body = {'app':'svoi-telegram','database':'ready','databaseSchema':2,'release':{'commit':'b'*40,'repository':REPOSITORY}}
        class Opener:
            def open(self,*_args,**_kwargs): return io.BytesIO(json.dumps(body).encode())
        with patch.object(system,'command',return_value='active'), patch.object(update.urllib.request,'build_opener',return_value=Opener()), patch.object(update.time,'monotonic',side_effect=[0,0,76]), patch.object(update.time,'sleep'):
            self.assertFalse(system.healthy(COMMIT,REPOSITORY))


class ActivationTests(Fixture):
    def setUp(self):
        super().setUp()
        self.root = self.base/'installation'
        self.previous, self.candidate = self.root/'releases'/'previous', self.root/'releases'/COMMIT
        self.previous.mkdir(parents=True)
        self.candidate.mkdir()
        (self.root/'.staging').mkdir(mode=0o700)
        try: os.symlink(str(self.previous), self.root/'current', target_is_directory=True)
        except OSError: self.skipTest('Host does not permit symlinks; Linux CI runs activation tests')
        self.state_dir = self.base/'state'
        self.state_dir.mkdir()
        self.database, self.backups = self.base/'svoi.sqlite', self.base/'backups'
        with contextlib.closing(sqlite3.connect(self.database)) as database:
            database.executescript('PRAGMA user_version=2; CREATE TABLE visits (id INTEGER); INSERT INTO visits VALUES(1);')
        database = self.database
        class FakeSystem:
            def __init__(self, outcomes): self.outcomes, self.starts, self.stops = iter(outcomes), 0, 0
            def preflight(self): pass
            def stop(self): self.stops += 1
            def start(self):
                self.starts += 1
                if self.starts == 1:
                    with contextlib.closing(sqlite3.connect(database)) as db:
                        db.execute('INSERT INTO visits VALUES(2)')
                        db.commit()
            def healthy(self, *_args): return next(self.outcomes)
        self.System = FakeSystem

    def test_failed_release_restores_code_but_preserves_new_database_writes(self):
        system = self.System([False, True])
        with self.assertRaisesRegex(RejectedRelease, 'previous code restored'):
            update.activate(self.candidate,self.manifest,12,{},system,root=self.root,state_dir=self.state_dir,database=self.database,backups=self.backups)
        self.assertEqual((self.root/'current').resolve(), self.previous)
        with contextlib.closing(sqlite3.connect(self.database)) as db: self.assertEqual(db.execute('SELECT id FROM visits').fetchall(), [(1,), (2,)])
        backups = list(self.backups.glob('*.sqlite'))
        self.assertEqual(len(backups), 1)
        with contextlib.closing(sqlite3.connect(backups[0])) as db: self.assertEqual(db.execute('SELECT id FROM visits').fetchall(), [(1,)])
        self.assertEqual(update.read_state(self.state_dir)['failedReleaseId'], 12)
        self.assertNotIn('pending', update.read_state(self.state_dir))

    def test_success_records_commit_and_keeps_previous_release(self):
        state = update.activate(self.candidate,self.manifest,12,{},self.System([True]),root=self.root,state_dir=self.state_dir,database=self.database,backups=self.backups)
        self.assertEqual((self.root/'current').resolve(), self.candidate)
        self.assertTrue(self.previous.is_dir())
        self.assertEqual(state['activeCommit'], COMMIT)

    def test_database_schema_change_prevents_switch(self):
        with contextlib.closing(sqlite3.connect(self.database)) as db: db.execute('PRAGMA user_version=3')
        with self.assertRaisesRegex(RejectedRelease, 'schema'):
            update.activate(self.candidate,self.manifest,12,{},self.System([]),root=self.root,state_dir=self.state_dir,database=self.database,backups=self.backups)
        self.assertEqual((self.root/'current').resolve(), self.previous)
        self.assertFalse(self.backups.exists())

    def test_interrupted_switch_is_recovered_from_pending_journal(self):
        update.switch_link(self.candidate,self.root)
        state = {'pending':{'previous':str(self.previous),'candidate':str(self.candidate),'releaseId':12}}
        result = update.recover_pending(state,self.System([True]),self.root,self.state_dir,self.database)
        self.assertEqual((self.root/'current').resolve(), self.previous)
        self.assertTrue(result['rollbackHealthy'])
        self.assertEqual(result['failedReleaseId'], 12)

    def test_future_schema_stops_automatic_recovery_without_opening_old_code(self):
        update.switch_link(self.candidate,self.root)
        with contextlib.closing(sqlite3.connect(self.database)) as db: db.execute('PRAGMA user_version=3')
        state = {'pending':{'previous':str(self.previous),'candidate':str(self.candidate),'releaseId':12}}
        system = self.System([])
        with self.assertRaisesRegex(RejectedRelease,'Unexpected database schema'):
            update.recover_pending(state,system,self.root,self.state_dir,self.database)
        self.assertEqual(system.starts,0)
        self.assertEqual(system.stops,1)
        self.assertIn('pending',state)
        self.assertEqual(update.database_schema(self.database),3)


if __name__ == '__main__': unittest.main()
