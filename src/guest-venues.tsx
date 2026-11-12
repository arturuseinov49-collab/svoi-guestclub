import React, { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Venue, money, stats } from './domain';
import { effectiveGuestProfile } from './venue-profile';
import { useStore } from './store';
import { Button, C, Callout, Empty, Icon, IconButton, IconName, Pill, Sheet, Txt, fx, s } from './ui';
import { GuestQr } from './qr';
import { WelcomeScreen } from './auth';
import { DeveloperPanel } from './developer';
import { SyncStatus } from './sync-status';
import { Bonuses, MyVisits, Reviews, ScreenActions } from './screens';
import { Panel, Panels } from './panels';
import { useTelegram } from './telegram';
import { ElpastorArt } from './elpastor-art';
import { ClubIconButton, ElpastorClubPage, EP } from './elpastor-club';
import { ElpastorQrSheet } from './elpastor-qr';
import { GlobalWalletCard, globalEarningDescription } from './bonus-ui';
import { GlobalWalletDetails } from './global-wallet';

type GuestTab = 'home' | 'visits' | 'bonuses' | 'reviews';
function VenueArt({ venue, large = false }: { venue: Venue; large?: boolean }) {
  const profile = effectiveGuestProfile(venue);
  if (profile.theme === 'elpastor') return <ElpastorArt large={large} demo={profile.demo} />;
  return <View {...fx('hero')} style={[xs.art, { minHeight: large ? 235 : 180, backgroundColor: C.lime }]}>
    <View style={[s.row, { justifyContent: 'space-between', gap: 10 }]}><Txt weight="bold" style={{ color: C.pine, fontSize: 9, letterSpacing: 1.5 }}>СВОИ / ЛЮБИМЫЕ МЕСТА</Txt>{profile.demo && <Pill label="Тестовая карточка" background="#FFFFFFB3" color={C.pine} />}</View>
    <Txt weight="extra" style={{ fontSize: large ? 35 : 30, lineHeight: large ? 42 : 36, letterSpacing: -1.3, color: C.ink }}>{venue.name}</Txt>
    <View style={[s.row, { gap: 8 }]}><Icon name="storefront-outline" size={15} color={C.pine} /><Txt weight="medium" style={{ flex: 1, fontSize: 11, lineHeight: 18, color: C.pine }}>{profile.tagline || venue.kind}</Txt></View>
  </View>;
}

