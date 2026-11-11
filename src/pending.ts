// Only fingerprints and request IDs are persisted. Tokens and command contents stay in memory.
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'svoi.pending.v1.';
const MAX_PENDING = 1000;
const storageError = () => new Error('Хранилище браузера недоступно. Откройте приложение в Telegram или разрешите сохранение данных. Перед повтором проверьте историю операции.');
function browserStorage(): PendingStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function commandFingerprint(account: number, input: Record<string, unknown>): Promise<string> {
  // Normalize exactly as the JSON request body, including undefined/NaN handling.
  const normalized = JSON.parse(JSON.stringify(input));
  const bytes = new TextEncoder().encode(canonical({ account, input: normalized }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export class PendingOperations {
  private memory = new Map<number, Record<string, string>>();
  constructor(private getStorage: () => PendingStorage | undefined = browserStorage) {}
  private read(account: number): Record<string, string> {
    const cached = this.memory.get(account); if (cached) return cached;
    let raw: string | null = null;
    try { const storage = this.getStorage(); if (!storage) throw storageError(); raw = storage.getItem(`${PREFIX}${account}`); }
    catch { throw storageError(); }
    let entries: Record<string, string> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.entries(parsed).some(([fingerprint, key]) => !/^[a-f0-9]{64}$/.test(fingerprint) || typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key))) throw new Error('Invalid registry');
        entries = parsed;
      } catch { throw new Error('Не удалось прочитать список неподтверждённых операций. Новый запрос не отправлен. Не очищайте данные: обратитесь к владельцу заведения для сверки.'); }
    }
    this.memory.set(account, entries); return entries;
  }
  private save(account: number, entries: Record<string, string>) {
    try {
      const storage = this.getStorage();
      if (!storage) throw storageError();
      if (Object.keys(entries).length) storage.setItem(`${PREFIX}${account}`, JSON.stringify(entries));
      else storage.removeItem(`${PREFIX}${account}`);
    } catch { throw storageError(); }
    this.memory.set(account, entries);
  }
  async acquire(account: number, input: Record<string, unknown>, proposedKey: string) {
    const fingerprint = await commandFingerprint(account, input);
    const entries = this.read(account);
    if (entries[fingerprint]) return { fingerprint, key: entries[fingerprint] };
    if (Object.keys(entries).length >= MAX_PENDING) throw new Error('Слишком много неподтверждённых операций. Новый запрос не отправлен. Сначала завершите сверку предыдущих операций с владельцем заведения.');
    const next = { ...entries, [fingerprint]: proposedKey };
    this.save(account, next); return { fingerprint, key: proposedKey };
  }
  resolve(account: number, fingerprint: string) {
    const next = { ...this.read(account) }; delete next[fingerprint]; this.save(account, next);
  }
}
