import { randomUUID } from 'node:crypto';
import { ApiError } from './database.mjs';
import { effectiveGuestProfile } from './venue-profile.mjs';

const WAIT_MS = 6 * 60 * 60 * 1000;
const POLL_MS = 24 * 60 * 60 * 1000;
const waiting = new Set(['awaiting_setup', 'awaiting_order', 'review']);
const terminal = new Set(['closed', 'cancelled', 'expired']);
const fail = (status, message) => { throw new ApiError(status, message); };
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `Некорректное поле: ${label}`);
  return value.trim();
};
const key = value => value.trim().normalize('NFKC').toLocaleLowerCase('ru');
const nowIso = store => new Date(store.clock()).toISOString();
const initialized = db => { db.serviceSessions ??= []; db.serviceMappings ??= []; db.orderDetails ??= []; return db; };
const hasTable = (store, table) => !!store.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const connection = (store, id) => hasTable(store, 'pos_connections') ? store.sql.prepare('SELECT id,venue_id AS venueId,provider,enabled,started_at AS startedAt FROM pos_connections WHERE id=?').get(id) : null;
const currentStaff = (store, venueId, userId) => !!store.sql.prepare('SELECT 1 FROM staff WHERE venue_id=? AND user_id=?').get(venueId, userId);
function posIdentifier(value, provider, label) {
  const id = text(value, 200, label);
  if (provider === 'iiko') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) fail(400, `${label}: нужен Cloud UUID iiko`);
    return id.toLowerCase();
  }
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) fail(400, `${label}: нужен положительный числовой код r_keeper`);
  return String(Number(id));
}

function contextFor(store, db, session) {
  const mapping = (db.serviceMappings ?? []).find(item => item.venueId === session.venueId);
  if (!mapping || !currentStaff(store, session.venueId, session.staffUserId)) return null;
  const pos = connection(store, mapping.connectionId);
  const table = mapping.tables.find(item => key(item.label) === key(session.tableLabel));
  const staff = mapping.staff.find(item => item.userId === session.staffUserId);
  if (!pos?.enabled || pos.venueId !== session.venueId || !table || !staff) return null;
  return { connectionId: mapping.connectionId, posTableId: table.posTableId, posWaiterId: staff.posWaiterId };
}
const contextStillConfigured = (store, db, session) => {
  const current = contextFor(store, db, session); const saved = session.context;
  return !!(current && saved && current.connectionId === saved.connectionId && current.posTableId === saved.posTableId && current.posWaiterId === saved.posWaiterId);
};

export function refreshServiceSessions(store, db) {
  for (const session of db.serviceSessions ?? []) {
    if (session.externalId || terminal.has(session.status)) continue;
    if (store.clock() >= Date.parse(session.expiresAt)) {
      session.status = 'expired'; session.updatedAt = nowIso(store); continue;
    }
    if (session.status === 'review') continue;
    session.context ??= contextFor(store, db, session);
    session.status = contextStillConfigured(store, db, session) ? 'awaiting_order' : 'awaiting_setup';
  }
  return db;
}

export function requireServiceAccess(store, db, userId, venueId, sessionId) {
  const role = store.requireStaff(userId, venueId);
  const session = (db.serviceSessions ?? []).find(item => item.id === sessionId && item.venueId === venueId);
  if (!session) fail(404, 'Обслуживание не найдено');
  if (role.role !== 'owner' && session.staffUserId !== userId) fail(403, 'Нет доступа к обслуживанию другого сотрудника');
  return session;
}

export function startService(store, db, userId, input) {
  store.requireStaff(userId, input.venueId);
  const venue = store.requireVenue(input.venueId, db); const profile = effectiveGuestProfile(venue);
  if (profile.demo || !profile.features.visits) fail(409, 'Обслуживание в этом заведении пока не включено');
  if (!db.memberships.some(item => item.venueId === venue.id && item.guestId === input.guestId)) fail(404, 'Гость не найден в заведении');
  const tableLabel = text(input.tableLabel, 40, 'стол');
  const note = input.note === undefined || input.note === '' ? '' : text(input.note, 500, 'заметка');
  initialized(db); refreshServiceSessions(store, db);
  if (input.previousSessionId !== undefined) {
    const previous = db.serviceSessions.filter(item => item.venueId === venue.id && item.guestId === input.guestId).at(-1)?.id ?? null;
    if (input.previousSessionId !== previous) fail(409, 'История обслуживания обновилась. Обновите экран и повторите действие');
  }
  if (db.serviceSessions.some(item => item.venueId === venue.id && !terminal.has(item.status) && (item.guestId === input.guestId || key(item.tableLabel) === key(tableLabel)))) fail(409, 'Для этого гостя или стола уже открыто обслуживание');
  const createdAt = nowIso(store);
  const session = { id: randomUUID(), venueId: venue.id, guestId: input.guestId, staffUserId: userId, tableLabel, note,
    status: 'awaiting_setup', createdAt, updatedAt: createdAt, expiresAt: new Date(store.clock() + WAIT_MS).toISOString() };
  session.context = contextFor(store, db, session);
  if (session.context) session.status = 'awaiting_order';
  db.serviceSessions.push(session);
  return { db, result: { sessionId: session.id, guestId: session.guestId } };
}

