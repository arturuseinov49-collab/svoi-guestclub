import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Txt, fx } from './ui';

// Live, locally bundled type stays sharp at every pixel density.
// This is an editorial adaptation of the venue's burgundy identity, not a bitmap logo.
export function ElpastorArt({ large = false, demo = false }: { large?: boolean; demo?: boolean }) {
  return <View {...fx('elpastor')} testID="elpastor-art" style={[a.card, large && a.large]}>
    <View pointerEvents="none" accessible={false} {...fx('elpastor-glow')} style={a.glow} />
    <View pointerEvents="none" accessible={false} {...fx('elpastor-frame')} style={a.frame} />
    <View pointerEvents="none" accessible={false} {...fx('elpastor-orbit')} style={a.orbit} />
    <View style={a.top}><Txt style={a.hello}>HOLA, AMIGO</Txt>{demo && <View style={a.badge}><View style={a.dot} /><Txt style={a.badgeText}>Тестовая карточка</Txt></View>}</View>
    <View style={a.identity} accessibilityLabel="Эль Пастор — мексиканский гастробар">
      <View style={a.ornament} accessible={false}><View style={a.rule} /><Txt style={a.star}>✦</Txt><View style={a.rule} /></View>
      <Txt {...fx('elpastor-type')} style={a.first}>ЭЛЬ</Txt>
      <Txt {...fx('elpastor-type')} style={a.name}>ПАСТОР</Txt>
      <Txt style={a.descriptor}>МЕКСИКАНСКИЙ ГАСТРОБАР</Txt>
    </View>
    <View style={a.bottom}><View style={a.smallRule} /><Txt style={a.footer}>КУХНЯ · ГАСТРОУЖИНЫ · МУЗЫКА</Txt><View style={a.smallRule} /></View>
  </View>;
}

const a = StyleSheet.create({
  card: { minHeight: 278, padding: 22, borderRadius: 25, backgroundColor: '#500B19', overflow: 'hidden', justifyContent: 'space-between', gap: 18 },
  large: { minHeight: 294 },
  glow: { position: 'absolute', width: 270, height: 270, borderRadius: 135, top: -130, left: -115 },
  frame: { position: 'absolute', inset: 10, borderWidth: 1, borderColor: '#E9BC7838', borderRadius: 18 },
  orbit: { position: 'absolute', width: 234, height: 234, right: -156, bottom: -42, borderRadius: 117, borderWidth: 1, borderColor: '#E9BC782A' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, zIndex: 2 },
  hello: { fontSize: 8, letterSpacing: 1.7, color: '#E6BB8E' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#F5D8A83C', backgroundColor: '#25091240' },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#E9BF8A' },
  badgeText: { fontSize: 8, color: '#F6DFBF' },
  identity: { alignItems: 'center', zIndex: 2 },
  ornament: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 11 },
  rule: { width: 36, height: 1, backgroundColor: '#E6BB8E70' },
  star: { fontSize: 19, lineHeight: 22, color: '#E6BB8E' },
  first: { fontFamily: 'CormorantGaramondBold', fontSize: 30, lineHeight: 32, letterSpacing: 6, paddingLeft: 6, color: '#FFF1DA' },
  name: { fontFamily: 'CormorantGaramondBold', fontSize: 53, lineHeight: 59, letterSpacing: 0.8, color: '#FFF1DA' },
  descriptor: { fontSize: 8, lineHeight: 14, letterSpacing: 1.5, color: '#E9C89D', marginTop: 7 },
  bottom: { flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  smallRule: { height: 1, backgroundColor: '#E6BB8E40', flex: 1, maxWidth: 24 },
  footer: { fontSize: 7, lineHeight: 12, letterSpacing: 0.9, color: '#F2D7B6' },
});
