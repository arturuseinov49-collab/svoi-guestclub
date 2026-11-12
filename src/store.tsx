import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Database, Venue } from './domain';
import type { GlobalProgram, GlobalWallet, GuestGlobalBalance } from './domain';
import { GuestVenueProfile } from './venue-profile';
import { telegramApp } from './telegram';
import { PendingOperations } from './pending';

export interface Account { id: number; firstName: string; lastName: string; username: string | null }
export interface StaffVenue { venueId: string; role: 'owner' | 'staff' }
export interface Snapshot {
  db: Database; catalog: Venue[]; user: Account; guestId: string; guestCode: string; guestQr: string; isDeveloper: boolean; staffVenues: StaffVenue[];
  globalProgram?: GlobalProgram | null;
  globalWallet?: GlobalWallet | null;
  guestGlobalBalances?: GuestGlobalBalance[];
}
export interface StaffMember { userId: number; name: string; role: 'owner' | 'staff' }
export interface ManagedVenue { id: string; name: string; kind: string; address: string; joinCode: string; guestProfile: GuestVenueProfile; managers: { userId: number; name: string }[]; guestCount: number; staffCount: number }
export interface CommandResult { venueId?: string; guestId?: string; earned?: number; code?: string; expiresAt?: string; members?: StaffMember[]; managedVenues?: ManagedVenue[] }
export type Command = { type: string; [key: string]: unknown };
export type PosAction = 'status' | 'configure' | 'probe' | 'enabled' | 'bind' | 'webhook-setup';
const emptyDatabase = (): Database => ({ version: 1, venues: [], guests: [], memberships: [], visits: [], notes: [], reviews: [], transactions: [] });
type Store = {
  db: Database; catalog: Venue[]; user: Account | null; guestId: string; guestCode: string; guestQr: string; isDeveloper: boolean; staffVenues: StaffVenue[];
  globalProgram: GlobalProgram | null; globalWallet: GlobalWallet | null; guestGlobalBalances: GuestGlobalBalance[];
  ready: boolean; loading: boolean; error: string; syncError: string; lastSynced: number;
  retry: () => Promise<void>; refresh: () => Promise<void>; logout: () => Promise<void>;
  command: (input: Command, idempotencyKey: string) => Promise<CommandResult>;
  posRequest: <T = unknown>(action: PosAction, input: Record<string, unknown>) => Promise<T>;
};
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
const Context = createContext<Store | null>(null);
export function StoreProvider({ children }: React.PropsWithChildren) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [lastSynced, setLastSynced] = useState(0);
  const token = useRef('');
  const account = useRef<number | null>(null);
  const pending = useRef(new PendingOperations());
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const polling = useRef(false);
  const authenticating = useRef(false);
  const request = useCallback(async (path: string, method = 'GET', input?: unknown, auth = token.current) => {
    let response: Response;
    // AbortSignal.timeout is absent in older mobile WebViews. Keep requests bounded
    // without making successful Telegram login depend on that newer API.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), path === '/api/pos/probe' ? 135000 : 15000);
    try {
      response = await fetch(path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) }, body: input ? JSON.stringify(input) : undefined, cache: 'no-store', signal: controller.signal });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(value.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.', response.status);
      return value;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('Нет связи с сервером. Проверьте интернет и повторите попытку.', 0);
    } finally { clearTimeout(timeout); }
  }, []);
  const apply = useCallback((next: Snapshot, revision: number) => {
    if (generation.current !== revision) return;
    if (!next.db || !next.user || !Array.isArray(next.staffVenues)) throw new Error('Некорректный ответ сервера');
    account.current = next.user.id; setSnapshot(next); setLastSynced(Date.now()); setSyncError('');
  }, []);
  const expired = useCallback((e: unknown, revision: number) => {
    if (revision === generation.current && e instanceof ApiError && e.status === 401) {
      generation.current++; token.current = ''; account.current = null; setSnapshot(null);
      setError('Сессия истекла. Закройте приложение и откройте его заново из Telegram.');
    }
  }, []);
  const serial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const task = queue.current.then(fn); queue.current = task.catch(() => {}); return task;
  }, []);
  const retry = useCallback(async () => {
    if (authenticating.current) return;
    const initData = telegramApp()?.initData;
    if (!initData) { setLoading(false); return; }
    authenticating.current = true; setLoading(true); setError('');
    const revision = ++generation.current;
    try {
      await serial(async () => {
        const session = await request('/api/session', 'POST', { initData }, '');
        if (generation.current !== revision) return;
        token.current = session.token;
        const next = session.db ? session : await request('/api/state');
        apply(next, revision);
      });
    } catch (e) { token.current = ''; setError(e instanceof Error ? e.message : 'Не удалось войти через Telegram'); }
    finally { authenticating.current = false; setLoading(false); }
  }, [apply, request, serial]);
  const refresh = useCallback(async () => {
    if (!token.current || polling.current) return;
    polling.current = true;
    const revision = generation.current;
    try { await serial(async () => { if (revision !== generation.current || !token.current) return; apply(await request('/api/state'), revision); }); }
    catch (e) { expired(e, revision); if (revision === generation.current) setSyncError(e instanceof Error ? e.message : 'Не удалось обновить данные'); }
    finally { polling.current = false; }
  }, [apply, expired, request, serial]);
  const command = useCallback(async (input: Command, proposedKey: string) => {
    const revision = generation.current;
    return serial(async () => {
      const userId = account.current;
      if (!token.current || userId === null || revision !== generation.current) throw new Error('Войдите через Telegram');
      const operation = await pending.current.acquire(userId, input, proposedKey);
      try {
        const next = await request('/api/commands', 'POST', { ...input, idempotencyKey: operation.key });
        // Keep the key if the response cannot be applied: the commit may have succeeded.
        apply(next, revision);
        pending.current.resolve(userId, operation.fingerprint);
        return (next.result ?? {}) as CommandResult;
      } catch (e) {
        // Any rejection may follow an earlier committed request whose response was lost.
        // Keep its key through validation/auth/rate errors, reloads and logout until success.
        expired(e, revision); throw e;
      }
    });
  }, [apply, expired, request, serial]);
  const logout = useCallback(async () => {
    await serial(async () => {
      if (token.current) await request('/api/session', 'DELETE');
      generation.current++; token.current = ''; account.current = null; setSnapshot(null); setError(''); setSyncError('');
    });
  }, [request, serial]);
  const posRequest = useCallback(async <T,>(action: PosAction, input: Record<string, unknown>): Promise<T> => {
    const revision = generation.current;
    if (!token.current) throw new Error('Войдите через Telegram');
    try {
      const value = action === 'status' ? await request(`/api/pos/status?venueId=${encodeURIComponent(String(input.venueId))}`) : await request(`/api/pos/${action}`, 'POST', input);
      if (revision !== generation.current) throw new Error('Аккаунт изменился. Откройте раздел заново');
      if (action === 'bind') await refresh();
      return value as T;
    } catch (e) { expired(e, revision); throw e; }
  }, [request, refresh, expired]);
  useEffect(() => {
    // Authenticate against Telegram's external startup data and the remote session API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void retry();
  }, [retry]);
  useEffect(() => {
    const tick = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh(); };
    const offline = () => setSyncError('Нет интернета. Показаны последние загруженные данные.');
    const timer = setInterval(tick, 5000);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', tick);
      window.addEventListener('online', tick);
      window.addEventListener('offline', offline);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', tick);
        window.removeEventListener('online', tick);
        window.removeEventListener('offline', offline);
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);
  return <Context.Provider value={{ db: snapshot?.db ?? emptyDatabase(), catalog: snapshot?.catalog ?? [], user: snapshot?.user ?? null, guestId: snapshot?.guestId ?? '', guestCode: snapshot?.guestCode ?? '', guestQr: snapshot?.guestQr ?? '', isDeveloper: snapshot?.isDeveloper === true, staffVenues: snapshot?.staffVenues ?? [], globalProgram: snapshot?.globalProgram ?? null, globalWallet: snapshot?.globalWallet ?? null, guestGlobalBalances: snapshot?.guestGlobalBalances ?? [], ready: !!snapshot, loading, error, syncError, lastSynced, retry, refresh, logout, command, posRequest }}>{children}</Context.Provider>;
}
export function useStore() { const value = useContext(Context); if (!value) throw new Error('StoreProvider missing'); return value; }
