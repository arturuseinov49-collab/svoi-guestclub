export type CashSystem = 'none' | 'iiko' | 'rkeeper';
export interface ServiceFlow {
  cashSystem: CashSystem;
  waiterAndroidUrl: string;
  waiterIosUrl: string;
}
export const defaultServiceFlow = (): ServiceFlow => ({ cashSystem: 'none', waiterAndroidUrl: '', waiterIosUrl: '' });

// These are public launch links supplied and tested by the venue's integrator.
// Never add a guest identity, QR, session, API key, or loyalty balance to a URL.
export function waiterUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Укажите ссылку текстом');
  const text = value.trim();
  if (!text) return '';
  if (text.length > 1000 || /[\s\\]/.test(text)) throw new Error('Проверьте ссылку открытия iikoWaiter');
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('Нужна полная HTTPS-ссылка от интегратора iikoWaiter'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !host.includes('.') || host.endsWith('.') || /^(?:\d+\.){3}\d+$/.test(host) || host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) {
    throw new Error('Нужна публичная HTTPS-ссылка без пароля, порта и фрагмента');
  }
  if (host === 'apps.apple.com' || host === 'play.google.com') throw new Error('Ссылка магазина устанавливает приложение. Для перехода нужна отдельная ссылка от интегратора');
  if ([...url.searchParams.keys()].some(key => /token|secret|password|api.?key|session|authorization|initdata|guest.?id|guest.?qr/i.test(key))) {
    throw new Error('Ссылка открытия не должна содержать ключи, пароли или данные гостя');
  }
  return url.href;
}
export function validateServiceFlow(value: unknown): ServiceFlow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Укажите настройки обслуживания');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['cashSystem', 'waiterAndroidUrl', 'waiterIosUrl'].includes(key)) ||
      typeof input.cashSystem !== 'string' || !['none', 'iiko', 'rkeeper'].includes(input.cashSystem)) throw new Error('Выберите кассовую систему');
  const cashSystem = input.cashSystem as CashSystem;
  const waiterAndroidUrl = waiterUrl(input.waiterAndroidUrl ?? '');
  const waiterIosUrl = waiterUrl(input.waiterIosUrl ?? '');
  return { cashSystem, waiterAndroidUrl: cashSystem === 'iiko' ? waiterAndroidUrl : '', waiterIosUrl: cashSystem === 'iiko' ? waiterIosUrl : '' };
}

export function waiterPlatform(platform: string, userAgent = ''): 'android' | 'ios' | null {
  if (platform === 'android' || platform === 'android_x') return 'android';
  if (platform === 'ios') return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  return null;
}
export const waiterStore = {
  android: 'https://play.google.com/store/apps/details?id=ru.iiko.iikowaiter5',
  ios: 'https://apps.apple.com/ru/app/iikowaiter-5/id641016373',
};
