import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Venue, money } from './domain';
import { effectiveGuestProfile } from './venue-profile';
import { ElpastorArt } from './elpastor-art';
import { Icon, IconName, Txt, fx } from './ui';

export const EP = { bg: '#210911', surface: '#350F1C', cream: '#FFF1DA', gold: '#E6BB8E', muted: '#C5A995', border: '#75404A' };

export function ClubIconButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return <Pressable {...fx('club-icon')} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [c.iconButton, pressed && { opacity: .75 }]}><Icon name={icon} color={EP.gold} size={21} /></Pressable>;
}

export function ClubButton({ label, subtitle, icon, tone = 'wine', onPress }: { label: string; subtitle?: string; icon: IconName; tone?: 'gold' | 'wine' | 'quiet'; onPress: () => void }) {
  const gold = tone === 'gold';
  const color = gold ? EP.surface : EP.cream;
  return <Pressable {...fx(`club-button club-${tone}`)} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [c.button, gold && { backgroundColor: '#EED0A4', borderColor: '#F7DBB3' }, tone === 'quiet' && { backgroundColor: '#2B0C16', borderColor: '#60333E' }, pressed && { opacity: .86, transform: [{ scale: .985 }] }]}>
    <View style={[c.buttonIcon, gold && { backgroundColor: '#5C241718' }]}><Icon name={icon} color={gold ? EP.surface : EP.gold} size={21} /></View>
    <View style={{ flex: 1, gap: 4 }}><Txt weight="bold" style={{ color, fontSize: 13, lineHeight: 18 }}>{label}</Txt>{subtitle && <Txt style={{ color: gold ? '#734A39' : EP.muted, fontSize: 10, lineHeight: 15 }}>{subtitle}</Txt>}</View>
    <Icon name="arrow-forward" size={16} color={gold ? '#734A39' : EP.gold} />
  </Pressable>;
}

export function ClubNotice({ children }: React.PropsWithChildren) {
  return <View style={c.notice}><Icon name="information-circle-outline" color={EP.gold} size={17} /><Txt style={{ flex: 1, color: EP.muted, fontSize: 11, lineHeight: 18 }}>{children}</Txt></View>;
}

type GuestTab = 'home' | 'visits' | 'bonuses' | 'reviews';
type Props = { venue: Venue; guestName: string; balance: number; tabs: { id: GuestTab; title: string; icon: IconName }[]; onQr: () => void; onTab: (tab: GuestTab) => void; onLink: (url: string) => void };

