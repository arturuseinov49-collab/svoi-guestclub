import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ApiError } from '../server/database.mjs';
import { defaultGuestProfile } from '../server/venue-profile.mjs';

function fixture(t, { durable = false } = {}) {
  const dir = durable ? mkdtempSync(join(tmpdir(), 'svoi-feedback-')) : null;
  const path = dir ? join(dir, 'test.sqlite') : ':memory:';
  let time = Date.parse('2026-11-13T10:00:00Z');
  let store = new Store(path, { clock: () => time, developerIds: [900000001] });
  const login = id => store.login({ id, firstName: `Тест ${id}`, lastName: '', username: null });
  const developer = login(900000001); const owner = login(1); const staff = login(2); const guest = login(3);
  const otherGuest = login(4); const foreign = login(5); const outsider = login(6);
  const command = (user, type, fields = {}, key = randomUUID()) => store.command(user.user.id, { type, idempotencyKey: key, ...fields });
  const venueId = command(developer, 'createVenue', { name: 'Анкеты кафе', kind: 'Кафе', address: 'Адрес 1' }).result.venueId;
  const foreignVenueId = command(developer, 'createVenue', { name: 'Другое кафе', kind: 'Кафе', address: 'Адрес 2' }).result.venueId;
  for (const [venue, user, role] of [[venueId, owner, 'owner'], [venueId, staff, 'staff'], [foreignVenueId, foreign, 'owner']]) store.sql.prepare('INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,?)').run(venue, user.user.id, role);
  for (const user of [guest, otherGuest]) command(staff, 'addGuest', { venueId, guestCode: user.guestCode });
  for (const user of [guest, staff]) command(foreign, 'addGuest', { venueId: foreignVenueId, guestCode: user.guestCode });
  const db = store.read();
  for (const venue of db.venues) venue.guestProfile = { ...defaultGuestProfile(), published: true, demo: true, feedbackEnabled: true, features: { visits: false, reviews: false, loyalty: false } };
  db.memberships[0].balance = 127;
  db.visits.push({ id: 'historical-visit', venueId, guestId: guest.guestId, createdAt: '2026-11-10T10:00:00Z', bill: 900, tips: 100, rating: 4 });
  db.reviews.push({ id: 'historical-review', visitId: 'historical-visit', venueId, guestId: guest.guestId, createdAt: '2026-11-10T10:01:00Z', text: 'Старый закрытый отзыв', rating: 5 });
  db.transactions.push({ id: 'historical-bonus', venueId, guestId: guest.guestId, amount: 127, reason: 'Историческая операция', createdAt: '2026-11-10T10:00:00Z' });
  db.globalLedger = [{ id: 'historical-leaves', venueId, guestId: guest.guestId, provider: 'iiko', connectionId: 'old', externalId: 'old-receipt', billMinor: 70000, delta: 7, createdAt: '2026-11-10T10:00:00Z' }];
  store.write(db);
  const record = (fields = {}, user = staff, key) => command(user, 'recordFeedbackVisit', { venueId, guestId: guest.guestId, preferences: ['Неострые блюда', 'Тихое место'], experience: 'pleasant', comment: 'Внутренний комментарий команды', ...fields }, key);
  const answers = { food: 'liked', service: 'liked', atmosphere: 'not_used', cleanliness: 'liked', value: 'disliked' };
  const submit = (visitId, fields = {}, user = guest, key) => command(user, 'submitGuestFeedback', { venueId, visitId, answers, comment: 'Комментарий гостя', ...fields }, key);
  const snapshot = (user = guest) => store.snapshot(user.user.id);
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, developer, owner, staff, guest, otherGuest, foreign, outsider, venueId, foreignVenueId, command, record, submit, answers, snapshot,
    advance(ms) { time += ms; }, restart() { store.close(); store = new Store(path, { clock: () => time, developerIds: [900000001] }); } };
}
const denied = (fn, status) => assert.throws(fn, error => error instanceof ApiError && error.status === status);
const financial = db => Object.fromEntries(['memberships', 'visits', 'transactions', 'globalLedger', 'posEvents'].map(key => [key, db[key]]));

