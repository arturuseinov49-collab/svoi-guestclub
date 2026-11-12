import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { GuestVenueProfile } from './venue-profile';
import { validateGuestProfile } from './venue-profile';
import { Button, C, Callout, Field, Icon, Section, Txt, s } from './ui';

const linkFields = [
  { key: 'menu', label: 'Ссылка на меню' },
  { key: 'booking', label: 'Ссылка на бронирование' },
  { key: 'telegram', label: 'Telegram заведения' },
  { key: 'vk', label: 'ВКонтакте заведения' },
  { key: 'website', label: 'Сайт заведения' },
] as const;

function Toggle({ label, description, value, disabled, onChange }: { label: string; description: string; value: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} disabled={disabled} onPress={() => onChange(!value)} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, paddingVertical: 9 }, pressed && { opacity: 0.7 }, disabled && { opacity: 0.5 }]}>
    <View style={{ flex: 1, gap: 4 }}><Txt weight="bold" style={{ fontSize: 13 }}>{label}</Txt><Txt style={s.caption}>{description}</Txt></View>
    <View style={{ width: 46, height: 28, padding: 3, borderRadius: 14, backgroundColor: value ? C.pine : '#D5DCD0', alignItems: value ? 'flex-end' : 'flex-start' }}><View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>{value && <Icon name="checkmark" color={C.pine} size={14} />}</View></View>
  </Pressable>;
}

export function VenueProfileEditor({ profile, busy, onSave, onCancel }: { profile: GuestVenueProfile; busy: boolean; onSave: (profile: GuestVenueProfile) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState<GuestVenueProfile>(() => ({ ...profile, links: { ...profile.links }, features: { ...profile.features }, highlights: [...profile.highlights] }));
  const [highlights, setHighlights] = useState(profile.highlights.join('\n'));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const change = (next: Partial<GuestVenueProfile>) => { setDraft(value => ({ ...value, ...next })); setError(''); setSaved(false); };
  const save = async () => {
    setError(''); setSaved(false);
    const items = highlights.split('\n').map(item => item.trim()).filter(Boolean);
    if (items.length > 6 || items.some(item => item.length > 60)) { setError('Добавьте не более 6 особенностей, до 60 символов каждая.'); return; }
    const links: GuestVenueProfile['links'] = {};
    for (const { key, label } of linkFields) {
      const value = draft.links[key]?.trim();
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error();
        links[key] = value;
      } catch { setError(`${label}: укажите полный адрес https:// без логина и пароля.`); return; }
    }
    let next: GuestVenueProfile;
    try { next = validateGuestProfile({ ...draft, highlights: items, links }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Проверьте поля карточки.'); return; }
    const ok = await onSave(next);
    if (ok) { setDraft(next); setHighlights(items.join('\n')); setSaved(true); }
    else setError('Карточку не удалось сохранить. Проверьте сообщение выше и повторите попытку.');
  };
  return <View style={{ gap: 20, borderTopWidth: 1, borderColor: C.line, paddingTop: 18 }}>
    <View style={{ gap: 7 }}><Txt weight="extra" style={{ fontSize: 19 }}>Карточка для гостей</Txt><Txt style={s.caption}>Содержание и доступные действия относятся только к этому заведению.</Txt></View>
    <View style={{ gap: 2 }}>
      <Toggle label="Показывать в каталоге" description="Гости смогут выбрать это заведение на стартовом экране." value={draft.published} disabled={busy} onChange={published => change({ published })} />
      <Toggle label="Тестовая карточка" description="На карточке появится заметная отметка «Тестовая»." value={draft.demo} disabled={busy} onChange={demo => change({ demo })} />
    </View>
    <View style={{ gap: 9 }}><Txt weight="bold" style={{ fontSize: 13 }}>Оформление</Txt><Button label="Стиль «Свои»" icon={draft.theme === 'svoi' ? 'checkmark-circle-outline' : 'leaf-outline'} variant={draft.theme === 'svoi' ? 'secondary' : 'ghost'} disabled={busy} onPress={() => change({ theme: 'svoi' })} /><Button label="Эль Пастор · бордо" icon={draft.theme === 'elpastor' ? 'checkmark-circle-outline' : 'sunny-outline'} variant={draft.theme === 'elpastor' ? 'secondary' : 'ghost'} disabled={busy} onPress={() => change({ theme: 'elpastor' })} /></View>
    <Field label="Короткая фраза на карточке" placeholder="Что делает это место особенным" value={draft.tagline} onChangeText={tagline => change({ tagline })} maxLength={120} editable={!busy} />
    <Field label="Описание заведения" placeholder="Атмосфера, кухня и особенности места" value={draft.description} onChangeText={description => change({ description })} multiline maxLength={1200} editable={!busy} />
    <Field label="Особенности — каждая с новой строки" placeholder={'Мексиканская кухня\nАвторские коктейли'} value={highlights} onChangeText={value => { setHighlights(value); setError(''); setSaved(false); }} multiline maxLength={365} editable={!busy} />
    <Txt style={[s.caption, { marginTop: -10 }]}>До 6 коротких особенностей, по 60 символов.</Txt>
    <Field label="Условия для гостей" placeholder="Условия, согласованные именно с этим заведением" value={draft.terms} onChangeText={terms => change({ terms })} multiline maxLength={1500} editable={!busy} />
    <View><Section title="Доступные действия" />
      <Toggle label="Анкеты после визита" description="Команда отмечает визит и предпочтения гостя. Гость оценивает заведение по пунктам и оставляет комментарий." value={draft.feedbackEnabled ?? draft.published} disabled={busy} onChange={feedbackEnabled => change({ feedbackEnabled })} />
    </View>
    <Callout>Предпочтения и отзывы о госте доступны только команде заведения. Отзыв гостя видят его автор и команда. Отключение анкет сохраняет историю.</Callout>
    <View style={{ gap: 16 }}><Section title="Официальные ссылки" />{linkFields.map(({ key, label }) => <Field key={key} label={label} placeholder="https://…" value={draft.links[key] ?? ''} onChangeText={value => change({ links: { ...draft.links, [key]: value } })} keyboardType="url" autoCapitalize="none" autoCorrect={false} maxLength={600} editable={!busy} />)}<Txt style={s.caption}>Добавляйте проверенные страницы заведения. Пустая ссылка скроет соответствующую кнопку.</Txt></View>
    {!!error && <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 20 }}>{error}</Txt>}
    {saved && <Callout icon="checkmark-circle-outline">{draft.published ? 'Карточка сохранена и доступна в каталоге гостей.' : 'Карточка сохранена. В общем каталоге она пока скрыта.'}</Callout>}
    <Button label="Сохранить карточку заведения" icon="checkmark-outline" loading={busy} onPress={() => void save()} />
    <Button label="Закрыть редактор карточки" variant="ghost" disabled={busy} onPress={onCancel} />
  </View>;
}
