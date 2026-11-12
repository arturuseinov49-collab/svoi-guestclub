import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { Guest, Venue } from './domain';
import { sameDay, shortDate } from './domain';
import { useStore } from './store';
import { Avatar, Button, C, Empty, Icon, Pill, Section, Stars, Txt, fx, s } from './ui';
import { GuestFeedbackCard, guestVisitTimeline } from './feedback-ui';

export type ScreenActions = { venue: Venue; go: (tab: number) => void; guest: (id: string) => void; scan: () => void; replyFeedback: (id: string) => void };
function GuestRow({ guest, venueId, onPress, compact = false }: { guest: Guest; venueId: string; onPress: () => void; compact?: boolean }) {
  const { db } = useStore();
  const visits = guestVisitTimeline(db, venueId, guest.id);
  const preferenceCount = new Set((db.staffFeedback ?? []).filter(item => item.venueId === venueId && item.guestId === guest.id).flatMap(item => item.preferences)).size;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Гость ${guest.name}`} onPress={onPress} style={({ pressed }) => [xs.guestRow, pressed && { backgroundColor: C.pale }]}><Avatar guest={guest} size={compact ? 44 : 48} /><View style={{ flex: 1, minWidth: 0, gap: 6 }}><Txt weight="bold" style={{ fontSize: 13 }}>{guest.name}</Txt><Txt style={{ fontSize: 11, color: C.muted, lineHeight: 18 }}>{visits.length} визитов · {visits[0] ? sameDay(visits[0].createdAt) ? 'Сегодня' : shortDate(visits[0].createdAt) : 'Первая встреча'}</Txt>{!compact && <View style={[s.row, { gap: 6, flexWrap: 'wrap' }]}>{visits.length >= 5 && <Pill label="Постоянный гость" />}{preferenceCount > 0 && <Pill label="Есть пожелания" />}</View>}</View><Icon name="chevron-forward" size={17} color={C.muted} /></Pressable>;
}
export function Home(p: ScreenActions) {
  const { db } = useStore();
  const visits = guestVisitTimeline(db, p.venue.id);
  const recent = [...new Set(visits.map(item => item.guestId))].slice(0, 3).map(id => db.guests.find(guest => guest.id === id)).filter((guest): guest is Guest => !!guest);
  const today = visits.filter(item => sameDay(item.createdAt)).length;
  return <View style={s.page}>
    <View style={{ gap: 8 }}><Txt weight="bold" style={s.eyebrow}>ВАША СМЕНА</Txt><Txt weight="extra" style={s.title}>Встречаем гостей.</Txt><Txt style={s.caption}>Замечаем детали. Помним пожелания.</Txt></View>
    <View {...fx('hero')} style={[s.card, { backgroundColor: C.lime, padding: 20, gap: 20 }]}><View style={[s.row, { gap: 14 }]}><View style={{ width: 57, height: 57, borderRadius: 20, backgroundColor: '#FFFFFF91', alignItems: 'center', justifyContent: 'center' }}><Icon name="qr-code-outline" size={32} color={C.pine} /></View><View style={{ flex: 1, minWidth: 0, gap: 5 }}><Txt weight="extra" style={{ fontSize: 19, lineHeight: 25 }}>Узнайте своего гостя</Txt><Txt style={{ fontSize: 12, color: C.pine, lineHeight: 19 }}>Предпочтения и история встреч — в одной карточке.</Txt></View></View><Button label="Сканировать QR гостя" icon="scan-outline" onPress={p.scan} /><Txt style={{ fontSize: 11, color: C.pine, lineHeight: 18 }}>После визита сохраните короткую анкету и заметку для команды.</Txt></View>
    <Button label="Найти гостя вручную" icon="search-outline" variant="ghost" onPress={() => p.go(1)} />
    <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}><Pill label={`Сегодня визитов: ${today}`} icon="footsteps-outline" /><Txt style={{ fontSize: 11, color: C.muted }}>Отмечено командой</Txt></View>
    {!!recent.length && <View><Section title="Недавно были у нас" /><View style={[s.card, { padding: 0, overflow: 'hidden' }]}>{recent.map((guest, index) => <View key={guest.id}>{index > 0 && <View style={xs.divider} />}<GuestRow guest={guest} venueId={p.venue.id} compact onPress={() => p.guest(guest.id)} /></View>)}</View></View>}
  </View>;
}
export function Guests(p: ScreenActions) {
  const { db } = useStore(); const [query, setQuery] = useState(''); const [regular, setRegular] = useState(false);
  const guests = useMemo(() => db.guests.filter(guest => db.memberships.some(member => member.guestId === guest.id && member.venueId === p.venue.id)).filter(guest => `${guest.name} ${guest.phone}`.toLowerCase().includes(query.toLowerCase())).filter(guest => !regular || guestVisitTimeline(db, p.venue.id, guest.id).length >= 5).sort((a, b) => guestVisitTimeline(db, p.venue.id, b.id).length - guestVisitTimeline(db, p.venue.id, a.id).length), [db, p.venue.id, query, regular]);
  return <View style={s.page}><View style={{ gap: 7 }}><Txt weight="bold" style={s.eyebrow}>ЛЮДИ, КОТОРЫЕ ВОЗВРАЩАЮТСЯ</Txt><Txt weight="extra" style={s.title}>Наши гости</Txt><Txt style={s.caption}>Пожелания и заметки только вашего заведения.</Txt></View><Button label="Сканировать QR гостя" icon="scan-outline" onPress={p.scan} /><View style={xs.search}><Icon name="search-outline" size={19} color={C.muted} /><TextInput accessibilityLabel="Поиск гостей" placeholder="Имя гостя" placeholderTextColor={C.muted} value={query} onChangeText={setQuery} style={xs.searchInput} />{query !== '' && <Pressable accessibilityRole="button" accessibilityLabel="Очистить поиск" onPress={() => setQuery('')}><Icon name="close-circle" size={18} color={C.muted} /></Pressable>}</View><View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>{[false, true].map(value => <Pressable key={String(value)} accessibilityRole="button" accessibilityState={{ selected: regular === value }} onPress={() => setRegular(value)} style={[xs.filter, regular === value && { backgroundColor: C.pine }]}><Txt weight="semibold" style={{ color: regular === value ? '#FFF' : C.muted, fontSize: 11 }}>{value ? 'Постоянные' : 'Все'}</Txt></Pressable>)}</View><View style={{ gap: 12 }}><Txt style={s.caption}>Найдено гостей: {guests.length}</Txt>{guests.length ? guests.map(guest => <View key={guest.id} style={[s.card, { padding: 0 }]}><GuestRow guest={guest} venueId={p.venue.id} onPress={() => p.guest(guest.id)} /></View>) : <Empty title="Пока никого" text="Измените запрос или попросите гостя показать свой QR." />}</View></View>;
}
export function Reviews(p: ScreenActions) {
  const { db } = useStore(); const [unanswered, setUnanswered] = useState(false);
  const all = (db.guestFeedback ?? []).filter(item => item.venueId === p.venue.id).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const feedback = all.filter(item => !unanswered || !item.response);
  const historical = db.reviews.filter(item => item.venueId === p.venue.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <View style={s.page}><View style={{ gap: 7 }}><Txt weight="bold" style={s.eyebrow}>ДИАЛОГ, КОТОРЫЙ ВАЖЕН</Txt><Txt weight="extra" style={s.title}>Отзывы гостей</Txt><Txt style={s.caption}>Что понравилось гостям и что можно улучшить.</Txt></View><View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}><Pill label={`Анкет: ${all.length}`} /><Pill label={`Без ответа: ${all.filter(item => !item.response).length}`} /></View><View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>{[false, true].map(value => <Pressable key={String(value)} accessibilityRole="button" accessibilityState={{ selected: unanswered === value }} onPress={() => setUnanswered(value)} style={[xs.filter, unanswered === value && { backgroundColor: C.pine }]}><Txt weight="semibold" style={{ color: unanswered === value ? '#FFF' : C.muted, fontSize: 11 }}>{value ? 'Без ответа' : 'Все отзывы'}</Txt></Pressable>)}</View>{feedback.map(item => <GuestFeedbackCard key={item.id} feedback={item} onReply={() => p.replyFeedback(item.id)} />)}{!feedback.length && <Empty icon="chatbubbles-outline" title={unanswered ? 'Всё отвечено' : 'Диалог только начинается'} text={unanswered ? 'Новые отзывы без ответа появятся здесь.' : 'После завершения визита гость сможет заполнить свою анкету.'} />}
    {!unanswered && !!historical.length && <View style={{ gap: 12 }}><Section title="Ранние отзывы" /><Txt style={s.caption}>Сохранённая история предыдущей версии.</Txt>{historical.map(review => <View key={review.id} style={[s.card, { gap: 12 }]}><Txt weight="bold">{db.guests.find(guest => guest.id === review.guestId)?.name ?? 'Гость заведения'}</Txt><View style={[s.row, { gap: 10 }]}><Stars rating={review.rating} /><Txt style={s.caption}>{shortDate(review.createdAt)}</Txt></View><Txt style={{ lineHeight: 23 }}>{review.text}</Txt>{review.response && <View style={{ gap: 6, padding: 12, borderRadius: 14, backgroundColor: C.pale }}><Txt weight="bold" style={{ fontSize: 11 }}>Ответ команды</Txt><Txt style={{ lineHeight: 21 }}>{review.response}</Txt></View>}</View>)}</View>}
  </View>;
}
const xs = StyleSheet.create({
  guestRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 17, paddingHorizontal: 14, borderRadius: 20 },
  divider: { height: 1, backgroundColor: C.line, marginLeft: 70, marginRight: 14 },
  search: { backgroundColor: '#FFF', flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.line, borderRadius: 15, paddingHorizontal: 14, gap: 10, minHeight: 54 },
  searchInput: { flex: 1, minWidth: 0, fontFamily: 'Manrope_500Medium', fontSize: 15, minHeight: 54, color: C.ink, outlineWidth: 0 } as any,
  filter: { paddingHorizontal: 14, paddingVertical: 11, borderRadius: 14, borderWidth: 1, borderColor: C.line },
});
