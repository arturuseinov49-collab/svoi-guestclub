import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import { Manrope_800ExtraBold } from '@expo-google-fonts/manrope/800ExtraBold';
import { Role } from './src/domain';
import { StoreProvider, useStore } from './src/store';
import { Guests, Home, Reviews, ScreenActions } from './src/screens';
import { Panel, Panels } from './src/panels';
import { C, Icon, IconButton, IconName, Txt, fx } from './src/ui';
import { useTelegram, telegramSuccess } from './src/telegram';
import { LoginScreen, WelcomeScreen } from './src/auth';
import { DeveloperPanel } from './src/developer';
import { SyncStatus } from './src/sync-status';
import { GuestPortal } from './src/guest-venues';
export default function App() {
  const [fonts, fontError] = useFonts({ Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold, CormorantGaramondBold: require('./assets/fonts/CormorantGaramond-Bold.ttf') });
  if (!fonts && !fontError) return <View style={styles.loading}><ActivityIndicator color={C.pine} /></View>;
  return <SafeAreaProvider><StoreProvider><AccountBoundary /></StoreProvider></SafeAreaProvider>;
}
function AccountBoundary() { const { user } = useStore(); return <Application key={user?.id ?? 'signed-out'} />; }
function Application() {
  const { db, ready, isDeveloper, staffVenues, syncError } = useStore();
  const insets = useSafeAreaInsets();
  const [requestedRole, setRole] = useState<Role>('staff');
  const [venueId, setVenueId] = useState('');
  const [tab, setTab] = useState(0);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [panelContext, setPanelContext] = useState<{ value: Panel; venueId: string }>({ value: null, venueId: '' });
  const panel = panelContext.value;
  const [toast, setToast] = useState('');
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const guestMode = ready && (requestedRole === 'guest' || staffVenues.length === 0);
  const venue = db.venues.find(v => v.id === venueId && staffVenues.some(item => item.venueId === v.id)) ?? db.venues.find(v => staffVenues.some(item => item.venueId === v.id)) ?? db.venues[0];
  const setPanel = (value: Panel) => setPanelContext({ value, venueId: venue?.id ?? '' });
  const openDeveloper = () => { setPanel(null); if (isDeveloper) setDeveloperOpen(true); };
  const telegram = useTelegram(developerOpen || !!panel || tab !== 0, () => { if (developerOpen) setDeveloperOpen(false); else if (panel) setPanel(null); else setTab(0); }, !guestMode);
  const permission = staffVenues.find(v => v.venueId === venue?.id);
  const role: Role = requestedRole === 'staff' && permission ? 'staff' : 'guest';
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [tab, venueId, role]);
  useEffect(() => { if (toast) { telegramSuccess(); const timer = setTimeout(() => setToast(''), 3800); return () => clearTimeout(timer); } }, [toast]);
  const changeRole = (next: Role) => { setRole(next); setTab(0); setPanel(null); };
  const changeVenue = (id: string) => { setVenueId(id); setTab(0); };
  if (guestMode) return <GuestPortal onStaff={id => { if (id) changeVenue(id); changeRole('staff'); }} />;
  if (!ready || !venue) return <View style={styles.outer}><StatusBar style="dark" /><View style={[styles.phone, { paddingTop: Math.max(insets.top, telegram.top), paddingBottom: Math.max(insets.bottom, telegram.bottom) }]}>{!ready ? <LoginScreen /> : <WelcomeScreen onDeveloper={openDeveloper} onReady={(id, staff) => { changeVenue(id); changeRole(staff ? 'staff' : 'guest'); }} />}{ready && isDeveloper && developerOpen && <DeveloperPanel onClose={() => setDeveloperOpen(false)} />}</View></View>;
  const actions: ScreenActions = {
    venue, go: setTab,
    guest: id => { if (role === 'staff') setPanel({ kind: 'guest', guestId: id }); },
    scan: () => { if (role === 'staff') setPanel({ kind: 'scan' }); },
    replyFeedback: feedbackId => { if (role === 'staff') setPanel({ kind: 'replyFeedback', feedbackId }); },
  };
  const tabs: { id: number; title: string; icon: IconName; active: IconName }[] = [
    { id: 0, title: 'Смена', icon: 'scan-outline', active: 'scan' },
    { id: 1, title: 'Гости', icon: 'people-outline', active: 'people' },
    { id: 2, title: 'Отзывы', icon: 'chatbubbles-outline', active: 'chatbubbles' },
  ];
  const activeTab = tab;
  const staffPanels = ['guest', 'feedbackVisit', 'replyFeedback', 'newGuest', 'scan'];
  const ownerPanels = ['team'];
  const allowedPanel = panel && (panelContext.venueId !== venue.id || (('guestId' in panel) && !db.memberships.some(m => m.guestId === panel.guestId && m.venueId === venue.id)) || (('feedbackId' in panel) && !(db.guestFeedback ?? []).some(item => item.id === panel.feedbackId && item.venueId === venue.id)) || (staffPanels.includes(panel.kind) && role !== 'staff') || (ownerPanels.includes(panel.kind) && permission?.role !== 'owner')) ? null : panel;
  const panelProps = { panel: allowedPanel, venue, role, setPanel, setVenue: changeVenue, setRole: changeRole, notify: setToast, openDeveloper };
  return <View style={styles.outer}><StatusBar style="dark" /><View style={[styles.phone, { paddingTop: Math.max(insets.top, telegram.top), paddingBottom: telegram.bottom }]}>
    <View style={styles.brandHeader}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View {...fx("brand")} style={styles.brandIcon}><Icon name="leaf" size={17} color={C.lime} /></View><Txt weight="extra" style={{ fontSize: 31, letterSpacing: -2 }}>свои</Txt></View><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Pressable accessibilityRole="button" accessibilityLabel="Ваш аккаунт и доступ" onPress={() => setPanel({ kind: 'settings' })} style={styles.rolePill}><View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: C.pine }} /><Txt weight="bold" style={{ fontSize: 9, letterSpacing: 0.8 }}>{role === 'staff' ? 'КОМАНДА' : 'ГОСТЬ'} · {syncError ? 'НЕТ СВЯЗИ' : 'LIVE'}</Txt></Pressable><IconButton name="settings-outline" label="Профиль и настройки" onPress={() => setPanel({ kind: 'settings' })} /></View></View>
    <View style={styles.venueBar}><Pressable accessibilityRole="button" accessibilityLabel={`Сменить заведение, сейчас ${venue.name}`} onPress={() => setPanel({ kind: 'venues' })} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}><View {...fx("foil")} style={styles.venueIcon}><Txt weight="extra" style={{ fontSize: 17 }}>{venue.monogram}</Txt></View><View style={{ gap: 3, flex: 1, minWidth: 0 }}><Txt numberOfLines={1} weight="bold" style={{ fontSize: 13 }}>{venue.name} <Icon name="chevron-down" size={12} /></Txt><Txt numberOfLines={1} style={{ color: C.muted, fontSize: 10 }}>{venue.kind}</Txt></View></Pressable>{role === 'guest' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, maxWidth: '42%' }}><Icon name="location-outline" size={13} color={C.muted} /><Txt numberOfLines={2} style={{ fontSize: 10, color: C.muted, flexShrink: 1 }}>{venue.address}</Txt></View>}</View>
    <SyncStatus />
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{tab === 0 ? <Home {...actions} /> : tab === 1 ? <Guests {...actions} /> : <Reviews {...actions} />}</ScrollView>
    <View {...fx("nav")} style={[styles.nav, { paddingBottom: Math.max(insets.bottom, Platform.OS === 'web' ? 13 : 8) }]}>{tabs.map(item => <Pressable key={item.title} accessibilityRole="tab" accessibilityLabel={item.title} accessibilityState={{ selected: activeTab === item.id }} onPress={() => setTab(item.id)} style={({ pressed }) => [styles.navItem, pressed && { opacity: 0.55 }]}><View {...fx(activeTab === item.id ? "nav-active" : "nav-idle")} style={[styles.navIcon, activeTab === item.id && { backgroundColor: C.lime }]}><Icon name={activeTab === item.id ? item.active : item.icon} color={activeTab === item.id ? C.pine : '#8D978B'} size={21} /></View><Txt weight={activeTab === item.id ? 'bold' : 'medium'} style={{ fontSize: 10, color: activeTab === item.id ? C.lime : '#B8BCAF' }}>{item.title}</Txt></Pressable>)}</View>
    {!!toast && <Pressable accessibilityRole="alert" onPress={() => setToast('')} style={[styles.toast, { top: insets.top + 9 }]}><Icon name="checkmark-circle" size={21} color={C.lime} /><Txt weight="semibold" style={{ color: '#FFF', fontSize: 12, flex: 1 }}>{toast}</Txt><Icon name="close" size={17} color="#FFF" /></Pressable>}
    <Panels {...panelProps} />
    {isDeveloper && developerOpen && <DeveloperPanel onClose={() => setDeveloperOpen(false)} />}
  </View></View>;
}
const styles = StyleSheet.create({
  outer: { flex: 1, backgroundColor: '#E8EDE3', alignItems: 'center' },
  phone: { flex: 1, width: '100%', maxWidth: 480, backgroundColor: C.bg, overflow: 'hidden' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  brandHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, height: 77 },
  brandIcon: { width: 29, height: 30, backgroundColor: C.pine, borderTopLeftRadius: 11, borderTopRightRadius: 11, borderBottomLeftRadius: 11, borderBottomRightRadius: 3, alignItems: 'center', justifyContent: 'center' },
  rolePill: { flexDirection: 'row', gap: 5, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#CCDFBA', backgroundColor: '#E8F4D6', paddingVertical: 7, paddingHorizontal: 8 },
  venueBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 22, paddingBottom: 17, borderBottomWidth: 1, borderColor: C.line },
  venueIcon: { width: 35, height: 35, backgroundColor: C.lavender, borderRadius: 12, borderWidth: 1, borderColor: '#E4DDEE', justifyContent: 'center', alignItems: 'center' },
  nav: { flexDirection: 'row', backgroundColor: C.ink, paddingTop: 8, borderTopWidth: 1, borderColor: C.ink },
  navItem: { flex: 1, alignItems: 'center', gap: 2, paddingTop: 1, minHeight: 52 },
  navIcon: { width: 48, height: 31, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  toast: { position: 'absolute', alignSelf: 'center', width: '90%', backgroundColor: C.dark, padding: 15, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 50, boxShadow: '0px 6px 24px #0002' },
});
