import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/application.mjs';

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
  const venue = async (user, suffix = '') => { const developer = await login(900000001); const response = await command(developer, 'createVenue', { name: `Кафе ${suffix || user.user.id}`, kind: 'Кафе', address: 'Тестовый адрес, 10' }); assert.equal(response.status, 200); app.store.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner')").run(response.body.result.venueId, user.user.id); return response.body.result; };
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

test('venue-scoped staff and own guest data are isolated in API, including internal notes and ratings', async t => {
  const f = await fixture(t); const a = await f.login(10); const b = await f.login(11); const guest = await f.login(12); const stranger = await f.login(13);
  const va = await f.venue(a); const vb = await f.venue(b);
  assert.equal((await f.command(guest, 'joinVenue', { code: va.joinCode })).status, 200);
  assert.equal((await f.command(guest, 'joinVenue', { code: vb.joinCode })).status, 200);
  assert.equal((await f.command(a, 'recordVisit', { venueId: va.venueId, guestId: guest.guestId, bill: 1000, tips: 100, rating: 4 })).status, 200);
  assert.equal((await f.command(b, 'recordVisit', { venueId: vb.venueId, guestId: guest.guestId, bill: 2000, tips: 0, rating: 2 })).status, 200);
  assert.equal((await f.command(a, 'addNote', { venueId: va.venueId, guestId: guest.guestId, text: 'Внутренняя заметка', kind: 'preference' })).status, 200);
  const g = (await f.state(guest)).body; assert.equal(g.db.guests.length, 1); assert.equal(g.db.notes.length, 0); assert.equal(g.db.visits.length, 2); assert.ok(g.db.visits.every(v => v.rating === null)); assert.ok(g.db.venues.every(v => !('joinCode' in v)));
  const sa = (await f.state(a)).body; assert.equal(sa.db.visits.length, 1); assert.equal(sa.db.notes.length, 1); assert.ok(sa.db.memberships.every(m => m.venueId === va.venueId)); assert.equal(sa.db.visits[0].rating, 4);
  assert.equal((await f.command(a, 'awardBonus', { venueId: vb.venueId, guestId: guest.guestId, amount: 100, reason: 'Попытка доступа' })).status, 403);
  for (const user of [guest, stranger]) assert.equal((await f.command(user, 'awardBonus', { venueId: va.venueId, guestId: guest.guestId, amount: 100, reason: 'Попытка доступа' })).status, 403);
  const ss = (await f.state(stranger)).body; assert.equal(ss.db.venues.length, 0); assert.equal(ss.db.guests.length, 1); assert.equal(ss.db.transactions.length, 0);
  assert.equal((await f.command(guest, 'redeemReward', { venueId: va.venueId, guestId: guest.guestId, rewardId: 'coffee' })).status, 403);
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
  assert.equal((await f.command(staff, 'updateProgram', { venueId: venue.venueId, program: { cashback: 30, everyVisits: 2, visitBonus: 1000, tipsBonus: 1000 } })).status, 403);
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

test('concurrent visits and redemption are atomic and duplicate request keys never double charge or credit', async t => {
  const f = await fixture(t); const owner = await f.login(40); const guest = await f.login(41); const venue = await f.venue(owner);
  await f.command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode });
  const fields = { venueId: venue.venueId, guestId: guest.guestId, bill: 1000, tips: 100, rating: 5 }; const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.command(owner, 'recordVisit', fields, key)));
  assert.ok(responses.every(r => r.status === 200)); assert.equal(responses.filter(r => !r.body.replayed).length, 1);
  let state = (await f.state(guest)).body; assert.equal(state.db.visits.length, 1); assert.equal(state.db.memberships[0].balance, 75);
  assert.equal((await f.command(owner, 'recordVisit', { ...fields, bill: 2000 }, key)).status, 409);
  await f.command(owner, 'awardBonus', { venueId: venue.venueId, guestId: guest.guestId, amount: 150, reason: 'К проверке списания' });
  const redeemKey = randomUUID(); const reward = { venueId: venue.venueId, guestId: guest.guestId, rewardId: 'coffee' };
  const rewards = await Promise.all(Array.from({ length: 5 }, () => f.command(owner, 'redeemReward', reward, redeemKey))); assert.ok(rewards.every(r => r.status === 200));
  state = (await f.state(guest)).body; assert.equal(state.db.memberships[0].balance, 75); assert.equal(state.db.transactions.filter(tx => tx.amount < 0).length, 1);
  await f.command(owner, 'awardBonus', { venueId: venue.venueId, guestId: guest.guestId, amount: 150, reason: 'Конкурирующее списание' });
  const unavailable = await Promise.all([f.command(owner, 'redeemReward', reward), f.command(owner, 'redeemReward', reward)]); assert.deepEqual(unavailable.map(r => r.status).sort(), [200, 400]);
  assert.equal((await f.state(guest)).body.db.memberships[0].balance, 75);
  const audit = f.app.store.sql.prepare('SELECT COUNT(*) AS n FROM audit WHERE command=?').get('recordVisit'); assert.equal(audit.n, 1);
});

