import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import type { Venue } from './domain';
import { defaultServiceFlow, validateServiceFlow, waiterPlatform, waiterStore } from './service-flow';
import { telegramApp } from './telegram';
import { Button, C, Txt, s } from './ui';

export async function openWaiterLink(url: string) {
  const app = telegramApp();
  if (app?.openLink && app.platform !== 'unknown') app.openLink(url, { try_instant_view: false });
  else if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  else await Linking.openURL(url);
}

export function WaiterHandoff({ venue }: { venue: Venue; guestId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [choice, setChoice] = useState<'android' | 'ios' | null>(null);
  let flow;
  try { flow = validateServiceFlow(venue.serviceFlow ?? defaultServiceFlow()); } catch { return null; }
  if (flow.cashSystem !== 'iiko') return null;
  const detected = waiterPlatform(telegramApp()?.platform ?? '', typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const device = detected ?? choice;
  const target = device === 'android' ? flow.waiterAndroidUrl : device === 'ios' ? flow.waiterIosUrl : '';
  const open = (url: string) => {
    setMessage('Если приложение не открылось, переключитесь в iikoWaiter вручную. Карточка гостя останется в «Своих».');
    void openWaiterLink(url).catch(() => setMessage('Не удалось открыть ссылку. Переключитесь в установленный iikoWaiter вручную.'));
  };
  return <View style={[s.card, { gap: 12, borderColor: C.pine }]}>
    <Txt weight="bold" style={{ fontSize: 17 }}>Продолжить обслуживание</Txt>
    <Txt style={s.caption}>Заказ оформляется в iikoWaiter. Предпочтения и история гостя остаются здесь.</Txt>
    {!device && <View style={{ gap: 8 }}><Txt style={s.caption}>Выберите телефон сотрудника</Txt><Button label="Android" variant="secondary" onPress={() => setChoice('android')} /><Button label="iPhone" variant="secondary" onPress={() => setChoice('ios')} /></View>}
    {target ? <Button label="Перейти в iikoWaiter" icon="open-outline" onPress={() => open(target)} />
      : <><Button label="Как перейти в iikoWaiter" icon="open-outline" variant="secondary" onPress={() => setExpanded(!expanded)} /><Txt style={s.caption}>Быстрый переход для этого телефона ещё не настроен.</Txt></>}
    {expanded && <View style={{ gap: 10 }}><Txt style={s.caption}>Сверните Telegram и откройте установленный iikoWaiter. Выберите стол и создайте заказ. Для возврата к карточке откройте «Свои» в Telegram.</Txt><Txt style={s.caption}>Передача гостя и его бонусов в заказ пока не подключена. QR сам по себе не создаёт визит и не начисляет бонусы.</Txt>{device && <Button label={`Установить iikoWaiter · ${device === 'ios' ? 'App Store' : 'Google Play'}`} variant="ghost" onPress={() => { void openWaiterLink(waiterStore[device]).catch(() => setMessage('Не удалось открыть магазин приложений.')); }} />}</View>}
    {target && <><Txt style={s.caption}>Откроется ссылка, настроенная руководителем. Данные гостя в неё не передаются.</Txt><Button label="Помощь с переходом и установкой" variant="ghost" onPress={() => setExpanded(!expanded)} /></>}
    {message ? <Txt accessibilityRole="alert" style={s.caption}>{message}</Txt> : null}
  </View>;
}
