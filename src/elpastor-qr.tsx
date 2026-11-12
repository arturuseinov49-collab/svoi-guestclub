import React from 'react';
import { StyleSheet, View } from 'react-native';
import { GuestQr } from './qr';
import { Icon, Sheet, Txt } from './ui';

type Props = {
  value: string;
  code: string;
  guestName: string;
  venueName: string;
  demo: boolean;
  onClose: () => void;
};

/** A venue-branded presentation of the existing global guest identity. */
export function ElpastorQrSheet({ value, code, guestName, venueName, demo, onClose }: Props) {
  return <Sheet visible theme="elpastor" title="Карта гостя" onClose={onClose}>
    <View testID="elpastor-qr-screen" style={q.content}>
      <View style={q.brand}>
        <View style={q.ornament} accessible={false}><View style={q.line} /><Txt style={q.star}>✦</Txt><View style={q.line} /></View>
        <Txt style={q.wordmark}>ЭЛЬ ПАСТОР</Txt>
        <Txt style={q.descriptor}>МЕКСИКАНСКИЙ ГАСТРОБАР</Txt>
      </View>
      <View style={q.identity}><Txt style={q.label}>ГОСТЬ</Txt><Txt weight="bold" style={q.name}>{guestName.trim() || 'Ваш личный профиль'}</Txt></View>
      <GuestQr value={value} code={code} variant="elpastor" />
      <Txt style={q.instruction}>Покажите карту сотруднику «{venueName}». Этот QR остаётся вашим во всех заведениях «Своих».</Txt>
      {demo && <View style={q.notice}><Icon name="information-circle-outline" size={17} color="#E6BB8E" /><Txt style={q.noticeText}>Тестовая карточка. Анкета появится после подтверждения визита сотрудником.</Txt></View>}
      <View style={q.footer}><View style={q.footerLine} /><Txt style={q.footerText}>СВОИ · ЛИЧНАЯ КАРТА</Txt><View style={q.footerLine} /></View>
    </View>
  </Sheet>;
}

const q = StyleSheet.create({
  content: { gap: 16, alignItems: 'stretch' },
  brand: { alignItems: 'center', gap: 4 },
  ornament: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 3 },
  line: { width: 26, height: 1, backgroundColor: '#75404A' },
  star: { color: '#E6BB8E', fontSize: 15, lineHeight: 18 },
  wordmark: { fontFamily: 'CormorantGaramondBold', fontSize: 29, lineHeight: 34, letterSpacing: 1.4, color: '#FFF1DA' },
  descriptor: { color: '#E6BB8E', fontSize: 7, lineHeight: 12, letterSpacing: 1.4 },
  identity: { alignItems: 'center', gap: 4 },
  label: { color: '#C5A995', fontSize: 8, letterSpacing: 2 },
  name: { color: '#FFF1DA', fontSize: 18, lineHeight: 25, textAlign: 'center' },
  instruction: { color: '#C5A995', fontSize: 11, lineHeight: 18, textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: 14, backgroundColor: '#350F1C', borderWidth: 1, borderColor: '#75404A' },
  noticeText: { color: '#E6CDB4', flex: 1, fontSize: 11, lineHeight: 18 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  footerLine: { width: 18, height: 1, backgroundColor: '#75404A' },
  footerText: { color: '#C5A995', fontSize: 8, letterSpacing: 1.2 },
});
