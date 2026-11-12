import { effectiveGuestProfile } from './venue-profile';
import type { GuestVenueProfile } from './venue-profile';
import type { ServiceFlow } from './service-flow';
import type { GlobalLedgerEntry } from './global-bonuses';
import type { FeedbackVisit, StaffFeedback, GuestFeedback } from './feedback';
export type { GlobalProgram, GlobalWallet, GlobalWalletTransaction, GuestGlobalBalance, GlobalLedgerEntry } from './global-bonuses';
export type { ServiceSessionView, ServiceReadiness, ServiceMapping } from './service-sessions';

export type Role = 'staff' | 'guest';
export type NoteKind = 'thanks' | 'preference' | 'note';
export interface Program { cashback: number; everyVisits: number; visitBonus: number; tipsBonus: number }
export interface Venue { id: string; name: string; kind: string; address: string; monogram: string; program: Program; guestProfile?: GuestVenueProfile; serviceFlow?: ServiceFlow }
export interface Guest { id: string; name: string; phone: string; color: string; createdAt: string }
export interface Membership { venueId: string; guestId: string; balance: number }
export interface Visit { id: string; venueId: string; guestId: string; bill: number; tips: number; rating: number | null; createdAt: string; source?: 'iiko' | 'rkeeper'; externalId?: string; tipsKnown?: boolean }
export interface Note { id: string; venueId: string; guestId: string; text: string; kind: NoteKind; createdAt: string; author: string }
export interface Review { id: string; venueId: string; guestId: string; visitId: string; text: string; rating: number; createdAt: string; response?: string }
export interface Transaction { id: string; venueId: string; guestId: string; amount: number; reason: string; createdAt: string }
export interface PosEvent { id: string; provider: 'iiko' | 'rkeeper'; venueId: string; externalId: string; result: 'imported' | 'duplicate' | 'unmatched' | 'ignored' | 'refund'; message: string; createdAt: string }
export interface Database { version: 1; venues: Venue[]; guests: Guest[]; memberships: Membership[]; visits: Visit[]; notes: Note[]; reviews: Review[]; transactions: Transaction[]; posEvents?: PosEvent[]; globalLedger?: GlobalLedgerEntry[]; feedbackVisits?: FeedbackVisit[]; staffFeedback?: StaffFeedback[]; guestFeedback?: GuestFeedback[] }
export interface Reward { id: string; name: string; description: string; cost: number; icon: 'cafe-outline' | 'ice-cream-outline' | 'restaurant-outline' }
export const rewards: Reward[] = [
  { id: 'coffee', name: 'Кофе в подарок', description: 'Любой классический кофе', cost: 150, icon: 'cafe-outline' },
  { id: 'dessert', name: 'Сладкий комплимент', description: 'Десерт из меню заведения', cost: 350, icon: 'ice-cream-outline' },
  { id: 'dinner', name: 'Особенный вечер', description: '500 ₽ в счёт следующего заказа', cost: 500, icon: 'restaurant-outline' },
];
export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const money = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
export const shortDate = (date: string) => new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
export const fullDate = (date: string) => new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
export const sameDay = (a: string, b = new Date().toISOString()) => new Date(a).toLocaleDateString('ru-RU') === new Date(b).toLocaleDateString('ru-RU');
export function stats(db: Database, venueId: string, guestId: string) {
  const visits = db.visits.filter(v => v.venueId === venueId && v.guestId === guestId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const spent = visits.reduce((sum, v) => sum + v.bill, 0);
  const tips = visits.reduce((sum, v) => sum + v.tips, 0);
  const rated = visits.filter(v => v.rating !== null);
  const knownTips = visits.filter(v => v.tipsKnown !== false);
  const knownSpent = knownTips.reduce((sum, v) => sum + v.bill, 0);
  return { visits, count: visits.length, spent, tips, tipsPercent: knownSpent ? Math.round(tips / knownSpent * 100) : 0, rating: rated.length ? rated.reduce((s, v) => s + v.rating!, 0) / rated.length : 0, balance: db.memberships.find(m => m.venueId === venueId && m.guestId === guestId)?.balance ?? 0 };
}
function ensureMember(db: Database, venueId: string, guestId: string) {
  if (!db.venues.some(v => v.id === venueId) || !db.guests.some(g => g.id === guestId)) throw new Error('Гость или заведение не найдены');
  if (!db.memberships.some(m => m.venueId === venueId && m.guestId === guestId)) throw new Error('Гость не добавлен в это заведение');
}
function integer(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}: от ${min} до ${max}`);
}
export function validateProgram(p: Program) {
  integer(p.cashback, 0, 30, 'Кешбэк, %');
  integer(p.everyVisits, 2, 100, 'Каждый N-й визит');
  integer(p.visitBonus, 0, 10000, 'Бонус за визиты');
  integer(p.tipsBonus, 0, 10000, 'Бонус за чаевые');
}
function currency(value: number, min: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error(`${label}: от ${min} до 1000000 ₽, не более 2 знаков после запятой`);
}
function changeBalance(db: Database, venueId: string, guestId: string, amount: number, reason: string, createdAt: string): Database {
  ensureMember(db, venueId, guestId);
  const membership = db.memberships.find(m => m.venueId === venueId && m.guestId === guestId)!;
  if (membership.balance + amount < 0) throw new Error('Недостаточно бонусов');
  return { ...db, memberships: db.memberships.map(m => m === membership ? { ...m, balance: m.balance + amount } : m), transactions: [{ id: uid(), venueId, guestId, amount, reason, createdAt }, ...db.transactions] };
}
export function recordVisit(db: Database, input: Omit<Visit, 'id' | 'createdAt'>, now = new Date().toISOString()): { db: Database; earned: number } {
  ensureMember(db, input.venueId, input.guestId);
  const venue = db.venues.find(v => v.id === input.venueId)!;
  const features = effectiveGuestProfile(venue).features;
  if (!features.visits) throw new Error('Учёт визитов в этом заведении пока не включён');
  currency(input.bill, 0.01, 'Сумма чека');
  currency(input.tips, 0, 'Чаевые');
  if (input.rating !== null) integer(input.rating, 1, 5, 'Оценка');
  const program = venue.program;
  const count = stats(db, input.venueId, input.guestId).count + 1;
  const earned = features.loyalty ? Math.floor(Math.round(input.bill * 100) * program.cashback / 10000) + (count % program.everyVisits === 0 ? program.visitBonus : 0) + (input.tipsKnown !== false && Math.round(input.tips * 100) * 10 >= Math.round(input.bill * 100) ? program.tipsBonus : 0) : 0;
  const next = { ...db, visits: [{ ...input, id: uid(), createdAt: now }, ...db.visits] };
  return { db: earned ? changeBalance(next, input.venueId, input.guestId, earned, `Визит · чек ${money(input.bill)} ₽`, now) : next, earned };
}
export function awardBonus(db: Database, venueId: string, guestId: string, amount: number, reason: string): Database {
  ensureMember(db, venueId, guestId);
  if (!effectiveGuestProfile(db.venues.find(v => v.id === venueId)!).features.loyalty) throw new Error('Бонусная программа этого заведения пока не включена');
  integer(amount, 1, 10000, 'Количество бонусов');
  if (reason.trim().length < 3 || reason.trim().length > 300) throw new Error('Укажите причину: от 3 до 300 символов');
  return changeBalance(db, venueId, guestId, amount, reason.trim(), new Date().toISOString());
}
export function redeemReward(db: Database, venueId: string, guestId: string, rewardId: string): Database {
  ensureMember(db, venueId, guestId);
  if (!effectiveGuestProfile(db.venues.find(v => v.id === venueId)!).features.loyalty) throw new Error('Бонусная программа этого заведения пока не включена');
  const reward = rewards.find(r => r.id === rewardId);
  if (!reward) throw new Error('Комплимент не найден');
  return changeBalance(db, venueId, guestId, -reward.cost, reward.name, new Date().toISOString());
}
export function addGuest(db: Database, venueId: string, name: string, phone: string): { db: Database; guestId: string } {
  if (!db.venues.some(v => v.id === venueId)) throw new Error('Заведение не найдено');
  const trimmed = name.trim();
  const normalized = phone.replace(/\D/g, '');
  if (trimmed.length < 2 || trimmed.length > 70) throw new Error('Имя: от 2 до 70 символов');
  if (normalized.length < 10 || normalized.length > 15) throw new Error('Укажите телефон: от 10 до 15 цифр');
  const existing = db.guests.find(g => g.phone.replace(/\D/g, '') === normalized);
  if (existing && db.memberships.some(m => m.venueId === venueId && m.guestId === existing.id)) throw new Error('Гость с таким телефоном уже есть в заведении');
  const guestId = existing?.id ?? uid();
  const guest: Guest = { id: guestId, name: trimmed, phone: normalized, color: ['#F0DCC8', '#DDDCEB', '#D8E5D7', '#F1DAD5'][db.guests.length % 4], createdAt: new Date().toISOString() };
  return { guestId, db: { ...db, guests: existing ? db.guests : [...db.guests, guest], memberships: [...db.memberships, { venueId, guestId, balance: 0 }] } };
}
export function addNote(db: Database, venueId: string, guestId: string, text: string, kind: NoteKind): Database {
  ensureMember(db, venueId, guestId);
  if (text.trim().length < 3 || text.trim().length > 1000) throw new Error('Комментарий: от 3 до 1000 символов');
  return { ...db, notes: [{ id: uid(), venueId, guestId, text: text.trim(), kind, createdAt: new Date().toISOString(), author: 'Команда заведения' }, ...db.notes] };
}
export function addReview(db: Database, venueId: string, guestId: string, rating: number, text: string): Database {
  ensureMember(db, venueId, guestId);
  if (!effectiveGuestProfile(db.venues.find(v => v.id === venueId)!).features.reviews) throw new Error('Отзывы в этом заведении пока не включены');
  integer(rating, 1, 5, 'Оценка');
  if (text.trim().length < 3 || text.trim().length > 1000) throw new Error('Отзыв: от 3 до 1000 символов');
  const visit = stats(db, venueId, guestId).visits.find(v => !db.reviews.some(r => r.visitId === v.id));
  if (!visit) throw new Error('Для нового отзыва нужен ещё один отмеченный визит');
  return { ...db, reviews: [{ id: uid(), venueId, guestId, visitId: visit.id, rating, text: text.trim(), createdAt: new Date().toISOString() }, ...db.reviews] };
}
export function replyReview(db: Database, reviewId: string, response: string): Database {
  if (response.trim().length < 3 || response.trim().length > 1000) throw new Error('Ответ: от 3 до 1000 символов');
  if (!db.reviews.some(r => r.id === reviewId)) throw new Error('Отзыв не найден');
  return { ...db, reviews: db.reviews.map(r => r.id === reviewId ? { ...r, response: response.trim() } : r) };
}
