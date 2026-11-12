import type { Database } from './domain';
import { effectiveGuestProfile } from './venue-profile';

export interface GlobalProgram { enabled: true; cashbackPercent: 1; redemptionEnabled: false }
export interface GlobalWalletTransaction { id: string; delta: number; reason: string; createdAt: string }
export interface GlobalWallet { unit: 'leaf'; balance: number; pendingReview: boolean; transactions: GlobalWalletTransaction[] }
export interface GuestGlobalBalance { venueId: string; guestId: string; balance: number }
// Server-only journal. Snapshots must project this into a guest's own wallet,
// never disclose the source receipt, staff/customer identifiers or other venues.
export interface GlobalLedgerEntry {
  id: string; guestId: string; venueId: string; provider: 'iiko' | 'rkeeper';
  connectionId: string; externalId: string; billMinor: number; delta: number; createdAt: string;
}
export const GLOBAL_PROGRAM: Readonly<GlobalProgram> = Object.freeze({ enabled: true, cashbackPercent: 1, redemptionEnabled: false });

export function globalBalances(db: Database): Map<string, number> {
  const balances = new Map<string, number>();
  for (const entry of db.globalLedger ?? []) {
    const balance = (balances.get(entry.guestId) ?? 0) + entry.delta;
    if (!Number.isSafeInteger(entry.delta) || entry.delta <= 0 || !Number.isSafeInteger(balance)) throw new Error('Некорректная запись общего кошелька');
    balances.set(entry.guestId, balance);
  }
  return balances;
}

export function guestGlobalWallet(db: Database, guestId: string, pendingReview: boolean, balances = globalBalances(db)): GlobalWallet {
  return {
    unit: 'leaf', balance: balances.get(guestId) ?? 0, pendingReview,
    transactions: (db.globalLedger ?? []).filter(entry => entry.guestId === guestId)
      .map(({ id, delta, createdAt }) => ({ id, delta, createdAt, reason: 'Кешбэк «Свои» · 1% от оплаченного чека' }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
  };
}

/** Called only by the trusted paid-POS import, inside its existing transaction.
 * Whole leaves are rounded down per receipt. Local loyalty rates are independent.
 * There is deliberately no public grant, conversion or spending operation.
 */
export function creditGlobalPosCashback(db: Database, input: Omit<GlobalLedgerEntry, 'delta'>): Database {
  const { id, guestId, venueId, provider, connectionId, externalId, billMinor, createdAt } = input;
  for (const value of [id, guestId, venueId, connectionId, externalId]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Некорректный источник начисления «Своих»');
  }
  if (!['iiko', 'rkeeper'].includes(provider) || !Number.isSafeInteger(billMinor) || billMinor <= 0 || billMinor > 100000000 || !Number.isFinite(Date.parse(createdAt))) throw new Error('Некорректный оплаченный чек');
  const venue = db.venues.find(item => item.id === venueId);
  if (!venue || !db.guests.some(item => item.id === guestId) || !db.memberships.some(item => item.venueId === venueId && item.guestId === guestId)) throw new Error('Гость не найден в заведении');
  const ledger = db.globalLedger ?? [];
  const previous = ledger.find(entry => entry.connectionId === connectionId && entry.externalId === externalId);
  if (previous) {
    if (previous.guestId !== guestId || previous.venueId !== venueId || previous.provider !== provider || previous.billMinor !== billMinor || previous.createdAt !== createdAt) throw new Error('Начисление по чеку требует сверки');
    return db;
  }
  const profile = effectiveGuestProfile(venue);
  if (profile.demo || !profile.features.visits) return db;
  const delta = Math.floor(billMinor / 10000);
  if (!delta) return db;
  const balance = (globalBalances(db).get(guestId) ?? 0) + delta;
  if (!Number.isSafeInteger(balance)) throw new Error('Превышен допустимый баланс общего кошелька');
  if (ledger.some(entry => entry.id === id)) throw new Error('Повторный идентификатор начисления');
  return { ...db, globalLedger: [...ledger, { id, guestId, venueId, provider, connectionId, externalId, billMinor, delta, createdAt }] };
}