test('feedback-only visit and staff questionnaire commit together, independently of retired demo/loyalty flags and balances', t => {
  const f = fixture(t); const before = f.store.read(); const tables = f.store.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const { result } = f.record(); const db = f.store.read();
  assert.equal(db.feedbackVisits.length, 1); assert.equal(db.staffFeedback.length, 1);
  assert.equal(db.feedbackVisits[0].id, result.visitId); assert.equal(db.staffFeedback[0].visitId, result.visitId);
  assert.equal(db.staffFeedback[0].staffUserId, f.staff.user.id); assert.equal(db.staffFeedback[0].id, result.feedbackId);
  assert.deepEqual(financial(db), financial(before)); assert.deepEqual(db.reviews, before.reviews);
  assert.equal(f.snapshot().productMode, 'feedback'); assert.equal(f.snapshot().globalWallet.balance, 7);
  assert.deepEqual(f.store.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
  assert.equal(f.store.sql.prepare('PRAGMA user_version').get().user_version, 2);
});

test('guest identity never exposes private staff feedback; current staff see only their venue even when visiting elsewhere', t => {
  const f = fixture(t); const own = f.record().result.visitId;
  f.record({ venueId: f.foreignVenueId, guestId: f.staff.guestId, preferences: ['Не торопить'], comment: 'Чужая внутренняя заметка' }, f.foreign);
  f.submit(own);
  for (const user of [f.guest, f.otherGuest, f.outsider, f.developer]) assert.deepEqual(f.snapshot(user).db.staffFeedback, []);
  assert.equal(f.snapshot().db.feedbackVisits.length, 1); assert.equal(Object.hasOwn(f.snapshot().db.feedbackVisits[0], 'staffUserId'), false);
  assert.equal(f.snapshot().db.guestFeedback.length, 1); assert.equal(f.snapshot(f.otherGuest).db.guestFeedback.length, 0);
  const staff = f.snapshot(f.staff);
  assert.equal(staff.db.staffFeedback.length, 1); assert.equal(staff.db.staffFeedback[0].venueId, f.venueId);
  assert.equal(staff.db.feedbackVisits.length, 2); assert.equal(staff.db.feedbackVisits.find(item => item.venueId === f.foreignVenueId).staffUserId, undefined);
  assert.equal(JSON.stringify(staff).includes('Чужая внутренняя заметка'), false);
  assert.equal(f.snapshot(f.foreign).db.staffFeedback.length, 1); assert.equal(f.snapshot(f.foreign).db.staffFeedback[0].venueId, f.foreignVenueId);
  assert.equal(f.snapshot(f.otherGuest).db.reviews.length, 0); assert.equal(f.snapshot(f.outsider).db.reviews.length, 0);
});

test('staff, venue and own-visit authorization reject forged identities and another guest or historical visit', t => {
  const f = fixture(t); const visitId = f.record().result.visitId;
  for (const user of [f.guest, f.otherGuest, f.foreign, f.developer]) denied(() => f.record({}, user), 403);
  denied(() => f.record({ guestId: f.outsider.guestId }), 404);
  denied(() => f.record({ venueId: f.foreignVenueId }), 403);
  for (const user of [f.otherGuest, f.staff, f.owner, f.developer]) denied(() => f.submit(visitId, {}, user), 404);
  denied(() => f.submit(visitId, { venueId: f.foreignVenueId }), 404);
  denied(() => f.submit('historical-visit'), 404);
  denied(() => f.submit(visitId, { guestId: f.otherGuest.guestId }), 400);
  denied(() => f.record({ staffUserId: f.owner.user.id }), 400);
  assert.equal(f.store.read().feedbackVisits.length, 1); assert.equal(f.store.read().guestFeedback, undefined);
});

test('questionnaire validation is strict, fixed preferences only, all answers required, bounded text, no silent extra fields', t => {
  const f = fixture(t); const before = f.store.read();
  for (const fields of [{ preferences: ['Неизвестная черта'] }, { preferences: ['Тихое место', 'Тихое место'] }, { preferences: 'Тихое место' }, { experience: 'bad_guest' }, { experience: null }, { comment: 'x'.repeat(1001) }, { comment: 'bad\u0000text' }, { preferences: new Array(9).fill('Тихое место') }, { bill: 900 }]) denied(() => f.record(fields), 400);
  assert.deepEqual(f.store.read(), before);
  const visitId = f.record({ preferences: [], experience: 'neutral', comment: '' }).result.visitId;
  const missing = { ...f.answers }; delete missing.value;
  for (const fields of [{ answers: missing }, { answers: { ...f.answers, food: 'great' } }, { answers: { ...f.answers, waitTime: 'liked' } }, { answers: [] }, { comment: 'x'.repeat(1001) }, { response: 'forged' }]) denied(() => f.submit(visitId, fields), 400);
  const valid = f.submit(visitId, { comment: '  Еда понравилась.\nСпасибо!  ' });
  assert.equal(valid.db.guestFeedback[0].comment, 'Еда понравилась.\nСпасибо!');
  assert.equal(valid.db.guestFeedback[0].response, null);
});

test('lost response replay survives restart without duplicate visit or feedback; another key cannot submit a second guest questionnaire', t => {
  const f = fixture(t, { durable: true }); const visitKey = randomUUID(); const guestKey = randomUUID();
  const first = f.record({ previousVisitId: null }, f.staff, visitKey).result;
  f.restart(); assert.deepEqual(f.record({ previousVisitId: null }, f.staff, visitKey).result, first);
  const submitted = f.submit(first.visitId, {}, f.guest, guestKey).result;
  f.restart(); assert.deepEqual(f.submit(first.visitId, {}, f.guest, guestKey).result, submitted);
  denied(() => f.submit(first.visitId), 409);
  denied(() => f.record({ previousVisitId: null }, f.staff), 409);
  const second = f.record({ previousVisitId: first.visitId }).result;
  assert.notEqual(second.visitId, first.visitId);
  assert.deepEqual(f.record({ previousVisitId: null }, f.staff, visitKey).result, first);
  assert.equal(f.store.read().feedbackVisits.length, 2); assert.equal(f.store.read().staffFeedback.length, 2); assert.equal(f.store.read().guestFeedback.length, 1);
});

test('current access is rechecked on record and reply replay after staff revocation; guest author retains own feedback', t => {
  const f = fixture(t); const key = randomUUID(); const first = f.record({}, f.staff, key).result;
  const feedbackId = f.submit(first.visitId).result.feedbackId; const replyKey = randomUUID();
  const reply = { venueId: f.venueId, feedbackId, response: 'Спасибо, учтём замечания.' };
  f.command(f.staff, 'replyGuestFeedback', reply, replyKey);
  f.command(f.owner, 'revokeStaff', { venueId: f.venueId, userId: f.staff.user.id });
  denied(() => f.record({}, f.staff, key), 403);
  denied(() => f.command(f.staff, 'replyGuestFeedback', reply, replyKey), 403);
  assert.deepEqual(f.snapshot(f.staff).db.staffFeedback, []);
  assert.equal(f.snapshot().db.guestFeedback[0].response, reply.response);
  assert.equal(Object.hasOwn(f.snapshot().db.guestFeedback[0], 'respondedBy'), false);
});

test('only current venue team can reply and repeated keys do not overwrite a later response', t => {
  const f = fixture(t); const feedbackId = f.submit(f.record().result.visitId).result.feedbackId;
  const payload = { venueId: f.venueId, feedbackId, response: 'Первый ответ' }; const key = randomUUID();
  for (const user of [f.guest, f.otherGuest, f.foreign, f.developer]) denied(() => f.command(user, 'replyGuestFeedback', payload), 403);
  denied(() => f.command(f.staff, 'replyGuestFeedback', { ...payload, venueId: f.foreignVenueId }), 403);
  denied(() => f.command(f.staff, 'replyGuestFeedback', { ...payload, response: ' ' }), 400);
  denied(() => f.command(f.staff, 'replyGuestFeedback', { ...payload, response: 'x'.repeat(1001) }), 400);
  f.command(f.staff, 'replyGuestFeedback', payload, key);
  f.advance(1000); f.command(f.owner, 'replyGuestFeedback', { ...payload, response: 'Обновлённый ответ' });
  f.command(f.staff, 'replyGuestFeedback', payload, key);
  assert.equal(f.snapshot().db.guestFeedback[0].response, 'Обновлённый ответ');
  assert.equal(f.snapshot(f.otherGuest).db.guestFeedback.length, 0);
});

test('disabled feedback prevents new records and submissions, preserves history and permits a team reply', t => {
  const f = fixture(t); const first = f.record().result.visitId; const second = f.record().result.visitId;
  const feedbackId = f.submit(first).result.feedbackId;
  const db = f.store.read(); db.venues.find(item => item.id === f.venueId).guestProfile.feedbackEnabled = false; f.store.write(db);
  denied(() => f.record(), 409); denied(() => f.submit(second), 409);
  f.command(f.staff, 'replyGuestFeedback', { venueId: f.venueId, feedbackId, response: 'Ответ на сохранённый отзыв' });
  assert.equal(f.snapshot().db.feedbackVisits.length, 2); assert.equal(f.snapshot().db.guestFeedback.length, 1);
  delete db.venues.find(item => item.id === f.venueId).guestProfile.feedbackEnabled;
  db.venues.find(item => item.id === f.venueId).guestProfile.published = false; f.store.write(db);
  denied(() => f.record(), 409);
});

test('a failure after state write rolls back visit, private questionnaire, audit and idempotency receipt atomically', t => {
  const f = fixture(t); const before = f.store.read(); const audit = f.store.sql.prepare('SELECT COUNT(*) n FROM audit').get().n;
  const key = randomUUID(); const write = f.store.write;
  f.store.write = function (db) { write.call(this, db); throw new Error('simulated interrupted commit'); };
  assert.throws(() => f.record({}, f.staff, key), /simulated interrupted commit/);
  f.store.write = write;
  assert.deepEqual(f.store.read(), before); assert.equal(f.store.sql.prepare('SELECT COUNT(*) n FROM audit').get().n, audit);
  assert.equal(f.store.sql.prepare('SELECT 1 FROM command_receipts WHERE command_key=?').get(key), undefined);
  f.record({}, f.staff, key); assert.equal(f.store.read().feedbackVisits.length, 1);
});

test('same confirmed visit cannot receive two questionnaires under distinct concurrent keys', async t => {
  const f = fixture(t); const visitId = f.record().result.visitId;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => f.submit(visitId))));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected' && item.reason.status === 409).length, 7);
  assert.equal(f.store.read().guestFeedback.length, 1);
});

test('replay normalizes accepted identifier whitespace consistently without weakening identity authorization', t => {
  const f = fixture(t); const visitKey = randomUUID(); const guestKey = randomUUID(); const replyKey = randomUUID();
  const fields = { venueId: ` ${f.venueId} `, guestId: ` ${f.guest.guestId} ` };
  const visitId = f.record(fields, f.staff, visitKey).result.visitId;
  assert.equal(f.record(fields, f.staff, visitKey).replayed, true);
  const guestFields = { venueId: ` ${f.venueId} `, visitId: ` ${visitId} ` };
  const feedbackId = f.submit(visitId, guestFields, f.guest, guestKey).result.feedbackId;
  assert.equal(f.submit(visitId, guestFields, f.guest, guestKey).replayed, true);
  const reply = { venueId: ` ${f.venueId} `, feedbackId: ` ${feedbackId} `, response: 'Спасибо' };
  f.command(f.staff, 'replyGuestFeedback', reply, replyKey);
  assert.equal(f.command(f.staff, 'replyGuestFeedback', reply, replyKey).replayed, true);
  assert.equal(f.store.read().feedbackVisits.length, 1); assert.equal(f.store.read().guestFeedback.length, 1);
});
