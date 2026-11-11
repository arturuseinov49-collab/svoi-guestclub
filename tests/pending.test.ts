import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PendingOperations, PendingStorage, commandFingerprint } from '../src/pending';

function browserSession() {
  const values = new Map<string, string>();
  const storage: PendingStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  return { values, storage, reload: () => new PendingOperations(() => storage) };
}
const award = { type: 'awardBonus', venueId: 'private-venue', guestId: 'private-guest', amount: 150, reason: 'Спасибо за визиты' };

test('operation fingerprint matches JSON request semantics, including reordered nested fields', async () => {
  const first = { type: 'updateProgram', venueId: 'venue-a', program: { cashback: 5, everyVisits: 5, visitBonus: 100, tipsBonus: 25 }, omitted: undefined };
  const reordered = { program: { tipsBonus: 25, visitBonus: 100, everyVisits: 5, cashback: 5 }, venueId: 'venue-a', type: 'updateProgram' };
  const fingerprint = await commandFingerprint(101, first);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, await commandFingerprint(101, reordered));
  assert.notEqual(fingerprint, await commandFingerprint(102, reordered), 'another Telegram account must have a separate operation');
  assert.notEqual(fingerprint, await commandFingerprint(101, { ...first, program: { ...first.program, cashback: 6 } }), 'changing nested program data is a new command');
  assert.equal(await commandFingerprint(101, { values: [undefined, NaN, Infinity], optional: undefined }), await commandFingerprint(101, { values: [null, null, null] }));
  assert.notEqual(await commandFingerprint(101, { values: [1, 2] }), await commandFingerprint(101, { values: [2, 1] }));
});

test('an uncertain write keeps its original request ID after form replacement and WebView reload', async () => {
  const browser = browserSession(); const firstKey = randomUUID();
  const first = await browser.reload().acquire(201, award, firstKey);
  // The form and registry are both recreated; only the browser session remains.
  const afterReload = await browser.reload().acquire(201, { reason: award.reason, amount: 150, guestId: award.guestId, venueId: award.venueId, type: award.type }, randomUUID());
  assert.equal(afterReload.key, firstKey); assert.equal(afterReload.fingerprint, first.fingerprint);
  const changed = await browser.reload().acquire(201, { ...award, amount: 151 }, randomUUID());
  assert.notEqual(changed.key, firstKey);
  const secondAccountKey = randomUUID(); const secondAccount = await browser.reload().acquire(202, award, secondAccountKey);
  assert.equal(secondAccount.key, secondAccountKey); assert.notEqual(secondAccount.fingerprint, first.fingerprint);
  assert.equal((await browser.reload().acquire(201, award, randomUUID())).key, firstKey, 'switching accounts must not discard the first account pending operation');
});

test('session persistence contains hashes and request IDs, with no command data or credentials', async () => {
  const browser = browserSession(); const key = randomUUID();
  const privateInput = { ...award, guestId: 'guest-secret-12345678', reason: 'Секретный комментарий гостя', phone: '+79991234567', token: 'secret-session-token-never-persist', initData: 'secret-telegram-initdata-never-persist' };
  await browser.reload().acquire(301, privateInput, key);
  const saved = JSON.stringify([...browser.values]);
  for (const forbidden of ['awardBonus', 'guest-secret-12345678', 'Секретный комментарий гостя', '+79991234567', 'secret-session-token-never-persist', 'secret-telegram-initdata-never-persist', 'reason', 'guestId', 'initData']) assert.equal(saved.includes(forbidden), false, `${forbidden} leaked into session storage`);
  assert.equal(browser.values.size, 1);
  const record = JSON.parse([...browser.values.values()][0]) as Record<string, string>;
  assert.equal(Object.keys(record).length, 1); assert.match(Object.keys(record)[0], /^[a-f0-9]{64}$/); assert.deepEqual(Object.values(record), [key]);
});

test('confirmed completion releases only that operation and permits a later deliberate identical action', async () => {
  const browser = browserSession(); const registry = browser.reload();
  const completed = await registry.acquire(401, award, randomUUID());
  const stillPending = await registry.acquire(401, { ...award, amount: 200 }, randomUUID());
  const anotherAccount = await registry.acquire(402, award, randomUUID());
  registry.resolve(401, completed.fingerprint);
  const nextKey = randomUUID(); assert.equal((await browser.reload().acquire(401, award, nextKey)).key, nextKey);
  assert.equal((await browser.reload().acquire(401, { ...award, amount: 200 }, randomUUID())).key, stillPending.key);
  assert.equal((await browser.reload().acquire(402, award, randomUUID())).key, anotherAccount.key);
  const finalRegistry = browser.reload();
  finalRegistry.resolve(401, completed.fingerprint);
  finalRegistry.resolve(401, stillPending.fingerprint);
  assert.equal(browser.values.has('svoi.pending.v1.401'), false);
  assert.equal((await browser.reload().acquire(402, award, randomUUID())).key, anotherAccount.key);
});

