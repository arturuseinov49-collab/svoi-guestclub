import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/application.mjs';
import { defaultGuestProfile } from '../server/venue-profile.mjs';

const botToken = '123456:TEST-ONLY-token-never-valid-in-Telegram';
function signed(id, now = Date.now(), extra = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), query_id: randomUUID(), user: JSON.stringify({ id, first_name: `Гость ${id}`, last_name: 'Тестовый', ...extra }) });
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', key).update(check).digest('hex')); return params.toString();
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'svoi-server-test-'));
  const path = join(directory, 'test.sqlite'); let app; let origin;
  async function start() {
    app = createApplication({ dataPath: path, botToken, rateLimits: false, developerIds: [900000001], ...options });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, { token, data, method = data ? 'POST' : 'GET', headers = {} } = {}) {
    const response = await fetch(origin + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function login(id, now, extra) { const response = await request('/api/session', { data: { initData: signed(id, now, extra) } }); assert.equal(response.status, 200); return response.body; }
  const command = (user, type, fields = {}, key = randomUUID()) => request('/api/commands', { token: user.token, data: { type, idempotencyKey: key, ...fields } });
  const state = user => request('/api/state', { token: user.token });
  const venue = async (user, suffix = '') => { const developer = await login(900000001); const response = await command(developer, 'createVenue', { name: `Кафе ${suffix || user.user.id}`, kind: 'Кафе', address: 'Тестовый адрес, 10' }); assert.equal(response.status, 200); app.store.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner')").run(response.body.result.venueId, user.user.id); const db = app.store.read(); db.venues.find(v => v.id === response.body.result.venueId).guestProfile = { ...defaultGuestProfile(), feedbackEnabled: true }; app.store.write(db); return response.body.result; };
  return { request, login, command, state, venue, restart: async () => { await app.close(); await start(); }, get app() { return app; } };
}

test('Telegram signatures, freshness, origin and bearer session are enforced', async t => {
  const f = await fixture(t); const data = signed(1);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/session', { data: { initData: data.replace('Гость', 'Подмена') + 'bad' } })).status, 401);
  assert.equal((await f.request('/api/session', { data: { initData: signed(1, Date.now() - 3700_000) } })).status, 401);
  assert.equal((await f.request('/api/session', { data: { initData: signed(1, Date.now() + 120_000) } })).status, 401);
  assert.equal((await f.request('/api/session', { data: { initData: data + '&auth_date=42' } })).status, 401);
  assert.equal((await f.request('/api/session', { data: { initData: data }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/session', { data: { initData: signed(1, undefined, { id: -1 }) } })).status, 401);
  const user = await f.login(1); assert.equal(user.db.venues.length, 0); assert.equal(user.db.guests.length, 1); assert.deepEqual(user.staffVenues, []);
  assert.equal((await f.request('/api/session', { token: user.token, method: 'DELETE' })).status, 200);
  assert.equal((await f.state(user)).status, 401);
});

test('venue-scoped staff feedback is private even when the employee is a guest elsewhere', async t => {
  const f = await fixture(t); const a = await f.login(10); const b = await f.login(11); const guest = await f.login(12); const stranger = await f.login(13);
  const va = await f.venue(a); const vb = await f.venue(b);
  for (const v of [va, vb]) await f.command(guest, 'joinVenue', { code: v.joinCode });
  const fields = { guestId: guest.guestId, previousVisitId: null, preferences: ['Тихое место'], experience: 'pleasant', comment: 'Только для нашей команды' };
  assert.equal((await f.command(a, 'recordFeedbackVisit', { venueId: va.venueId, ...fields })).status, 200);
  assert.equal((await f.command(b, 'recordFeedbackVisit', { venueId: vb.venueId, ...fields })).status, 200);
  const g = (await f.state(guest)).body; assert.equal(g.productMode, 'feedback'); assert.equal(g.db.feedbackVisits.length, 2); assert.deepEqual(g.db.staffFeedback, []);
  assert.ok(g.db.feedbackVisits.every(v => !('staffUserId' in v))); assert.ok(g.db.venues.every(v => !('joinCode' in v)));
  const sa = (await f.state(a)).body; assert.equal(sa.db.staffFeedback.length, 1); assert.equal(sa.db.staffFeedback[0].venueId, va.venueId);
  assert.equal((await f.command(a, 'recordFeedbackVisit', { venueId: vb.venueId, ...fields })).status, 403);
  assert.equal((await f.command(guest, 'recordFeedbackVisit', { venueId: va.venueId, ...fields })).status, 403);
  assert.deepEqual((await f.state(stranger)).body.db.feedbackVisits, []);
});

test('same Telegram identity shares account between independent sessions and server restarts', async t => {
  const f = await fixture(t); const first = await f.login(20); const second = await f.login(20);
  assert.notEqual(first.token, second.token); assert.equal(first.guestId, second.guestId); assert.equal(first.guestCode, second.guestCode);
  const venue = await f.venue(first); assert.equal((await f.state(second)).body.db.venues[0].id, venue.venueId);
  await f.restart(); assert.equal((await f.state(second)).body.db.venues[0].id, venue.venueId);
  const third = await f.login(20); assert.equal(third.guestCode, first.guestCode); assert.equal(third.staffVenues[0].role, 'owner');
});

test('staff invitations are owner-only, expiring and single-use; revocation immediately removes access', async t => {
  let now = Date.now(); const f = await fixture(t, { clock: () => now }); const owner = await f.login(30, now); const staff = await f.login(31, now); const intruder = await f.login(32, now); const venue = await f.venue(owner);
  assert.equal((await f.command(staff, 'createStaffInvite', { venueId: venue.venueId })).status, 403);
  const invite = (await f.command(owner, 'createStaffInvite', { venueId: venue.venueId })).body.result;
  assert.equal((await f.command(staff, 'acceptStaffInvite', { code: invite.code })).status, 200);
  assert.equal((await f.command(intruder, 'acceptStaffInvite', { code: invite.code })).status, 400);
  assert.equal((await f.command(staff, 'createStaffInvite', { venueId: venue.venueId })).status, 403);
  assert.equal((await f.command(owner, 'listStaff', { venueId: venue.venueId })).body.result.members.length, 2);
  const op = { venueId: venue.venueId, guestCode: intruder.guestCode }; const key = randomUUID(); assert.equal((await f.command(staff, 'addGuest', op, key)).status, 200);
  assert.equal((await f.command(owner, 'revokeStaff', { venueId: venue.venueId, userId: staff.user.id })).status, 200);
  assert.equal((await f.state(staff)).body.db.venues.length, 0);
  assert.equal((await f.command(staff, 'addGuest', op, key)).status, 403);
  assert.equal((await f.command(owner, 'revokeStaff', { venueId: venue.venueId, userId: owner.user.id })).status, 400);
  const expired = (await f.command(owner, 'createStaffInvite', { venueId: venue.venueId })).body.result;
  now += 24 * 60 * 60 * 1000 + 1; const fresh = await f.login(32, now);
  assert.equal((await f.command(fresh, 'acceptStaffInvite', { code: expired.code })).status, 400);
  assert.equal((await f.state(owner)).status, 401);
});

test('concurrent visit confirmation is atomic, idempotent and creates no financial entries', async t => {
  const f = await fixture(t); const owner = await f.login(40); const guest = await f.login(41); const venue = await f.venue(owner);
  await f.command(owner, 'scanGuest', { venueId: venue.venueId, qr: guest.guestQr });
  const fields = { venueId: venue.venueId, guestId: guest.guestId, previousVisitId: null, preferences: [], experience: 'neutral', comment: '' }; const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.command(owner, 'recordFeedbackVisit', fields, key)));
  assert.ok(responses.every(r => r.status === 200), JSON.stringify(responses)); assert.equal(responses.filter(r => !r.body.replayed).length, 1);
  const state = (await f.state(guest)).body; assert.equal(state.db.feedbackVisits.length, 1); assert.equal(state.db.memberships[0].balance, 0); assert.deepEqual(state.db.transactions, []); assert.deepEqual(state.db.visits, []);
  assert.equal((await f.command(owner, 'recordFeedbackVisit', { ...fields, comment: 'Изменённая анкета' }, key)).status, 409);
  assert.equal((await f.command(owner, 'recordFeedbackVisit', fields)).status, 409);
  assert.equal(f.app.store.sql.prepare("SELECT COUNT(*) AS n FROM audit WHERE command='recordFeedbackVisit'").get().n, 1);
});

test('guest questionnaire belongs to a confirmed visit and author; responses reach only that author', async t => {
  const f = await fixture(t); const owner = await f.login(50); const guest = await f.login(51); const other = await f.login(52); const venue = await f.venue(owner);
  for (const g of [guest, other]) await f.command(owner, 'addGuest', { venueId: venue.venueId, guestCode: g.guestCode });
  const confirmed = await f.command(owner, 'recordFeedbackVisit', { venueId: venue.venueId, guestId: guest.guestId, previousVisitId: null, preferences: [], experience: 'neutral', comment: '' });
  assert.equal(confirmed.status, 200);
  const answers = { food: 'liked', service: 'disliked', atmosphere: 'liked', cleanliness: 'not_used', value: 'liked' };
  const input = { venueId: venue.venueId, visitId: confirmed.body.result.visitId, answers, comment: 'Долго ждали заказ' };
  assert.equal((await f.command(other, 'submitGuestFeedback', input)).status, 404);
  const result = await f.command(guest, 'submitGuestFeedback', input); assert.equal(result.status, 200);
  assert.equal(result.body.db.guestFeedback[0].guestId, guest.guestId);
  assert.equal((await f.command(guest, 'submitGuestFeedback', input)).status, 409);
  const reply = { venueId: venue.venueId, feedbackId: result.body.result.feedbackId, response: 'Спасибо, проверим время ожидания' };
  assert.equal((await f.command(other, 'replyGuestFeedback', reply)).status, 403);
  assert.equal((await f.command(owner, 'replyGuestFeedback', reply)).status, 200);
  assert.equal((await f.state(guest)).body.db.guestFeedback[0].response, reply.response);
  assert.deepEqual((await f.state(other)).body.db.guestFeedback, []);
  await f.restart(); assert.equal((await f.state(guest)).body.db.guestFeedback[0].response, reply.response);
});

test('retired financial and POS operations fail closed without changing data, even for managers', async t => {
  const f = await fixture(t); const owner = await f.login(60); const guest = await f.login(61); const venue = await f.venue(owner);
  await f.command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode });
  const before = f.app.store.read();
  for (const type of ['recordVisit', 'awardBonus', 'redeemReward', 'updateProgram', 'updateServiceFlow', 'startService', 'cancelService', 'configureServiceMapping', 'resolveServiceOrder', 'addReview', 'addNote']) {
    for (const alias of [type, ` ${type} `, `\t${type}\n`, `\u00a0${type}\u00a0`]) {
      assert.equal((await f.command(owner, alias, { venueId: venue.venueId, guestId: guest.guestId, bill: 100, tips: 0, rating: 5 })).status, 410, JSON.stringify(alias));
    }
  }
  assert.equal((await f.command(owner, 'replaceDatabase', { db: { memberships: [{ balance: 999999 }] } })).status, 400);
  assert.deepEqual(f.app.store.read(), before); assert.equal(f.app.pos, undefined);
});

test('session bearer values stay hashed at rest and malformed or excessive requests fail closed', async t => {
  const f = await fixture(t, { rateLimits: true }); const user = await f.login(70);
  const session = f.app.store.sql.prepare('SELECT token_hash FROM sessions').get();
  assert.match(session.token_hash, /^[a-f0-9]{64}$/); assert.notEqual(session.token_hash, user.token);
  assert.equal((await f.request('/api/state', { token: 'forged-token' })).status, 401);
  assert.equal((await f.request('/api/commands', { token: user.token, data: { type: 'createVenue', idempotencyKey: 'short' } })).status, 400);
  assert.equal((await f.request('/api/commands', { token: user.token, data: { text: 'a'.repeat(21000) } })).status, 413);
  assert.equal((await f.request('/api/session', { data: { initData: signed(70) }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  let response;
  for (let i = 0; i < 31; i++) response = await f.request('/api/session', { data: { initData: 'invalid' } });
  assert.equal(response.status, 429);
  assert.equal((await f.state(user)).status, 200);
});

test('malformed questionnaire rolls back and audit references the confirmed author and venue', async t => {
  const f = await fixture(t); const owner = await f.login(80); const guest = await f.login(81); const venue = await f.venue(owner);
  await f.command(guest, 'joinVenue', { code: venue.joinCode });
  const fields = { venueId: venue.venueId, guestId: guest.guestId, previousVisitId: null, preferences: [], experience: 'neutral', comment: '' };
  const before = f.app.store.read();
  for (const invalid of [{ preferences: ['Произвольная характеристика'] }, { experience: '__proto__' }, { comment: 'a'.repeat(1001) }]) {
    assert.equal((await f.command(owner, 'recordFeedbackVisit', { ...fields, ...invalid })).status, 400);
  }
  assert.deepEqual(f.app.store.read(), before);
  const result = await f.command(owner, 'recordFeedbackVisit', fields); assert.equal(result.status, 200);
  const row = f.app.store.sql.prepare("SELECT actor_id,venue_id,guest_id FROM audit WHERE command='recordFeedbackVisit'").get();
  assert.equal(row.actor_id, owner.user.id); assert.equal(row.venue_id, venue.venueId); assert.equal(row.guest_id, guest.guestId);
  for (const badId of [Number.MAX_SAFE_INTEGER + 10, {}, [], null]) assert.equal((await f.command(owner, 'revokeStaff', { venueId: venue.venueId, userId: badId })).status, 400);
});
