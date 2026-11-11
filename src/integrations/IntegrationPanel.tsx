import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Database, PosEvent, money, shortDate } from '../domain';
import { PanelProps } from '../panels';
import { createSeed } from '../seed';
import { Button, C, Callout, Icon, Pill, Section, Sheet, Txt, s } from '../ui';
import { Fixture, Provider, Scenario, createFixture, normalizeFixture, processReceipt, providerName } from './pos';
import { LiveConnections } from './LiveConnections';
export function IntegrationPanel(p: PanelProps) {
  if (p.panel?.kind !== 'integrations') return null;
  return <Sheet visible title="Касса и «Свои»" subtitle={p.venue.name} onClose={() => p.setPanel(null)}><ConnectionTabs key={p.venue.id} {...p} /></Sheet>;
}
function ConnectionTabs(p: PanelProps) {
  const [demo, setDemo] = useState(false);
  return <View style={{ gap: 18 }}><Button label={demo ? 'Вернуться к подключениям' : 'Открыть тестовую песочницу'} variant="ghost" icon={demo ? 'business-outline' : 'flask-outline'} onPress={() => setDemo(!demo)} />{demo ? <IntegrationBody {...p} venue={{ ...p.venue, id: 'list' }} /> : <LiveConnections venueId={p.venue.id} />}</View>;
}
function IntegrationBody(p: PanelProps) {
  // POS fixtures operate only in this component's disposable sandbox, never the live API.
  const [db, setDb] = useState<Database>(createSeed);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState<Provider>('iiko');
  const [scenario, setScenario] = useState<Scenario>('closed');
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [result, setResult] = useState<PosEvent | null>(null);
  const [manualGuest, setManualGuest] = useState<string | undefined>();
  const [raw, setRaw] = useState(false);
  const [offlineChecked, setOfflineChecked] = useState(false);
  const m = { busy: false, error, run: (fn: (value: Database) => Database, after: () => void) => {
    try { const next = fn(db); setDb(next); setError(''); after(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка симуляции'); }
  } };
  const receipt = fixture ? normalizeFixture(fixture, p.venue.id) : null;
  const log = (db.posEvents ?? []).filter(e => e.venueId === p.venue.id && e.provider === provider).slice(0, 8);
  const hasImported = db.visits.some(v => v.venueId === p.venue.id && v.source === provider);
  const scenarios: { id: Scenario; title: string }[] = [{ id: 'closed', title: 'Закрытый чек' }, { id: 'duplicate', title: 'Повтор' }, { id: 'unmatched', title: 'Без гостя' }, { id: 'open', title: 'Открытый' }, { id: 'refund', title: 'Возврат' }, { id: 'offline', title: 'Нет связи' }];
  const prepare = () => {
    setResult(null); setManualGuest(undefined);
    if (scenario === 'offline') {
      setFixture(null); setOfflineChecked(true);
      p.notify('Симуляция: нет связи · визиты и баланс не изменены');
      return;
    }
    const last = (db.posEvents ?? []).find(e => e.venueId === p.venue.id && e.provider === provider && e.result === 'imported');
    const id = scenario === 'duplicate' && last ? last.externalId : `DEMO-${provider.toUpperCase()}-${1001 + (db.posEvents ?? []).filter(e => e.venueId === p.venue.id && e.provider === provider).length}`;
    setFixture(createFixture(provider, p.venue.id, scenario, id));
  };
  const sync = () => {
    if (!receipt) return;
    let event: PosEvent;
    void m.run(current => { const processed = processReceipt(current, receipt, manualGuest); event = processed.event; return processed.db; }, () => { setResult(event); p.notify('Тест завершён. Рабочие данные не изменены.'); });
  };
  return <>
    <Callout icon="flask-outline">Отдельная тестовая песочница iiko и r_keeper. Гости и чеки вымышлены. Рабочая база и реальные бонусы не меняются. При закрытии результаты теста сбрасываются.</Callout>
    <View style={[s.row, { gap: 10 }]}>{(['iiko', 'rkeeper'] as const).map(id => <Pressable accessibilityRole="button" accessibilityLabel={`Демо ${providerName(id)}`} key={id} onPress={() => { setProvider(id); setFixture(null); setResult(null); setManualGuest(undefined); }} style={[s.card, { flex: 1, gap: 12, backgroundColor: provider === id ? C.pine : '#FFF', borderColor: provider === id ? C.pine : C.line }]}><View style={[s.row, { justifyContent: 'space-between' }]}><Txt weight="extra" style={{ fontSize: id === 'iiko' ? 26 : 18, color: provider === id ? '#FFF' : C.ink }}>{providerName(id)}</Txt><Icon name={provider === id ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={provider === id ? C.lime : C.muted} /></View><Txt style={{ color: provider === id ? '#CDDEC7' : C.muted, fontSize: 9 }}>{id === 'iiko' ? 'Cloud · событие заказа' : 'White Server API v2'}</Txt></Pressable>)}</View>
    <View><Section title="Сценарий проверки" /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>{scenarios.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => { setScenario(item.id); setFixture(null); setResult(null); }} style={{ padding: 11, backgroundColor: scenario === item.id ? C.pale : '#FFF', borderRadius: 11, borderWidth: 1, borderColor: scenario === item.id ? C.pine : C.line }}><Txt weight="semibold" style={{ fontSize: 10 }}>{item.title}</Txt></Pressable>)}</ScrollView></View>
    {scenario === 'duplicate' && !hasImported && <Callout>Сначала обработайте закрытый чек, затем запустите сценарий «Повтор».</Callout>}
    <Button label={scenario === 'offline' ? 'Проверить без подключения' : 'Подготовить тестовый чек'} icon="receipt-outline" variant="secondary" disabled={scenario === 'duplicate' && !hasImported} onPress={prepare} />
    {scenario === 'offline' && offlineChecked && <View style={[s.card, { gap: 12 }]}><Pill label="Симуляция: касса недоступна" background={C.softOrange} color={C.orange} /><Txt style={s.caption}>Не создаём визиты и не меняем баланс. В реальной интеграции сервер повторит получение чеков после восстановления связи.</Txt></View>}
    {receipt && <View style={[s.card, { gap: 14 }]}><View style={[s.row, { justifyContent: 'space-between' }]}><Pill label={`${providerName(provider)} · тестовый чек`} /><Pill label={receipt.status === 'closed' ? 'Закрыт' : receipt.status === 'open' ? 'Открыт' : 'Возврат'} background={C.softOrange} color={C.orange} /></View><Txt weight="bold" style={{ fontSize: 12 }}>{receipt.externalId}</Txt>{[
      ['Сумма', `${money(receipt.bill)} ₽`], ['Гость', manualGuest ? db.guests.find(g => g.id === manualGuest)?.name ?? '—' : receipt.guestPhone ? 'Александр Миронов' : 'Не определён'], ['Чаевые', receipt.tips === null ? 'Не переданы кассой' : `${money(receipt.tips)} ₽`], ['Оценка гостя', 'Оставляет сотрудник'],
    ].map(([label, value]) => <View key={label} style={[s.row, { gap: 12, justifyContent: 'space-between' }]}><Txt style={{ color: C.muted, fontSize: 11 }}>{label}</Txt><Txt weight="semibold" style={{ fontSize: 11, textAlign: 'right', flex: 1 }}>{value}</Txt></View>)}<Button label="Обработать чек" icon="sync-outline" onPress={sync} loading={m.busy} />{result?.result === 'unmatched' && <View style={{ gap: 9 }}><Txt weight="bold" style={{ fontSize: 12 }}>Кому принадлежит чек?</Txt>{db.guests.filter(g => db.memberships.some(member => member.venueId === p.venue.id && member.guestId === g.id)).map(g => <Pressable key={g.id} accessibilityRole="button" accessibilityLabel={`Привязать чек ${g.name}`} onPress={() => setManualGuest(g.id)} style={[s.row, { padding: 10, gap: 9, backgroundColor: manualGuest === g.id ? C.pale : C.bg, borderRadius: 10 }]}><Icon name={manualGuest === g.id ? 'checkmark-circle' : 'ellipse-outline'} size={17} /><Txt style={{ fontSize: 11 }}>{g.name}</Txt></Pressable>)}{manualGuest && <Button label="Импортировать с выбранным гостем" onPress={sync} loading={m.busy} />}</View>}<Pressable accessibilityRole="button" accessibilityLabel="Показать структуру демо-данных" onPress={() => setRaw(!raw)}><Txt weight="bold" style={{ fontSize: 10, color: C.muted }}>{raw ? 'Скрыть структуру ↑' : 'Структура демо-данных ↓'}</Txt></Pressable>{raw && <Txt selectable style={{ fontSize: 9, lineHeight: 15, color: C.muted }}>{JSON.stringify(fixture, null, 2)}</Txt>}</View>}
    {m.error !== '' && <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12 }}>{m.error}</Txt>}
    {result && <View accessibilityRole="alert" style={{ padding: 16, borderRadius: 15, gap: 8, backgroundColor: result.result === 'imported' ? C.pale : C.softOrange }}><View style={[s.row, { gap: 7 }]}><Icon name={result.result === 'imported' ? 'checkmark-circle-outline' : 'information-circle-outline'} size={18} /><Txt weight="bold" style={{ fontSize: 12 }}>{result.result === 'imported' ? 'Чек учтён' : result.result === 'duplicate' ? 'Повтор защищён' : result.result === 'refund' ? 'Нужна сверка возврата' : result.result === 'unmatched' ? 'Нужна привязка гостя' : 'Начисление пропущено'}</Txt></View><Txt style={{ lineHeight: 20, fontSize: 12 }}>{result.message}</Txt></View>}
    <View><Section title="Журнал обмена" />{log.length ? log.map(e => <View key={e.id} style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: C.line, gap: 6 }}><View style={[s.row, { gap: 7 }]}><Icon name={e.result === 'imported' ? 'checkmark-circle' : 'information-circle-outline'} color={e.result === 'imported' ? C.pine : C.orange} size={15} /><Txt weight="bold" style={{ fontSize: 10, flex: 1 }}>{e.externalId}</Txt><Txt style={{ fontSize: 9, color: C.muted }}>{shortDate(e.createdAt)}</Txt></View><Txt style={{ color: C.muted, lineHeight: 18, fontSize: 10 }}>{e.message}</Txt></View>) : <Txt style={s.caption}>Запустите первый сценарий. Результат доступен до закрытия песочницы.</Txt>}</View>
    <Callout>Для реального обмена нужен сервер-посредник и доступ заведения к API. Ключи кассы в мобильном приложении не хранятся. Списание бонусов в кассе и автоматический пересчёт возвратов в это демо не входят.</Callout>
  </>;
}
