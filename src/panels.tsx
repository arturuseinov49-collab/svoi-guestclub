import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Role, Venue } from './domain';
import { Command, CommandResult, StaffMember, useStore } from './store';
import { Button, C, Callout, Field, Icon, Pill, Sheet, Txt, s } from './ui';
import { GuestQr, ScanGuest } from './qr';
import { CopyCode } from './copy-code';
import { StaffGuestProfile, StaffReplyForm, StaffVisitForm } from './feedback-ui';
export type Panel = null | { kind: 'settings' | 'venues' | 'scan' | 'newGuest' | 'program' | 'review' | 'integrations' | 'joinVenue' | 'acceptInvite' | 'team' } | { kind: 'guest' | 'feedbackVisit' | 'visit' | 'award' | 'note'; guestId: string } | { kind: 'reply'; reviewId: string } | { kind: 'replyFeedback'; feedbackId: string } | { kind: 'redeem'; guestId: string; rewardId: string } | { kind: 'pick'; next: 'visit' | 'award' | 'redeem'; rewardId?: string };
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
  if (!p.panel || ['integrations', 'visit', 'award', 'note', 'program', 'review', 'reply', 'redeem', 'pick'].includes(p.panel.kind)) return null;
  const { panel } = p;
  const titles: Record<string, string> = { settings: 'Ваши «Свои»', joinVenue: 'Вступить в клуб', acceptInvite: 'Приглашение в команду', team: 'Команда заведения', venues: 'Любимые места', scan: 'QR гостя', newGuest: 'Знакомство начинается здесь', guest: 'Карточка гостя', feedbackVisit: 'После визита', replyFeedback: 'Ответ от команды' };
  const title = panel.kind === 'guest' ? db.guests.find(g => g.id === panel.guestId)?.name ?? titles.guest : titles[panel.kind];
  const done = (message: string, next: Panel = null) => { p.notify(message); p.setPanel(next); };
  const bodyProps = { ...p, done };
  return <Sheet visible title={title} subtitle={['feedbackVisit', 'replyFeedback'].includes(panel.kind) ? `Заведение «${p.venue.name}»` : undefined} onClose={() => p.setPanel(null)}><PanelBody key={`${panel.kind}-${p.venue.id}-${'guestId' in panel ? panel.guestId : 'feedbackId' in panel ? panel.feedbackId : ''}`} {...bodyProps} /></Sheet>;
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
    case 'guest': return <StaffGuestProfile venue={p.venue} guestId={panel.guestId} onFinish={() => p.setPanel({ kind: 'feedbackVisit', guestId: panel.guestId })} />;
    case 'feedbackVisit': return <StaffVisitForm venue={p.venue} guestId={panel.guestId} onDone={() => p.done('Визит и заметка сохранены', { kind: 'guest', guestId: panel.guestId })} onBack={() => p.setPanel({ kind: 'guest', guestId: panel.guestId })} />;
    case 'replyFeedback': return <StaffReplyForm venueId={p.venue.id} feedbackId={panel.feedbackId} onDone={() => p.done('Ответ гостю сохранён')} />;
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
    {staff?.role === 'owner' && <Button label="Управление командой" icon="people-outline" onPress={() => p.setPanel({ kind: 'team' })} />}
    {staff && <View style={[s.card, { gap: 8 }]}><Txt weight="bold">Код клуба для гостей</Txt><Txt selectable weight="extra" style={{ fontSize: 25, letterSpacing: 2 }}>{(p.venue as Venue & { joinCode?: string }).joinCode}</Txt><CopyCode code={(p.venue as Venue & { joinCode?: string }).joinCode ?? ''} label="Скопировать код клуба" /><Txt style={s.caption}>Гость вводит этот код в «Вступить в клуб». Доступ сотрудника он не даёт.</Txt></View>}
    <Button label="Вступить в клуб" icon="add" variant="secondary" onPress={() => p.setPanel({ kind: 'joinVenue' })} />
    <Button label="У меня приглашение в команду" variant="ghost" onPress={() => p.setPanel({ kind: 'acceptInvite' })} />
    {isDeveloper && <Button label="Панель разработчика" icon="construct-outline" variant="secondary" onPress={p.openDeveloper} />}
    <Button label="Обновить данные" icon="sync-outline" variant="ghost" onPress={() => { void refresh(); p.setPanel(null); }} />
    {Platform.OS === 'web' && <Button label="Экспортировать доступные данные" icon="download-outline" variant="ghost" onPress={exportData} />}
    <ErrorMessage message={error} /><Button label="Выйти из аккаунта" variant="ghost" loading={busy} onPress={() => { setBusy(true); void logout().catch(e => setError(e.message)).finally(() => setBusy(false)); }} />
    <Txt style={s.caption}>Внутренние анкеты и заметки доступны только команде заведения. Гость отдельно делится впечатлениями о своём визите.</Txt></>;
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
    <Callout>Сотрудники видят гостей и внутренние заметки только этого заведения. Доступ команде выдаёт руководитель.</Callout>
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
