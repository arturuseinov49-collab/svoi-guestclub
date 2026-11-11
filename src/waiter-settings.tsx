import React, { useState } from 'react';
import { View } from 'react-native';
import type { Venue } from './domain';
import { defaultServiceFlow, validateServiceFlow, CashSystem } from './service-flow';
import { useMutation } from './panels';
import { Button, C, Field, Txt, s } from './ui';

export function WaiterSettings({ venue, notify }: { venue: Venue; notify?: (message: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(() => venue.serviceFlow ?? defaultServiceFlow());
  const [validation, setValidation] = useState('');
  const mutation = useMutation();
  const save = () => {
    setValidation('');
    try {
      const serviceFlow = validateServiceFlow(draft);
      void mutation.run({ type: 'updateServiceFlow', venueId: venue.id, serviceFlow }, () => { setExpanded(false); notify?.('Сценарий обслуживания сохранён'); });
    } catch (error) { setValidation(error instanceof Error ? error.message : 'Проверьте настройки'); }
  };
  return <View style={{ gap: 12 }}>
    <Button label="Обслуживание и iikoWaiter" icon="phone-portrait-outline" variant="secondary" onPress={() => setExpanded(!expanded)} />
    {expanded && <View style={[s.card, { gap: 14 }]}>
      <Txt weight="bold">Кассовая система заведения</Txt>
      <Txt style={s.caption}>Определяет следующий шаг в карточке гостя. Подключение кассы и импорт чеков настраиваются отдельно.</Txt>
      {([['none', 'Без перехода в кассу'], ['iiko', 'iiko · iikoWaiter'], ['rkeeper', 'r_keeper']] as [CashSystem, string][]).map(([id, label]) => <Button key={id} label={label} variant={draft.cashSystem === id ? 'primary' : 'secondary'} disabled={mutation.busy} onPress={() => setDraft({ ...draft, cashSystem: id })} />)}
      {draft.cashSystem === 'iiko' && <>
        <Txt weight="bold">Быстрый переход · необязательно</Txt>
        <Txt style={s.caption}>Получите у интегратора iikoWaiter публичную HTTPS-ссылку для открытия приложения и проверьте её на каждом телефоне. Ссылки магазинов сюда не нужны. Пока ссылок нет, сотруднику показывается инструкция ручного перехода.</Txt>
        <Field label="Ссылка открытия на Android" placeholder="https://…" value={draft.waiterAndroidUrl} onChangeText={waiterAndroidUrl => setDraft({ ...draft, waiterAndroidUrl })} keyboardType="url" autoCapitalize="none" autoCorrect={false} editable={!mutation.busy} />
        <Field label="Ссылка открытия на iPhone" placeholder="https://…" value={draft.waiterIosUrl} onChangeText={waiterIosUrl => setDraft({ ...draft, waiterIosUrl })} keyboardType="url" autoCapitalize="none" autoCorrect={false} editable={!mutation.busy} />
        <Txt style={s.caption}>Не добавляйте пароли, API-ключи или данные гостя. Эти ссылки только открывают приложение; они не привязывают гостя к заказу и не включают начисления.</Txt>
      </>}
      {(validation || mutation.error) ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12 }}>{validation || mutation.error}</Txt> : null}
      <Button label="Сохранить сценарий" loading={mutation.busy} onPress={save} />
    </View>}
  </View>;
}
