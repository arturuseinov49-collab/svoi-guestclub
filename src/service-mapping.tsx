import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation } from './panels';
import { StaffMember, useStore } from './store';
import type { ServiceMapping } from './service-sessions';
import { Button, C, Field, Txt, s } from './ui';

type Connection = { id: string; provider: 'iiko' | 'rkeeper'; scope: string; enabled: boolean; verifiedAt: number | null };
export function ServiceMappingSettings({ venueId, notify }: { venueId: string; notify?: (message: string) => void }) {
  const { serviceMappings, serviceReadiness, posRequest, command } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [draft, setDraft] = useState<ServiceMapping>(() => serviceMappings?.find(item => item.venueId === venueId) ?? { venueId, connectionId: '', tables: [], staff: [] });
  const mutation = useMutation();
  const readiness = serviceReadiness?.find(item => item.venueId === venueId);
  const provider = connections.find(item => item.id === draft.connectionId)?.provider;
  const load = async () => {
    setExpanded(true); setLoading(true); setLoadError('');
    try {
      const [status, team] = await Promise.all([posRequest<{ connections: Connection[] }>('status', { venueId }), command({ type: 'listStaff', venueId }, globalThis.crypto.randomUUID())]);
      setConnections(status.connections); setMembers(team.members ?? []);
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить кассы и команду'); }
    finally { setLoading(false); }
  };
  const changeWaiter = (userId: number, posWaiterId: string) => setDraft(current => ({ ...current, staff: [...current.staff.filter(item => item.userId !== userId), { userId, posWaiterId }] }));
  return <View style={{ gap: 12 }}>
    <Button label="Столы и сотрудники кассы" variant="secondary" icon="restaurant-outline" loading={loading} onPress={() => expanded ? setExpanded(false) : void load()} />
    {expanded && <View style={[s.card, { gap: 14 }]}>
      <Txt weight="extra" style={{ fontSize: 20 }}>Автоматическая связь с заказом</Txt>
      <Txt style={s.caption}>Настройте один раз: номер стола в «Своих» → стол кассы, сотрудник → официант кассы. После QR сотруднику останется ввести только номер стола.</Txt>
      {serviceMappings === null ? <Txt style={s.caption}>Сервер ещё не поддерживает эту настройку. Обновите приложение позже.</Txt> : <>
        <Txt style={s.caption}>{readiness?.ready ? 'Настройки сохранены. Сопоставление работает при включённом обмене с кассой.' : 'Нужны реальные API-доступы, проверенное подключение и включённый обмен. Сами соответствия не создают заказы и не включают начисления.'}</Txt>
        {loadError ? <><Txt accessibilityRole="alert" style={{ color: C.red, lineHeight: 20 }}>{loadError}</Txt><Button label="Повторить загрузку касс и команды" variant="ghost" onPress={() => void load()} /></> : null}
        {!loading && !loadError && !connections.length && <Txt style={s.caption}>Подключений пока нет. Сначала добавьте кассу в разделе «Интеграции iiko и r_keeper».</Txt>}
        {!!connections.length && <>
          <Txt weight="bold">Подключение кассы</Txt>
          {connections.map(item => <Button key={item.id} label={`${item.provider === 'iiko' ? 'iiko' : 'r_keeper'} · ${item.scope}${!item.verifiedAt ? ' · не проверено' : !item.enabled ? ' · обмен выключен' : ''}`} variant={draft.connectionId === item.id ? 'primary' : 'secondary'} onPress={() => setDraft({ ...draft, connectionId: item.id })} disabled={mutation.busy} />)}
          <Txt weight="bold">Столы</Txt><Txt style={s.caption}>Идентификаторы столов и официантов получите у администратора кассы. «01» и «1» — разные номера.</Txt>
          {provider === 'iiko' && <Txt style={s.caption}>Для iiko нужен Cloud ID стола (поле id), а не posId и не номер. Для сотрудника укажите UUID официанта iikoCloud.</Txt>}
          {provider === 'rkeeper' && <Txt style={s.caption}>Для r_keeper нужны код стола (tableCode) и код официанта (waiterId) выбранного MID. Уточните их у администратора кассы.</Txt>}
          {draft.tables.map((table, index) => <View key={index} style={{ gap: 9, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12 }}><Field label={`Номер стола · ${index + 1}`} value={table.label} maxLength={40} editable={!mutation.busy} onChangeText={label => setDraft({ ...draft, tables: draft.tables.map((item, i) => i === index ? { ...item, label } : item) })} /><Field label={`ID стола в кассе · ${index + 1}`} value={table.posTableId} autoCapitalize="none" autoCorrect={false} editable={!mutation.busy} onChangeText={posTableId => setDraft({ ...draft, tables: draft.tables.map((item, i) => i === index ? { ...item, posTableId } : item) })} /><Button label={`Убрать стол · ${index + 1}`} variant="ghost" disabled={mutation.busy} onPress={() => setDraft({ ...draft, tables: draft.tables.filter((_, i) => i !== index) })} /></View>)}
          <Button label="Добавить соответствие стола" variant="secondary" disabled={mutation.busy} onPress={() => setDraft({ ...draft, tables: [...draft.tables, { label: '', posTableId: '' }] })} />
          <Txt weight="bold">Сотрудники заведения</Txt><Txt style={s.caption}>Заполните ID только для сотрудников, которые оформляют заказы. Пустое поле удаляет соответствие.</Txt>
          {members.map(member => <View key={member.userId} style={{ gap: 6 }}><Txt weight="bold" style={{ fontSize: 12 }}>{member.name} · {member.role === 'owner' ? 'руководитель' : 'сотрудник'}</Txt><Field label={`ID официанта · ${member.name}`} value={draft.staff.find(item => item.userId === member.userId)?.posWaiterId ?? ''} autoCapitalize="none" autoCorrect={false} editable={!mutation.busy} onChangeText={value => changeWaiter(member.userId, value)} /></View>)}
          {mutation.error ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 20 }}>{mutation.error}</Txt> : null}
          <Button label="Сохранить связь с кассой" loading={mutation.busy} disabled={!draft.connectionId || !members.length || !!loadError} onPress={() => void mutation.run({ type: 'configureServiceMapping', ...draft, staff: draft.staff.filter(item => members.some(member => member.userId === item.userId) && item.posWaiterId.trim()) }, () => { setExpanded(false); notify?.('Соответствия столов и сотрудников сохранены'); })} />
        </>}
      </>}
    </View>}
  </View>;
}