test('reviews use authenticated identity and a real unreviewed visit; staff responses are scoped', async t => {
  const f = await fixture(t); const owner = await f.login(50); const guest = await f.login(51); const other = await f.login(52); const venue = await f.venue(owner);
  await f.command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode }); await f.command(owner, 'addGuest', { venueId: venue.venueId, guestCode: other.guestCode });
  assert.equal((await f.command(guest, 'addReview', { venueId: venue.venueId, rating: 5, text: 'Хорошее место' })).status, 400);
  await f.command(owner, 'recordVisit', { venueId: venue.venueId, guestId: guest.guestId, bill: 100, tips: 0, rating: 5 });
  const result = await f.command(guest, 'addReview', { venueId: venue.venueId, guestId: other.guestId, rating: 5, text: 'Хорошее место' }); assert.equal(result.status, 200);
  const review = result.body.db.reviews[0]; assert.equal(review.guestId, guest.guestId);
  assert.equal((await f.command(guest, 'addReview', { venueId: venue.venueId, rating: 5, text: 'Второй отзыв' })).status, 400);
  assert.equal((await f.command(other, 'replyReview', { reviewId: review.id, response: 'Чужой ответ' })).status, 403);
  assert.equal((await f.command(owner, 'replyReview', { reviewId: review.id, response: 'Будем рады видеть снова!' })).status, 200);
  assert.equal((await f.state(guest)).body.db.reviews[0].response, 'Будем рады видеть снова!'); assert.equal((await f.state(other)).body.db.reviews.length, 0);
});

test('bad mutations rollback, no client database or POS metadata is trusted', async t => {
  const f = await fixture(t); const owner = await f.login(60); const guest = await f.login(61); const venue = await f.venue(owner);
  await f.command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode }); const base = { venueId: venue.venueId, guestId: guest.guestId };
  assert.equal((await f.command(owner, 'recordVisit', { ...base, bill: -100, tips: 0, rating: 5 })).status, 400);
  assert.equal((await f.command(owner, 'recordVisit', { ...base, bill: 100, tips: 0, rating: 6 })).status, 400);
  assert.equal((await f.command(owner, 'awardBonus', { ...base, amount: 1.5, reason: 'Некорректный бонус' })).status, 400);
  assert.equal((await f.command(owner, 'addNote', { ...base, text: 'Любая заметка', kind: '__proto__' })).status, 400);
  assert.equal((await f.command(owner, 'updateProgram', { venueId: venue.venueId, program: { cashback: 200, everyVisits: 0, visitBonus: -2, tipsBonus: 0 } })).status, 400);
  assert.equal((await f.command(owner, 'replaceDatabase', { db: { memberships: [{ balance: 999999 }] } })).status, 400);
  let state = (await f.state(guest)).body; assert.equal(state.db.visits.length, 0); assert.equal(state.db.memberships[0].balance, 0);
  const visit = await f.command(owner, 'recordVisit', { ...base, bill: 100, tips: 0, rating: null, source: 'iiko', externalId: 'fake-pos-receipt' }); assert.equal(visit.status, 200);
  state = (await f.state(owner)).body; assert.equal(state.db.visits[0].source, undefined); assert.equal(state.db.visits[0].externalId, undefined);
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

test('audit references actual server-resolved targets; malformed IDs cannot enter SQL or domain state', async t => {
  const f = await fixture(t); const owner = await f.login(80); const guest = await f.login(81);
  const developer = await f.login(900000001);
  const created = await f.command(developer, 'createVenue', { name: 'Настоящее кафе', kind: 'Кафе', address: 'Адрес, 10', venueId: 'forged-venue', guestId: 'forged-guest' });
  const venue = created.body.result;
  f.app.store.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner')").run(venue.venueId, owner.user.id);
  await f.command(guest, 'joinVenue', { code: venue.joinCode, venueId: 'forged-venue', guestId: 'forged-guest' });
  const fields = { venueId: venue.venueId, guestId: guest.guestId };
  await f.command(owner, 'recordVisit', { ...fields, bill: 200, tips: 0, rating: 5 });
  const reviewed = await f.command(guest, 'addReview', { venueId: venue.venueId, guestId: 'forged-guest', rating: 5, text: 'Настоящий отзыв' });
  assert.equal(reviewed.status, 200);
  await f.command(owner, 'replyReview', { reviewId: reviewed.body.db.reviews[0].id, response: 'Спасибо за отзыв', venueId: 'forged-venue', guestId: 'forged-guest' });
  const audit = f.app.store.sql.prepare('SELECT command,venue_id,guest_id FROM audit').all();
  assert.equal(audit.length, 5); assert.ok(audit.every(row => row.venue_id === venue.venueId));
  assert.equal(audit[0].guest_id, null); assert.ok(audit.slice(1).every(row => row.guest_id === guest.guestId));
  for (const badId of [Number.MAX_SAFE_INTEGER + 10, {}, [], null]) {
    assert.equal((await f.command(owner, 'awardBonus', { ...fields, guestId: badId, amount: 100, reason: 'Некорректный ID' })).status, 404);
    assert.equal((await f.command(owner, 'revokeStaff', { venueId: venue.venueId, userId: badId })).status, 400);
  }
  assert.equal(f.app.store.sql.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 5);
});
