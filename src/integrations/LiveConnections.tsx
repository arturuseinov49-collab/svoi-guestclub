import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { money } from '../domain';
import { useStore } from '../store';
import { Button, C, Callout, Field, Pill, Section, Txt, s } from '../ui';

type Provider = 'iiko' | 'rkeeper';
type Connection = { id: string; provider: Provider; scope: string; enabled: boolean; verifiedAt: number | null; lastSuccessAt: string | null; lastError: string | null; counts: Record<string, number> };
type Receipt = { connectionId: string; externalId: string; provider: Provider; customerId: string | null; status: string; billMinor: number | null; closedAt: string | null; earned: number; guestId: string | null; message: string };
type Status = { storageReady: boolean; connections: Connection[]; receipts: Receipt[]; heldGuests: number };
const name = (provider: Provider) => provider === 'iiko' ? 'iiko' : 'r_keeper';
const when = (date: string | number) => new Date(date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function LiveConnections({ venueId }: { venueId: string }) {
  const { posRequest, staffVenues } = useStore();
  const owner = staffVenues.some(venue => venue.venueId === venueId && venue.role === 'owner');
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const [provider, setProvider] = useState<Provider | null>(null);
  const [binding, setBinding] = useState<Receipt | null>(null); const [guestCode, setGuestCode] = useState('');
  const [setup, setSetup] = useState<{ webhookUrl: string; webhookToken: string } | null>(null);
  const [revealToken, setRevealToken] = useState(false);
  const refresh = useCallback(async () => { const next = await posRequest<Status>('status', { venueId }); setStatus(next); }, [posRequest, venueId]);
  useEffect(() => {
    let active = true;
    const load = () => { void posRequest<Status>('status', { venueId }).then(next => { if (active) { setStatus(next); setError(''); } }).catch(cause => { if (active) setError(cause.message); }); };
    load(); const timer = setInterval(load, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [posRequest, venueId]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); setNotice(success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие'); }
    finally { setBusy(false); }
  };
  return <View style={{ gap: 18 }}>
    <Callout icon="business-outline">Каждая касса привязана только к этому заведению. Бонусы начисляются по его программе в «Своих». Баланс в кассовой системе не изменяется.</Callout>
    {error ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 19 }}>{error}</Txt> : null}
    {notice ? <Txt accessibilityRole="alert" style={{ color: C.pine, fontSize: 12 }}>{notice}</Txt> : null}
    {!status && !error && <Txt style={s.caption}>Загружаем подключения…</Txt>}
    {status && <>
      {status.connections.length === 0 && <View style={[s.card, { gap: 12 }]}><Pill label="Кассы пока не подключены" background={C.pale} /><Txt weight="bold" style={{ fontSize: 20 }}>Подключите своё заведение</Txt><Txt style={s.caption}>Понадобятся API-доступы администратора iikoCloud или r_keeper White Server. После проверки соединения руководитель включает автоматический обмен.</Txt></View>}
      {status.connections.map(connection => <View key={connection.id} style={[s.card, { gap: 12 }]}>
        <View style={[s.row, { flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }]}><Txt weight="extra" style={{ fontSize: 22 }}>{name(connection.provider)}</Txt><Pill label={connection.lastError === 'review_required' ? 'Нужна сверка' : connection.enabled ? connection.lastError ? 'Ошибка обмена' : connection.lastSuccessAt ? 'Обмен включён' : 'Ожидаем чеки' : connection.verifiedAt ? 'Обмен выключен' : 'Требуется настройка'} /></View>
        <Txt selectable style={{ color: C.muted, fontSize: 11 }}>Касса: {connection.scope}</Txt>
        <Txt style={s.caption}>{connection.lastSuccessAt ? `Последний обмен: ${when(connection.lastSuccessAt)}` : 'Успешного получения чеков ещё не было.'}</Txt>
        <Txt style={s.caption}>Учтено: {connection.counts.imported ?? 0} · Без привязки: {connection.counts.unmatched ?? 0} · Сверка: {(connection.counts.review ?? 0) + (connection.counts.held ?? 0)}</Txt>
        {connection.lastError && <Callout>{connection.lastError === 'review_required' ? 'Получен возврат без связи с исходным чеком. Обмен остановлен до сверки администратором интеграции.' : 'Проверьте доступы и разрешения кассы. Автоматические попытки продолжаются, пока обмен включён.'}</Callout>}
        {owner && <>
          <Button label={`Проверить ${name(connection.provider)}`} icon="pulse-outline" variant="secondary" loading={busy} onPress={() => { void run(() => posRequest('probe', { connectionId: connection.id }), 'Соединение проверено. Теперь можно включить обмен.'); }} />
          <Button label={connection.enabled ? `Остановить обмен ${name(connection.provider)}` : `Включить обмен ${name(connection.provider)}`} icon={connection.enabled ? 'pause-outline' : 'sync-outline'} variant={connection.enabled ? 'ghost' : 'primary'} disabled={busy || (!connection.enabled && !connection.verifiedAt)} onPress={() => { void run(() => posRequest('enabled', { connectionId: connection.id, enabled: !connection.enabled }), connection.enabled ? 'Обмен остановлен.' : 'Обмен включён. Чеки появятся после получения из кассы.'); }} />
          {connection.provider === 'iiko' && <Button label="Параметры вебхука iiko" variant="ghost" disabled={busy} onPress={() => { void run(async () => { setRevealToken(false); setSetup(await posRequest('webhook-setup', { connectionId: connection.id })); }, 'Параметры видит только руководитель.'); }} />}
        </>}
      </View>)}
      {setup && <View style={[s.card, { gap: 12 }]}><Txt weight="bold">Настройка TableOrderUpdate</Txt><Txt style={s.caption}>Передайте эти значения администратору iiko. Для организации возможен один адрес вебхука: существующее подключение сначала согласуйте с ним.</Txt><Field label="Адрес вебхука" value={setup.webhookUrl} editable={false} /><Field label="Токен вебхука — секрет" value={setup.webhookToken} editable={false} secureTextEntry={!revealToken} /><Button label={revealToken ? 'Скрыть токен' : 'Показать токен для копирования'} variant="ghost" onPress={() => setRevealToken(!revealToken)} /><Button label="Скрыть параметры" variant="ghost" onPress={() => { setSetup(null); setRevealToken(false); }} /></View>}
      {owner && !provider && <><Section title="Добавить или обновить кассу" /><View style={{ gap: 10 }}><Button label="Настроить iiko" variant="secondary" disabled={!status.storageReady || busy} onPress={() => setProvider('iiko')} /><Button label="Настроить r_keeper" variant="secondary" disabled={!status.storageReady || busy} onPress={() => setProvider('rkeeper')} /></View>{!status.storageReady && <Callout>Администратору сервера нужно включить защищённое хранение API-ключей.</Callout>}</>}
      {provider && owner && <ConnectionForm provider={provider} busy={busy} onCancel={() => setProvider(null)} onSave={config => run(async () => { await posRequest('configure', { venueId, provider, config }); setProvider(null); }, 'Ключи сохранены на сервере. Обмен выключен до проверки и включения.')} />}
      {!owner && <Txt style={s.caption}>Ключи кассы и привязки гостей настраивает руководитель заведения.</Txt>}
      {status.heldGuests > 0 && <Callout>Начисления приостановлены для {status.heldGuests} гостей из-за изменений или возвратов. Нужна сверка с кассовым отчётом; автоматического сторнирования пока нет.</Callout>}
      <Section title="Чеки из кассы" />
      {!status.receipts.length && <Txt style={s.caption}>Здесь появятся реальные чеки после подключения. Повторное получение одного чека не создаёт ещё одно начисление.</Txt>}
      {status.receipts.map(receipt => <View key={`${receipt.connectionId}:${receipt.externalId}`} style={[s.card, { gap: 9 }]}>
        <View style={[s.row, { justifyContent: 'space-between', gap: 10 }]}><Pill label={name(receipt.provider)} /><Txt weight="bold">{receipt.billMinor === null ? 'Сумма неизвестна' : `${money(receipt.billMinor / 100)} ₽`}</Txt></View>
        <Txt selectable style={{ color: C.muted, fontSize: 10 }}>Чек {receipt.externalId}</Txt><Txt style={{ fontSize: 12, lineHeight: 18 }}>{receipt.message}{receipt.status === 'imported' ? ` · +${receipt.earned} Б` : ''}</Txt>
        {receipt.closedAt && <Txt style={s.caption}>{when(receipt.closedAt)}</Txt>}
        {owner && receipt.status === 'unmatched' && receipt.customerId && <Button label="Привязать гостя к кассе" variant="secondary" disabled={busy} onPress={() => { setBinding(receipt); setGuestCode(''); }} />}
        {receipt.status === 'unmatched' && !receipt.customerId && <Txt style={s.caption}>Касса не передала идентификатор клиента. Администратору нужно настроить передачу гостя в заказе.</Txt>}
      </View>)}
      {binding && <View style={[s.card, { gap: 12 }]}><Txt weight="bold">Кому принадлежит чек?</Txt><Txt style={s.caption}>Гость должен уже состоять в клубе. После привязки накопленные и будущие оплаченные чеки этого клиента будут начислять ему бонусы.</Txt><Field label="Код гостя для кассы" value={guestCode} onChangeText={setGuestCode} autoCapitalize="characters" maxLength={16} /><Button label="Подтвердить привязку" disabled={busy || guestCode.trim().length < 8} onPress={() => { void run(async () => { await posRequest('bind', { connectionId: binding.connectionId, externalId: binding.externalId, guestCode }); setBinding(null); setGuestCode(''); }, 'Гость привязан. Подходящие чеки обработаны.'); }} /><Button label="Отменить привязку" variant="ghost" onPress={() => setBinding(null)} /></View>}
      <Button label="Обновить состояние касс" variant="ghost" icon="refresh-outline" disabled={busy} onPress={() => { void run(refresh, 'Состояние обновлено.'); }} />
    </>}
  </View>;
}

function ConnectionForm({ provider, busy, onSave, onCancel }: { provider: Provider; busy: boolean; onSave: (config: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [fields, setFields] = useState<Record<string, string>>({ offset: '180' });
  const field = (key: string, label: string, secret = false, hint?: string) => <Field key={key} label={label} placeholder={hint} value={fields[key] ?? ''} onChangeText={value => setFields(current => ({ ...current, [key]: value }))} secureTextEntry={secret} autoCapitalize="none" autoCorrect={false} maxLength={secret ? 4096 : 4000} />;
  const save = () => {
    const config = provider === 'iiko' ? { appId: fields.appId, clientSecret: fields.clientSecret, apiKey: fields.apiKey, organizationId: fields.organizationId, terminalGroupIds: (fields.terminalGroupIds ?? '').split(/[\s,;]+/).filter(Boolean), utcOffsetMinutes: Number(fields.offset) } : { objectId: fields.objectId, token: fields.token, customerIdProperty: fields.customerIdProperty, closedAtProperty: fields.closedAtProperty, currency: fields.currency };
    void onSave(config);
  };
  return <View style={[s.card, { gap: 14 }]}>
    <Txt weight="extra" style={{ fontSize: 22 }}>{name(provider)} · подключение</Txt>
    <Callout>Доступы выдаёт администратор кассы. Ключи сохраняются зашифрованными на сервере. Сохранение настроек само по себе не включает начисления.</Callout>
    {provider === 'iiko' ? <>
      <Txt style={s.caption}>Поддерживается iikoCloud. Для локального iiko сначала нужен доступ Cloud API. appId и clientSecret — от зарегистрированного приложения интеграции.</Txt>
      {field('organizationId', 'iiko: organizationId')}{field('terminalGroupIds', 'iiko: terminalGroupIds', false, 'Идентификаторы через запятую')}{field('appId', 'iiko: appId')}{field('clientSecret', 'iiko: clientSecret', true)}{field('apiKey', 'iiko: API-ключ', true)}{field('offset', 'Часовой пояс кассы, минут от UTC', false, 'Москва: 180')}
    </> : <>
      <Callout>Нужны White Server и лицензия интеграции. Администратор должен разрешить чтение закрытых заказов всех столов и настроить дополнительные поля клиента и фактического времени закрытия. Без этих данных автоматическое начисление недоступно.</Callout>
      {field('objectId', 'r_keeper: objectId')}{field('token', 'r_keeper: токен White Server', true)}{field('customerIdProperty', 'Поле идентификатора клиента', false, 'Название extProperties из кассы')}{field('closedAtProperty', 'Поле времени закрытия чека', false, 'Название extProperties из кассы')}
      <Button label={fields.currency === 'RUB' ? 'Валюта ресторана: российский рубль ✓' : 'Подтвердить: валюта ресторана — российский рубль'} variant="secondary" onPress={() => setFields(current => ({ ...current, currency: current.currency === 'RUB' ? '' : 'RUB' }))} />
    </>}
    <Button label="Сохранить подключение" onPress={save} loading={busy} /><Button label="Отмена настройки" variant="ghost" disabled={busy} onPress={onCancel} />
  </View>;
}
