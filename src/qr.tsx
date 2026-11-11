import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { guestInput, guestQrDrawing, guestQrPattern } from './qr-code';
import { useStore } from './store';
import { telegramApp, TelegramApp } from './telegram';
import { Button, C, Callout, Field, Icon, Txt, s } from './ui';

export function GuestQr({ value, code, variant = 'default' }: { value: string; code: string; variant?: 'default' | 'elpastor' }) {
  const drawing = useMemo(() => guestQrDrawing(value), [value]);
  const club = variant === 'elpastor';
  // Integer modules and the original four-module quiet zone remain untouched.
  // A compact fixed size also fits inside the club sheet on a 320px phone.
  const moduleSize = drawing ? Math.max(4, Math.floor((club ? 218 : 246) / drawing.size)) : 5;
  const size = drawing ? drawing.size * moduleSize : 0;
  return <View testID={club ? 'elpastor-qr-card' : undefined} style={[s.card, { alignItems: 'center', gap: 12 }, club && { width: '100%', padding: 15, backgroundColor: '#350F1C', borderColor: '#75404A', borderRadius: 22, boxShadow: 'none' }]}>
    {!club && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="qr-code-outline" color={C.pine} size={20} /><Txt weight="bold">Ваш личный QR</Txt></View>}
    <View style={[{ maxWidth: '100%' }, club && { padding: 5, borderRadius: 16, backgroundColor: '#FFFFFF', alignItems: 'center' }]}>
      {drawing ? Platform.OS === 'web'
      ? <svg role="img" aria-label="Личный QR гостя" data-testid="guest-qr" width={size} height={size} viewBox={`0 0 ${drawing.size} ${drawing.size}`} style={{ maxWidth: '100%', height: 'auto', background: '#FFFFFF', display: 'block' }} shapeRendering="crispEdges"><rect width={drawing.size} height={drawing.size} fill="#FFFFFF" /><path d={drawing.path} fill="#000000" /></svg>
      : <View accessibilityRole="image" accessibilityLabel="Личный QR гостя" style={{ width: size, height: size, backgroundColor: '#FFFFFF' }}>{drawing.runs.map((run, index) => <View key={index} style={{ position: 'absolute', left: run.x * moduleSize, top: run.y * moduleSize, width: run.width * moduleSize, height: moduleSize, backgroundColor: '#000000' }} />)}</View>
      : <Txt style={[s.caption, club && { color: '#350F1C', padding: 12, textAlign: 'center' }]}>QR появится после синхронизации с сервером.</Txt>}
    </View>
    {!club && <Txt style={[s.caption, { textAlign: 'center' }]}>Покажите сотруднику при визите. Этот QR действует во всех заведениях «Своих».</Txt>}
    <View style={[{ backgroundColor: club ? '#FFF1DA' : C.pale, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center', gap: 4 }, club && { width: '100%' }]}><Txt style={[s.caption, club && { color: '#71442F', fontSize: 9, letterSpacing: 1.4 }]}>{club ? 'КОД ГОСТЯ' : 'Если камера не считывает'}</Txt><Txt selectable weight="extra" style={{ fontSize: 20, letterSpacing: 2, color: club ? '#350F1C' : C.ink }} accessibilityLabel={`Код гостя ${code}`}>{code || '—'}</Txt>{club && <Txt style={{ color: '#71442F', fontSize: 10 }}>Можно назвать сотруднику</Txt>}</View>
  </View>;
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorConstructor = { new(options: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };
type ScannerWindow = Window & { BarcodeDetector?: DetectorConstructor };

export function ScanGuest({ venueId, onResolved, onCancel }: { venueId: string; onResolved: (guestId: string) => void; onCancel?: () => void }) {
  const { command } = useStore();
  const [mode, setMode] = useState<'idle' | 'starting' | 'camera' | 'telegram'>('idle');
  const [nativeNeedsRecovery, setNativeNeedsRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const mounted = useRef(true);
  const locked = useRef(false);
  const opening = useRef(false);
  const generation = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const native = useRef<TelegramApp | null>(null);
  const pending = useRef<{ payload: string; key: string } | null>(null);

  const stopResources = useCallback(() => {
    generation.current++;
    opening.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    if (native.current) { try { native.current.closeScanQrPopup?.(); } catch {} native.current = null; }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const app = telegramApp();
    const closed = () => {
      if (native.current !== app) return;
      native.current = null; opening.current = false; generation.current++;
      if (mounted.current) setMode('idle');
    };
    app?.onEvent('scanQrPopupClosed', closed);
    return () => { mounted.current = false; app?.offEvent('scanQrPopupClosed', closed); stopResources(); };
  }, [stopResources]);
  useEffect(() => {
    // Opening Telegram's native scanner can hide the webview; leave that popup alone.
    const hidden = () => { if (document.visibilityState === 'hidden' && !native.current) { stopResources(); setMode('idle'); } };
    const leaving = () => { stopResources(); setMode('idle'); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hidden);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', leaving);
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hidden);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', leaving);
    };
  }, [stopResources]);

  const resolve = async (value: string, allowShortCode: boolean) => {
    if (locked.current || !mounted.current) return;
    let parsed: ReturnType<typeof guestInput>;
    try { parsed = guestInput(value, allowShortCode); }
    catch (e) { setError((e as Error).message); return; }
    locked.current = true; setBusy(true); setError(''); setInput(value.trim());
    stopResources(); setMode('idle');
    const payload = JSON.stringify({ ...parsed, venueId });
    if (pending.current?.payload !== payload) pending.current = { payload, key: globalThis.crypto.randomUUID() };
    try {
      const result = await command({ ...parsed, venueId }, pending.current.key);
      if (!result.guestId) throw new Error('Сервер не вернул гостя. Повторите попытку.');
      pending.current = null;
      if (mounted.current) onResolved(result.guestId);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Не удалось найти гостя. Повторите попытку.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };

  const startBrowser = async () => {
    stopResources();
    opening.current = true;
    const run = generation.current;
    setMode('starting'); setError('');
    try {
      const DetectorClass = typeof window === 'undefined' ? undefined : (window as ScannerWindow).BarcodeDetector;
      if (!DetectorClass || !navigator.mediaDevices?.getUserMedia) throw new Error('Эта камера не поддерживает сканирование в браузере. Откройте «Свои» в Telegram на телефоне или введите код гостя ниже.');
      if (DetectorClass.getSupportedFormats && !(await DetectorClass.getSupportedFormats()).includes('qr_code')) throw new Error('Браузер не распознаёт QR. Используйте сканер Telegram или код гостя ниже.');
      if (generation.current !== run || !mounted.current) return;
      const detector = new DetectorClass({ formats: ['qr_code'] });
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (generation.current !== run || !mounted.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      media.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (generation.current !== run || !mounted.current) return;
        stopResources(); setMode('idle');
        setError('Камера отключилась. Откройте её снова или введите код гостя ниже.');
      }, { once: true }));
      if (!video.current) throw new Error('Не удалось открыть камеру. Введите код гостя ниже.');
      video.current.srcObject = media;
      await video.current.play();
      if (generation.current !== run || !mounted.current) return;
      setMode('camera');
      const detect = async () => {
        if (generation.current !== run || !mounted.current || !video.current || locked.current) return;
        try {
          if (video.current.readyState >= 2) {
            const results = await detector.detect(video.current);
            if (generation.current !== run || !mounted.current) return;
            const match = results.find(result => guestQrPattern.test(result.rawValue.trim()));
            if (match) { void resolve(match.rawValue, false); return; }
            if (results.length) setError('В кадре другой QR. Покажите личный QR гостя из «Своих».');
          }
          if (generation.current === run && mounted.current) timer.current = setTimeout(() => void detect(), 250);
        } catch { if (generation.current === run && mounted.current) { stopResources(); setMode('idle'); setError('Камера не смогла прочитать QR. Попробуйте сканер Telegram или введите код гостя.'); } }
      };
      void detect();
    } catch (e) {
      if (generation.current !== run || !mounted.current) return;
      stopResources(); setMode('idle');
      const cameraError = e as Error;
      setError(cameraError.name === 'NotAllowedError' ? 'Доступ к камере не разрешён. Разрешите его в настройках или введите код гостя ниже.' : cameraError.name === 'NotFoundError' ? 'Камера не найдена. Введите код гостя ниже.' : cameraError.name === 'NotReadableError' ? 'Камера занята другим приложением. Закройте его и попробуйте снова или введите код гостя ниже.' : cameraError.message || 'Не удалось открыть камеру. Введите код гостя ниже.');
    }
  };

  const start = () => {
    // Telegram 6.4–7.6 does not report a user-cancelled scanner. Let the visible
    // retry button close that stale session before starting a new one.
    const recovering = mode === 'telegram' && nativeNeedsRecovery;
    if (locked.current || (!recovering && (opening.current || mode !== 'idle'))) return;
    if (recovering) stopResources();
    opening.current = true;
    const app = telegramApp();
    const version = app?.version.split('.').map(Number) ?? [0];
    const supportedVersion = version[0] > 6 || (version[0] === 6 && version[1] >= 4);
    if (app?.showScanQrPopup && supportedVersion && ['android', 'android_x', 'ios'].includes(app.platform)) {
      const run = ++generation.current;
      setNativeNeedsRecovery(!(version[0] > 7 || (version[0] === 7 && version[1] >= 7)));
      setError(''); setMode('telegram'); native.current = app;
      try {
        app.showScanQrPopup({ text: 'Наведите камеру на личный QR гостя «Своих»' }, value => {
          if (!mounted.current || locked.current || generation.current !== run) return true;
          if (!guestQrPattern.test(value.trim())) { setError('Это другой QR. Покажите личный QR гостя из «Своих».'); return false; }
          native.current = null; // Returning true closes the native popup once.
          void resolve(value, false); return true;
        });
        return;
      } catch { native.current = null; }
    }
    void startBrowser();
  };

  const stop = () => { stopResources(); setMode('idle'); };
  return <View style={{ gap: 17 }}>
    <Callout icon="qr-code-outline">Сканируйте личный QR гостя. Затем проверьте имя и подтвердите визит.</Callout>
    <Button label={mode === 'starting' ? 'Запрашиваем камеру…' : mode === 'telegram' ? nativeNeedsRecovery ? 'Открыть сканер снова' : 'Сканер Telegram открыт' : mode === 'camera' ? 'Камера открыта' : 'Открыть камеру'} icon="scan-outline" disabled={busy || (mode !== 'idle' && !(mode === 'telegram' && nativeNeedsRecovery))} onPress={start} />
    {Platform.OS === 'web' && <video ref={video} playsInline muted autoPlay aria-label="Камера для сканирования QR гостя" style={{ display: mode === 'camera' || mode === 'starting' ? 'block' : 'none', width: '100%', maxHeight: 270, borderRadius: 18, objectFit: 'cover', background: '#101710' }} />}
    {mode !== 'idle' && <Button label="Закрыть камеру" variant="ghost" onPress={stop} />}
    <View style={{ gap: 11 }}><Txt weight="bold">Не получается отсканировать?</Txt><Field label="Код гостя или текст QR" placeholder="8 символов под QR гостя" value={input} onChangeText={value => { setInput(value); setError(''); }} maxLength={100} autoCorrect={false} autoCapitalize="none" editable={!busy} /><Button label="Найти гостя по коду" variant="secondary" loading={busy} disabled={!input.trim()} onPress={() => void resolve(input, true)} /></View>
    {!!error && <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 20 }}>{error}</Txt>}
    {onCancel && <Button label="Отмена" variant="ghost" disabled={busy} onPress={() => { stopResources(); onCancel(); }} />}
  </View>;
}
