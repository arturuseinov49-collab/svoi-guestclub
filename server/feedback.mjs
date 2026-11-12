import { randomUUID } from 'node:crypto';
import { ApiError } from './database.mjs';

// Keep the public choices aligned with src/feedback.ts. This module does not
// call the historical financial domain, POS store, or global wallet.
const preferences = new Set(['Неострые блюда', 'Острые блюда', 'Без лука', 'Овощные блюда', 'Кофе без сахара', 'Тихое место', 'Быстрое обслуживание', 'Не торопить']);
const experiences = new Set(['pleasant', 'neutral', 'needs_attention']);
const questions = ['food', 'service', 'atmosphere', 'cleanliness', 'value'];
const answers = new Set(['liked', 'disliked', 'not_used']);
const fail = (status, message) => { throw new ApiError(status, message); };
const now = store => new Date(store.clock()).toISOString();
function text(value, min, max, label) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail(400, `${label}: от ${min} до ${max} символов`);
  return value.trim();
}
function object(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(400, `${label}: проверьте поля`);
  return value;
}
function inputFields(input, fields, optional = []) {
  return object(input, ['type', 'idempotencyKey', ...fields, ...optional], fields, 'Анкета');
}
function venueMember(store, db, venueId, guestId) {
  const venue = store.requireVenue(venueId, db);
  if (!db.guests.some(guest => guest.id === guestId) || !db.memberships.some(member => member.venueId === venueId && member.guestId === guestId)) fail(404, 'Гость не найден в этом заведении');
  return venue;
}
function enabled(venue) {
  if (!(venue.guestProfile?.feedbackEnabled ?? (venue.guestProfile?.published === true))) fail(409, 'Анкеты в этом заведении пока не включены');
}
function ownVisit(store, db, userId, venueId, visitId) {
  const guestId = store.user(userId)?.guest_id;
  if (!guestId) fail(401, 'Войдите через Telegram');
  venueMember(store, db, venueId, guestId);
  const visit = (db.feedbackVisits ?? []).find(item => item.id === visitId && item.venueId === venueId && item.guestId === guestId);
  if (!visit) fail(404, 'Ваш подтверждённый визит не найден');
  return visit;
}
function teamFeedback(store, db, userId, venueId, feedbackId) {
  store.requireStaff(userId, venueId);
  const feedback = (db.guestFeedback ?? []).find(item => item.id === feedbackId && item.venueId === venueId);
  if (!feedback) fail(404, 'Отзыв не найден в этом заведении');
  return feedback;
}

export function recordFeedbackVisit(store, db, userId, input) {
  inputFields(input, ['venueId', 'guestId', 'preferences', 'experience', 'comment'], ['previousVisitId']);
  const venueId = text(input.venueId, 1, 100, 'Заведение'); const guestId = text(input.guestId, 1, 100, 'Гость');
  store.requireStaff(userId, venueId);
  enabled(venueMember(store, db, venueId, guestId));
  if (!Array.isArray(input.preferences) || input.preferences.length > preferences.size || input.preferences.some(value => typeof value !== 'string' || !preferences.has(value)) || new Set(input.preferences).size !== input.preferences.length) fail(400, 'Выберите неповторяющиеся предпочтения из списка');
  if (!experiences.has(input.experience)) fail(400, 'Выберите впечатление от общения');
  const comment = text(input.comment, 0, 1000, 'Комментарий');
  if (Object.hasOwn(input, 'previousVisitId')) {
    const previous = input.previousVisitId === null ? null : text(input.previousVisitId, 1, 100, 'Предыдущий визит');
    const latest = (db.feedbackVisits ?? []).filter(item => item.venueId === venueId && item.guestId === guestId).at(-1)?.id ?? null;
    if (previous !== latest) fail(409, 'История визитов обновилась. Обновите карточку гостя и повторите действие');
  }
  const createdAt = now(store); const visitId = randomUUID(); const feedbackId = randomUUID();
  const visit = { id: visitId, venueId, guestId, staffUserId: userId, createdAt };
  const feedback = { id: feedbackId, visitId, venueId, guestId, staffUserId: userId, preferences: [...input.preferences], experience: input.experience, comment, createdAt };
  return { db: { ...db, feedbackVisits: [...(db.feedbackVisits ?? []), visit], staffFeedback: [...(db.staffFeedback ?? []), feedback] }, result: { visitId, feedbackId, guestId } };
}

