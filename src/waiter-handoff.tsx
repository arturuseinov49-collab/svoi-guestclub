import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import type { Venue } from './domain';
import { defaultServiceFlow, validateServiceFlow, waiterPlatform, waiterStore } from './service-flow';
import { telegramApp } from './telegram';
import { Button, C, Field, Txt, s } from './ui';
import { useStore } from './store';
import { useMutation } from './panels';
import { activeService, ServiceSessionCard } from './service-ui';
import { effectiveGuestProfile } from './venue-profile';

export async function openWaiterLink(url: string) {
  const app = telegramApp();
  if (app?.openLink && app.platform !== 'unknown') app.openLink(url, { try_instant_view: false });
  else if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  else await Linking.openURL(url);
}

export function WaiterHandoff({ venue, guestId }: { venue: Venue; guestId: string }) {
  const { db, user, serviceSessions, serviceReadiness, staffVenues } = useStore();
  const [table, setTable] = useState('');
  const [attempt, setAttempt] = useState<{ tableLabel: string; previousSessionId: string | null } | null>(null);
  const [validation, setValidation] = useState('');
  const mutation = useMutation();
  const cashSystem = venue.serviceFlow?.cashSystem ?? 'none';
  const sessions = serviceSessions?.filter(item => item.venueId === venue.id && item.guestId === guestId).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = sessions?.find(activeService);
  const assignedToMe = current?.staffUserId === user?.id;
  const readiness = serviceReadiness?.find(item => item.venueId === venue.id);
  const manager = staffVenues.some(item => item.venueId === venue.id && item.role === 'owner');
  const name = db.guests.find(item => item.id === guestId)?.name ?? 'этот гость';
  const profile = effectiveGuestProfile(venue);
  const canStart = !profile.demo && profile.features.visits;
  const save = () => {
    const input = attempt ?? { tableLabel: table.trim(), previousSessionId: sessions?.[0]?.id ?? null };
    if (!input.tableLabel) { setValidation('Укажите номер стола'); return; }
    setAttempt(input); setValidation('');
    void mutation.run({ type: 'startService', venueId: venue.id, guestId, ...input }, result => {
      if (!result.sessionId) { setValidation('Сервер не подтвердил сохранение стола. Повторите проверку.'); return; }
      setAttempt(null); setTable('');
    });
  };
  if (cashSystem === 'none' && !sessions?.length) return null;
  if (serviceSessions === null) return <View style={[s.card, { gap: 10 }]}><Txt weight="bold">Обслуживание стола пока недоступно</Txt><Txt style={s.caption}>Сервер ещё не поддерживает сохранение стола. Обновите данные немного позже.</Txt></View>;
  return <View style={{ gap: 14 }}>
    {current && <ServiceSessionCard session={current} staff manager={manager} />}
    {canStart && (!current || attempt !== null) && <View testID="service-table-form" style={[s.card, { gap: 12, borderColor: C.pine }]}>
      <Txt weight="extra" style={{ fontSize: 20 }}>За какой стол садится гость?</Txt>
      <Field label="Номер стола" placeholder="Например, 12" value={attempt?.tableLabel ?? table} onChangeText={setTable} maxLength={40} autoCorrect={false} editable={!mutation.busy && attempt === null} />
      {readiness?.ready && !!readiness.tableLabels.length && <Txt style={s.caption}>Настроенные столы: {readiness.tableLabels.slice(0, 20).join(', ')}{readiness.tableLabels.length > 20 ? '…' : ''}. Укажите номер точно, включая ведущий ноль.</Txt>}
      <Txt style={{ fontSize: 13, lineHeight: 21 }}>Заказ и чек этого стола будут привязаны к {name}.</Txt>
      <Txt style={s.caption}>Закрепите стол за одним гостем. Это не отмечает визит и не начисляет бонусы.</Txt>
      {(!readiness?.ready || !readiness.staffMapped) && <Txt style={s.caption}>Руководителю ещё нужно завершить подключение кассы и настройку столов. Пока сохраним ожидание заказа.</Txt>}
      {(mutation.error || validation) ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 20 }}>{mutation.error || validation}</Txt> : null}
      <Button label={attempt !== null && !mutation.busy ? 'Проверить сохранение стола' : 'Сохранить стол'} icon="checkmark-outline" loading={mutation.busy} disabled={attempt === null && !table.trim()} onPress={save} />
      {attempt !== null && !mutation.busy && !current && <Button label="Исправить номер стола" variant="ghost" onPress={() => { setTable(attempt.tableLabel); setAttempt(null); setValidation(''); }} />}
    </View>}
    {!canStart && !current && <Txt style={s.caption}>Обслуживание столов в этом заведении пока не включено.</Txt>}
    {current && !assignedToMe && <Txt style={s.caption}>Стол закреплён за другим сотрудником. Заказ в кассе оформляет назначенный официант.</Txt>}
    {current && assignedToMe && attempt === null && cashSystem === 'iiko' && <WaiterLaunch venue={venue} tableLabel={current.tableLabel} />}
    {current && assignedToMe && attempt === null && cashSystem === 'rkeeper' && <Txt style={s.caption}>Откройте стол {current.tableLabel} в r_keeper и оформите заказ под своим кассовым аккаунтом. После обмена с кассой заказ появится в карточке.</Txt>}
    {!!sessions?.filter(item => !activeService(item)).length && <View style={{ gap: 10 }}><Txt weight="bold">Прошлые заказы столов</Txt>{sessions.filter(item => !activeService(item)).slice(0, 3).map(item => <ServiceSessionCard key={item.id} session={item} staff manager={manager} />)}</View>}
  </View>;
}

