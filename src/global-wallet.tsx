import React from 'react';
import { View } from 'react-native';
import { shortDate } from './domain';
import { BonusTheme, GlobalBonusAmount, bonusColors } from './bonus-ui';
import { Icon, Txt, s } from './ui';

export interface GlobalWalletEntryView {
  id: string;
  amount: number;
  createdAt: string;
  reason: string;
  venueName?: string;
}

/** Receives only the signed-in guest's ledger, never another guest's history. */
export function GlobalWalletDetails({ balance, entries, earningDescription, redemptionDescription, pendingReview = false, theme = 'default' }: {
  balance: number | null;
  entries: GlobalWalletEntryView[];
  earningDescription: string;
  redemptionDescription: string;
  pendingReview?: boolean;
  theme?: BonusTheme;
}) {
  const colors = bonusColors(theme);
  return <>
    <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, gap: 12 }]}>
      <Txt weight="bold" style={{ fontSize: 12, color: colors.muted }}>Ваш глобальный счёт «Своих»</Txt>
      <GlobalBonusAmount amount={balance} color={colors.accent} size={42} />
      <Txt style={{ fontSize: 12, lineHeight: 20, color: colors.muted }}>Баланс общий для вашего профиля. Бонусы заведений остаются в их отдельных клубных картах.</Txt>
    </View>
    {pendingReview && <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, gap: 8 }]}><Txt weight="bold" style={{ color: colors.ink }}>Есть операции на сверке</Txt><Txt style={{ fontSize: 12, lineHeight: 20, color: colors.muted }}>По части чеков нужна проверка. Подробности уточните у команды «Своих».</Txt></View>}
    <View style={{ gap: 10 }}><Txt weight="bold" style={{ color: colors.ink, fontSize: 17 }}>Условия программы</Txt><Txt style={{ fontSize: 13, lineHeight: 22, color: colors.muted }}>{earningDescription}</Txt><Txt style={{ fontSize: 13, lineHeight: 22, color: colors.muted }}>{redemptionDescription}</Txt></View>
    <View style={{ gap: 14 }}>
      <Txt weight="bold" style={{ fontSize: 19, color: colors.ink }}>История начислений</Txt>
      {entries.length ? <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, paddingVertical: 3 }]}>{entries.map((entry, index) => <View key={entry.id} style={{ borderTopWidth: index ? 1 : 0, borderColor: colors.border, paddingVertical: 15, gap: 8 }}>
        <View style={{ gap: 5 }}><Txt weight="bold" style={{ color: colors.ink, fontSize: 13, lineHeight: 20 }}>{entry.reason}</Txt><Txt style={{ color: colors.muted, fontSize: 11, lineHeight: 18 }}>{entry.venueName ? `${entry.venueName} · ` : ''}{shortDate(entry.createdAt)}</Txt></View>
        <GlobalBonusAmount amount={Math.abs(entry.amount)} prefix={entry.amount < 0 ? '−' : '+'} color={colors.accent} size={20} />
      </View>)}</View> : <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, gap: 12 }]}><Icon name="leaf" color={colors.accent} size={26} /><Txt weight="bold" style={{ color: colors.ink }}>{balance === null ? 'Счёт пока недоступен' : 'Операций пока нет'}</Txt><Txt style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}>{balance === null ? 'Обновите данные немного позже. Ваши сохранённые операции остаются на сервере.' : 'Здесь появятся начисления вашего глобального счёта.'}</Txt></View>}
    </View>
  </>;
}