export function cancelService(store, db, userId, input) {
  refreshServiceSessions(store, db);
  const session = requireServiceAccess(store, db, userId, input.venueId, input.sessionId);
  if (session.externalId || session.status === 'closed') fail(409, 'Заказ уже связан с кассой. Нужна сверка руководителя');
  if (session.status === 'expired') fail(409, 'Время ожидания заказа истекло');
  session.status = 'cancelled'; session.updatedAt = nowIso(store);
  return { db, result: { sessionId: session.id, guestId: session.guestId } };
}

export function configureServiceMapping(store, db, userId, input) {
  store.requireStaff(userId, input.venueId, true); store.requireVenue(input.venueId, db);
  const connectionId = text(input.connectionId, 80, 'подключение'); const pos = connection(store, connectionId);
  if (!pos || pos.venueId !== input.venueId) fail(404, 'Подключение этого заведения не найдено');
  if (!Array.isArray(input.tables) || input.tables.length > 100 || !Array.isArray(input.staff) || input.staff.length > 100) fail(400, 'Не более 100 столов и сотрудников');
  const tables = input.tables.map(item => ({ label: text(item?.label, 40, 'стол'), posTableId: posIdentifier(item?.posTableId, pos.provider, 'Стол кассы') }));
  const staff = input.staff.map(item => {
    if (!Number.isSafeInteger(item?.userId) || !currentStaff(store, input.venueId, item.userId)) fail(400, 'Сотрудник не работает в этом заведении');
    return { userId: item.userId, posWaiterId: posIdentifier(item.posWaiterId, pos.provider, 'Официант кассы') };
  });
  for (const values of [tables.map(item => key(item.label)), tables.map(item => item.posTableId), staff.map(item => item.userId), staff.map(item => item.posWaiterId)]) if (new Set(values).size !== values.length) fail(409, 'Сопоставления столов и официантов должны быть однозначными');
  initialized(db);
  db.serviceMappings = [...db.serviceMappings.filter(item => item.venueId !== input.venueId), { venueId: input.venueId, connectionId, tables, staff }];
  refreshServiceSessions(store, db);
  return { db, result: { venueId: input.venueId } };
}

// This boundary receives verified adapter metadata, never public Mini App input.
export function normalizeServiceMetadata(input, clock) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.tableIds) || input.tableIds.length > 20 || !Array.isArray(input.items) || input.items.length > 500) fail(400, 'Некорректные сведения заказа');
  const tableIds = input.tableIds.map(value => text(value, 200, 'стол кассы'));
  if (new Set(tableIds).size !== tableIds.length) fail(400, 'Повторный стол кассы');
  const waiterId = input.waiterId === null ? null : text(input.waiterId, 200, 'официант кассы');
  let openedAt = input.openedAt;
  if (openedAt !== null) {
    if (typeof openedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(openedAt) || !Number.isFinite(Date.parse(openedAt)) || Date.parse(openedAt) > clock + 300000) fail(400, 'Нужен подтверждённый момент открытия заказа');
    const [year, month, day] = openedAt.slice(0, 10).split('-').map(Number); const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail(400, 'Некорректная дата открытия заказа');
    openedAt = new Date(openedAt).toISOString();
  }
  const items = input.items.map(item => {
    if (!Number.isFinite(item?.quantity) || item.quantity <= 0 || item.quantity > 1000000 || (item.sumMinor !== null && (!Number.isSafeInteger(item.sumMinor) || item.sumMinor < 0 || item.sumMinor > 100000000))) fail(400, 'Некорректная позиция заказа');
    return { name: text(item.name, 200, 'блюдо'), quantity: item.quantity, sumMinor: item.sumMinor };
  });
  const comment = input.comment === null || input.comment === undefined || input.comment === '' ? null : text(input.comment, 1000, 'комментарий кассы');
  return { tableIds, waiterId, openedAt, items, comment };
}