export function submitGuestFeedback(store, db, userId, input) {
  inputFields(input, ['venueId', 'visitId', 'answers', 'comment']);
  const venueId = text(input.venueId, 1, 100, 'Заведение'); const visitId = text(input.visitId, 1, 100, 'Визит');
  const visit = ownVisit(store, db, userId, venueId, visitId);
  enabled(store.requireVenue(venueId, db));
  const fields = object(input.answers, questions, questions, 'Ответы');
  if (questions.some(key => !answers.has(fields[key]))) fail(400, 'Ответьте на каждый вопрос анкеты');
  const comment = text(input.comment, 0, 1000, 'Комментарий');
  if ((db.guestFeedback ?? []).some(item => item.visitId === visitId && item.venueId === venueId)) fail(409, 'Отзыв об этом визите уже отправлен');
  const feedbackId = randomUUID();
  const feedback = { id: feedbackId, visitId, venueId, guestId: visit.guestId, answers: Object.fromEntries(questions.map(key => [key, fields[key]])), comment,
    createdAt: now(store), response: null, respondedAt: null };
  return { db: { ...db, guestFeedback: [...(db.guestFeedback ?? []), feedback] }, result: { feedbackId, visitId, guestId: visit.guestId } };
}

export function replyGuestFeedback(store, db, userId, input) {
  inputFields(input, ['venueId', 'feedbackId', 'response']);
  const venueId = text(input.venueId, 1, 100, 'Заведение'); const feedbackId = text(input.feedbackId, 1, 100, 'Отзыв');
  const feedback = teamFeedback(store, db, userId, venueId, feedbackId);
  const response = text(input.response, 1, 1000, 'Ответ');
  return { db: { ...db, guestFeedback: db.guestFeedback.map(item => item.id === feedback.id ? { ...item, response, respondedAt: now(store), respondedBy: userId } : item) },
    result: { feedbackId, guestId: feedback.guestId } };
}

export function authorizeFeedbackReplay(store, db, userId, input) {
  const venueId = text(input.venueId, 1, 100, 'Заведение');
  if (input.type === 'recordFeedbackVisit') store.requireStaff(userId, venueId);
  if (input.type === 'submitGuestFeedback') ownVisit(store, db, userId, venueId, text(input.visitId, 1, 100, 'Визит'));
  if (input.type === 'replyGuestFeedback') teamFeedback(store, db, userId, venueId, text(input.feedbackId, 1, 100, 'Отзыв'));
}

export function feedbackSnapshot(db, guestId, staffVenues) {
  const permitted = new Set(staffVenues.map(item => item.venueId));
  const member = new Set(db.memberships.filter(item => item.guestId === guestId).map(item => item.venueId));
  const visible = item => permitted.has(item.venueId) || (item.guestId === guestId && member.has(item.venueId));
  return {
    feedbackVisits: (db.feedbackVisits ?? []).filter(visible).map(item => ({ id: item.id, venueId: item.venueId, guestId: item.guestId, createdAt: item.createdAt,
      ...(permitted.has(item.venueId) ? { staffUserId: item.staffUserId } : {}) })),
    // Guest identity or club membership alone never grants staff-only access.
    staffFeedback: (db.staffFeedback ?? []).filter(item => permitted.has(item.venueId)).map(item => ({ id: item.id, visitId: item.visitId, venueId: item.venueId,
      guestId: item.guestId, staffUserId: item.staffUserId, preferences: [...item.preferences], experience: item.experience, comment: item.comment, createdAt: item.createdAt })),
    guestFeedback: (db.guestFeedback ?? []).filter(visible).map(item => ({ id: item.id, visitId: item.visitId, venueId: item.venueId, guestId: item.guestId,
      answers: Object.fromEntries(questions.map(key => [key, item.answers[key]])), comment: item.comment, createdAt: item.createdAt, response: item.response ?? null, respondedAt: item.respondedAt ?? null })),
  };
}
