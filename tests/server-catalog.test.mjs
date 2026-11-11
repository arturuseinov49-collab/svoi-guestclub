import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, ApiError } from '../server/database.mjs';
import { defaultGuestProfile } from '../server/venue-profile.mjs';
import { recordVisit } from '../server/domain.mjs';

function fixture(t) {
  const store = new Store(':memory:', { developerIds: [101] }); t.after(() => store.close());
  const login = id => store.login({ id, firstName: `Аккаунт ${id}`, lastName: '', username: null });
  const developer = login(101), manager = login(102), guest = login(103), visitor = login(104);
  const cmd = (user, type, fields = {}, key = randomUUID()) => store.command(user.user.id, { type, ...fields, idempotencyKey: key });
  const create = name => cmd(developer, 'createVenue', { name, kind: 'Гастробар', address: 'Тестовая улица, 4' }).result;
  const venue = create('Мексиканский бар'), privateVenue = create('Закрытый клуб');
  cmd(manager, 'acceptStaffInvite', { code: cmd(developer, 'createManagerInvite', { venueId: venue.venueId }).result.code });
  cmd(manager, 'scanGuest', { venueId: venue.venueId, qr: guest.guestQr });
  const profile = { ...defaultGuestProfile(), published: true, demo: true, theme: 'elpastor', tagline: 'Мексиканский гастробар', description: 'Описание места', highlights: ['Мексиканская кухня', 'Музыка'], terms: 'Условия клуба пока не согласованы.', links: { booking: 'https://example.com/reserve', telegram: 'https://t.me/example' } };
  const configure = (guestProfile, key) => cmd(developer, 'updateVenueProfile', { venueId: venue.venueId, guestProfile }, key);
  return { store, developer, manager, guest, visitor, cmd, venue, privateVenue, profile, configure };
}
const denied = (fn, status) => assert.throws(fn, error => error instanceof ApiError && error.status === status);

test('published catalog exposes only venue cards and browsing never enrolls a guest or exposes team data', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.snapshot(104).catalog, [], 'legacy/default venues are not automatically published');
  f.cmd(f.manager, 'recordVisit', { venueId: f.venue.venueId, guestId: f.guest.guestId, bill: 1000, tips: 0, rating: 5 });
  f.cmd(f.manager, 'addNote', { venueId: f.venue.venueId, guestId: f.guest.guestId, text: 'Внутренняя заметка команды', kind: 'note' });
  f.configure(f.profile);
  const before = f.store.read(); const state = f.store.snapshot(104);
  assert.equal(state.catalog.length, 1); assert.equal(state.catalog[0].id, f.venue.venueId);
  assert.deepEqual(Object.keys(state.catalog[0]).sort(), ['id','name','kind','address','monogram','program','guestProfile'].sort());
  assert.deepEqual(state.catalog[0].guestProfile, f.profile);
  assert.equal(JSON.stringify(state.catalog).includes(f.venue.joinCode), false);
  assert.equal(JSON.stringify(state.catalog).includes('Внутренняя заметка'), false);
  assert.equal(JSON.stringify(state.catalog).includes(f.guest.guestId), false);
  assert.deepEqual(state.staffVenues, []); assert.deepEqual(state.db.venues, []);
  for (const field of ['memberships','visits','notes','reviews','transactions']) assert.deepEqual(state.db[field], []);
  assert.deepEqual(f.store.read(), before, 'snapshot is read-only');
  f.configure({ ...f.profile, published: false });
  assert.deepEqual(f.store.snapshot(104).catalog, []);
  assert.equal(f.store.snapshot(103).db.venues[0].id, f.venue.venueId, 'unpublishing preserves a member history');
  assert.equal(f.store.snapshot(103).db.visits.length, 1);
  assert.equal(f.store.snapshot(103).db.memberships[0].balance, 50);
});

test('only developer can update a venue card, replay rechecks rights and never restores an old profile', t => {
  const f = fixture(t); const key = randomUUID();
  for (const user of [f.manager, f.guest, f.visitor]) denied(() => f.cmd(user, 'updateVenueProfile', { venueId: f.venue.venueId, guestProfile: f.profile, isDeveloper: true }), 403);
  denied(() => f.cmd(f.developer, 'updateVenueProfile', { venueId: 'not-a-venue', guestProfile: f.profile }), 404);
  f.configure(f.profile, key);
  const changed = { ...f.profile, tagline: 'Новое описание', features: { ...f.profile.features, loyalty: false } };
  f.configure(changed);
  const count = f.store.sql.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  assert.equal(f.configure(f.profile, key).replayed, true);
  assert.deepEqual(f.store.snapshot(104).catalog[0].guestProfile, changed);
  assert.equal(f.store.sql.prepare('SELECT COUNT(*) AS count FROM audit').get().count, count);
  const managed = f.cmd(f.developer, 'listManagedVenues').result.managedVenues;
  assert.deepEqual(managed.find(v => v.id === f.venue.venueId).guestProfile, changed);
  assert.deepEqual(managed.find(v => v.id === f.privateVenue.venueId).guestProfile, defaultGuestProfile());
  assert.equal(f.store.sql.prepare("SELECT venue_id FROM audit WHERE command='updateVenueProfile' ORDER BY id DESC LIMIT 1").get().venue_id, f.venue.venueId);
  f.store.developerIds.delete(101);
  denied(() => f.configure(f.profile, key), 403);
});

