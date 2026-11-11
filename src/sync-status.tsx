import React, { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useStore } from './store';
import { C, Icon, Txt } from './ui';

export function SyncStatus() {
  const { syncError, lastSynced, refresh } = useStore();
  const [busy, setBusy] = useState(false);
  if (!syncError) return null;
  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try { await refresh(); } finally { setBusy(false); }
  };
  return <View style={{ backgroundColor: C.softOrange, paddingHorizontal: 22, paddingVertical: 12, gap: 8 }}>
    <View style={{ flexDirection: 'row', gap: 9 }}><Icon name="cloud-offline-outline" color={C.orange} size={18} /><View style={{ flex: 1, gap: 5 }}>
      <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 19 }}>{syncError}</Txt>
      {!!lastSynced && <Txt style={{ color: C.muted, fontSize: 10 }}>Последнее обновление: {new Date(lastSynced).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</Txt>}
    </View></View>
    <Pressable accessibilityRole="button" accessibilityLabel="Повторить синхронизацию" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => void retry()} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, backgroundColor: '#FFFFFF99' }}>
      {busy ? <ActivityIndicator size="small" color={C.pine} /> : <Icon name="refresh-outline" size={16} color={C.pine} />}
      <Txt weight="bold" style={{ fontSize: 12, color: C.pine }}>{busy ? 'Обновляем…' : 'Обновить данные'}</Txt>
    </Pressable>
  </View>;
}
