import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseInfo } from '../server/release-info.mjs';
import { createApplication } from '../server/application.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/database.mjs';

test('release metadata exposes only validated public build identity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'svoi-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'version.json');
  assert.deepEqual(readReleaseInfo(file), { commit: null, repository: null, builtAt: null });
  const release = { app: 'svoi-telegram', repository: 'example/svoi', commit: 'a'.repeat(40), builtAt: '2026-11-12T00:00:00Z', databaseSchema: 2, ignoredPrivateValue: 'never-return' };
  writeFileSync(file, JSON.stringify(release));
  assert.deepEqual(readReleaseInfo(file), { repository: release.repository, commit: release.commit, builtAt: release.builtAt });
  writeFileSync(file, JSON.stringify({ ...release, commit: 'main' }));
  assert.throws(() => readReleaseInfo(file), /Invalid release metadata/);
  writeFileSync(file, JSON.stringify({ ...release, databaseSchema: 3 }));
  assert.throws(() => readReleaseInfo(file), /Invalid release metadata/);
});

test('opening a future database schema fails before DDL and preserves its version and data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'svoi-future-schema-'));
  let after;
  t.after(() => { after?.close(); rmSync(directory, { recursive: true, force: true }); });
  const file = join(directory, 'future.sqlite');
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA user_version=3; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep me');");
  seed.close();
  assert.throws(() => new Store(file), /Unsupported database schema/);
  after = new DatabaseSync(file);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(after.prepare('SELECT value FROM future_data').get().value, 'keep me');
  assert.equal(after.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='app_state'").get().total, 0);
});

test('health reads actual database schema and does not require guest authentication', async t => {
  const app = createApplication({ dataPath: ':memory:', rateLimits: false });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.databaseSchema, 2);
  assert.equal(body.database, 'ready');
  assert.deepEqual(body.release, { commit: null, repository: null, builtAt: null });
  app.store.sql.exec('PRAGMA user_version=3');
  const actual = await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`).then(r => r.json());
  assert.equal(actual.databaseSchema, 3);
});