const orderFor = (db, connectionId, externalId) => (db.orderDetails ?? []).find(item => item.connectionId === connectionId && item.externalId === externalId);
const claimed = (db, order, exceptId) => (db.serviceSessions ?? []).some(item => item.id !== exceptId && item.context?.connectionId === order.connectionId && item.externalId === order.externalId);
const alreadyCredited = (store, order) => order.previouslyCredited || !!store.sql.prepare('SELECT credited_fingerprint FROM pos_orders WHERE connection_id=? AND external_id=?').get(order.connectionId, order.externalId)?.credited_fingerprint;
function eligible(store, db, session, order) {
  if (!session.context || session.externalId || terminal.has(session.status) || store.clock() >= Date.parse(session.expiresAt) || !contextStillConfigured(store, db, session)) return false;
  const context = session.context; const pos = connection(store, context.connectionId); const service = order.service;
  return !!(pos?.enabled && !alreadyCredited(store, order) && ['open', 'paid'].includes(order.status) && !claimed(db, order, session.id)
    && (!order.closedAt || order.closedAt >= pos.startedAt)
    && order.venueId === session.venueId && order.connectionId === context.connectionId && service?.tableIds.includes(context.posTableId)
    && service.waiterId === context.posWaiterId && service.openedAt && service.openedAt >= session.createdAt && service.openedAt < session.expiresAt
    && (!order.closedAt || service.openedAt <= order.closedAt));
}
function missingIdentityMetadata(store, db, session, order) {
  const service = order.service;
  return !session.externalId && !terminal.has(session.status) && store.clock() < Date.parse(session.expiresAt)
    && contextStillConfigured(store, db, session) && order.connectionId === session.context.connectionId && order.venueId === session.venueId
    && !alreadyCredited(store, order) && !claimed(db, order, session.id) && ['open', 'paid'].includes(order.status)
    && service?.tableIds.includes(session.context.posTableId) && (!service.waiterId || !service.openedAt)
    && (!service.waiterId || service.waiterId === session.context.posWaiterId)
    && (!service.openedAt || (service.openedAt >= session.createdAt && service.openedAt < session.expiresAt));
}
function historicalPaidCandidate(store, db, session, order) {
  if (!['cancelled', 'expired'].includes(session.status) || session.externalId || !session.context || !session.candidateIds?.includes(order.externalId)) return false;
  const pos = connection(store, session.context.connectionId); const metadata = order.service;
  return !!(pos?.enabled && pos.venueId === session.venueId && order.venueId === session.venueId && order.connectionId === session.context.connectionId
    && order.status === 'paid' && !alreadyCredited(store, order) && !claimed(db, order, session.id)
    && metadata?.tableIds.includes(session.context.posTableId) && metadata.waiterId === session.context.posWaiterId
    && metadata.openedAt && metadata.openedAt >= session.createdAt && metadata.openedAt < session.expiresAt
    && order.closedAt && order.closedAt >= metadata.openedAt && order.closedAt >= pos.startedAt);
}

export function ingestServiceBatch(store, db, connection, records) {
  initialized(db); refreshServiceSessions(store, db);
  for (const { receipt, service } of records) {
    const old = orderFor(db, connection.id, receipt.externalId);
    const credited = store.sql.prepare('SELECT credited_fingerprint FROM pos_orders WHERE connection_id=? AND external_id=?').get(connection.id, receipt.externalId)?.credited_fingerprint;
    const entry = { ...(old ?? {}), connectionId: connection.id, venueId: connection.venueId, externalId: receipt.externalId,
      status: receipt.status, billMinor: receipt.billMinor, closedAt: receipt.closedAt, customerId: receipt.customerId,
      service: service ?? old?.service ?? null, previouslyCredited: !!credited || old?.previouslyCredited === true, updatedAt: nowIso(store) };
    db.orderDetails = [...db.orderDetails.filter(item => item.connectionId !== connection.id || item.externalId !== receipt.externalId), entry];
  }
  // Evaluate the complete metadata batch before linking anything: no first-order wins.
  const candidates = new Map();
  for (const session of db.serviceSessions) if (waiting.has(session.status) && !session.externalId) {
    candidates.set(session.id, db.orderDetails.filter(order => eligible(store, db, session, order)));
    const incomplete = db.orderDetails.filter(order => missingIdentityMetadata(store, db, session, order));
    if (incomplete.length) {
      session.status = 'review'; session.updatedAt = nowIso(store);
      session.candidateIds = [...new Set([...(session.candidateIds ?? []), ...incomplete.map(item => item.externalId)])];
      for (const order of incomplete) order.serviceReview = true;
    }
  }
  for (const session of db.serviceSessions) {
    const choices = candidates.get(session.id); if (!choices?.length) continue;
    const ambiguous = choices.length !== 1 || [...candidates].some(([id, orders]) => id !== session.id && orders.some(order => order.connectionId === choices[0].connectionId && order.externalId === choices[0].externalId));
    if (session.status === 'review' || ambiguous || choices[0].serviceReview) {
      session.status = 'review'; session.candidateIds = [...new Set([...(session.candidateIds ?? []), ...choices.map(item => item.externalId)])]; session.updatedAt = nowIso(store);
      for (const order of choices) order.serviceReview = true;
    } else {
      session.externalId = choices[0].externalId; session.status = 'linked'; session.updatedAt = nowIso(store);
    }
  }
  return db;
}

