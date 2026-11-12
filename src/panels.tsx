import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { NoteKind, Role, Venue, fullDate, money, rewards, shortDate, stats } from './domain';
import { Command, CommandResult, StaffMember, useStore } from './store';
import { Avatar, Button, C, Callout, Empty, Field, Icon, Pill, Section, Sheet, Stars, Txt, s } from './ui';
import { GuestQr, ScanGuest } from './qr';
import { CopyCode } from './copy-code';
import { effectiveGuestProfile } from './venue-profile';
import { WaiterHandoff } from './waiter-handoff';
import { WaiterSettings } from './waiter-settings';
import { GlobalBonusAmount } from './bonus-ui';
import { ServiceMappingSettings } from './service-mapping';
export type Panel = null | { kind: 'settings' | 'venues' | 'scan' | 'newGuest' | 'program' | 'review' | 'integrations' | 'joinVenue' | 'acceptInvite' | 'team' } | { kind: 'guest' | 'visit' | 'award' | 'note'; guestId: string } | { kind: 'reply'; reviewId: string } | { kind: 'redeem'; guestId: string; rewardId: string } | { kind: 'pick'; next: 'visit' | 'award' | 'redeem'; rewardId?: string };
export type PanelProps = { panel: Panel; venue: Venue; role: Role; setPanel: (p: Panel) => void; setVenue: (id: string) => void; setRole: (role: Role) => void; notify: (text: string) => void; openDeveloper: () => void };
export function useMutation() {
  const { command } = useStore();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const locked = React.useRef(false);
  const pending = React.useRef<{ payload: string; key: string } | null>(null);
  const run = async (input: Command, after: (result: CommandResult) => void) => {
    if (locked.current) return;
    const payload = JSON.stringify(input);
    if (pending.current?.payload !== payload) pending.current = { payload, key: globalThis.crypto.randomUUID() };
    locked.current = true; setBusy(true); setError('');
    try { const result = await command(input, pending.current.key); pending.current = null; after(result); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить. Попробуйте ещё раз.'); }
    finally { locked.current = false; setBusy(false); }
  };
  return { error, busy, run };
}
function ErrorMessage({ message }: { message: string }) { return message ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 20 }}>{message}</Txt> : null; }
export function Panels(p: PanelProps) {
  const { db } = useStore();
  if (!p.panel || p.panel.kind === 'integrations') return null;
  const { panel } = p;
  const titles: Record<string, string> = { settings: 'Ваши «Свои»', joinVenue: 'Вступить в клуб', acceptInvite: 'Приглашение в команду', team: 'Команда заведения', venues: 'Любимые места', scan: 'QR гостя', newGuest: 'Знакомство начинается здесь', program: 'Своя программа', review: 'Как прошёл ваш визит?', guest: 'Карточка гостя', visit: 'Новый визит', award: 'Бонусы заведения', note: 'Заметка о госте', reply: 'Ответ от команды', redeem: 'Маленький комплимент', pick: 'Выберите гостя' };
  const title = panel.kind === 'guest' ? db.guests.find(g => g.id === panel.guestId)?.name ?? titles.guest : titles[panel.kind];
  const done = (message: string, next: Panel = null) => { p.notify(message); p.setPanel(next); };
  const bodyProps = { ...p, done };
  return <Sheet visible title={title} subtitle={['visit', 'award', 'note', 'program', 'review', 'redeem', 'reply'].includes(panel.kind) ? `Заведение «${p.venue.name}»` : undefined} onClose={() => p.setPanel(null)}><PanelBody key={`${panel.kind}-${p.venue.id}-${'guestId' in panel ? panel.guestId : ''}`} {...bodyProps} /></Sheet>;
}
function PanelBody(p: PanelProps & { done: (message: string, next?: Panel) => void }) {
  const { panel } = p;
  switch (panel?.kind) {
    case 'settings': return <Settings {...p} />;
    case 'venues': return <VenuePicker {...p} />;
    case 'scan': return <ScanGuest venueId={p.venue.id} onResolved={guestId => p.setPanel({ kind: 'guest', guestId })} onCancel={() => p.setPanel(null)} />;
    case 'newGuest': return <NewGuest {...p} />;
    case 'joinVenue': return <JoinForm {...p} />;
    case 'acceptInvite': return <JoinForm {...p} staff />;
    case 'team': return <Team {...p} />;
    case 'guest': return <GuestProfile {...p} guestId={panel.guestId} />;
    case 'pick': return <GuestPicker {...p} next={panel.next} rewardId={panel.rewardId} />;
    case 'visit': return <VisitForm {...p} guestId={panel.guestId} />;
    case 'award': return <AwardForm {...p} guestId={panel.guestId} />;
    case 'note': return <NoteForm {...p} guestId={panel.guestId} />;
    case 'program': return <ProgramForm {...p} />;
    case 'review': return <ReviewForm {...p} />;
    case 'reply': return <ReplyForm {...p} reviewId={panel.reviewId} />;
    case 'redeem': return <RedeemForm {...p} guestId={panel.guestId} rewardId={panel.rewardId} />;
    default: return null;
  }
}
type FormProps = PanelProps & { done: (message: string, next?: Panel) => void };
function Settings(p: FormProps) {
  const { db, user, guestCode, isDeveloper, staffVenues, logout, refresh, syncError } = useStore();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const staff = staffVenues.find(v => v.venueId === p.venue.id);
  const exportData = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `svoi-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <><View style={[s.row, { gap: 10 }]}><Icon name="paper-plane-outline" /><View style={{ flex: 1, gap: 5 }}><Txt weight="extra">{user?.firstName} {user?.lastName}</Txt><Txt style={s.caption}>Аккаунт подтверждён Telegram</Txt></View><Pill label={syncError ? "Нет связи" : "Telegram"} /></View>
    <GuestCode code={guestCode} /><ErrorMessage message={syncError} />
    <Callout>Данные хранятся на сервере. На другом телефоне откройте приложение через тот же аккаунт Telegram.</Callout>
    {staff && <><Txt weight="bold">Ваш режим в «{p.venue.name}»</Txt>{(['staff', 'guest'] as const).map(role => <Button key={role} label={role === 'staff' ? 'Режим сотрудника' : 'Режим гостя'} variant={p.role === role ? 'primary' : 'secondary'} onPress={() => { p.setRole(role); p.setPanel(null); }} />)}</>}
    {staff?.role === 'owner' && <WaiterSettings venue={p.venue} notify={p.notify} />}
    {staff?.role === 'owner' && <ServiceMappingSettings venueId={p.venue.id} notify={p.notify} />}
    {staff?.role === 'owner' && <Button label="Управление командой" icon="people-outline" onPress={() => p.setPanel({ kind: 'team' })} />}
    {staff && <><View style={[s.card, { gap: 8 }]}><Txt weight="bold">Код клуба для гостей</Txt><Txt selectable weight="extra" style={{ fontSize: 25, letterSpacing: 2 }}>{(p.venue as Venue & { joinCode?: string }).joinCode}</Txt><CopyCode code={(p.venue as Venue & { joinCode?: string }).joinCode ?? ''} label="Скопировать код клуба" /><Txt style={s.caption}>Гость вводит этот код в «Вступить в клуб». Доступ сотрудника он не даёт.</Txt></View><Button label="Интеграции iiko и r_keeper" icon="git-compare-outline" variant="secondary" onPress={() => p.setPanel({ kind: 'integrations' })} /></>}
    <Button label="Вступить в клуб" icon="add" variant="secondary" onPress={() => p.setPanel({ kind: 'joinVenue' })} />
    <Button label="У меня приглашение в команду" variant="ghost" onPress={() => p.setPanel({ kind: 'acceptInvite' })} />
    {isDeveloper && <Button label="Панель разработчика" icon="construct-outline" variant="secondary" onPress={p.openDeveloper} />}
    <Button label="Обновить данные" icon="sync-outline" variant="ghost" onPress={() => { void refresh(); p.setPanel(null); }} />
    {Platform.OS === 'web' && <Button label="Экспортировать доступные данные" icon="download-outline" variant="ghost" onPress={exportData} />}
    <ErrorMessage message={error} /><Button label="Выйти из аккаунта" variant="ghost" loading={busy} onPress={() => { setBusy(true); void logout().catch(e => setError(e.message)).finally(() => setBusy(false)); }} />
    <Txt style={s.caption}>Внутренние заметки доступны только команде заведения. Визиты пока отмечает сотрудник: кассы к рабочей базе не подключены.</Txt></>;
}
export function GuestCode({ code }: { code: string }) {
  const { guestQr } = useStore();
  return <GuestQr value={guestQr} code={code} />;
}
function JoinForm(p: FormProps & { staff?: boolean }) {
  const [code, setCode] = useState(''); const m = useMutation();
  return <><Callout>{p.staff ? 'Сотрудникам код выдаёт руководитель, а руководителю — разработчик «Своих». Приглашение одноразовое и действует 24 часа.' : 'Введите код клуба, который вам дали в заведении.'}</Callout><Field label={p.staff ? 'Код приглашения' : 'Код клуба'} value={code} onChangeText={setCode} autoCapitalize="characters" maxLength={40} /><ErrorMessage message={m.error} /><Button label={p.staff ? 'Принять приглашение' : 'Вступить в клуб'} loading={m.busy} disabled={!code.trim()} onPress={() => void m.run({ type: p.staff ? 'acceptStaffInvite' : 'joinVenue', code: code.trim().toUpperCase() }, result => { if (result.venueId) p.setVenue(result.venueId); p.setRole(p.staff ? 'staff' : 'guest'); p.done(p.staff ? 'Вы в команде' : 'Добро пожаловать в клуб'); })} /></>;
}
function Team(p: FormProps) {
  const { user } = useStore(); const m = useMutation();
  const [invite, setInvite] = useState(''); const [expiry, setExpiry] = useState('');
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  return <>
    <Callout>Сотрудники видят гостей и заметки только этого заведения. Правила бонусов и состав команды меняет руководитель.</Callout>
    <Button label="Создать приглашение сотрудника" icon="person-add-outline" loading={m.busy} onPress={() => void m.run({ type: 'createStaffInvite', venueId: p.venue.id }, result => { setInvite(result.code ?? ''); setExpiry(result.expiresAt ?? ''); })} />
    {invite && <View style={[s.card, { gap: 10, backgroundColor: C.lime }]}><Txt weight="bold">Одноразовое приглашение</Txt><Txt selectable weight="extra" style={{ fontSize: 18, letterSpacing: 1 }}>{invite.match(/.{1,4}/g)?.join(' ')}</Txt><CopyCode key={invite} code={invite} label="Скопировать приглашение сотрудника" /><Txt style={s.caption}>Передайте лично сотруднику. Действует до {expiry ? new Date(expiry).toLocaleString('ru-RU') : 'завтра'}. В приложении нужно выбрать «Я сотрудник» и ввести код.</Txt></View>}
    <Button label="Показать состав команды" variant="secondary" loading={m.busy} onPress={() => void m.run({ type: 'listStaff', venueId: p.venue.id }, result => { setMembers(result.members ?? []); setRemoving(null); })} />
    {members?.map(member => <View key={member.userId} style={[s.card, { gap: 10 }]}>
      <Txt weight="bold">{member.name}{member.userId === user?.id ? ' · вы' : ''}</Txt><Pill label={member.role === 'owner' ? 'Руководитель' : 'Сотрудник'} />
      {member.role !== 'owner' && (removing === member.userId ? <>
        <Callout>Закрыть доступ сотруднику «{member.name}»? Он больше не сможет работать с гостями «{p.venue.name}». Сохранённые визиты и заметки останутся.</Callout>
        <Button label="Подтвердить закрытие доступа сотрудника" loading={m.busy} onPress={() => void m.run({ type: 'revokeStaff', venueId: p.venue.id, userId: member.userId }, () => { setMembers(current => current?.filter(item => item.userId !== member.userId) ?? []); setRemoving(null); p.notify('Доступ сотрудника закрыт'); })} />
        <Button label="Оставить доступ" variant="ghost" disabled={m.busy} onPress={() => setRemoving(null)} />
      </> : <Button label={`Закрыть доступ: ${member.name}`} variant="ghost" disabled={m.busy} onPress={() => setRemoving(member.userId)} />)}
    </View>)}
    <ErrorMessage message={m.error} />
  </>;
}
function VenuePicker(p: FormProps) {
  const { db, isDeveloper } = useStore();
  return <>{db.venues.map(v => <Pressable key={v.id} accessibilityRole="button" accessibilityLabel={`Выбрать заведение ${v.name}`} onPress={() => { p.setVenue(v.id); p.setPanel(null); }} style={[s.card, s.row, { gap: 15, borderColor: p.venue.id === v.id ? C.pine : C.line }]}><View style={{ width: 49, height: 49, borderRadius: 16, backgroundColor: C.pale, alignItems: 'center', justifyContent: 'center' }}><Txt weight="extra" style={{ fontSize: 24 }}>{v.monogram}</Txt></View><View style={{ flex: 1, gap: 5 }}><Txt weight="bold" style={{ fontSize: 16 }}>{v.name}</Txt><Txt style={s.caption}>{v.kind} · {v.address}</Txt></View><Icon name={p.venue.id === v.id ? 'checkmark-circle' : 'chevron-forward'} size={20} /></Pressable>)}<Button label="Вступить в клуб" icon="add" variant="secondary" onPress={() => p.setPanel({ kind: 'joinVenue' })} />{isDeveloper && <Button label="Панель разработчика" variant="ghost" onPress={p.openDeveloper} />}</>;
}
function NewGuest(p: FormProps) {
  const [guestCode, setGuestCode] = useState(''); const m = useMutation();
  return <><Button label="Сканировать QR гостя" icon="scan-outline" onPress={() => p.setPanel({ kind: 'scan' })} /><Callout icon="person-add-outline">Гость показывает личный QR из «Своих». После сканирования проверьте профиль и подтвердите визит.</Callout><Txt weight="bold">Или найдите по короткому коду</Txt><Field label="Код гостя" placeholder="8 символов из профиля гостя" value={guestCode} onChangeText={setGuestCode} autoCapitalize="characters" maxLength={8} /><ErrorMessage message={m.error} /><Button label="Добавить гостя" variant="secondary" loading={m.busy} onPress={() => void m.run({ type: 'addGuest', venueId: p.venue.id, guestCode: guestCode.trim().toUpperCase() }, result => p.done('Гость добавлен', result.guestId ? { kind: 'guest', guestId: result.guestId } : null))} /></>;
}
function GuestPicker(p: FormProps & { next: 'visit' | 'award' | 'redeem'; rewardId?: string }) {
  const { db } = useStore(); const [query, setQuery] = useState('');
  const guests = db.guests.filter(g => db.memberships.some(m => m.venueId === p.venue.id && m.guestId === g.id)).filter(g => `${g.name} ${g.phone}`.toLowerCase().includes(query.toLowerCase()));
  return <><Field label="Поиск гостя" placeholder="Имя гостя" value={query} onChangeText={setQuery} />{guests.map(g => <Pressable key={g.id} accessibilityRole="button" accessibilityLabel={`Выбрать гостя ${g.name}`} onPress={() => p.setPanel(p.next === 'redeem' ? { kind: 'redeem', guestId: g.id, rewardId: p.rewardId! } : { kind: p.next, guestId: g.id })} style={[s.row, { gap: 12, paddingVertical: 7 }]}><Avatar guest={g} size={42} /><View style={{ flex: 1, gap: 5 }}><Txt weight="bold" style={{ fontSize: 13 }}>{g.name}</Txt><Txt style={s.caption}>{stats(db, p.venue.id, g.id).balance} Б заведения</Txt></View><Icon name="chevron-forward" size={16} /></Pressable>)}{!guests.length && <Empty title="Гость не найден" text="Добавьте новую карточку в разделе «Гости»." />}</>;
}
function GuestProfile(p: FormProps & { guestId: string }) {
  const { db, guestGlobalBalances } = useStore();
  const [more, setMore] = useState(false);
  const guest = db.guests.find(g => g.id === p.guestId)!;
  const st = stats(db, p.venue.id, guest.id);
  const globalBalance = guestGlobalBalances.find(wallet => wallet.venueId === p.venue.id && wallet.guestId === guest.id);
  const features = effectiveGuestProfile(p.venue).features;
  const notes = db.notes.filter(n => n.venueId === p.venue.id && n.guestId === guest.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const preferences = notes.filter(n => n.kind === 'preference');
  const otherNotes = notes.filter(n => n.kind !== 'preference');
  return <>
    <View style={[s.row, { gap: 14 }]}><Avatar guest={guest} size={60} /><View style={{ gap: 7, flex: 1, minWidth: 0 }}><Txt style={s.caption}>Гость «{p.venue.name}»</Txt><Pill label={st.count >= 5 ? 'Постоянный гость' : st.count ? 'Уже знакомы' : 'Первая встреча'} /><Txt style={s.caption}>{st.visits[0] ? `Последний визит: ${shortDate(st.visits[0].createdAt)}` : 'Подтверждённых визитов пока нет'}</Txt></View></View>
    <View style={[s.card, { flexDirection: 'row', gap: 12, paddingHorizontal: 16 }]}>
      <View testID="guest-visit-count" style={{ flex: 1, minWidth: 0, gap: 5 }}><Txt weight="extra" style={{ fontSize: 28 }}>{st.count}</Txt><Txt style={s.caption}>визитов в заведение</Txt></View>
      <View style={{ width: 1, backgroundColor: C.line }} />
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}><Txt weight="extra" style={{ fontSize: 24 }}>{money(st.balance)} Б</Txt><Txt style={s.caption}>бонусы заведения</Txt></View>
    </View>
    <View><Section title="Предпочтения гостя" action="Добавить" onPress={() => p.setPanel({ kind: 'note', guestId: guest.id })} /><View style={{ gap: 10 }}>{preferences.length ? preferences.map(note => <View key={note.id} style={[s.card, { gap: 8, backgroundColor: C.pale }]}><Txt style={{ fontSize: 14, lineHeight: 23 }}>{note.text}</Txt><Txt style={{ fontSize: 10, color: C.muted }}>{note.author} · {shortDate(note.createdAt)}</Txt></View>) : <Txt style={s.caption}>Пока не записаны. Уточните любимые блюда и пожелания у гостя — команда сможет учитывать их в следующий раз.</Txt>}</View></View>
    {!!otherNotes.length && <View style={{ gap: 10 }}><Txt weight="bold">Команде на заметку</Txt>{otherNotes.slice(0, 3).map(note => <View key={note.id} style={[s.card, { gap: 8 }]}><Pill label={note.kind === 'thanks' ? 'Есть за что поблагодарить' : 'На заметку'} /><Txt style={{ lineHeight: 22 }}>{note.text}</Txt><Txt style={{ fontSize: 10, color: C.muted }}>{note.author} · {shortDate(note.createdAt)}</Txt></View>)}</View>}
    <View testID="staff-global-balance" style={[s.card, { gap: 8, backgroundColor: C.pale }]}><View style={[s.row, { justifyContent: 'space-between', gap: 12 }]}><Txt weight="bold" style={{ fontSize: 13, lineHeight: 20, flex: 1, minWidth: 0 }}>Глобальные бонусы гостя</Txt><GlobalBonusAmount amount={globalBalance?.balance ?? null} size={24} /></View><Txt style={{ fontSize: 11, lineHeight: 18, color: C.muted }}>Счёт «Своих» · пока только накопление</Txt></View>
    <WaiterHandoff venue={p.venue} guestId={guest.id} />
    {features.visits && (!p.venue.serviceFlow || p.venue.serviceFlow.cashSystem === 'none') && <Button label="Отметить визит" icon="checkmark-circle-outline" onPress={() => p.setPanel({ kind: 'visit', guestId: guest.id })} />}
    <Button label={more ? 'Скрыть дополнительные действия' : 'Бонусы и другие действия'} variant="ghost" icon={more ? 'chevron-up' : 'ellipsis-horizontal'} onPress={() => setMore(value => !value)} />
    {more && <View style={{ gap: 14 }}>
      {features.visits && p.venue.serviceFlow && p.venue.serviceFlow.cashSystem !== 'none' && <><Callout>Если чек будет загружен из кассы, не отмечайте этот визит вручную: иначе посещение и бонусы могут задвоиться.</Callout><Button label="Отметить визит вручную" variant="ghost" onPress={() => p.setPanel({ kind: 'visit', guestId: guest.id })} /></>}
      {features.loyalty && <Button label="Начислить бонусы заведения" variant="secondary" icon="gift-outline" onPress={() => p.setPanel({ kind: 'award', guestId: guest.id })} />}
      <Button label="Добавить заметку" variant="ghost" icon="create-outline" onPress={() => p.setPanel({ kind: 'note', guestId: guest.id })} />
      {features.loyalty && <View style={[s.card, { gap: 12 }]}><Txt weight="bold">За бонусы заведения</Txt>{rewards.map(reward => <Button key={reward.id} label={`${reward.name} · ${reward.cost} Б`} disabled={st.balance < reward.cost} variant="ghost" onPress={() => p.setPanel({ kind: 'redeem', guestId: guest.id, rewardId: reward.id })} />)}</View>}
      <View style={[s.card, { gap: 10 }]}><Txt weight="bold">Об истории гостя</Txt><Txt style={s.caption}>{st.count ? `Средний чек: ${money(st.spent / st.count)} ₽` : 'Средний чек пока неизвестен'}</Txt><Txt style={s.caption}>{st.visits.some(v => v.tipsKnown !== false) ? `Чаевые по известным чекам: ${st.tipsPercent}%` : 'Данных о чаевых пока нет'}</Txt><Txt style={s.caption}>{st.rating ? `Впечатление команды: ${st.rating.toFixed(1)} из 5` : 'Оценок команды пока нет'}</Txt></View>
      {otherNotes.slice(3).map(note => <View key={note.id} style={[s.card, { gap: 8 }]}><Txt style={{ lineHeight: 22 }}>{note.text}</Txt><Txt style={s.caption}>{note.author} · {shortDate(note.createdAt)}</Txt></View>)}
    </View>}
    <View><Section title="Последние визиты" />{!st.count ? <Txt style={s.caption}>Здесь появятся подтверждённые визиты. Открытие QR само по себе не создаёт визит.</Txt> : <View style={{ gap: 12 }}>{st.visits.slice(0, 8).map(v => <View key={v.id} style={{ borderBottomWidth: 1, borderColor: C.line, paddingBottom: 12, gap: 6 }}><View style={[s.row, { justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }]}><Txt weight="semibold" style={{ fontSize: 12 }}>{fullDate(v.createdAt)}</Txt><Txt weight="bold" style={{ fontSize: 14 }}>{money(v.bill)} ₽</Txt></View><Txt style={{ color: C.muted, fontSize: 11 }}>{v.source ? `${v.source === 'iiko' ? 'iiko' : 'r_keeper'} · ` : ''}{v.tipsKnown === false ? 'Чаевые не переданы' : `Чаевые ${money(v.tips)} ₽`}</Txt></View>)}</View>}</View>
    <Txt style={{ fontSize: 10, lineHeight: 17, color: C.muted }}>Заметки видит только команда «{p.venue.name}».</Txt>
  </>;
}
const currencyValue = (text: string) => text.trim() ? Number(text.replace(',', '.').replace(/\s/g, '')) : NaN;
function currencyError(text: string, minimum: number, label: string) {
  const normalized = text.replace(/\s/g, '');
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) return `${label}: введите сумму в рублях, не более 2 знаков после запятой.`;
  const value = currencyValue(text);
  return value < minimum || value > 1000000 ? `${label}: от ${money(minimum)} до 1 000 000 ₽.` : '';
}
function VisitForm(p: FormProps & { guestId: string }) {
  const { db } = useStore(); const guest = db.guests.find(g => g.id === p.guestId)!;
  const [bill, setBill] = useState(''); const [tips, setTips] = useState(''); const [rating, setRating] = useState(5); const m = useMutation();
  const [billTouched, setBillTouched] = useState(false); const [tipsTouched, setTipsTouched] = useState(false);
  const billError = currencyError(bill, 0.01, 'Сумма чека'); const tipsError = currencyError(tips.trim() || '0', 0, 'Чаевые');
  const save = () => {
    setBillTouched(true); setTipsTouched(true);
    if (billError || tipsError) return;
    void m.run({ type: 'recordVisit', venueId: p.venue.id, guestId: guest.id, bill: currencyValue(bill), tips: currencyValue(tips.trim() || '0'), rating }, result => p.done(`Визит отмечен · +${result.earned ?? 0} Б заведения`, { kind: 'guest', guestId: guest.id }));
  };
  return <><MiniGuest guestId={guest.id} />
    <View style={{ gap: 8 }}><Field label="Сумма чека, ₽" placeholder="Например, 1800" value={bill} onChangeText={setBill} onBlur={() => setBillTouched(true)} keyboardType="decimal-pad" maxLength={12} editable={!m.busy} /><ErrorMessage message={billTouched ? billError : ''} /></View>
    <View style={{ gap: 8 }}><Field label="Чаевые, ₽" placeholder="0" value={tips} onChangeText={setTips} onBlur={() => setTipsTouched(true)} keyboardType="decimal-pad" maxLength={12} editable={!m.busy} /><ErrorMessage message={tipsTouched ? tipsError : ''} /></View>
    <View style={{ gap: 4 }}><Txt weight="semibold" style={s.caption}>Впечатление команды о визите</Txt><Stars rating={rating} onChange={m.busy ? undefined : setRating} size={32} /></View>
    <Callout>Проверьте имя гостя и сумму чека. Визит и бонусы заведения появятся у гостя после сохранения. Глобальные бонусы начисляются отдельно, когда касса подтвердит оплату чека. Оценка гостя и чаевые доступны только команде заведения.</Callout>
    <ErrorMessage message={m.error} /><Button label="Сохранить визит" loading={m.busy} onPress={save} /></>;
}
function MiniGuest({ guestId }: { guestId: string }) { const { db } = useStore(); const guest = db.guests.find(g => g.id === guestId)!; return <View style={[s.row, { gap: 12, backgroundColor: C.pale, padding: 13, borderRadius: 16 }]}><Avatar guest={guest} size={39} /><Txt weight="bold" style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{guest.name}</Txt></View>; }
function AwardForm(p: FormProps & { guestId: string }) {
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState('Спасибо за то, что выбираете нас'); const m = useMutation();
  return <><MiniGuest guestId={p.guestId} /><Txt weight="bold">Сколько подарим?</Txt><View style={[s.row, { gap: 9 }]}>{[50, 100, 200].map(n => <Button key={n} label={`${n} Б`} variant={amount === `${n}` ? 'primary' : 'secondary'} style={{ flex: 1 }} onPress={() => setAmount(`${n}`)} />)}</View><Field label="Количество бонусов" placeholder="Например, 100" value={amount} onChangeText={setAmount} keyboardType="number-pad" maxLength={5} /><Field label="За что благодарим" value={reason} onChangeText={setReason} multiline maxLength={300} /><ErrorMessage message={m.error} /><Button label="Подарить бонусы" icon="gift-outline" loading={m.busy} disabled={!amount.trim() || !reason.trim()} onPress={() => void m.run({ type: 'awardBonus', venueId: p.venue.id, guestId: p.guestId, amount: Number(amount), reason }, () => p.done(`Подарено ${amount} Б заведения`, { kind: 'guest', guestId: p.guestId }))} /></>;
}
function NoteForm(p: FormProps & { guestId: string }) {
  const [text, setText] = useState(''); const [kind, setKind] = useState<NoteKind>('preference'); const m = useMutation();
  return <><MiniGuest guestId={p.guestId} /><View style={{ gap: 9 }}>{([{ kind: 'thanks', label: 'Есть за что поблагодарить', icon: 'heart-outline' }, { kind: 'preference', label: 'Предпочтения гостя', icon: 'cafe-outline' }, { kind: 'note', label: 'На заметку', icon: 'bookmark-outline' }] as const).map(item => <Pressable accessibilityRole="button" accessibilityLabel={item.label} key={item.kind} onPress={() => setKind(item.kind)} style={[s.row, { gap: 10, padding: 13, borderRadius: 14, backgroundColor: kind === item.kind ? C.pale : '#FFF', borderWidth: 1, borderColor: kind === item.kind ? C.pine : C.line }]}><Icon name={item.icon} size={18} /><Txt weight="semibold" style={{ fontSize: 12, flex: 1 }}>{item.label}</Txt>{kind === item.kind && <Icon name="checkmark-circle" size={18} />}</Pressable>)}</View><Field label="Комментарий о госте" placeholder="Что стоит запомнить команде?" value={text} onChangeText={setText} multiline maxLength={1000} /><ErrorMessage message={m.error} /><Button label="Сохранить заметку" loading={m.busy} onPress={() => void m.run({ type: 'addNote', venueId: p.venue.id, guestId: p.guestId, text, kind }, () => p.done('Заметка сохранена', { kind: 'guest', guestId: p.guestId }))} /></>;
}
function ProgramForm(p: FormProps) {
  const [cashback, setCashback] = useState(`${p.venue.program.cashback}`); const [every, setEvery] = useState(`${p.venue.program.everyVisits}`); const [visit, setVisit] = useState(`${p.venue.program.visitBonus}`); const [tips, setTips] = useState(`${p.venue.program.tipsBonus}`); const m = useMutation();
  return <><Field label="Кешбэк с чека, % (0–30)" value={cashback} onChangeText={setCashback} keyboardType="number-pad" maxLength={2} /><Field label="Каждый N-й визит (2–100)" value={every} onChangeText={setEvery} keyboardType="number-pad" maxLength={3} /><Field label="Бонус за N-й визит, Б" value={visit} onChangeText={setVisit} keyboardType="number-pad" maxLength={5} /><Field label="Бонус за чаевые от 10%, Б" value={tips} onChangeText={setTips} keyboardType="number-pad" maxLength={5} /><Callout>Новые правила применяются к следующим визитам. Уже начисленные бонусы сохранятся.</Callout><ErrorMessage message={m.error} /><Button label="Сохранить программу" loading={m.busy} onPress={() => void m.run({ type: 'updateProgram', venueId: p.venue.id, program: { cashback: cashback.trim() ? Number(cashback) : null, everyVisits: every.trim() ? Number(every) : null, visitBonus: visit.trim() ? Number(visit) : null, tipsBonus: tips.trim() ? Number(tips) : null } }, () => p.done('Программа обновлена'))} /></>;
}
function ReviewForm(p: FormProps) {
  const { db, guestId } = useStore(); const [rating, setRating] = useState(5); const [text, setText] = useState(''); const m = useMutation();
  const eligible = stats(db, p.venue.id, guestId).visits.some(v => !db.reviews.some(r => r.visitId === v.id));
  return <><View style={{ alignItems: 'center', gap: 10 }}><Icon name="chatbubble-ellipses-outline" size={35} /><Txt style={s.caption}>Ваши слова помогут команде стать лучше.</Txt><Stars rating={rating} onChange={setRating} size={35} /></View><Field label="Ваш отзыв о заведении" placeholder="Что вам запомнилось?" value={text} onChangeText={setText} multiline maxLength={1000} />{!eligible && <Callout>Вы уже оставили отзывы обо всех отмеченных визитах. Приходите снова — будем рады новому отзыву.</Callout>}<ErrorMessage message={m.error} /><Button label="Сохранить отзыв" disabled={!eligible} loading={m.busy} onPress={() => void m.run({ type: 'addReview', venueId: p.venue.id, rating, text }, () => p.done('Спасибо! Ваш отзыв сохранён'))} /></>;
}
function ReplyForm(p: FormProps & { reviewId: string }) {
  const { db } = useStore(); const review = db.reviews.find(r => r.id === p.reviewId)!; const [text, setText] = useState(review.response ?? ''); const m = useMutation();
  return <><View style={s.card}><Stars rating={review.rating} /><Txt style={{ fontSize: 13, lineHeight: 22, marginTop: 12 }}>{review.text}</Txt></View><Field label="Ответ гостю" placeholder="Поблагодарите или помогите разобраться" value={text} onChangeText={setText} multiline maxLength={1000} /><ErrorMessage message={m.error} /><Button label="Сохранить ответ" loading={m.busy} onPress={() => void m.run({ type: 'replyReview', reviewId: p.reviewId, response: text }, () => p.done('Ответ сохранён'))} /></>;
}
function RedeemForm(p: FormProps & { guestId: string; rewardId: string }) {
  const { db, guestCode } = useStore(); const reward = rewards.find(r => r.id === p.rewardId)!; const balance = stats(db, p.venue.id, p.guestId).balance; const m = useMutation();
  return <><MiniGuest guestId={p.guestId} /><View style={{ alignItems: 'center', gap: 12, paddingVertical: 10 }}><View style={{ width: 100, height: 100, backgroundColor: C.pale, borderRadius: 35, alignItems: 'center', justifyContent: 'center' }}><Icon name={reward.icon} size={49} /></View><Txt weight="extra" style={{ fontSize: 23 }}>{reward.name}</Txt><Txt style={s.caption}>{reward.description}</Txt><Pill label={`${reward.cost} Б`} /></View>{p.role === 'guest' && <><GuestCode code={guestCode} /><Callout>Покажите свой код гостя сотруднику. Он выдаст комплимент и подтвердит списание.</Callout></>}<Callout>При выдаче комплимента спишется {reward.cost} бонусов заведения в «{p.venue.name}». Баланс заведения после списания: {Math.max(0, balance - reward.cost)} Б. Глобальный счёт не изменится. Списание сохранится на сервере и будет видно гостю на всех его устройствах. Касса пока не подключена.</Callout>{balance < reward.cost && <ErrorMessage message={`Недостаточно бонусов. На счёте ${balance} Б.`} />}<ErrorMessage message={m.error} /><Button label={p.role === 'staff' ? `Подтвердить списание ${reward.cost} Б` : 'Списание подтверждает сотрудник'} icon="checkmark" disabled={balance < reward.cost || p.role !== 'staff'} loading={m.busy} onPress={() => void m.run({ type: 'redeemReward', venueId: p.venue.id, guestId: p.guestId, rewardId: p.rewardId }, () => p.done('Комплимент выбран · списание сохранено'))} /></>;
}
