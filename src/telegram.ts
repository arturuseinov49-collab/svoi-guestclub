import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
export interface TelegramApp {
  initData: string; platform: string; version: string; viewportStableHeight?: number;
  safeAreaInset?: { top: number; bottom: number }; contentSafeAreaInset?: { top: number; bottom: number };
  ready: () => void; expand: () => void; setHeaderColor?: (color: string) => void; setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  onEvent: (event: string, callback: () => void) => void; offEvent: (event: string, callback: () => void) => void;
  BackButton?: { show: () => void; hide: () => void; onClick: (fn: () => void) => void; offClick: (fn: () => void) => void };
  HapticFeedback?: { notificationOccurred: (type: 'success' | 'error' | 'warning') => void };
  showScanQrPopup?: (params: { text?: string }, callback?: (value: string) => boolean | void) => void;
  closeScanQrPopup?: () => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
}
declare global { interface Window { Telegram?: { WebApp: TelegramApp } } }
export function telegramApp() { return Platform.OS === 'web' && typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined; }
export function useTelegram(backVisible: boolean, onBack: () => void, enabled = true, background = '#F7F8F2') {
  const ref = useRef(onBack);
  useEffect(() => { ref.current = onBack; }, [onBack]);
  const [environment, setEnvironment] = useState(() => {
    const app = telegramApp();
    return app && app.platform !== 'unknown' ? { inside: true, platform: app.platform, top: (app.safeAreaInset?.top ?? 0) + (app.contentSafeAreaInset?.top ?? 0), bottom: (app.safeAreaInset?.bottom ?? 0) + (app.contentSafeAreaInset?.bottom ?? 0) } : { inside: false, platform: 'browser', top: 0, bottom: 0 };
  });
  useEffect(() => {
    if (!enabled) return;
    const app = telegramApp(); if (!app || app.platform === 'unknown') return;
    app.ready(); app.expand();
    const resize = () => {
      setEnvironment({ inside: true, platform: app.platform, top: (app.safeAreaInset?.top ?? 0) + (app.contentSafeAreaInset?.top ?? 0), bottom: (app.safeAreaInset?.bottom ?? 0) + (app.contentSafeAreaInset?.bottom ?? 0) });
      if (app.viewportStableHeight) document.documentElement.style.setProperty('--svoi-height', `${app.viewportStableHeight}px`);
    };
    if (app.viewportStableHeight) document.documentElement.style.setProperty('--svoi-height', `${app.viewportStableHeight}px`);
    for (const event of ['viewportChanged', 'safeAreaChanged', 'contentSafeAreaChanged']) app.onEvent(event, resize);
    return () => { for (const event of ['viewportChanged', 'safeAreaChanged', 'contentSafeAreaChanged']) app.offEvent(event, resize); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const app = telegramApp(); if (!app || app.platform === 'unknown') return;
    // Older Telegram clients can reject a custom header color. Content remains usable.
    try { app.setHeaderColor?.(background); } catch {}
    try { app.setBackgroundColor?.(background); } catch {}
    try { app.setBottomBarColor?.(background); } catch {}
  }, [background, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const back = telegramApp()?.BackButton; if (!back) return;
    const handler = () => ref.current();
    if (backVisible) back.show(); else back.hide();
    back.onClick(handler);
    return () => { back.offClick(handler); back.hide(); };
  }, [backVisible, enabled]);
  return environment;
}
export function telegramSuccess() {
  const app = telegramApp();
  if (app && app.platform !== 'unknown') { try { app.HapticFeedback?.notificationOccurred('success'); } catch {} }
}
