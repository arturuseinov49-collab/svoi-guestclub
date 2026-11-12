import React, { useState } from 'react';
import { View } from 'react-native';
import { money } from './domain';
import { bonusColors, BonusTheme } from './bonus-ui';
import { useStore } from './store';
import { useMutation } from './panels';
import type { ServiceSessionView, ServiceStatus } from './service-sessions';
import { Button, C, Txt, s } from './ui';

export const activeService = (session: ServiceSessionView) => !['closed', 'cancelled', 'expired'].includes(session.status);
const when = (date: string) => new Date(date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const labels: Record<ServiceStatus, string> = { awaiting_setup: 'Стол сохранён · ждём подключения кассы', awaiting_order: 'Ждём заказ из кассы', linked: 'Заказ из кассы', review: 'Заказ на сверке', closed: 'Чек оплачен', cancelled: 'Ожидание отменено', expired: 'Время ожидания истекло' };
const descriptions: Partial<Record<ServiceStatus, string>> = {
  awaiting_setup: 'Касса ещё не готова к автоматическому обмену. Заказ появится после подключения, бонусы — после подтверждения оплаты.',
  awaiting_order: 'Когда касса передаст подходящий заказ этого стола, он появится здесь.',
  review: 'Нужна сверка связи с заказом у руководителя. До её окончания состав и сумма не показываются.',
  cancelled: 'Связь с будущим заказом отменена. Заказы в кассе не изменились.',
  expired: 'Заказ не удалось получить за время ожидания. Обратитесь к сотруднику.',
};

export function ServiceSessionCard({ session, theme = 'default', staff = false, manager = false }: { session: ServiceSessionView; theme?: BonusTheme; staff?: boolean; manager?: boolean }) {
  const colors = bonusColors(theme);
  const mutation = useMutation();
  const [cancel, setCancel] = useState(false);
  const [candidate, setCandidate] = useState('');
  // A review must not render a previous order even if a stale response contains it.
  const order = session.status === 'review' ? undefined : session.order;
  return <View testID={`service-session-${session.id}`} style={[s.card, { gap: 12, minWidth: 0, backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={{ gap: 5 }}><Txt weight="bold" style={{ fontSize: 10, letterSpacing: 1, color: colors.accent }}>ЗАКАЗ СТОЛА</Txt><Txt weight="extra" style={{ fontSize: 24, color: colors.ink }}>Стол {session.tableLabel}</Txt><Txt style={{ color: colors.muted, fontSize: 11 }}>{when(session.createdAt)}</Txt></View>
    <Txt weight="bold" style={{ color: colors.accent, fontSize: 13, lineHeight: 21 }}>{labels[session.status]}</Txt>
    {descriptions[session.status] && <Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>{descriptions[session.status]}</Txt>}
    {order && <View style={{ gap: 11 }}>
      {order.items.length ? order.items.map((item, index) => <View key={index} style={{ gap: 4, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border }}><Txt style={{ color: colors.ink, fontSize: 13, lineHeight: 21 }}>{item.name}</Txt><Txt style={{ color: colors.muted, fontSize: 12 }}>Количество: {String(item.quantity).replace('.', ',')}{item.sumMinor === null ? '' : ` · ${money(item.sumMinor / 100)} ₽`}</Txt></View>) : <Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>Касса пока не передала состав заказа.</Txt>}
      <Txt weight="extra" style={{ color: colors.ink, fontSize: 20 }}>{order.billMinor === null ? 'Сумма пока не передана' : `Итого: ${money(order.billMinor / 100)} ₽`}</Txt>
      {session.status === 'closed' && order.closedAt && <Txt style={{ color: colors.muted, fontSize: 11 }}>Оплата подтверждена кассой · {when(order.closedAt)}</Txt>}
      {staff && order.comment && <View style={{ gap: 4 }}><Txt weight="bold" style={{ color: colors.ink, fontSize: 12 }}>Комментарий к заказу · для команды</Txt><Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>{order.comment}</Txt></View>}
    </View>}
    {activeService(session) && session.status !== 'review' && <Txt style={{ color: colors.muted, fontSize: 11, lineHeight: 18 }}>Запись стола ещё не является оплаченным визитом и не начисляет бонусы.</Txt>}
    {staff && session.note && <Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>Команде: {session.note}</Txt>}
    {manager && !!session.candidates?.length && <View style={{ gap: 10 }}><Txt weight="bold">{session.status === 'cancelled' ? 'Сверить чек после отмены ожидания' : session.status === 'expired' ? 'Сверить чек после истечения ожидания' : 'Выберите заказ после сверки с кассой'}</Txt>{session.candidates.map(item => <Button key={item.externalId} label={`${item.externalId} · ${item.billMinor === null ? 'сумма неизвестна' : `${money(item.billMinor / 100)} ₽`}${item.openedAt ? ` · ${when(item.openedAt)}` : ''}`} variant={candidate === item.externalId ? 'primary' : 'secondary'} onPress={() => setCandidate(item.externalId)} disabled={mutation.busy} />)}{candidate && <><Txt style={s.caption}>Состав и чек выбранного заказа будут доступны этому гостю.</Txt><Button label="Подтвердить связь с заказом" loading={mutation.busy} onPress={() => void mutation.run({ type: 'resolveServiceOrder', venueId: session.venueId, sessionId: session.id, externalId: candidate }, () => setCandidate(''))} /></>}</View>}
    {staff && session.canCancel && (cancel ? <View style={{ gap: 8 }}><Txt style={s.caption}>Отменить ожидание заказа для этого гостя? Сам заказ в кассе останется без изменений.</Txt><Button label="Подтвердить отмену ожидания" loading={mutation.busy} onPress={() => void mutation.run({ type: 'cancelService', venueId: session.venueId, sessionId: session.id }, () => setCancel(false))} /><Button label="Продолжить ожидание" variant="ghost" disabled={mutation.busy} onPress={() => setCancel(false)} /></View> : <Button label="Отменить ожидание заказа" variant="ghost" onPress={() => setCancel(true)} />)}
    {mutation.error ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 20 }}>{mutation.error}</Txt> : null}
  </View>;
}

export function GuestServiceHistory({ venueId, theme = 'default', activeOnly = false }: { venueId: string; theme?: BonusTheme; activeOnly?: boolean }) {
  const { guestId, serviceSessions } = useStore();
  const colors = bonusColors(theme);
  const sessions = serviceSessions?.filter(item => item.venueId === venueId && item.guestId === guestId && (!activeOnly || activeService(item))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (activeOnly && !sessions?.length) return null;
  return <View testID="guest-service-history" style={{ gap: 12 }}><Txt weight="extra" style={{ fontSize: 20, color: colors.ink }}>{activeOnly ? 'Ваш стол сейчас' : 'Заказы и чеки столов'}</Txt>{sessions === undefined ? <Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>История заказов пока недоступна. Обновите приложение немного позже.</Txt> : sessions.length ? sessions.map(session => <ServiceSessionCard key={session.id} session={session} theme={theme} />) : <Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>Покажите сотруднику свой QR. После привязки стола здесь появится статус обслуживания, а после обмена с кассой — заказ и чек.</Txt>}</View>;
}
