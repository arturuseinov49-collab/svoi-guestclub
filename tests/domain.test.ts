import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGuest, addNote, addReview, awardBonus, recordVisit, redeemReward, stats, validateProgram } from '../src/domain';
import { createSeed } from '../src/seed';
const visit = { venueId: 'list', guestId: 'alex', bill: 1800, tips: 250, rating: 5 };
test('visit cashback, tips appreciation and venue isolation', () => {
  const db = createSeed(); const before = stats(db, 'list', 'alex'); const other = stats(db, 'moss', 'alex');
  const result = recordVisit(db, visit);
  assert.equal(result.earned, 115);
  assert.equal(stats(result.db, 'list', 'alex').balance, before.balance + 115);
  assert.equal(stats(result.db, 'list', 'alex').count, before.count + 1);
  assert.deepEqual(stats(result.db, 'moss', 'alex'), other);
  assert.equal(stats(db, 'list', 'alex').balance, before.balance, 'input is immutable');
});
test('Nth visit adds a milestone once', () => {
  let db = createSeed(); db.visits = db.visits.filter(v => v.guestId !== 'alex' || v.venueId !== 'list').concat(db.visits.filter(v => v.guestId === 'alex' && v.venueId === 'list').slice(0, 4));
  const fifth = recordVisit(db, { ...visit, tips: 0 }); assert.equal(fifth.earned, 190);
  const sixth = recordVisit(fifth.db, { ...visit, tips: 0 }); assert.equal(sixth.earned, 90);
});
test('decimal receipts retain kopecks, cashback rounds down', () => {
  const result = recordVisit(createSeed(), { ...visit, bill: 2400.5, tips: 0 });
  assert.equal(result.earned, 120); assert.equal(result.db.visits[0].bill, 2400.5);
});
test('invalid money, stars and unknown members are rejected', () => {
  const db = createSeed();
  for (const bill of [-10, 0, NaN, Infinity, 1.001]) assert.throws(() => recordVisit(db, { ...visit, bill }));
  assert.throws(() => recordVisit(db, { ...visit, tips: -1 }));
  assert.throws(() => recordVisit(db, { ...visit, rating: 6 }));
  assert.throws(() => recordVisit(db, { ...visit, guestId: 'missing' }));
});
test('tips bonus starts at exactly 10 percent', () => {
  const db = createSeed();
  assert.equal(recordVisit(db, { ...visit, bill: 100, tips: 9.99 }).earned, 5);
  assert.equal(recordVisit(db, { ...visit, bill: 100, tips: 10 }).earned, 30);
});
test('unknown imported tips and rating do not create false scores', () => {
  const db = createSeed(); const before = stats(db, 'list', 'alex');
  const result = recordVisit(db, { ...visit, bill: 10000, tips: 0, tipsKnown: false, rating: null });
  const after = stats(result.db, 'list', 'alex');
  assert.equal(result.earned, 500); assert.equal(after.rating, before.rating); assert.equal(after.tipsPercent, before.tipsPercent);
});
test('redemption cannot overdraw or affect another venue', () => {
  const db = createSeed(); const result = redeemReward(db, 'list', 'alex', 'coffee');
  assert.equal(stats(result, 'list', 'alex').balance, 590);
  assert.equal(stats(result, 'moss', 'alex').balance, 230);
  assert.throws(() => redeemReward(db, 'list', 'misha', 'coffee'), /Недостаточно/);
  assert.throws(() => redeemReward(db, 'list', 'alex', 'unknown'));
});
test('manual appreciation requires positive integer points and reason', () => {
  const db = createSeed();
  assert.equal(stats(awardBonus(db, 'list', 'alex', 100, 'За помощь команде'), 'list', 'alex').balance, 840);
  for (const value of [-100, 0, 1.5, NaN]) assert.throws(() => awardBonus(db, 'list', 'alex', value, 'Спасибо'));
  assert.throws(() => awardBonus(db, 'list', 'alex', 100, ''));
});
test('guest phone is unique within venue; existing guest may join another', () => {
  const db = createSeed(); assert.throws(() => addGuest(db, 'list', 'Другой', '+7 900 000 00 01'), /уже есть/);
  const result = addGuest(db, 'moss', 'Анна', '+7 900 000 00 02');
  assert.equal(result.guestId, 'anna'); assert.equal(result.db.guests.length, db.guests.length);
  assert.equal(stats(result.db, 'moss', 'anna').balance, 0);
});
test('comments stay scoped to venue and guest', () => {
  const db = addNote(createSeed(), 'moss', 'alex', 'Любит двойной эспрессо', 'preference');
  assert.equal(db.notes[0].venueId, 'moss'); assert.equal(db.notes[0].guestId, 'alex');
  assert.throws(() => addNote(db, 'list', 'missing', 'Текст', 'note'));
  assert.throws(() => addNote(db, 'list', 'alex', ' ', 'note'));
});
test('reviews require an unreviewed visit; one review per visit', () => {
  let db = createSeed(); let count = 0;
  while (stats(db, 'list', 'alex').visits.some(v => !db.reviews.some(r => r.visitId === v.id))) { db = addReview(db, 'list', 'alex', 5, 'Очень уютно'); count++; }
  assert.equal(count, 11); assert.throws(() => addReview(db, 'list', 'alex', 5, 'Ещё отзыв'), /визит/);
  assert.throws(() => addReview(db, 'moss', 'misha', 5, 'Не посещал'));
});
test('program rule bounds prevent invalid calculations', () => {
  const p = createSeed().venues[0].program; validateProgram(p);
  assert.throws(() => validateProgram({ ...p, cashback: 31 }));
  assert.throws(() => validateProgram({ ...p, everyVisits: 0 }));
  assert.throws(() => validateProgram({ ...p, visitBonus: -1 }));
});
