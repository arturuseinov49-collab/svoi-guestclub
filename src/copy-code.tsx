import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, C, Txt } from './ui';

// Codes remain selectable above this button when a WebView denies clipboard access.
export function CopyCode({ code, label = 'Скопировать код' }: { code: string; label?: string }) {
  const [result, setResult] = useState<{ code: string; state: 'idle' | 'busy' | 'copied' | 'manual' }>({ code, state: 'idle' });
  const state = result.code === code ? result.state : 'idle';
  const copy = async () => {
    setResult({ code, state: 'busy' });
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setResult({ code, state: 'copied' });
    } catch { setResult({ code, state: 'manual' }); }
  };
  return <View style={{ gap: 8 }}>
    <Button label={state === 'copied' ? 'Код скопирован' : label} icon={state === 'copied' ? 'checkmark' : 'copy-outline'} variant="ghost" loading={state === 'busy'} disabled={!code} onPress={() => void copy()} />
    {state === 'manual' && <Txt accessibilityRole="alert" style={{ fontSize: 12, lineHeight: 19, color: C.pine }}>Не удалось скопировать автоматически. Зажмите код выше, выделите его и выберите «Копировать».</Txt>}
  </View>;
}
