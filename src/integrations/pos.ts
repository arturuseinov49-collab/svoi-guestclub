import { Database, PosEvent, recordVisit, uid } from '../domain';
export type Provider = 'iiko' | 'rkeeper';
export type Scenario = 'closed' | 'duplicate' | 'unmatched' | 'open' | 'refund' | 'offline';
export interface Receipt {
  provider: Provider; venueId: string; externalVenueId: string; externalId: string;
  bill: number; tips: number | null; guestPhone: string | null;
  status: 'closed' | 'open' | 'refund'; occurredAt: string;
}
// Minimal demo fixtures, NOT vendor SDK types. guestLink and tips are separate
// enrichments: White Server GetOrderList does not promise either field.
export interface IikoFixture {
  demo: true; provider: 'iiko';
  event: { eventType: 'TableOrderUpdate'; organizationId: string; eventInfo: { id: string; creationStatus: 'Success'; order: { status: string; sum: number } } };
  enrichment: { guestPhone: string | null; tips: number | null; occurredAt: string; returned: boolean };
}
export interface RkeeperFixture {
  demo: true; provider: 'rkeeper';
  response: { responseCommon: { objectId: string; taskType: 'GetOrderList' }; taskResponse: { orders: { orderGuid: string; sum: number; unpaid: number; isFinished: boolean; isReturn: boolean }[] } };
  enrichment: { guestPhone: string | null; tips: number | null; occurredAt: string };
}
export type Fixture = IikoFixture | RkeeperFixture;
export const providerName = (provider: Provider) => provider === 'iiko' ? 'iiko' : 'r_keeper';
export const venueReference = (provider: Provider, venueId: string) => `${provider === 'iiko' ? 'demo-organization' : 'demo-object'}-${venueId}`;
export function createFixture(provider: Provider, venueId: string, scenario: Scenario, externalId: string): Fixture {
  const isOpen = scenario === 'open'; const isReturn = scenario === 'refund';
  const enrichment = { guestPhone: scenario === 'unmatched' ? null : '79000000001', tips: provider === 'iiko' ? 250 : null, occurredAt: new Date().toISOString() };
  if (provider === 'iiko') return { demo: true, provider, event: { eventType: 'TableOrderUpdate', organizationId: venueReference(provider, venueId), eventInfo: { id: externalId, creationStatus: 'Success', order: { status: isOpen ? 'New' : 'Closed', sum: 1800 } } }, enrichment: { ...enrichment, returned: isReturn } };
  return { demo: true, provider, response: { responseCommon: { objectId: venueReference(provider, venueId), taskType: 'GetOrderList' }, taskResponse: { orders: [{ orderGuid: externalId, sum: 2400.50, unpaid: isOpen ? 2400.50 : 0, isFinished: !isOpen, isReturn }] } }, enrichment };
}
export function normalizeFixture(fixture: Fixture, venueId: string): Receipt {
  let receipt: Receipt;
  if (fixture.provider === 'iiko') {
    const { event, enrichment } = fixture;
    if (event.eventType !== 'TableOrderUpdate' || event.eventInfo.creationStatus !== 'Success') throw new Error('Неподдерживаемое событие iiko');
    receipt = { provider: 'iiko', venueId, externalVenueId: event.organizationId, externalId: event.eventInfo.id, bill: event.eventInfo.order.sum, tips: enrichment.tips, guestPhone: enrichment.guestPhone, occurredAt: enrichment.occurredAt, status: enrichment.returned ? 'refund' : event.eventInfo.order.status === 'Closed' ? 'closed' : 'open' };
  } else {
    const order = fixture.response.taskResponse.orders[0];
    if (!order || fixture.response.responseCommon.taskType !== 'GetOrderList') throw new Error('Нет заказа в ответе r_keeper');
    receipt = { provider: 'rkeeper', venueId, externalVenueId: fixture.response.responseCommon.objectId, externalId: order.orderGuid, bill: order.sum, tips: fixture.enrichment.tips, guestPhone: fixture.enrichment.guestPhone, occurredAt: fixture.enrichment.occurredAt, status: order.isReturn ? 'refund' : order.isFinished && order.unpaid === 0 ? 'closed' : 'open' };
  }
  if (receipt.externalVenueId !== venueReference(receipt.provider, venueId)) throw new Error('Чек относится к другому заведению');
  if (!receipt.externalId || !Number.isFinite(Date.parse(receipt.occurredAt))) throw new Error('Некорректный идентификатор или дата чека');
  return receipt;
}
export function processReceipt(db: Database, receipt: Receipt, manualGuestId?: string): { db: Database; event: PosEvent; earned: number } {
  if (!db.venues.some(v => v.id === receipt.venueId) || receipt.externalVenueId !== venueReference(receipt.provider, receipt.venueId)) throw new Error('Не совпадает привязка заведения');
  let result: PosEvent['result']; let message: string; let next = db; let earned = 0;
  const exists = db.visits.some(v => v.source === receipt.provider && v.venueId === receipt.venueId && v.externalId === receipt.externalId);
  if (receipt.status === 'refund') { result = 'refund'; message = 'Возврат требует сверки сотрудником. Начисление не выполнено; баланс не изменён.'; }
  else if (receipt.status !== 'closed') { result = 'ignored'; message = 'Чек ещё открыт. Дождёмся закрытия и полной оплаты.'; }
  else if (exists) { result = 'duplicate'; message = 'Этот чек уже учтён. Повторного визита и начисления нет.'; }
  else {
    const guest = manualGuestId ? db.guests.find(g => g.id === manualGuestId) : db.guests.find(g => receipt.guestPhone && g.phone.replace(/\D/g, '') === receipt.guestPhone.replace(/\D/g, ''));
    if (!guest || !db.memberships.some(m => m.venueId === receipt.venueId && m.guestId === guest.id)) { result = 'unmatched'; message = 'Гость не определён. Привяжите чек к карточке вручную.'; }
    else {
      const imported = recordVisit(db, { venueId: receipt.venueId, guestId: guest.id, bill: receipt.bill, tips: receipt.tips ?? 0, tipsKnown: receipt.tips !== null, rating: null, source: receipt.provider, externalId: receipt.externalId }, receipt.occurredAt);
      next = imported.db; earned = imported.earned;
      result = 'imported'; message = `Визит записан · ${guest.name} · +${earned} Б`;
    }
  }
  const event: PosEvent = { id: uid(), provider: receipt.provider, venueId: receipt.venueId, externalId: receipt.externalId, result, message, createdAt: new Date().toISOString() };
  return { db: { ...next, posEvents: [event, ...(next.posEvents ?? [])].slice(0, 200) }, event, earned };
}