function releaseUnchosenCandidates(store, db, session, chosenId, userId) {
  for (const order of db.orderDetails ?? []) {
    if (order.connectionId !== session.context.connectionId || order.externalId === chosenId || !session.candidateIds?.includes(order.externalId) || !order.serviceReview) continue;
    const unresolved = (db.serviceSessions ?? []).some(other => other.id !== session.id && !other.externalId
      && other.context?.connectionId === order.connectionId && other.candidateIds?.includes(order.externalId));
    const row = store.sql.prepare('SELECT outcome,credited_fingerprint FROM pos_orders WHERE connection_id=? AND external_id=?').get(order.connectionId, order.externalId);
    if (unresolved || claimed(db, order, session.id) || alreadyCredited(store, order) || !row || row.outcome === 'review' || ['refund', 'review'].includes(order.status)) continue;
    // The manager selected a different order. Release only this soft ambiguity;
    // never apply/credit the unchosen receipt here or clear any financial hold.
    order.serviceReview = false;
    store.sql.prepare("UPDATE pos_orders SET outcome='unmatched',guest_id=NULL,updated_at=? WHERE connection_id=? AND external_id=?").run(nowIso(store), order.connectionId, order.externalId);
    store.sql.prepare('INSERT INTO pos_audit(connection_id,external_id,actor_id,action,created_at) VALUES (?,?,?,?,?)').run(order.connectionId, order.externalId, userId, 'service_candidate_released', nowIso(store));
  }
}

export function resolveServiceOrder(store, db, userId, input) {
  store.requireStaff(userId, input.venueId, true); refreshServiceSessions(store, db);
  const session = requireServiceAccess(store, db, userId, input.venueId, input.sessionId);
  const externalId = text(input.externalId, 200, 'заказ');
  const order = session.context && orderFor(db, session.context.connectionId, externalId);
  const historical = !!order && historicalPaidCandidate(store, db, session, order);
  if (!order || !session.candidateIds?.includes(externalId) || (!historical && !eligible(store, db, session, order))) fail(409, 'Заказ больше не подходит для подтверждения');
  const paid = store.sql.prepare('SELECT credited_fingerprint FROM pos_orders WHERE connection_id=? AND external_id=?').get(order.connectionId, order.externalId);
  if (paid?.credited_fingerprint) fail(409, 'Этот чек уже учтён');
  if (historical && db.serviceSessions.some(item => item.id !== session.id && item.venueId === session.venueId && !terminal.has(item.status)
    && (item.guestId === session.guestId || key(item.tableLabel) === key(session.tableLabel)))) fail(409, 'У этого гостя или стола уже есть активное обслуживание. Сначала завершите его');
  const competing = (db.serviceSessions ?? []).some(item => item.id !== session.id && eligible(store, db, item, order));
  if (competing) fail(409, 'Заказ подходит нескольким гостям. Нужна сверка');
  session.externalId = externalId; session.status = 'linked'; session.updatedAt = nowIso(store); order.serviceReview = false;
  releaseUnchosenCandidates(store, db, session, externalId, userId);
  return { db, result: { sessionId: session.id, guestId: session.guestId }, reapply: { connectionId: session.context.connectionId, externalId } };
}

export function serviceOrderBinding(db, connectionId, externalId) {
  const session = (db.serviceSessions ?? []).find(item => item.context?.connectionId === connectionId && item.externalId === externalId);
  const order = orderFor(db, connectionId, externalId);
  return { session, blocked: !session && order?.serviceReview === true };
}

