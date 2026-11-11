import { Database, Visit } from './domain';
export const DEMO_GUEST = 'alex';
export function createSeed(): Database {
  const ago = (days: number, hour = 15) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 20, 0, 0); return d.toISOString(); };
  const guests = [
    { id: 'alex', name: 'Александр Миронов', phone: '79000000001', color: '#E6D9C5' },
    { id: 'anna', name: 'Анна Соколова', phone: '79000000002', color: '#E4DBEC' },
    { id: 'mark', name: 'Марк Волков', phone: '79000000003', color: '#D9E4D7' },
    { id: 'lena', name: 'Елена Белова', phone: '79000000004', color: '#F1D9D0' },
    { id: 'misha', name: 'Михаил Ким', phone: '79000000005', color: '#D6E2EA' },
    { id: 'dasha', name: 'Дарья Лебедева', phone: '79000000006', color: '#EFDFC2' },
  ].map(g => ({ ...g, createdAt: ago(60) }));
  const visits: Visit[] = [];
  const counts = [12, 9, 7, 5, 3, 1];
  guests.forEach((g, i) => {
    for (let n = 0; n < counts[i]; n++) visits.push({ id: `v-${g.id}-${n}`, venueId: 'list', guestId: g.id, bill: [1800, 2400, 1200, 3200, 950, 1500][i], tips: [250, 360, 120, 400, 50, 150][i], rating: i === 4 ? 4 : 5, createdAt: ago(n * 4 + (i > 2 ? i : 0), 12 + i) });
  });
  for (let n = 0; n < 4; n++) visits.push({ id: `v-moss-${n}`, venueId: 'moss', guestId: 'alex', bill: 800, tips: 100, rating: 5, createdAt: ago(n * 7 + 1) });
  const db: Database = {
    version: 1,
    venues: [
      { id: 'list', name: 'Лист', kind: 'Кофе и бистро', address: 'ул. Садовая, 12', monogram: 'Л', program: { cashback: 5, everyVisits: 5, visitBonus: 100, tipsBonus: 25 } },
      { id: 'moss', name: 'Мох', kind: 'Кофейня у дома', address: 'ул. Лесная, 8', monogram: 'М', program: { cashback: 7, everyVisits: 4, visitBonus: 150, tipsBonus: 30 } },
    ], guests,
    memberships: [...guests.map((g, i) => ({ venueId: 'list', guestId: g.id, balance: [740, 560, 280, 430, 95, 100][i] })), { venueId: 'moss', guestId: 'alex', balance: 230 }],
    visits: visits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    notes: [
      { id: 'n1', venueId: 'list', guestId: 'alex', kind: 'thanks', text: 'Всегда благодарит команду и оставляет щедрые чаевые. В следующий визит угостить любимым фильтром.', author: 'Мария · администратор', createdAt: ago(0) },
      { id: 'n2', venueId: 'list', guestId: 'alex', kind: 'preference', text: 'Фильтр без сахара, столик у окна. Часто приходит с книгой.', author: 'Илья · бариста', createdAt: ago(4) },
      { id: 'n3', venueId: 'list', guestId: 'anna', kind: 'thanks', text: 'Приходит с друзьями по воскресеньям. Очень тепло общается с командой.', author: 'Мария · администратор', createdAt: ago(1) },
      { id: 'n4', venueId: 'list', guestId: 'mark', kind: 'preference', text: 'Капучино на овсяном молоке. Любит пробовать новые десерты.', author: 'Илья · бариста', createdAt: ago(3) },
    ],
    reviews: [
      { id: 'r1', venueId: 'list', guestId: 'anna', visitId: 'v-anna-0', rating: 5, text: 'То самое место, куда возвращаешься за атмосферой. И за вашим капучино, конечно ☕', createdAt: ago(0), response: 'Анна, очень рады быть вашим любимым местом. До встречи в «Листе»! 🌿' },
      { id: 'r2', venueId: 'list', guestId: 'alex', visitId: 'v-alex-1', rating: 5, text: 'Помнят мой любимый кофе и всегда встречают с улыбкой. Спасибо команде!', createdAt: ago(4) },
      { id: 'r3', venueId: 'list', guestId: 'misha', visitId: 'v-misha-0', rating: 4, text: 'Вкусный завтрак, уютно. В этот раз немного долго ждал заказ.', createdAt: ago(4) },
      { id: 'r4', venueId: 'moss', guestId: 'alex', visitId: 'v-moss-1', rating: 5, text: 'Уютная кофейня, отличный эспрессо. Загляну ещё!', createdAt: ago(8) },
    ], transactions: [],
  };
  db.memberships.forEach((m, i) => db.transactions.push({ id: `seed-balance-${i}`, venueId: m.venueId, guestId: m.guestId, amount: m.balance, reason: 'Начальный баланс · демоданные', createdAt: ago(5) }));
  return db;
}