test('venue card validation rejects malformed flags, unknown fields and executable or credential-bearing links atomically', t => {
  const f = fixture(t); const before = f.store.read();
  const invalid = [null, {}, { ...f.profile, published: 'true' }, { ...f.profile, demo: 1 }, { ...f.profile, theme: 'external' }, { ...f.profile, theme: ['svoi'] },
    { ...f.profile, secret: 'not-public' }, { ...f.profile, tagline: 'x'.repeat(121) }, { ...f.profile, description: 'x'.repeat(1201) },
    { ...f.profile, terms: 'x'.repeat(1501) }, { ...f.profile, highlights: Array(7).fill('Особенность') }, { ...f.profile, highlights: [''] },
    { ...f.profile, highlights: ['x'.repeat(61)] }, { ...f.profile, description: 'bad\u0000text' },
    { ...f.profile, features: { loyalty: false } }, { ...f.profile, features: { ...f.profile.features, owner: true } },
    { ...f.profile, links: { unknown: 'https://example.com' } },
    ...['javascript:alert(1)', 'data:text/html,hello', '//example.com', 'http://example.com', 'https://user:secret@example.com', 'https://example.com/'+'x'.repeat(600)].map(booking => ({ ...f.profile, links: { booking } })),
  ];
  for (const profile of invalid) { denied(() => f.configure(profile), 400); assert.deepEqual(f.store.read(), before); }
  f.configure({ ...f.profile, tagline: '  Текст  ', links: { booking: 'https://example.com', menu: '' } });
  const saved = f.store.read().venues.find(v => v.id === f.venue.venueId).guestProfile;
  assert.equal(saved.tagline, 'Текст'); assert.deepEqual(saved.links, { booking: 'https://example.com/' });
});

test('individual actions control manual and POS bonuses without removing existing balances or history', t => {
  const f = fixture(t); const fields = { venueId: f.venue.venueId, guestId: f.guest.guestId, bill: 1000, tips: 100, rating: 5 };
  f.cmd(f.manager, 'recordVisit', fields);
  f.cmd(f.manager, 'awardBonus', { venueId: fields.venueId, guestId: fields.guestId, amount: 200, reason: 'Прежняя благодарность' });
  const previous = f.store.read(); const balance = previous.memberships[0].balance;
  f.configure({ ...f.profile, features: { loyalty: false, visits: true, reviews: false } });
  const noBonus = f.cmd(f.manager, 'recordVisit', fields);
  assert.equal(noBonus.result.earned, 0); assert.equal(noBonus.db.memberships[0].balance, balance);
  assert.equal(noBonus.db.transactions.length, previous.transactions.length);
  assert.throws(() => f.cmd(f.manager, 'awardBonus', { venueId: fields.venueId, guestId: fields.guestId, amount: 100, reason: 'Новая благодарность' }), /программа.*не включена/);
  assert.throws(() => f.cmd(f.manager, 'redeemReward', { venueId: fields.venueId, guestId: fields.guestId, rewardId: 'coffee' }), /программа.*не включена/);
  assert.throws(() => f.cmd(f.guest, 'addReview', { venueId: fields.venueId, rating: 5, text: 'Новый отзыв гостя' }), /Отзывы.*не включены/);
  const pos = recordVisit(f.store.read(), { ...fields, rating: null, tipsKnown: false, source: 'iiko', externalId: 'cashier-check' });
  assert.equal(pos.earned, 0); assert.equal(pos.db.memberships[0].balance, balance);
  const unrelatedBefore = f.store.read().venues.find(v => v.id === f.privateVenue.venueId);
  f.configure({ ...f.profile, features: { loyalty: false, visits: false, reviews: false } });
  const disabled = f.store.read();
  assert.throws(() => f.cmd(f.manager, 'recordVisit', fields), /Учёт визитов.*не включён/);
  assert.throws(() => recordVisit(disabled, { ...fields, rating: null, source: 'rkeeper', externalId: 'another-check' }), /Учёт визитов.*не включён/);
  assert.deepEqual(f.store.read(), disabled);
  assert.deepEqual(f.store.read().venues.find(v => v.id === f.privateVenue.venueId), unrelatedBefore);
  f.configure(f.profile);
  assert.equal(f.cmd(f.manager, 'recordVisit', fields).result.earned, 75);
  assert.equal(f.cmd(f.guest, 'addReview', { venueId: fields.venueId, rating: 5, text: 'Отзыв после включения' }).db.reviews.length, 1);
});