export function updateServiceOrderOutcome(db, connectionId, externalId, outcome, now) {
  const { session } = serviceOrderBinding(db, connectionId, externalId);
  if (!session) return;
  if (outcome === 'review' || outcome === 'held' || outcome === 'ignored') session.status = 'review';
  else if (outcome === 'imported') session.status = 'closed';
  session.updatedAt = now;
}

export function servicePollTargets(store, db, connectionId) {
  refreshServiceSessions(store, db);
  const tables = new Set(); const orders = new Set(); const dates = [];
  for (const session of db.serviceSessions ?? []) {
    if (session.context?.connectionId !== connectionId || terminal.has(session.status)) continue;
    if (!session.externalId) {
      if (!contextStillConfigured(store, db, session) || store.clock() >= Date.parse(session.expiresAt)) continue;
      tables.add(session.context.posTableId); dates.push(session.createdAt);
    } else {
      const order = orderFor(db, connectionId, session.externalId);
      if (order && ['paid', 'refund', 'review'].includes(order.status)) continue;
      if (store.clock() >= Date.parse(session.createdAt) + POLL_MS) {
        if (!session.pollStopped) { session.status = 'review'; session.pollStopped = true; session.updatedAt = nowIso(store); }
        continue;
      }
      orders.add(session.externalId);
    }
  }
  if (tables.size > 100 || orders.size > 100) fail(409, 'Слишком много обслуживаний для безопасного обмена. Нужна сверка руководителя');
  return { tableIds: [...tables].sort(), orderIds: [...orders].sort(), since: dates.sort()[0] ?? null };
}

export function serviceSnapshot(store, db, userId, guestId, staffVenues) {
  refreshServiceSessions(store, db);
  const roles = new Map(staffVenues.map(item => [item.venueId, item.role]));
  const serviceSessions = (db.serviceSessions ?? []).filter(item => item.guestId === guestId || roles.has(item.venueId)).map(session => {
    const staff = roles.has(session.venueId);
    const owner = roles.get(session.venueId) === 'owner';
    const assigned = staff && (owner || session.staffUserId === userId);
    const view = { id: session.id, venueId: session.venueId, guestId: session.guestId, tableLabel: session.tableLabel, status: session.status,
      createdAt: session.createdAt, updatedAt: session.updatedAt, expiresAt: session.expiresAt,
      canCancel: assigned && !session.externalId && waiting.has(session.status) };
    if (staff) view.staffUserId = session.staffUserId;
    if (assigned) view.note = session.note;
    const order = session.context && session.externalId && orderFor(db, session.context.connectionId, session.externalId);
    if (order && (staff || session.status !== 'review')) view.order = { status: order.status, billMinor: order.billMinor, openedAt: order.service?.openedAt ?? null,
      closedAt: order.closedAt, items: (order.service?.items ?? []).map(({ name, quantity, sumMinor }) => ({ name, quantity, sumMinor })) };
    if (assigned && view.order && order.service?.comment) view.order.comment = order.service.comment;
    if (owner && ['review', 'cancelled', 'expired'].includes(session.status) && !session.externalId) view.candidates = (db.orderDetails ?? []).filter(item => session.candidateIds?.includes(item.externalId) && item.connectionId === session.context?.connectionId && (eligible(store, db, session, item) || historicalPaidCandidate(store, db, session, item)))
      .map(item => ({ externalId: item.externalId, status: item.status, billMinor: item.billMinor, openedAt: item.service?.openedAt ?? null }));
    return view;
  });
  const serviceReadiness = staffVenues.map(({ venueId }) => {
    const mapping = (db.serviceMappings ?? []).find(item => item.venueId === venueId);
    const pos = mapping && connection(store, mapping.connectionId);
    const staffMapped = !!mapping?.staff.some(item => item.userId === userId);
    return { venueId, ready: !!pos?.enabled && staffMapped && !!mapping?.tables.length, staffMapped, tableLabels: mapping?.tables.map(item => item.label) ?? [] };
  });
  const serviceMappings = (db.serviceMappings ?? []).filter(item => roles.get(item.venueId) === 'owner').map(item => ({ venueId: item.venueId, connectionId: item.connectionId,
    tables: item.tables.map(({ label, posTableId }) => ({ label, posTableId })), staff: item.staff.map(({ userId, posWaiterId }) => ({ userId, posWaiterId })) }));
  return { serviceSessions, serviceReadiness, serviceMappings };
}