export function GuestPortal({ onStaff }: { onStaff: (venueId?: string) => void }) {
  const { db, catalog, user, guestId, guestCode, guestQr, isDeveloper, staffVenues, globalWallet, globalProgram } = useStore();
  const insets = useSafeAreaInsets();
  const [selectedId, setSelectedId] = useState('');
  const [requestedTab, setTab] = useState<GuestTab>('home');
  const [overlay, setOverlay] = useState<'qr' | 'account' | 'developer' | 'global' | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState('');
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Public discovery adds no membership and exposes no other guests' records.
  const ownVenues = db.venues.filter(v => db.memberships.some(m => m.guestId === guestId && m.venueId === v.id));
  const venues = [...new Map([...catalog, ...ownVenues].map(v => [v.id, v])).values()];
  const venue = venues.find(v => v.id === selectedId);
  const profile = venue ? effectiveGuestProfile(venue) : null;
  const club = profile?.theme === 'elpastor';
  const back = () => {
    if (overlay) setOverlay(null);
    else if (panel) setPanel(null);
    else if (requestedTab !== 'home') setTab('home');
    else { setSelectedId(''); setNotice(''); }
  };
  const telegram = useTelegram(!!overlay || !!panel || !!venue, back, true, club ? EP.bg : C.bg);
  const choose = (id: string) => { setSelectedId(id); setTab('home'); setPanel(null); setNotice(''); };
  const toCatalog = () => { choose(''); setOverlay(null); };
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [selectedId, requestedTab]);
  const my = venue ? stats(db, venue.id, guestId) : null;
  const hasTransactions = !!venue && db.transactions.some(t => t.venueId === venue.id && t.guestId === guestId);
  const hasReviews = !!venue && db.reviews.some(r => r.venueId === venue.id && r.guestId === guestId);
  const tabs: { id: GuestTab; title: string; icon: IconName }[] = [{ id: 'home', title: 'Заведение', icon: 'storefront-outline' }];
  if (profile?.features.visits || my?.count) tabs.push({ id: 'visits', title: 'Визиты', icon: 'footsteps-outline' });
  if (profile?.features.loyalty || hasTransactions || my?.balance) tabs.push({ id: 'bonuses', title: 'Бонусы', icon: 'gift-outline' });
  if (profile?.features.reviews || hasReviews) tabs.push({ id: 'reviews', title: 'Отзывы', icon: 'chatbubbles-outline' });
  const tab = tabs.some(item => item.id === requestedTab) ? requestedTab : 'home';
  const openLink = async (url: string) => {
    try { await Linking.openURL(url); } catch { setNotice('Не удалось открыть ссылку. Попробуйте ещё раз.'); }
  };
  const actions: ScreenActions | null = venue ? {
    venue, role: 'guest', go: index => setTab((['home', 'visits', 'bonuses', 'reviews'] as GuestTab[])[index] ?? 'home'),
    guest: () => {}, visit: () => {}, scan: () => {}, award: () => {}, program: () => {}, reply: () => {},
    globalBonuses: () => setOverlay('global'),
    review: () => { if (profile?.features.reviews) setPanel({ kind: 'review' }); },
    redeem: (rewardId, id) => { if (profile?.features.loyalty && id === guestId) setPanel({ kind: 'redeem', rewardId, guestId }); },
  } : null;
  const allowedPanel = panel && ((panel.kind === 'review' && profile?.features.reviews) || (panel.kind === 'redeem' && profile?.features.loyalty)) ? panel : null;
  return <View style={[xs.outer, club && { backgroundColor: '#16060D' }]}><StatusBar style={club ? 'light' : 'dark'} /><View {...fx(club ? 'elpastor-page' : '')} style={[xs.phone, { paddingTop: Math.max(insets.top, telegram.top), paddingBottom: Math.max(insets.bottom, telegram.bottom) }, club && { backgroundColor: EP.bg }]}>
    <View style={xs.header}>{venue ? <Pressable accessibilityRole="button" accessibilityLabel="Все заведения" onPress={toCatalog} style={[s.row, { minHeight: 44, gap: 8, flex: 1 }]}><Icon name="arrow-back" size={21} color={club ? EP.gold : C.ink} /><Txt weight="bold" style={{ fontSize: 12, color: club ? EP.cream : C.ink }}>Все заведения</Txt></Pressable> : <View style={[s.row, { flex: 1, gap: 8 }]}><View {...fx('brand')} style={xs.brand}><Icon name="leaf" color={C.lime} size={17} /></View><Txt weight="extra" style={{ fontSize: 30, letterSpacing: -1.6 }}>свои</Txt></View>}{club ? <><ClubIconButton icon="qr-code-outline" label="Мой QR" onPress={() => setOverlay('qr')} /><ClubIconButton icon="person-outline" label="Профиль и настройки" onPress={() => setOverlay('account')} /></> : <><IconButton name="qr-code-outline" label="Мой QR" onPress={() => setOverlay('qr')} /><IconButton name="person-outline" label="Профиль и настройки" onPress={() => setOverlay('account')} /></>}</View>
    <SyncStatus />
    {!!notice && <Pressable accessibilityRole="alert" onPress={() => setNotice('')} style={{ backgroundColor: club ? EP.surface : C.pale, padding: 14 }}><Txt style={{ fontSize: 12, color: club ? EP.cream : C.ink }}>{notice}</Txt></Pressable>}
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {!venue ? <View style={{ gap: 24 }}>
        <View style={{ paddingHorizontal: 22, paddingTop: 14, gap: 10 }}><Txt weight="bold" style={s.eyebrow}>ВАШИ МЕСТА · ВАШИ ПРАВИЛА</Txt><Txt weight="extra" style={[s.title, { fontSize: 38, lineHeight: 44 }]}>Куда сегодня{user?.firstName ? `,\n${user.firstName}` : ''}?</Txt><Txt style={s.caption}>Выберите заведение. Внутри — его возможности, ваши визиты и отдельная программа клуба.</Txt></View>
        <View style={{ paddingHorizontal: 22 }}><GlobalWalletCard balance={globalWallet?.balance ?? null} pendingReview={globalWallet?.pendingReview} caption={globalEarningDescription(globalProgram)} onPress={() => setOverlay('global')} /></View>
        <View style={{ paddingHorizontal: 22, gap: 18 }}>{venues.map(item => {
          const itemProfile = effectiveGuestProfile(item); const state = stats(db, item.id, guestId);
          const member = ownVenues.some(v => v.id === item.id);
          return <Pressable {...fx(itemProfile.theme === 'elpastor' ? 'elpastor-tile' : '')} key={item.id} accessibilityRole="button" accessibilityLabel={`Открыть заведение ${item.name}`} onPress={() => choose(item.id)} style={({ pressed }) => [xs.card, pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] }]}>
            <VenueArt venue={item} />
            <View style={{ padding: 18, gap: 12 }}><View style={[s.row, { alignItems: 'flex-start', gap: 8 }]}><View style={{ flex: 1, gap: 5 }}><Txt weight="extra" style={{ fontSize: 20 }}>{item.name}</Txt><Txt style={s.caption}>{item.kind}</Txt></View><View style={xs.arrow}><Icon name="arrow-up-outline" size={19} color={C.pine} /></View></View><View style={[s.row, { gap: 6 }]}><Icon name="location-outline" size={14} color={C.muted} /><Txt style={[s.caption, { flex: 1 }]}>{item.address}</Txt></View><View style={[s.row, { justifyContent: 'space-between', gap: 8, paddingTop: 12, borderTopWidth: 1, borderColor: C.line }]}><Txt weight="bold" style={{ color: C.pine, fontSize: 12 }}>Открыть заведение</Txt>{member && itemProfile.features.loyalty ? <View style={{ gap: 4, alignItems: 'flex-end', minWidth: 0 }}><Txt style={{ fontSize: 9, color: C.muted }}>Бонусы заведения</Txt><Pill label={`${money(state.balance)} Б`} /></View> : <Txt style={{ fontSize: 10, color: C.muted }}>{member ? 'Вы уже в клубе' : itemProfile.demo ? 'Знакомство с концепцией' : 'Условия внутри'}</Txt>}</View></View>
          </Pressable>;
        })}</View>
        {!venues.length && <><Empty icon="storefront-outline" title="Ваше первое место" text="Опубликованные заведения появятся здесь. Уже бывали у нас? Покажите сотруднику QR или введите код клуба." /><WelcomeScreen showSyncStatus={false} onDeveloper={() => setOverlay('developer')} onReady={(id, staff) => { if (staff) onStaff(id); else choose(id); }} /></>}
        {!!venues.length && <View style={{ paddingHorizontal: 22, gap: 12 }}><Button label="Мой QR для визита" icon="qr-code-outline" variant="secondary" onPress={() => setOverlay('qr')} /><Button label="Есть приглашение или код клуба" variant="ghost" onPress={() => setOverlay('account')} />{isDeveloper && <Button label="Панель разработчика" icon="construct-outline" variant="ghost" onPress={() => setOverlay('developer')} />}{!!staffVenues.length && <Button label="Перейти в режим сотрудника" icon="people-outline" variant="ghost" onPress={() => onStaff()} />}</View>}
      </View> : tab === 'home' ? club ? <ElpastorClubPage venue={venue} guestName={user?.firstName ?? ''} balance={my?.balance ?? 0} globalBalance={globalWallet?.balance ?? null} globalCaption={globalEarningDescription(globalProgram)} globalPendingReview={globalWallet?.pendingReview} onGlobal={() => setOverlay('global')} tabs={tabs} onQr={() => setOverlay('qr')} onTab={setTab} onLink={url => void openLink(url)} /> : <View style={{ padding: 22, paddingTop: 8, gap: 22 }}>
        <VenueArt venue={venue} large />
        <View style={{ gap: 9 }}><Txt weight="extra" style={{ fontSize: 29, letterSpacing: -0.7 }}>{venue.name}</Txt><Txt style={s.caption}>{venue.kind} · {venue.address}</Txt></View>
        {profile?.demo && <Callout>Тестовая карточка. Условия клуба ещё не согласованы с заведением.</Callout>}
        <View style={{ gap: 11 }}><Txt weight="extra" style={{ fontSize: 20 }}>{profile?.theme === 'elpastor' ? 'Планы на ваш вечер' : 'Возможности заведения'}</Txt>{([
          ['booking', 'Забронировать стол', 'calendar-outline'], ['menu', 'Посмотреть меню', 'restaurant-outline'], ['telegram', 'Афиша и новости', 'musical-notes-outline'], ['vk', 'Заведение ВКонтакте', 'people-outline'], ['website', 'Сайт заведения', 'globe-outline'],
        ] as const).map(([key, label, icon]) => profile?.links[key] ? <Button key={key} label={label} icon={icon} variant={key === 'booking' ? 'primary' : 'ghost'} onPress={() => void openLink(profile.links[key]!)} /> : null)}<Button label="Показать мой QR" icon="qr-code-outline" variant="secondary" onPress={() => setOverlay('qr')} /></View>
        <View style={{ gap: 12 }}>{!!profile?.description && <Txt style={{ fontSize: 14, lineHeight: 24 }}>{profile.description}</Txt>}<View style={[s.row, { flexWrap: 'wrap', gap: 7 }]}>{profile?.highlights.map(label => <Pill key={label} label={label} background={profile.theme === 'elpastor' ? '#F2E2D9' : C.pale} color={profile.theme === 'elpastor' ? '#7F1018' : C.pine} />)}</View></View>
        {profile?.features.loyalty && <Pressable accessibilityRole="button" accessibilityLabel="Открыть мои бонусы" onPress={() => setTab('bonuses')} style={[s.card, { gap: 10 }]}><Txt style={s.caption}>Бонусы заведения «{venue.name}»</Txt><Txt weight="extra" style={{ fontSize: 34 }}>{money(my?.balance ?? 0)} Б</Txt><Txt style={s.caption}>Условия начисления и доступные комплименты →</Txt></Pressable>}
        <GlobalWalletCard balance={globalWallet?.balance ?? null} pendingReview={globalWallet?.pendingReview} caption={globalEarningDescription(globalProgram)} onPress={() => setOverlay('global')} />
        {!!profile?.terms && <View style={[s.card, { gap: 10 }]}><Txt weight="extra" style={{ fontSize: 18 }}>Условия этого заведения</Txt><Txt style={{ fontSize: 13, lineHeight: 22 }}>{profile.terms}</Txt></View>}
        {!profile?.features.loyalty && <Txt style={s.caption}>Бонусная программа пока не подключена. Условия появятся здесь после согласования с заведением.</Txt>}
        {tabs.length > 1 && <View style={{ gap: 10 }}><Txt weight="extra" style={{ fontSize: 18 }}>Ваше в этом месте</Txt>{tabs.filter(item => item.id !== 'home').map(item => <Button key={item.id} label={`Мои ${item.title.toLowerCase()}`} icon={item.icon} variant="ghost" onPress={() => setTab(item.id)} />)}</View>}
      </View> : actions && (tab === 'visits' ? <MyVisits {...actions} /> : tab === 'bonuses' ? <Bonuses {...actions} /> : <Reviews {...actions} />)}
    </ScrollView>
    {!!venue && <View {...fx('nav')} style={[xs.nav, club && { backgroundColor: EP.bg, borderTopWidth: 1, borderColor: '#75404A60' }]}>{tabs.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityLabel={item.title} accessibilityState={{ selected: tab === item.id }} onPress={() => setTab(item.id)} style={xs.navItem}><Icon name={item.icon} size={21} color={tab === item.id ? club ? EP.gold : C.lime : club ? EP.muted : '#B8BCAF'} /><Txt weight="bold" style={{ fontSize: 10, color: tab === item.id ? club ? EP.cream : C.lime : club ? EP.muted : '#B8BCAF' }}>{item.title}</Txt></Pressable>)}</View>}
    {overlay === 'qr' && (club && venue ? <ElpastorQrSheet value={guestQr} code={guestCode} guestName={user?.firstName ?? ''} venueName={venue.name} demo={!!profile?.demo} onClose={() => setOverlay(null)} /> : <Sheet visible title="Ваш личный QR" subtitle={venue ? `Покажите сотруднику «${venue.name}»` : 'Один QR для всех ваших заведений'} onClose={() => setOverlay(null)}><GuestQr value={guestQr} code={guestCode} />{profile?.demo && <Callout>Карточка заведения тестовая. Сам показ QR не создаёт визит и не начисляет бонусы.</Callout>}</Sheet>)}
    {overlay === 'global' && <Sheet visible title="Глобальные бонусы" subtitle="Единый счёт вашего профиля «Свои»" theme={club ? 'elpastor' : 'default'} onClose={() => setOverlay(null)}><GlobalWalletDetails balance={globalWallet?.balance ?? null} entries={(globalWallet?.transactions ?? []).map(entry => ({ id: entry.id, amount: entry.delta, reason: entry.reason, createdAt: entry.createdAt }))} earningDescription={globalEarningDescription(globalProgram, true)} redemptionDescription="Пока только копим. Списание глобальных бонусов ещё не включено." pendingReview={globalWallet?.pendingReview} theme={club ? 'elpastor' : 'default'} /></Sheet>}
    {overlay === 'account' && <Sheet visible title="Аккаунт и приглашения" onClose={() => setOverlay(null)}>{!!staffVenues.length && <Button label="Перейти в режим сотрудника" onPress={() => onStaff()} />}<WelcomeScreen showSyncStatus={false} onDeveloper={() => setOverlay('developer')} onReady={(id, staff) => { setOverlay(null); if (staff) onStaff(id); else choose(id); }} /></Sheet>}
    {overlay === 'developer' && isDeveloper && <DeveloperPanel onClose={() => setOverlay(null)} />}
    {venue && <Panels panel={allowedPanel} venue={venue} role="guest" setPanel={setPanel} setVenue={choose} setRole={role => { if (role === 'staff') onStaff(venue.id); }} notify={setNotice} openDeveloper={() => setOverlay('developer')} />}
  </View></View>;
}
const xs = StyleSheet.create({
  outer: { flex: 1, alignItems: 'center', backgroundColor: '#E8EDE3' }, phone: { flex: 1, width: '100%', maxWidth: 480, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 22, minHeight: 78 }, brand: { width: 29, height: 31, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.pine },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, borderRadius: 26, overflow: 'hidden', boxShadow: '0px 8px 24px #1E302414' },
  art: { padding: 20, borderRadius: 23, gap: 15, justifyContent: 'space-between', overflow: 'hidden' }, arrow: { width: 35, height: 35, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.pale, transform: [{ rotate: '45deg' }] },
  nav: { flexDirection: 'row', padding: 12, backgroundColor: C.ink }, navItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
});
