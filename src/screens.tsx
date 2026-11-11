import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Guest, Role, Venue, money, rewards, sameDay, shortDate, stats } from './domain';
import { useStore } from './store';
import { Avatar, Button, C, Callout, Empty, Icon, Pill, Section, Stars, Txt, fx, s } from './ui';
import { GuestQr } from './qr';
import { effectiveGuestProfile } from './venue-profile';
export type ScreenActions = {
  venue: Venue; role: Role; go: (tab: number) => void; guest: (id: string) => void;
  visit: (id?: string) => void; scan: () => void; award: (id?: string) => void; review: () => void;
  program: () => void; redeem: (rewardId: string, guestId?: string) => void; reply: (id: string) => void;
};
function GuestRow({ guest, venueId, onPress, compact = false }: { guest: Guest; venueId: string; onPress: () => void; compact?: boolean }) {
  const { db } = useStore();
  const st = stats(db, venueId, guest.id);
  return <Pressable accessibilityRole="button" accessibilityLabel={`Гость ${guest.name}`} onPress={onPress} style={({ pressed }) => [xs.guestRow, pressed && { backgroundColor: C.pale }]}>
    <Avatar guest={guest} size={compact ? 44 : 48} />
    <View style={{ flex: 1, gap: 5 }}><Txt weight="bold" style={{ fontSize: 13 }}>{guest.name}</Txt><Txt style={{ fontSize: 11, color: C.muted }}>{st.count} визитов <Txt style={{ fontSize: 11, color: '#BCC3B6' }}> · </Txt> {st.visits[0] ? (sameDay(st.visits[0].createdAt) ? 'Сегодня' : shortDate(st.visits[0].createdAt)) : 'Пока не было визитов'}</Txt>{!compact && <View style={[s.row, { gap: 5, flexWrap: 'wrap' }]}>{st.count >= 5 && <Pill label="Постоянный гость" />}{st.tipsPercent >= 10 && <Pill label="Щедрые чаевые" background={C.softOrange} color={C.orange} />}</View>}</View>
    <View style={{ alignItems: 'flex-end', gap: 5 }}><View style={[s.row, { gap: 4 }]}><Icon name="star" size={12} color="#B98E4E" /><Txt weight="bold" style={{ fontSize: 12 }}>{st.rating ? st.rating.toFixed(1) : '—'}</Txt></View><Txt weight="semibold" style={{ fontSize: 11, color: C.muted }}>{money(st.balance)} Б</Txt></View><Icon name="chevron-forward" size={15} color="#A5AE9F" />
  </Pressable>;
}
function ClubStamp() {
  return <View {...fx('foil')} pointerEvents="none" style={xs.clubStamp}><View style={xs.stampRing}><Icon name="sparkles" size={21} color={C.pine} /><Txt weight="extra" style={{ fontSize: 14, letterSpacing: -0.5 }}>СВОЙ</Txt><Txt weight="bold" style={{ fontSize: 6, letterSpacing: 0.9 }}>ПРОВЕРЕНО</Txt></View></View>;
}
export function Home(p: ScreenActions) {
  const { db, guestId, guestCode, guestQr } = useStore();
  const my = db.guests.find(g => g.id === guestId)!;
  const st = stats(db, p.venue.id, guestId);
  const guests = db.guests.filter(g => db.memberships.some(m => m.venueId === p.venue.id && m.guestId === g.id));
  const today = db.visits.filter(v => v.venueId === p.venue.id && sameDay(v.createdAt));
  const featured = [...guests].sort((a, b) => stats(db, p.venue.id, b.id).count - stats(db, p.venue.id, a.id).count).slice(0, 3);
  const remaining = p.venue.program.everyVisits - st.count % p.venue.program.everyVisits;
  const review = db.reviews.find(r => r.venueId === p.venue.id && (p.role === 'staff' || r.guestId === guestId));
  const author = db.guests.find(g => g.id === review?.guestId);
  return <View style={s.page}>
    <View style={{ gap: 10 }}><Txt weight="extra" style={s.eyebrow}>{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()} / СВОЙ КРУГ</Txt><Txt weight="extra" style={s.title}>{p.role === 'staff' ? 'НЕ ПРОСТО\nГОСТИ. СВОИ.' : `${my.name.split(' ')[0].toUpperCase()},\nВЫ В КЛУБЕ.`}</Txt><Txt style={s.caption}>{p.role === 'staff' ? 'Замечаем людей. Возвращаем любовь бонусами.' : 'Привычка приходить. Привилегия быть своим.'}</Txt></View>
    <View {...fx('hero')} style={xs.hero}>
      <ClubStamp />
      <View style={[s.row, { gap: 7, marginBottom: 15 }]}><View style={xs.liveDot} /><Txt numberOfLines={1} weight="extra" style={{ color: C.pine, fontSize: 9, letterSpacing: 1.3, flex: 1, minWidth: 0 }}>{p.role === 'staff' ? 'СВОИ / ГОСТЕВОЙ КЛУБ' : `ЛИЧНЫЙ СЧЁТ / ${p.venue.name.toUpperCase()}`}</Txt></View>
      <Txt weight="extra" style={{ color: C.ink, fontSize: p.role === 'staff' ? 43 : 50, lineHeight: 44, letterSpacing: -2.1 }}>{p.role === 'staff' ? 'СВОИМ\nБОЛЬШЕ.' : `${money(st.balance)} Б`}</Txt>
      <Txt style={{ color: C.pine, fontSize: 12, marginTop: 12, lineHeight: 20, maxWidth: '64%' }}>{p.role === 'staff' ? `${guests.length} гостей в вашем круге.\nКаждого есть за что ценить.` : 'Ваш баланс хороших привычек.\nМеняйте на приятное.'}</Txt>
      <Pressable accessibilityRole="button" accessibilityLabel={p.role === 'staff' ? 'Открыть программу лояльности' : 'Выбрать комплимент'} onPress={() => p.go(2)} style={xs.heroLink}><Txt weight="extra" style={{ fontSize: 11, color: C.ink }}>{p.role === 'staff' ? 'В клуб привилегий' : 'Забрать комплимент'}</Txt><Icon name="arrow-forward" size={16} color={C.ink} /></Pressable>
      <View style={xs.heroFooter}><Txt weight="bold" style={{ color: C.pine, fontSize: 9, lineHeight: 15, letterSpacing: 0.4, flex: 1 }}>{p.role === 'staff' ? 'ХОРОШЕЕ ВОЗВРАЩАЕТСЯ.' : `КЕШБЭК ${p.venue.program.cashback}% С КАЖДОГО ВИЗИТА`}</Txt><Txt weight="extra" style={{ color: C.ink, fontSize: 14 }}>свои ↗</Txt></View>
    </View>
    {p.role === 'staff' ? <>
      <View style={{ flexDirection: 'row', gap: 12 }}><View {...fx('soft-card')} style={[xs.statCard, { flex: 1 }]}><View style={[s.row, { justifyContent: 'space-between' }]}><Icon name="footsteps-outline" size={18} color={C.muted} /><Pill label="сегодня" background={C.pale} /></View><Txt weight="extra" style={xs.statValue}>{today.length.toString().padStart(2, '0')}</Txt><Txt style={s.caption}>визита отмечено</Txt></View><View {...fx('soft-card')} style={[xs.statCard, { flex: 1 }]}><View style={[s.row, { justifyContent: 'space-between' }]}><Icon name="heart-outline" size={18} color={C.muted} /><Icon name="trending-up" size={17} color={C.pine} /></View><Txt weight="extra" style={xs.statValue}>{guests.filter(g => stats(db, p.venue.id, g.id).count >= 5).length.toString().padStart(2, '0')}</Txt><Txt style={s.caption}>постоянных гостя</Txt></View></View>
      <Button label="Сканировать QR гостя" icon="scan-outline" onPress={p.scan} />
      <Button label="Выбрать гостя вручную" icon="people-outline" variant="ghost" onPress={() => p.visit()} />
      <View><Section title="Повод сказать спасибо" action="Все гости" onPress={() => p.go(1)} />{featured.length ? <View style={[s.card, { padding: 0, overflow: 'hidden' }]}>{featured.map((g, i) => <View key={g.id}>{i > 0 && <View style={xs.divider} />}<GuestRow guest={g} venueId={p.venue.id} onPress={() => p.guest(g.id)} compact /></View>)}</View> : <Empty title="Знакомство начинается с QR" text="Попросите гостя открыть личный QR в «Своих» и отсканируйте его. Затем подтвердите сумму чека — бонусы начислятся автоматически." />}</View>
      <Pressable {...fx('foil')} accessibilityRole="button" accessibilityLabel="Начислить благодарность гостю" onPress={() => p.award()} style={xs.thanksBanner}><View style={xs.thanksIcon}><Icon name="gift-outline" size={23} color={C.orange} /></View><View style={{ flex: 1, gap: 4 }}><Txt weight="bold" style={{ fontSize: 13 }}>Хорошее стоит замечать</Txt><Txt style={{ fontSize: 11, color: C.muted }}>Подарите бонусы от команды</Txt></View><Icon name="arrow-forward" size={17} /></Pressable>
    </> : <>
      <GuestQr value={guestQr} code={guestCode} />
      <View style={s.card}><View style={[s.row, { justifyContent: 'space-between', marginBottom: 16 }]}><Txt weight="bold">До нового «спасибо»</Txt><Pill label={`${st.count % p.venue.program.everyVisits} / ${p.venue.program.everyVisits} визитов`} /></View><View style={{ flexDirection: 'row', gap: 6 }}>{Array.from({ length: Math.min(p.venue.program.everyVisits, 10) }, (_, i) => <View key={i} style={{ height: 7, flex: 1, borderRadius: 4, backgroundColor: i < Math.floor((st.count % p.venue.program.everyVisits) / p.venue.program.everyVisits * Math.min(p.venue.program.everyVisits, 10)) ? C.pine : C.line }} />)}</View><Txt style={[s.caption, { marginTop: 12 }]}>Ещё {remaining} визита — и {p.venue.program.visitBonus} бонусов ваши.</Txt></View>
      <View><Section title="Вам будет приятно" action="Все подарки" onPress={() => p.go(2)} /><RewardCard rewardId="coffee" balance={st.balance} onPress={() => p.redeem('coffee', guestId)} /></View>
      <View style={[s.row, { gap: 12 }]}><View {...fx('soft-card')} style={[xs.statCard, { flex: 1 }]}><Icon name="footsteps-outline" size={20} /><Txt weight="extra" style={xs.statValue}>{st.count}</Txt><Txt style={s.caption}>визитов вместе</Txt></View><View {...fx('soft-card')} style={[xs.statCard, { flex: 1 }]}><Icon name="leaf-outline" size={20} /><Txt weight="extra" style={xs.statValue}>{p.venue.program.cashback}%</Txt><Txt style={s.caption}>возвращаем бонусами</Txt></View></View>
    </>}
    {review && author && <View><Section title="Слова, которые греют" action="Все отзывы" onPress={() => p.go(3)} /><View style={s.card}><Stars rating={review.rating} /><Txt style={{ lineHeight: 23, marginVertical: 13, fontSize: 13 }}>«{review.text}»</Txt><View style={[s.row, { gap: 10 }]}><Avatar guest={author} size={30} /><Txt weight="bold" style={{ flex: 1, fontSize: 11 }}>{author.name}</Txt><Txt style={{ fontSize: 10, color: C.muted }}>{shortDate(review.createdAt)}</Txt></View></View></View>}
    <View style={[s.row, { justifyContent: 'center', gap: 6 }]}><Icon name="leaf-outline" size={13} color={C.muted} /><Txt style={{ fontSize: 10, color: C.muted }}>Место, где каждый — свой</Txt></View>
  </View>;
}
export function Guests(p: ScreenActions) {
  const { db } = useStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('Все');
  const guests = useMemo(() => db.guests.filter(g => db.memberships.some(m => m.guestId === g.id && m.venueId === p.venue.id)).filter(g => `${g.name} ${g.phone}`.toLowerCase().includes(query.toLowerCase())).filter(g => { const st = stats(db, p.venue.id, g.id); return filter === 'Все' || (filter === 'Постоянные' && st.count >= 5) || (filter === 'Щедрые чаевые' && st.tipsPercent >= 10); }).sort((a, b) => stats(db, p.venue.id, b.id).count - stats(db, p.venue.id, a.id).count), [db, p.venue.id, query, filter]);
  return <View style={s.page}><View style={{ gap: 7 }}><Txt weight="bold" style={s.eyebrow}>ЛЮДИ, КОТОРЫЕ ВОЗВРАЩАЮТСЯ</Txt><Txt weight="extra" style={s.title}>Наши гости</Txt><Txt style={s.caption}>За каждым визитом — своя история.</Txt></View><Button label="Сканировать QR гостя" icon="scan-outline" onPress={p.scan} /><View style={xs.search}><Icon name="search-outline" size={19} color={C.muted} /><TextInput accessibilityLabel="Поиск гостей" placeholder="Имя гостя" placeholderTextColor={C.muted} value={query} onChangeText={setQuery} style={xs.searchInput} />{query !== '' && <Pressable accessibilityRole="button" accessibilityLabel="Очистить поиск" onPress={() => setQuery('')}><Icon name="close-circle" size={18} color={C.muted} /></Pressable>}</View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>{['Все', 'Постоянные', 'Щедрые чаевые'].map(f => <Pressable accessibilityRole="button" accessibilityState={{ selected: filter === f }} key={f} onPress={() => setFilter(f)} style={[xs.filter, filter === f && { backgroundColor: C.pine }]}><Txt weight="semibold" style={{ color: filter === f ? '#FFF' : C.muted, fontSize: 11 }}>{f}</Txt></Pressable>)}</ScrollView><View style={{ gap: 12 }}><Txt style={s.caption}>Найдено гостей: {guests.length}</Txt>{guests.length ? guests.map(g => <View key={g.id} style={[s.card, { padding: 0 }]}><GuestRow guest={g} venueId={p.venue.id} onPress={() => p.guest(g.id)} /></View>) : <Empty title="Пока никого" text="Измените запрос или добавьте первого гостя." />}</View></View>;
}
function RewardCard({ rewardId, balance, onPress, staff = false }: { rewardId: string; balance: number; onPress: () => void; staff?: boolean }) {
  const reward = rewards.find(r => r.id === rewardId)!;
  const enough = balance >= reward.cost;
  return <View style={[s.card, { gap: 15 }]}><View style={[s.row, { gap: 14 }]}><View {...fx('foil')} style={[xs.rewardArt, rewardId === 'dessert' && { backgroundColor: '#F2E7DE' }, rewardId === 'dinner' && { backgroundColor: '#E6E2ED' }]}><Icon name={reward.icon} size={36} color={C.pine} /><View style={xs.artSpark}><Icon name="sparkles" size={13} color={C.orange} /></View></View><View style={{ flex: 1, gap: 5 }}><Txt weight="bold" style={{ fontSize: 15 }}>{reward.name}</Txt><Txt style={{ fontSize: 11, lineHeight: 18, color: C.muted }}>{reward.description}</Txt><Txt weight="extra" style={{ fontSize: 16, color: C.pine }}>{reward.cost} Б</Txt></View></View><Button label={staff ? 'Выдать гостю' : enough ? 'Получить комплимент' : `Не хватает ${reward.cost - balance} Б`} onPress={onPress} disabled={!staff && !enough} variant="secondary" icon={staff ? 'gift-outline' : 'arrow-forward'} /></View>;
}
export function Bonuses(p: ScreenActions) {
  const { db, guestId, staffVenues } = useStore();
  const st = stats(db, p.venue.id, guestId);
  const program = p.venue.program;
  const loyaltyEnabled = effectiveGuestProfile(p.venue).features.loyalty;
  const txs = db.transactions.filter(t => t.venueId === p.venue.id && (p.role === 'staff' || t.guestId === guestId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
  return <View style={s.page}><View style={{ gap: 7 }}><Txt weight="bold" style={s.eyebrow}>МАЛЕНЬКИЕ ЗНАКИ ВНИМАНИЯ</Txt><Txt weight="extra" style={s.title}>{p.role === 'staff' ? 'Спасибо в бонусах' : loyaltyEnabled ? 'Приятно быть своим' : 'Ваши бонусы'}</Txt><Txt style={s.caption}>{loyaltyEnabled ? 'Своя программа. Свои поводы вернуться.' : 'Баланс и история этого заведения.'}</Txt></View>
    {p.role === 'guest' && <View {...fx('dark-card')} style={xs.balanceBanner}><View><Txt style={{ color: '#CCDDC7', fontSize: 11 }}>Ваш баланс в «{p.venue.name}»</Txt><Txt weight="extra" style={{ fontSize: 36, color: '#FFF', marginTop: 5 }}>{money(st.balance)} <Txt style={{ color: C.lime, fontSize: 20 }}>Б</Txt></Txt></View><Icon name="gift-outline" size={43} color={C.lime} /></View>}
    {!loyaltyEnabled && <Callout>Бонусная программа сейчас не действует. Ранее начисленный баланс и история сохранены; условия использования уточните у команды заведения.</Callout>}
    {loyaltyEnabled && <><View><Section title="Как это работает" action={p.role === 'staff' && staffVenues.some(v => v.venueId === p.venue.id && v.role === 'owner') ? 'Настроить' : undefined} onPress={p.program} /><View style={[s.card, { paddingVertical: 4 }]}>{[
      { icon: 'receipt-outline' as const, title: `${program.cashback}% с каждого чека`, text: 'Возвращаются на бонусный счёт' },
      { icon: 'repeat-outline' as const, title: `+${program.visitBonus} Б за каждый ${program.everyVisits}-й визит`, text: 'За любовь к вашему месту' },
      { icon: 'heart-outline' as const, title: `+${program.tipsBonus} Б за щедрость`, text: 'Если чаевые составили от 10% чека' },
    ].map((item, i) => <View key={item.title} style={[s.row, { gap: 12, paddingVertical: 15, borderTopWidth: i ? 1 : 0, borderColor: C.line }]}><View style={xs.ruleIcon}><Icon name={item.icon} size={21} /></View><View style={{ flex: 1, gap: 4 }}><Txt weight="bold" style={{ fontSize: 12 }}>{item.title}</Txt><Txt style={{ fontSize: 10, lineHeight: 17, color: C.muted }}>{item.text}</Txt></View></View>)}</View><Txt style={[s.caption, { fontSize: 10, marginTop: 10 }]}>Бонусы «{p.venue.name}» действуют только в этом заведении.</Txt></View>
    {p.role === 'staff' && <Button label="Поблагодарить гостя" icon="gift-outline" onPress={() => p.award()} />}
    <View><Section title="Комплименты от заведения" /><View style={{ gap: 12 }}>{rewards.map(r => <RewardCard key={r.id} rewardId={r.id} balance={st.balance} staff={p.role === 'staff'} onPress={() => p.redeem(r.id, p.role === 'guest' ? guestId : undefined)} />)}</View></View></>}
    <View><Section title="История бонусов" />{txs.length ? <View style={[s.card, { paddingVertical: 3 }]}>{txs.map((t, i) => <View key={t.id} style={[s.row, { gap: 11, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderColor: C.line }]}><View style={[xs.txIcon, t.amount < 0 && { backgroundColor: C.softOrange }]}><Icon name={t.amount < 0 ? 'gift-outline' : 'add'} size={17} color={t.amount < 0 ? C.orange : C.pine} /></View><View style={{ flex: 1, gap: 4 }}><Txt weight="semibold" style={{ fontSize: 11, lineHeight: 17 }}>{t.reason}</Txt><Txt style={{ fontSize: 10, color: C.muted }}>{p.role === 'staff' ? `${db.guests.find(g => g.id === t.guestId)?.name.split(' ')[0]} · ` : ''}{shortDate(t.createdAt)}</Txt></View><Txt weight="bold" style={{ fontSize: 13, color: t.amount > 0 ? C.pine : C.orange }}>{t.amount > 0 ? '+' : '−'}{money(Math.abs(t.amount))} Б</Txt></View>)}</View> : <Empty title={loyaltyEnabled ? 'Здесь появятся бонусы' : 'История пока пуста'} text={!loyaltyEnabled ? 'Здесь хранится история начислений и списаний этого заведения.' : p.role === 'staff' ? 'Отметьте визит или поблагодарите гостя.' : 'Покажите свой QR сотруднику при визите. После подтверждения чека начисление появится здесь.'} />}</View>
  </View>;
}
export function Reviews(p: ScreenActions) {
  const { db, guestId } = useStore();
  const reviewsEnabled = effectiveGuestProfile(p.venue).features.reviews;
  const [filter, setFilter] = useState('Все отзывы');
  const all = db.reviews.filter(r => r.venueId === p.venue.id && (p.role === 'staff' || r.guestId === guestId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reviews = all.filter(r => filter === 'Все отзывы' || (filter === 'Без ответа' ? !r.response : r.guestId === guestId));
  const rating = all.length ? all.reduce((sum, r) => sum + r.rating, 0) / all.length : 0;
  return <View style={s.page}><View style={{ gap: 7 }}><Txt weight="bold" style={s.eyebrow}>ДИАЛОГ, КОТОРЫЙ ВАЖЕН</Txt><Txt weight="extra" style={s.title}>О вашем месте</Txt><Txt style={s.caption}>Впечатления гостей после посещения.</Txt></View><View style={[s.card, s.row, { gap: 20 }]}><Txt weight="extra" style={{ fontSize: 46, letterSpacing: -2 }}>{rating ? rating.toFixed(1) : '—'}</Txt><View style={{ gap: 7 }}><Stars rating={Math.round(rating)} size={18} /><Txt style={s.caption}>На основе отзывов: {all.length}</Txt></View><View style={{ flex: 1, alignItems: 'flex-end' }}><Icon name="chatbubble-ellipses-outline" size={28} color={C.muted} /></View></View>
    {p.role === 'guest' && (reviewsEnabled ? <Button label="Поделиться впечатлением" icon="create-outline" onPress={p.review} /> : <Callout>Новые отзывы для этого заведения сейчас отключены. Ваши прежние отзывы и ответы команды сохранены.</Callout>)}
    <View style={[s.row, { gap: 8 }]}>{[...(p.role === 'staff' ? ['Все отзывы', 'Без ответа'] : ['Мои отзывы'])].map(f => <Pressable accessibilityRole="button" accessibilityState={{ selected: filter === f }} key={f} onPress={() => setFilter(f)} style={[xs.filter, filter === f && { backgroundColor: C.pine }]}><Txt weight="semibold" style={{ fontSize: 11, color: filter === f ? '#FFF' : C.muted }}>{f}</Txt></Pressable>)}</View>
    {reviews.length ? reviews.map(r => { const author = db.guests.find(g => g.id === r.guestId)!; return <View key={r.id} style={[s.card, { gap: 13 }]}><View style={[s.row, { gap: 10 }]}><Avatar guest={author} size={39} /><View style={{ flex: 1, gap: 4 }}><Txt weight="bold" style={{ fontSize: 12 }}>{author.name}{p.role === 'guest' && author.id === guestId ? ' · вы' : ''}</Txt><Txt style={{ fontSize: 10, color: C.muted }}>{shortDate(r.createdAt)} · После визита</Txt></View><Stars rating={r.rating} size={11} /></View><Txt style={{ lineHeight: 23, fontSize: 13 }}>{r.text}</Txt>{r.response && <View style={{ backgroundColor: C.pale, borderRadius: 13, padding: 13, gap: 6 }}><Txt weight="bold" style={{ fontSize: 10 }}>Команда «{p.venue.name}»</Txt><Txt style={{ fontSize: 12, lineHeight: 20 }}>{r.response}</Txt></View>}{p.role === 'staff' && <Pressable accessibilityRole="button" accessibilityLabel={`Ответить на отзыв ${author.name}`} onPress={() => p.reply(r.id)} style={[s.row, { gap: 5, alignSelf: 'flex-start', paddingVertical: 4 }]}><Icon name="arrow-undo-outline" size={14} color={C.pine} /><Txt weight="bold" style={{ fontSize: 11 }}>{r.response ? 'Изменить ответ' : 'Ответить гостю'}</Txt></Pressable>}</View>; }) : <Empty icon="chatbubbles-outline" title="Диалог только начинается" text="Здесь будут впечатления гостей и ответы команды." />}
  </View>;
}
export function MyVisits(p: ScreenActions) {
  const { db, guestId } = useStore();
  const st = stats(db, p.venue.id, guestId);
  const reviewsEnabled = effectiveGuestProfile(p.venue).features.reviews;
  return <View style={s.page}><View style={{ gap: 7 }}><Txt weight="bold" style={s.eyebrow}>НАША ОБЩАЯ ИСТОРИЯ</Txt><Txt weight="extra" style={s.title}>Ваши визиты</Txt><Txt style={s.caption}>Хорошие привычки складываются в историю.</Txt></View><View style={[s.card, s.row, { justifyContent: 'space-around' }]}><View style={{ gap: 6, alignItems: 'center' }}><Txt weight="extra" style={{ fontSize: 28 }}>{st.count}</Txt><Txt style={s.caption}>визитов</Txt></View><View style={{ height: 40, width: 1, backgroundColor: C.line }} /><View style={{ gap: 6, alignItems: 'center' }}><Txt weight="extra" style={{ fontSize: 28 }}>{money(st.spent)} ₽</Txt><Txt style={s.caption}>сумма заказов</Txt></View></View><View style={{ gap: 12 }}>{st.visits.map(v => <View key={v.id} style={[s.card, { gap: 13 }]}><View style={[s.row, { gap: 12 }]}><View style={xs.ruleIcon}><Icon name="cafe-outline" size={21} /></View><View style={{ flex: 1, gap: 3 }}><Txt weight="bold" style={{ fontSize: 14 }}>{p.venue.name}</Txt><Txt style={s.caption}>{shortDate(v.createdAt)}</Txt></View><Txt weight="bold">{money(v.bill)} ₽</Txt></View><View style={[s.row, { justifyContent: 'space-between' }]}><Txt style={{ color: C.muted, fontSize: 11 }}>Спасибо за чаевые: {money(v.tips)} ₽</Txt><Pill label="Визит отмечен" icon="checkmark" /></View></View>)}</View>{reviewsEnabled && st.count > 0 && <Button label="Оставить отзыв" icon="create-outline" variant="secondary" onPress={p.review} />}{!st.count && <Empty title="До первой встречи" text="После посещения сотрудник отметит ваш визит." />}</View>;
}
const xs = StyleSheet.create({
  hero: { backgroundColor: C.lime, borderRadius: 30, borderWidth: 1, borderColor: '#FFFFFFAD', padding: 23, overflow: 'hidden', minHeight: 290 },
  heroLink: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginTop: 18, paddingVertical: 5 },
  heroFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderColor: '#244A3D24', paddingTop: 16, marginTop: 19, gap: 10 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.pine },
  clubStamp: { position: 'absolute', width: 84, height: 84, borderRadius: 42, backgroundColor: C.lavender, borderWidth: 1, borderColor: '#FFFFFFC9', right: 14, top: 145, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '10deg' }], overflow: 'hidden' },
  stampRing: { width: 70, height: 70, borderRadius: 35, borderWidth: 1, borderColor: '#FFFFFFAD', alignItems: 'center', justifyContent: 'center', gap: 2 },
  statCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, padding: 18, borderRadius: 24, gap: 5, boxShadow: '0px 5px 20px #263E2906' },
  statValue: { fontSize: 37, letterSpacing: -1.7, marginTop: 6 },
  guestRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 17, paddingHorizontal: 14, borderRadius: 20 },
  divider: { height: 1, backgroundColor: C.line, marginLeft: 70, marginRight: 14 },
  thanksBanner: { backgroundColor: C.lavender, borderWidth: 1, borderColor: '#FFFFFFB3', borderRadius: 24, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' },
  thanksIcon: { width: 43, height: 46, borderRadius: 16, backgroundColor: '#FFFFFF85', alignItems: 'center', justifyContent: 'center' },
  search: { backgroundColor: '#FFF', flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.line, borderRadius: 15, paddingHorizontal: 14, gap: 10, height: 52 },
  searchInput: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 13, height: '100%', color: C.ink, outlineWidth: 0 } as any,
  filter: { paddingHorizontal: 15, paddingVertical: 10, borderRadius: 19, backgroundColor: C.pale },
  rewardArt: { width: 76, height: 82, borderRadius: 24, backgroundColor: C.pale, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  artSpark: { position: 'absolute', right: 9, top: 10 },
  balanceBanner: { backgroundColor: C.dark, borderRadius: 28, padding: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', overflow: 'hidden', borderWidth: 1, borderColor: '#557B674D' },
  ruleIcon: { width: 42, height: 42, borderRadius: 16, backgroundColor: C.pale, alignItems: 'center', justifyContent: 'center' },
  txIcon: { width: 32, height: 32, borderRadius: 11, backgroundColor: C.pale, alignItems: 'center', justifyContent: 'center' },
});