export function ElpastorClubPage({ venue, guestName, balance, tabs, onQr, onTab, onLink }: Props) {
  const profile = effectiveGuestProfile(venue);
  return <View testID="elpastor-club-page" style={c.page}>
    <View style={c.clubCard}>
      <ElpastorArt large demo={profile.demo} />
      <View style={c.personal}>
        <View style={{ flex: 1, gap: 5 }}><Txt style={c.eyebrow}>ВАША КАРТА ГОСТЯ</Txt><Txt style={c.guestName}>{guestName || 'Hola, amigo'}</Txt></View>
        <View style={c.seal} accessible={false}><Icon name="sparkles-outline" size={24} color={EP.gold} /></View>
      </View>
      <View style={{ padding: 16, paddingTop: 0 }}><ClubButton label="Показать мой QR" subtitle="Личный код для визита" icon="qr-code-outline" tone="gold" onPress={onQr} /></View>
    </View>
    <View style={c.location}><Icon name="location-outline" size={15} color={EP.gold} /><Txt style={{ flex: 1, color: EP.muted, fontSize: 11, lineHeight: 18 }}>{venue.address}</Txt></View>
    <View style={{ gap: 12 }}><View style={c.sectionTitle}><Txt style={c.heading}>Планы на ваш вечер</Txt><Txt style={{ color: EP.gold, fontSize: 17 }}>✦</Txt></View>
      {([
        ['booking', 'Забронировать стол', 'Выбрать дату и время', 'calendar-outline'],
        ['menu', 'Посмотреть меню', 'Мексиканский гастробар', 'restaurant-outline'],
        ['telegram', 'Афиша и новости', 'Музыка, встречи и гастроужины', 'musical-notes-outline'],
      ] as const).map(([key, label, subtitle, icon]) => profile.links[key] ? <ClubButton key={key} label={label} subtitle={subtitle} icon={icon} onPress={() => onLink(profile.links[key]!)} /> : null)}
    </View>
    {profile.demo && <ClubNotice>Тестовая карточка. Условия клуба ещё не согласованы с заведением.</ClubNotice>}
    {profile.features.loyalty && <Pressable {...fx('club-panel')} accessibilityRole="button" accessibilityLabel="Открыть мои бонусы" onPress={() => onTab('bonuses')} style={c.panel}><Txt style={c.eyebrow}>ВАШИ БОНУСЫ В «{venue.name.toUpperCase()}»</Txt><Txt style={{ fontFamily: 'CormorantGaramondBold', fontSize: 38, color: EP.cream }}>{money(balance)} Б</Txt><Txt style={c.body}>Условия начисления и комплименты →</Txt></Pressable>}
    <View style={{ gap: 14 }}><Txt style={c.heading}>Hola, amigo</Txt>{!!profile.description && <Txt style={c.body}>{profile.description}</Txt>}<View style={c.highlights}>{profile.highlights.map(label => <View key={label} style={c.chip}><Txt style={{ fontSize: 10, lineHeight: 16, color: EP.gold }}>{label}</Txt></View>)}</View>
      {([
        ['vk', 'Заведение ВКонтакте', 'people-outline'], ['website', 'Сайт заведения', 'globe-outline'],
      ] as const).map(([key, label, icon]) => profile.links[key] ? <ClubButton key={key} label={label} icon={icon} tone="quiet" onPress={() => onLink(profile.links[key]!)} /> : null)}
    </View>
    {!!profile.terms && <View {...fx('club-panel')} style={c.panel}><Txt style={c.eyebrow}>УСЛОВИЯ КЛУБА</Txt><Txt style={c.body}>{profile.terms}</Txt></View>}
    {!profile.features.loyalty && <Txt style={{ color: EP.muted, fontSize: 11, lineHeight: 18 }}>Бонусная программа пока не подключена. Условия появятся после согласования с заведением.</Txt>}
    {tabs.length > 1 && <View style={{ gap: 10 }}><Txt style={c.heading}>Ваша история</Txt>{tabs.filter(item => item.id !== 'home').map(item => <ClubButton key={item.id} label={`Мои ${item.title.toLowerCase()}`} icon={item.icon} tone="quiet" onPress={() => onTab(item.id)} />)}</View>}
    <View style={c.footer}><View style={c.line} /><Txt style={{ color: EP.muted, fontSize: 8, letterSpacing: 2 }}>ЭЛЬ ПАСТОР · СВОИ</Txt><View style={c.line} /></View>
  </View>;
}

const c = StyleSheet.create({
  page: { padding: 18, paddingTop: 5, gap: 22 },
  clubCard: { borderRadius: 27, borderWidth: 1, borderColor: '#854453', backgroundColor: EP.surface, overflow: 'hidden', boxShadow: '0px 16px 32px #0C020844' },
  personal: { flexDirection: 'row', alignItems: 'center', padding: 19, gap: 12 },
  guestName: { fontFamily: 'CormorantGaramondBold', color: EP.cream, fontSize: 29, lineHeight: 34 },
  eyebrow: { color: EP.gold, fontSize: 8, letterSpacing: 1.7, lineHeight: 14 },
  seal: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: EP.border, alignItems: 'center', justifyContent: 'center' },
  location: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { fontFamily: 'CormorantGaramondBold', fontSize: 28, lineHeight: 34, color: EP.cream, flexShrink: 1 },
  body: { color: EP.muted, fontSize: 12, lineHeight: 21 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 66, padding: 13, borderRadius: 17, backgroundColor: '#4D1627', borderWidth: 1, borderColor: EP.border, overflow: 'hidden' },
  buttonIcon: { width: 37, height: 37, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E6BB8E0C' },
  iconButton: { width: 44, height: 44, borderRadius: 16, borderWidth: 1, borderColor: '#75404A80', backgroundColor: EP.surface, justifyContent: 'center', alignItems: 'center' },
  notice: { padding: 13, borderRadius: 16, backgroundColor: '#E6BB8E08', borderWidth: 1, borderColor: '#75404A70', flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  panel: { padding: 18, backgroundColor: EP.surface, borderWidth: 1, borderColor: '#75404A80', borderRadius: 21, gap: 12 },
  highlights: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 20, borderWidth: 1, borderColor: '#75404A80', paddingHorizontal: 10, paddingVertical: 7 },
  footer: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  line: { height: 1, width: 24, backgroundColor: EP.border },
});