test('corrupted persisted operations block new requests and preserve evidence for reconciliation', async () => {
  const fingerprint = await commandFingerprint(501, award);
  const invalid = ['broken JSON', 'null', '[]', '{"bad-fingerprint":"valid-request-key-12345"}', JSON.stringify({ [fingerprint]: 42 }), JSON.stringify({ [fingerprint]: 'short' }), JSON.stringify({ [fingerprint]: 'key with spaces is not valid' })];
  for (const raw of invalid) {
    const browser = browserSession(); browser.values.set('svoi.pending.v1.501', raw);
    await assert.rejects(browser.reload().acquire(501, award, randomUUID()), /Новый запрос не отправлен/);
    assert.equal(browser.values.get('svoi.pending.v1.501'), raw, 'corruption must not be silently reset');
  }
});

test('1000 unresolved operations allow retries but reject new writes without evicting old keys', async () => {
  const browser = browserSession(); const existingFingerprint = await commandFingerprint(601, award); const originalKey = randomUUID();
  const entries = Object.fromEntries(Array.from({ length: 999 }, (_, i) => [i.toString(16).padStart(64, '0'), randomUUID()]));
  entries[existingFingerprint] = originalKey;
  const original = JSON.stringify(entries); browser.values.set('svoi.pending.v1.601', original);
  const registry = browser.reload();
  assert.equal((await registry.acquire(601, award, randomUUID())).key, originalKey, 'retry of an existing uncertain write remains possible at capacity');
  const newOperation = { ...award, amount: 999 };
  await assert.rejects(registry.acquire(601, newOperation, randomUUID()), /Слишком много неподтверждённых операций/);
  assert.equal(browser.values.get('svoi.pending.v1.601'), original);
  registry.resolve(601, existingFingerprint);
  const newKey = randomUUID(); assert.equal((await registry.acquire(601, newOperation, newKey)).key, newKey);
  const saved = JSON.parse(browser.values.get('svoi.pending.v1.601')!) as Record<string, string>;
  assert.equal(Object.keys(saved).length, 1000); assert.equal(saved[existingFingerprint], undefined);
  for (let i = 0; i < 999; i++) assert.equal(saved[i.toString(16).padStart(64, '0')], entries[i.toString(16).padStart(64, '0')]);
});

test('unreadable or unavailable browser storage blocks acquiring a new operation key', async () => {
  let writes = 0;
  const denied: PendingStorage = { getItem: () => { throw new Error('Storage access denied'); }, setItem: () => { writes++; }, removeItem: () => {} };
  await assert.rejects(new PendingOperations(() => denied).acquire(701, award, randomUUID()));
  await assert.rejects(new PendingOperations(() => undefined).acquire(701, award, randomUUID()));
  assert.equal(writes, 0, 'a failed registry read must never overwrite unknown pending operations');
});

test('failed persistence blocks a new key and failed cleanup retains the previously persisted retry key', async () => {
  const browser = browserSession(); let failWrite = true; let failRemove = false;
  const storage: PendingStorage = {
    getItem: key => browser.storage.getItem(key),
    setItem: (key, value) => { if (failWrite) throw new Error('Storage quota exceeded'); browser.storage.setItem(key, value); },
    removeItem: key => { if (failRemove) throw new Error('Storage access denied'); browser.storage.removeItem(key); },
  };
  const registry = new PendingOperations(() => storage);
  await assert.rejects(registry.acquire(702, award, randomUUID()));
  assert.equal(browser.values.size, 0, 'no key was durably registered');
  // Recovery must acquire and persist the actual proposed key, not reuse an earlier unsaved one.
  failWrite = false; const key = randomUUID(); const operation = await registry.acquire(702, award, key);
  assert.equal(operation.key, key); assert.equal(browser.values.size, 1);
  const beforeCleanup = [...browser.values.values()][0]; failRemove = true;
  assert.throws(() => registry.resolve(702, operation.fingerprint));
  assert.equal([...browser.values.values()][0], beforeCleanup);
  assert.equal((await new PendingOperations(() => storage).acquire(702, award, randomUUID())).key, key, 'a reload must retain the confirmed operation retry key after failed cleanup');
  assert.equal((await registry.acquire(702, award, randomUUID())).key, key, 'the current view must also retain the key after failed cleanup');
});
