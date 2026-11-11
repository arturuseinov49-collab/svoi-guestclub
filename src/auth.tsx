import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useStore } from './store';
import { GuestCode, useMutation } from './panels';
import { Button, C, Callout, Field, Icon, Txt, fx, s } from './ui';
import { telegramApp } from './telegram';
import { SyncStatus } from './sync-status';

export function LoginScreen() {
  const { loading, error, retry } = useStore();
  const openTelegram = () => { window.location.href = 'https://t.me/svoi_guestclub_demo_bot'; };
  return <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, paddingVertical: 34, gap: 25 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}><View {...fx('brand')} style={{ backgroundColor: C.pine, padding: 12, borderRadius: 18, overflow: 'hidden' }}><Icon name="leaf" color={C.lime} size={25} /></View><Txt weight="extra" style={{ fontSize: 37, letterSpacing: -1.8 }}>свои</Txt><View style={{ flex: 1 }} /><Icon name="sparkles-outline" size={22} color={C.orange} /></View>
    <View {...fx('hero')} style={{ backgroundColor: C.lime, borderRadius: 30, borderWidth: 1, borderColor: '#FFFFFFB3', padding: 24, gap: 19, overflow: 'hidden' }}>
      <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#FFFFFF85', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20 }}><Icon name="sparkles" size={12} color={C.pine} /><Txt weight="bold" style={{ fontSize: 9, letterSpacing: 0.7, color: C.pine }}>КЛУБ ХОРОШИХ ПРИВЫЧЕК</Txt></View>
      <Txt weight="extra" style={{ fontSize: 38, lineHeight: 43, letterSpacing: -1.7 }}>{'Свои люди.\nСвой аккаунт.'}</Txt>
      <Txt style={{ fontSize: 14, lineHeight: 23, color: C.pine }}>Бонусы, визиты и любимые места — с вами на любом телефоне.</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginTop: 3 }}><Txt weight="semibold" style={{ fontSize: 12, color: C.pine, flex: 1 }}>Быть своим — приятно</Txt><View {...fx('foil')} style={{ width: 54, height: 54, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: C.lavender, overflow: 'hidden' }}><Icon name="paper-plane" size={25} color={C.pine} /></View></View>
    </View>
    {loading ? <View style={{ alignItems: 'center', gap: 12 }}><ActivityIndicator color={C.ink} /><Txt>Входим через Telegram…</Txt></View> : <><Button label="Войти через Telegram" icon="paper-plane-outline" onPress={openTelegram} /><Txt style={[s.caption, { textAlign: 'center' }]}>Откройте бота, нажмите «Начать», затем «Открыть “Свои”». Вход произойдёт автоматически.</Txt></>}
    {!!error && <Txt accessibilityRole="alert" style={{ color: C.red, lineHeight: 21 }}>{error}</Txt>}
    {!loading && !!telegramApp()?.initData && <Button label="Повторить вход" variant="ghost" onPress={() => void retry()} />}
    <View style={{ gap: 9, paddingHorizontal: 3 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name="shield-checkmark-outline" size={15} color={C.pine} /><Txt weight="bold" style={{ fontSize: 12 }}>Ваш Telegram — ваш профиль</Txt></View><Txt style={s.caption}>Гости показывают личный QR при визите. Команда получает доступ к своему заведению по приглашению руководителя.</Txt></View>
  </ScrollView>;
}
export function WelcomeScreen({ onReady, onDeveloper, showSyncStatus = true }: { onReady: (venueId: string, staff: boolean) => void; onDeveloper: () => void; showSyncStatus?: boolean }) {
  const { user, guestCode, isDeveloper, logout } = useStore();
  const [mode, setMode] = useState<'guest' | 'staff'>('guest');
  const [code, setCode] = useState('');
  const [logoutError, setLogoutError] = useState(''); const m = useMutation();
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 22, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
    <View style={{ gap: 12 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><Txt weight="extra" style={{ fontSize: 30, letterSpacing: -1.4 }}>свои ↗</Txt><Icon name="sparkles-outline" color={C.orange} size={19} /></View><Txt weight="extra" style={s.title}>{`${user?.firstName},\nРады вам.`}</Txt><Txt style={s.caption}>Вы вошли через Telegram. Начнём вашу историю.</Txt></View>
    {showSyncStatus && <SyncStatus />}
    {isDeveloper && <Button label="Панель разработчика" icon="construct-outline" variant="secondary" onPress={onDeveloper} />}
    <View style={{ flexDirection: 'row', gap: 9 }}>{([{ id: 'guest', label: 'Я гость' }, { id: 'staff', label: 'Я сотрудник' }] as const).map(item => <Button key={item.id} label={item.label} style={{ flex: 1 }} variant={mode === item.id ? 'primary' : 'ghost'} onPress={() => { setMode(item.id); setCode(''); }} />)}</View>
    {mode === 'guest' && <GuestCode code={guestCode} />}
    <Field label={mode === 'staff' ? 'Код приглашения' : 'Код клуба'} placeholder={mode === 'staff' ? 'Личный код в команду' : '8 символов от заведения'} value={code} onChangeText={setCode} autoCapitalize="characters" maxLength={40} />
    <Callout>{mode === 'staff' ? 'Сотруднику код выдаёт руководитель. Руководитель получает приглашение от разработчика «Своих». Код действует один раз в течение 24 часов.' : 'Покажите сотруднику свой QR — он добавит вас в клуб и отметит визит. Или вступите в клуб по коду заведения.'}</Callout>
    {!!m.error && <Txt accessibilityRole="alert" style={{ color: C.red }}>{m.error}</Txt>}
    <Button label={mode === 'staff' ? 'Принять приглашение' : 'Вступить в клуб'} loading={m.busy} disabled={!code.trim()} onPress={() => void m.run({ type: mode === 'staff' ? 'acceptStaffInvite' : 'joinVenue', code: code.trim().toUpperCase() }, result => { if (result.venueId) onReady(result.venueId, mode === 'staff'); })} />
    <Txt style={s.caption}>Заведения добавляет команда «Своих». Ваш профиль и бонусы доступны на любом телефоне через Telegram.</Txt>
    {!!logoutError && <Txt style={{ color: C.red }}>{logoutError}</Txt>}<Button label="Выйти из аккаунта" variant="ghost" onPress={() => void logout().catch(e => setLogoutError(e.message))} />
  </ScrollView>;
}
