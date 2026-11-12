import React from 'react';
import { Pressable, View } from 'react-native';
import { money } from './domain';
import { C, Icon, Txt, fx, s } from './ui';

export type BonusTheme = 'default' | 'elpastor';
export function bonusColors(theme: BonusTheme = 'default') {
  return theme === 'elpastor'
    ? { ink: '#FFF1DA', muted: '#C5A995', accent: '#E6BB8E', surface: '#350F1C', border: '#75404A80' }
    : { ink: C.ink, muted: C.muted, accent: C.pine, surface: C.pale, border: C.line };
}

export function globalEarningDescription(program: { enabled: boolean; cashbackPercent: number } | null, detailed = false) {
  if (!program) return 'Условия глобальной программы пока недоступны. Обновите данные немного позже.';
  if (!program.enabled) return 'Начисления по глобальной программе сейчас выключены.';
  return `${money(program.cashbackPercent)}% с оплаченных чеков подключённых заведений. Начисление появится после подтверждения оплаты кассой.${detailed ? ' По каждому чеку начисляются целые глобальные бонусы с округлением вниз.' : ''}`;
}

/** The filled Ionicons leaf is the same symbol used in the Svoi wordmark. */
export function GlobalBonusAmount({ amount, size = 34, color = C.pine, prefix = '', testID }: { amount: number | null; size?: number; color?: string; prefix?: string; testID?: string }) {
  const text = amount === null ? '—' : `${prefix}${money(amount)}`;
  return <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={amount === null ? 'Глобальный баланс пока недоступен' : `${text} глобальных бонусов`} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Math.max(5, size / 5), minWidth: 0 }}>
    <Txt weight="extra" style={{ fontSize: size, lineHeight: size * 1.25, color, flexShrink: 1 }}>{text}</Txt>
    <View testID="global-bonus-symbol" accessible={false} importantForAccessibility="no-hide-descendants"><Icon name="leaf" size={Math.max(15, size * .7)} color={color} /></View>
  </View>;
}

export function GlobalWalletCard({ balance, onPress, theme = 'default', caption, pendingReview = false }: { balance: number | null; onPress?: () => void; theme?: BonusTheme; caption?: string; pendingReview?: boolean }) {
  const colors = bonusColors(theme);
  const content = <>
    <View style={{ gap: 6 }}><Txt weight="bold" style={{ color: colors.accent, fontSize: 9, letterSpacing: 1.2 }}>СВОИ · ЕДИНЫЙ СЧЁТ</Txt><Txt weight="extra" style={{ fontSize: 19, lineHeight: 25, color: colors.ink }}>Глобальные бонусы</Txt></View>
    <GlobalBonusAmount amount={balance} color={colors.accent} />
    <Txt style={{ fontSize: 12, lineHeight: 20, color: colors.muted }}>{caption ?? 'Отдельный счёт «Своих». Бонусы заведений хранятся в их клубных картах.'}</Txt>
    {pendingReview && <Txt style={{ fontSize: 11, lineHeight: 18, color: colors.muted }}>Есть операции на сверке.</Txt>}
    {onPress && <View style={[s.row, { gap: 8 }]}><Txt weight="bold" style={{ flex: 1, fontSize: 12, color: colors.accent }}>История и условия</Txt><Icon name="arrow-forward" size={17} color={colors.accent} /></View>}
  </>;
  const style = [s.card, { gap: 13, backgroundColor: colors.surface, borderColor: colors.border }];
  return onPress ? <Pressable {...fx(theme === 'elpastor' ? 'club-panel' : 'soft-card')} testID="global-wallet-card" accessibilityRole="button" accessibilityLabel="Открыть глобальные бонусы" onPress={onPress} style={style}>{content}</Pressable> : <View testID="global-wallet-card" style={style}>{content}</View>;
}
