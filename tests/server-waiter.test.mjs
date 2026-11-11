import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, ApiError } from '../server/database.mjs';
import { validateServiceFlow, waiterPlatform, waiterUrl, defaultServiceFlow } from '../server/service-flow.mjs';

test('waiter settings accept public launch links, reject credentials and never turn store links into app launch', () => {
  assert.deepEqual(validateServiceFlow({ cashSystem: 'none' }), defaultServiceFlow());
  assert.equal(waiterUrl('  https://waiter.example.com/open/restaurant  '), 'https://waiter.example.com/open/restaurant');
  for (const url of ['iikowaiter://open', 'intent://open', 'javascript:alert(1)', 'http://waiter.example.com', 'https://user:pass@waiter.example.com', 'https://127.0.0.1/', 'https://localhost/', 'https://waiter.local/', 'https://[::1]/', 'https://waiter.example.com:8080/', 'https://waiter.example.com/#token', 'https://waiter.example.com/?api_key=secret', 'https://waiter.example.com/?guestId=1', 'https://play.google.com/store/apps/details?id=ru.iiko.iikowaiter5', 'https://apps.apple.com/ru/app/iikowaiter/id641016373']) assert.throws(() => waiterUrl(url), undefined, url);
  for (const cashSystem of [['iiko'], null, 1, {}, 'unknown']) assert.throws(() => validateServiceFlow({ cashSystem }));
  assert.throws(() => validateServiceFlow({ cashSystem: 'iiko', token: 'secret' }));
  assert.deepEqual(validateServiceFlow({ cashSystem: 'rkeeper', waiterAndroidUrl: 'https://waiter.example.com/android', waiterIosUrl: '' }), { cashSystem: 'rkeeper', waiterAndroidUrl: '', waiterIosUrl: '' });
  assert.equal(waiterPlatform('android'), 'android');
  assert.equal(waiterPlatform('ios'), 'ios');
  assert.equal(waiterPlatform('unknown', 'Mozilla/5.0 (iPhone)'), 'ios');
  assert.equal(waiterPlatform('tdesktop', 'Windows NT'), null);
});

test('only the venue manager sets service flow; snapshots and replays preserve venue isolation', t => {
  const store = new Store(':memory:', { developerIds: [101] }); t.after(() => store.close());
  const login = id => store.login({ id, firstName: `Test ${id}`, lastName: '', username: null });
  const developer = login(101), manager = login(102), staff = login(103), guest = login(104), outsider = login(105);
  const cmd = (user, type, fields = {}, idempotencyKey = randomUUID()) => store.command(user.user.id, { type, ...fields, idempotencyKey });
  const create = name => cmd(developer, 'createVenue', { name, kind: 'Кафе', address: 'Тестовый адрес' }).result.venueId;
  const venueId = create('Кафе А'), otherId = create('Кафе Б');
  cmd(manager, 'acceptStaffInvite', { code: cmd(developer, 'createManagerInvite', { venueId }).result.code });
  cmd(staff, 'acceptStaffInvite', { code: cmd(manager, 'createStaffInvite', { venueId }).result.code });
  cmd(manager, 'scanGuest', { venueId, qr: guest.guestQr });
  const serviceFlow = { cashSystem: 'iiko', waiterAndroidUrl: 'https://waiter.example.com/android/venue-a', waiterIosUrl: 'https://waiter.example.com/ios/venue-a' };
  const key = randomUUID();
  cmd(manager, 'updateServiceFlow', { venueId, serviceFlow }, key);
  assert.deepEqual(store.snapshot(staff.user.id).db.venues[0].serviceFlow, serviceFlow);
  assert.equal('serviceFlow' in store.snapshot(guest.user.id).db.venues[0], false);
  assert.ok(store.snapshot(guest.user.id).catalog.every(venue => !('serviceFlow' in venue)));
  assert.equal(store.read().venues.find(v => v.id === otherId).serviceFlow, undefined);
  const forbidden = fn => assert.throws(fn, error => error instanceof ApiError && error.status === 403);
  for (const user of [staff, guest, outsider, developer]) forbidden(() => cmd(user, 'updateServiceFlow', { venueId, serviceFlow }));
  forbidden(() => cmd(manager, 'updateServiceFlow', { venueId: otherId, serviceFlow }));
  assert.equal(cmd(manager, 'updateServiceFlow', { venueId, serviceFlow }, key).replayed, true);
  const before = store.read();
  assert.throws(() => cmd(manager, 'updateServiceFlow', { venueId, serviceFlow: { ...serviceFlow, waiterAndroidUrl: 'https://waiter.example.com/?token=secret' } }), error => error.status === 400);
  assert.deepEqual(store.read(), before);
  cmd(developer, 'revokeManager', { venueId, userId: manager.user.id });
  forbidden(() => cmd(manager, 'updateServiceFlow', { venueId, serviceFlow }, key));
  assert.equal(store.read().visits.length, 0);
  assert.equal(store.read().transactions.length, 0);
});