function WaiterLaunch({ venue, tableLabel }: { venue: Venue; tableLabel: string }) {
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
    <Txt style={s.caption}>Стол {tableLabel} сохранён в «Своих». Откройте этот стол в iikoWaiter под своим кассовым аккаунтом и оформите заказ.</Txt>
    {!device && <View style={{ gap: 8 }}><Txt style={s.caption}>Выберите телефон сотрудника</Txt><Button label="Android" variant="secondary" onPress={() => setChoice('android')} /><Button label="iPhone" variant="secondary" onPress={() => setChoice('ios')} /></View>}
    {target ? <Button label="Перейти в iikoWaiter" icon="open-outline" onPress={() => open(target)} />
      : <><Button label="Как перейти в iikoWaiter" icon="open-outline" variant="secondary" onPress={() => setExpanded(!expanded)} /><Txt style={s.caption}>Быстрый переход для этого телефона ещё не настроен.</Txt></>}
    {expanded && <View style={{ gap: 10 }}><Txt style={s.caption}>Сверните Telegram и откройте установленный iikoWaiter. Выберите стол {tableLabel} и создайте заказ. Для возврата к карточке откройте «Свои» в Telegram.</Txt><Txt style={s.caption}>Ссылка предназначена для перехода. Если приложение не открылось, переключитесь вручную. Заказ связывается с гостем через подключённую кассу по столу, сотруднику и времени. QR сам по себе не создаёт визит и не начисляет бонусы.</Txt>{device && <Button label={`Установить iikoWaiter · ${device === 'ios' ? 'App Store' : 'Google Play'}`} variant="ghost" onPress={() => { void openWaiterLink(waiterStore[device]).catch(() => setMessage('Не удалось открыть магазин приложений.')); }} />}</View>}
    {target && <><Txt style={s.caption}>Откроется ссылка, настроенная руководителем. Данные гостя в неё не передаются.</Txt><Button label="Помощь с переходом и установкой" variant="ghost" onPress={() => setExpanded(!expanded)} /></>}
    {message ? <Txt accessibilityRole="alert" style={s.caption}>{message}</Txt> : null}
  </View>;
}
