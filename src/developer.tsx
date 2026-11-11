import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Command, CommandResult, ManagedVenue, useStore } from './store';
import { Button, C, Callout, Empty, Field, Icon, Pill, Section, Sheet, Txt, fx, s } from './ui';
import { CopyCode } from './copy-code';
import { VenueProfileEditor } from './venue-profile-editor';

export function DeveloperPanel({ onClose }: { onClose: () => void }) {
  const { isDeveloper, command } = useStore();
  const [venues, setVenues] = useState<ManagedVenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('Кафе');
  const [address, setAddress] = useState('');
  const [invite, setInvite] = useState<{ venueId: string; code: string; expiresAt: string } | null>(null);
  const [removing, setRemoving] = useState<{ venueId: string; userId: number } | null>(null);
  const [editingVenue, setEditingVenue] = useState<string | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    if (!isDeveloper) return;
    let active = true;
    void command({ type: 'listManagedVenues' }, globalThis.crypto.randomUUID())
      .then(result => { if (active) setVenues(result.managedVenues ?? []); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить заведения'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isDeveloper, command]);
  const run = async (input: Command, after?: (result: CommandResult) => void) => {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await command(input, globalThis.crypto.randomUUID());
      after?.(result);
      if (input.type === 'listManagedVenues') setVenues(result.managedVenues ?? []);
      else {
        try {
          const list = await command({ type: 'listManagedVenues' }, globalThis.crypto.randomUUID());
          setVenues(list.managedVenues ?? []);
        } catch { setError('Изменение сохранено, но список не обновился. Нажмите «Обновить».'); }
      }
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить действие'); return false; }
    finally { locked.current = false; setBusy(false); setLoading(false); }
  };
  if (!isDeveloper) return null;
  return <Sheet visible title="Панель разработчика" subtitle="Заведения и руководители «Своих»" onClose={onClose}>
    <View {...fx('hero')} style={[s.card, { backgroundColor: C.lime, gap: 13, overflow: 'hidden' }]}>
      <View style={[s.row, { gap: 9 }]}><Icon name="key-outline" color={C.pine} /><Pill label="Личный доступ" background="#FFFFFF99" /></View>
      <Txt weight="extra" style={{ fontSize: 28, letterSpacing: -1 }}>Ваш круг растёт.</Txt>
      <Txt style={{ color: C.pine, lineHeight: 22 }}>Добавляйте места, настраивайте их карточки и приглашайте руководителей. Они соберут свою команду.</Txt>
      <View style={[s.row, { gap: 8 }]}><Txt weight="extra" style={{ fontSize: 27 }}>{venues.length}</Txt><Txt style={{ color: C.pine }}>заведений в «Своих»</Txt></View>
    </View>
    {!!error && <Txt accessibilityRole="alert" style={{ color: C.red, lineHeight: 21 }}>{error}</Txt>}
    {!!notice && <Callout icon="checkmark-circle-outline">{notice}</Callout>}
    <Button label={creating ? 'Скрыть форму' : 'Добавить заведение'} icon={creating ? 'remove' : 'add'} disabled={busy || loading} onPress={() => setCreating(value => !value)} />
    {creating && <View style={[s.card, { gap: 17 }]}>
      <Txt weight="extra" style={{ fontSize: 18 }}>Новое место</Txt>
      <Field label="Название заведения" placeholder="Например, Кофейня на углу" value={name} onChangeText={setName} maxLength={70} />
      <Field label="Формат" value={kind} onChangeText={setKind} maxLength={50} />
      <Field label="Адрес" placeholder="Город, улица, дом" value={address} onChangeText={setAddress} maxLength={150} />
      <Txt style={s.caption}>После создания настройте карточку для гостей и выдайте код руководителю. В общем каталоге новое место скрыто до публикации; условия программы согласуйте отдельно.</Txt>
      <Button label="Создать заведение" icon="storefront-outline" loading={busy} disabled={name.trim().length < 2 || kind.trim().length < 2 || address.trim().length < 2} onPress={() => void run({ type: 'createVenue', name: name.trim(), kind: kind.trim(), address: address.trim() }, () => { setName(''); setAddress(''); setCreating(false); setNotice('Заведение создано. Теперь пригласите руководителя.'); })} />
    </View>}
    <View style={[s.row, { justifyContent: 'space-between' }]}><Txt weight="extra" style={{ fontSize: 19 }}>Все заведения</Txt><Button label="Обновить" icon="sync-outline" variant="ghost" loading={busy} style={{ minHeight: 42, paddingVertical: 9, paddingHorizontal: 12 }} onPress={() => void run({ type: 'listManagedVenues' })} /></View>
    {loading ? <ActivityIndicator color={C.pine} /> : !venues.length ? <Empty icon="storefront-outline" title="Первое место — за вами" text="Создайте заведение и передайте руководителю его личный код приглашения." /> : venues.map(venue => <View key={venue.id} style={[s.card, { gap: 16 }]}>
      <View style={[s.row, { gap: 12 }]}><View {...fx('foil')} style={{ width: 46, height: 46, borderRadius: 16, backgroundColor: C.lavender, alignItems: 'center', justifyContent: 'center' }}><Icon name="storefront-outline" color={C.pine} /></View><View style={{ flex: 1, gap: 5 }}><Txt weight="extra" style={{ fontSize: 18 }}>{venue.name}</Txt><Txt style={s.caption}>{venue.kind} · {venue.address}</Txt></View></View>
      <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}><Pill label={`${venue.guestCount} гостей`} /><Pill label={`${venue.staffCount} в команде`} /><Pill label={venue.managers.length ? 'Руководитель назначен' : 'Ждёт руководителя'} background={venue.managers.length ? C.pale : C.softOrange} /></View>
      <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}><Pill label={venue.guestProfile.published ? 'В каталоге гостей' : 'Скрыто из каталога'} background={venue.guestProfile.published ? C.pale : C.softOrange} />{venue.guestProfile.demo && <Pill label="Тестовая карточка" background={C.lavender} />}</View>
      <Button label={`Карточка для гостей · ${venue.name}`} icon="albums-outline" variant="secondary" disabled={busy} onPress={() => setEditingVenue(current => current === venue.id ? null : venue.id)} />
      {editingVenue === venue.id && <VenueProfileEditor key={venue.id} profile={venue.guestProfile} busy={busy} onCancel={() => setEditingVenue(null)} onSave={guestProfile => run({ type: 'updateVenueProfile', venueId: venue.id, guestProfile }, () => setNotice('Карточка заведения сохранена.'))} />}
      <View style={{ gap: 8 }}><Txt style={s.caption}>Код клуба для гостей</Txt><Txt selectable weight="bold" style={{ letterSpacing: 2 }}>{venue.joinCode}</Txt><CopyCode code={venue.joinCode} label={`Скопировать код клуба · ${venue.name}`} /></View>
      {!!venue.managers.length && <View style={{ gap: 10 }}><Section title="Руководители" />{venue.managers.map(manager => <View key={manager.userId} style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 12, gap: 10 }}><Txt weight="semibold">{manager.name}</Txt>{removing?.venueId === venue.id && removing.userId === manager.userId ? <><Callout>Закрыть доступ руководителя к «{venue.name}»? Команда и данные заведения сохранятся.</Callout><Button label="Подтвердить закрытие доступа" loading={busy} onPress={() => void run({ type: 'revokeManager', venueId: venue.id, userId: manager.userId }, () => { setRemoving(null); setInvite(current => current?.venueId === venue.id ? null : current); setNotice('Доступ руководителя закрыт.'); })} /><Button label="Оставить доступ" variant="ghost" disabled={busy} onPress={() => setRemoving(null)} /></> : <Button label={`Закрыть доступ: ${manager.name}`} variant="ghost" disabled={busy} onPress={() => setRemoving({ venueId: venue.id, userId: manager.userId })} />}</View>)}</View>}
      <Button label={`Код руководителю · ${venue.name}`} icon="key-outline" variant="secondary" loading={busy} onPress={() => void run({ type: 'createManagerInvite', venueId: venue.id }, result => { setInvite({ venueId: venue.id, code: result.code ?? '', expiresAt: result.expiresAt ?? '' }); setNotice('Передайте код лично руководителю заведения.'); })} />
      {invite?.venueId === venue.id && <View {...fx('foil')} style={{ backgroundColor: C.lavender, borderRadius: 17, padding: 17, gap: 10 }}><Txt weight="bold">Код приглашения руководителя</Txt><Txt selectable weight="extra" style={{ fontSize: 20, letterSpacing: 1 }}>{invite.code.match(/.{1,4}/g)?.join(' ')}</Txt><CopyCode key={invite.code} code={invite.code} label="Скопировать приглашение руководителя" /><Txt style={{ color: C.pine, fontSize: 12, lineHeight: 20 }}>Одноразовый. Действует до {invite.expiresAt ? new Date(invite.expiresAt).toLocaleString('ru-RU') : 'завтра'}. В приложении нужно выбрать «Я сотрудник» и ввести этот код. Новый код заменит предыдущее неиспользованное приглашение.</Txt></View>}
    </View>)}
  </Sheet>;
}
