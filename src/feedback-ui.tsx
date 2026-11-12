import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Database, Venue } from './domain';
import { fullDate, shortDate } from './domain';
import { useStore } from './store';
import { useMutation } from './panels';
import { feedbackLimits, feedbackQuestions, staffExperienceOptions, staffPreferenceOptions } from './feedback';
import type { GuestFeedback, RecordFeedbackVisitInput, StaffExperience } from './feedback';
import { Avatar, Button, C, Callout, Field, Icon, Pill, Section, Txt, s } from './ui';
import { effectiveGuestProfile } from './venue-profile';

export function guestVisitTimeline(db: Database, venueId: string, guestId?: string) {
  return [
    ...(db.feedbackVisits ?? []).map(visit => ({ ...visit, legacy: false })),
    ...db.visits.map(visit => ({ id: visit.id, venueId: visit.venueId, guestId: visit.guestId, createdAt: visit.createdAt, legacy: true })),
  ].filter(visit => visit.venueId === venueId && (!guestId || visit.guestId === guestId)).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function StaffGuestProfile({ venue, guestId, onFinish }: { venue: Venue; guestId: string; onFinish: () => void }) {
  const { db, user } = useStore();
  const guest = db.guests.find(item => item.id === guestId);
  const visits = guestVisitTimeline(db, venue.id, guestId);
  const feedback = (db.staffFeedback ?? []).filter(item => item.venueId === venue.id && item.guestId === guestId).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const notes = db.notes.filter(item => item.venueId === venue.id && item.guestId === guestId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const preferences = [...new Set(feedback.flatMap(item => item.preferences))];
  const profile = effectiveGuestProfile(venue);
  const enabled = profile.feedbackEnabled ?? profile.published;
  if (!guest) return <Txt>Карточка гостя недоступна. Обновите данные.</Txt>;
  return <>
    <View style={[s.row, { gap: 14 }]}><Avatar guest={guest} size={60} /><View style={{ flex: 1, gap: 7, minWidth: 0 }}><Txt style={s.caption}>Гость «{venue.name}»</Txt><Pill label={visits.length >= 5 ? 'Постоянный гость' : visits.length ? 'Уже знакомы' : 'Первая встреча'} /><Txt style={s.caption}>{visits[0] ? `Последний визит: ${shortDate(visits[0].createdAt)}` : 'Визитов пока не отмечено'}</Txt></View></View>
    <View testID="guest-visit-count" style={[s.card, { gap: 5 }]}><Txt weight="extra" style={{ fontSize: 30 }}>{visits.length}</Txt><Txt style={s.caption}>визитов в это заведение</Txt></View>
    <View style={{ gap: 12 }}><Section title="Предпочтения гостя" /><View style={[s.row, { flexWrap: 'wrap', gap: 8 }]}>{preferences.map(item => <Pill key={item} label={item} />)}</View>{notes.filter(item => item.kind === 'preference').map(note => <View key={note.id} style={[s.card, { gap: 7, backgroundColor: C.pale }]}><Txt style={{ lineHeight: 23 }}>{note.text}</Txt><Txt style={s.caption}>{note.author} · {shortDate(note.createdAt)}</Txt></View>)}{!preferences.length && !notes.some(item => item.kind === 'preference') && <Txt style={s.caption}>Пока не записаны. Уточните пожелания у гостя и сохраните их в анкете после визита.</Txt>}</View>
    {enabled && db.feedbackVisits !== undefined ? <Button label="Завершить визит" icon="checkmark-circle-outline" onPress={onFinish} /> : <Callout>{db.feedbackVisits === undefined ? 'Анкеты пока недоступны на сервере. Обновите приложение немного позже.' : 'Анкеты для этого заведения пока не включены.'}</Callout>}
    <Txt style={s.caption}>После визита заполните короткую анкету. Сканирование QR само по себе не отмечает посещение.</Txt>
    <View style={{ gap: 12 }}><Section title="Заметки команды" />{!feedback.length && !notes.some(item => item.kind !== 'preference') && <Txt style={s.caption}>Здесь появятся наблюдения сотрудников после визитов.</Txt>}{feedback.map(item => <View key={item.id} testID={`staff-feedback-${item.id}`} style={[s.card, { gap: 10 }]}><Txt weight="bold" style={{ fontSize: 13 }}>{staffExperienceOptions.find(option => option.value === item.experience)?.label ?? 'После визита'}</Txt>{item.comment ? <Txt style={{ lineHeight: 23 }}>{item.comment}</Txt> : <Txt style={s.caption}>Без дополнительного комментария</Txt>}{!!item.preferences.length && <Txt style={s.caption}>Пожелания в этот визит: {item.preferences.join(', ')}</Txt>}<Txt style={{ fontSize: 10, color: C.muted }}>{item.staffUserId === user?.id ? 'Вы' : 'Сотрудник заведения'} · {fullDate(item.createdAt)}</Txt></View>)}{notes.filter(item => item.kind !== 'preference').map(note => <View key={note.id} style={[s.card, { gap: 8 }]}><Txt style={{ lineHeight: 23 }}>{note.text}</Txt><Txt style={s.caption}>{note.author} · {shortDate(note.createdAt)} · Ранняя заметка</Txt></View>)}</View>
    <View style={{ gap: 10 }}><Section title="История визитов" />{visits.slice(0, 12).map(visit => <View key={visit.id} style={[s.row, { gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }]}><Icon name="checkmark-circle-outline" size={18} color={C.pine} /><View style={{ flex: 1, gap: 4 }}><Txt weight="bold" style={{ fontSize: 12 }}>{fullDate(visit.createdAt)}</Txt><Txt style={s.caption}>{visit.legacy ? 'Ранее отмеченный визит' : 'Визит завершён командой'}</Txt></View></View>)}{!visits.length && <Txt style={s.caption}>Первый визит появится после сохранения анкеты.</Txt>}</View>
    <Callout icon="lock-closed-outline">Предпочтения, впечатление сотрудника и заметки доступны только команде «{venue.name}». Гость и другие заведения их не видят.</Callout>
  </>;
}

export function StaffVisitForm({ venue, guestId, onDone, onBack }: { venue: Venue; guestId: string; onDone: () => void; onBack: () => void }) {
  const { db } = useStore();
  const [preferences, setPreferences] = useState<string[]>([]);
  const [experience, setExperience] = useState<StaffExperience | null>(null);
  const [comment, setComment] = useState('');
  const [attempt, setAttempt] = useState<RecordFeedbackVisitInput | null>(null);
  const [validation, setValidation] = useState('');
  const mutation = useMutation();
  const guest = db.guests.find(item => item.id === guestId);
  const save = () => {
    if (!experience) return;
    if (!attempt && /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(comment)) { setValidation('Уберите служебные символы из заметки и повторите сохранение.'); return; }
    setValidation('');
    const input = attempt ?? { type: 'recordFeedbackVisit' as const, venueId: venue.id, guestId, preferences, experience, comment: comment.trim(), previousVisitId: (db.feedbackVisits ?? []).filter(item => item.venueId === venue.id && item.guestId === guestId).at(-1)?.id ?? null };
    setAttempt(input); void mutation.run({ ...input }, onDone);
  };
  const locked = mutation.busy || attempt !== null;
  return <>
    <View style={{ gap: 7 }}><Txt weight="extra" style={{ fontSize: 22 }}>{guest?.name ?? 'Гость'}</Txt><Txt style={s.caption}>Короткая анкета после визита. Записывайте только то, что поможет команде встретить гостя внимательнее.</Txt></View>
    <View style={{ gap: 12 }}><Txt weight="bold">Что предпочитает гость?</Txt><Txt style={s.caption}>Отметьте то, что гость действительно попросил. Можно ничего не выбирать.</Txt><View style={[s.row, { flexWrap: 'wrap', gap: 8 }]}>{staffPreferenceOptions.map(label => { const selected = preferences.includes(label); return <Pressable key={label} accessibilityRole="checkbox" aria-checked={selected} accessibilityLabel={label} accessibilityState={{ checked: selected, disabled: locked }} disabled={locked} onPress={() => setPreferences(current => current.includes(label) ? current.filter(item => item !== label) : [...current, label])} style={{ flexDirection: 'row', gap: 6, alignItems: 'center', maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 12, borderRadius: 15, backgroundColor: selected ? C.pine : C.card, borderWidth: 1, borderColor: selected ? C.pine : C.line, opacity: locked ? .6 : 1 }}><Icon name={selected ? 'checkmark-circle' : 'ellipse-outline'} color={selected ? C.lime : C.muted} size={17} /><Txt weight="semibold" style={{ color: selected ? '#FFF' : C.ink, fontSize: 12, flexShrink: 1 }}>{label}</Txt></Pressable>; })}</View></View>
    <View style={{ gap: 10 }}><Txt weight="bold">Как прошло общение?</Txt>{staffExperienceOptions.map(option => <Pressable key={option.value} accessibilityRole="radio" aria-checked={experience === option.value} accessibilityLabel={option.label} accessibilityState={{ checked: experience === option.value, disabled: locked }} disabled={locked} onPress={() => setExperience(option.value)} style={[s.card, s.row, { gap: 10, padding: 14, borderColor: experience === option.value ? C.pine : C.line, backgroundColor: experience === option.value ? C.pale : C.card, opacity: locked ? .6 : 1 }]}><Icon name={experience === option.value ? 'radio-button-on' : 'radio-button-off'} color={C.pine} size={21} /><Txt weight="semibold" style={{ flex: 1, fontSize: 13 }}>{option.label}</Txt></Pressable>)}</View>
    <Field label="Заметка для команды · необязательно" placeholder="Пожелания к подаче, общению или следующему визиту" value={comment} onChangeText={setComment} multiline maxLength={feedbackLimits.commentLength} editable={!locked} />
    <Txt style={s.caption}>{comment.length}/{feedbackLimits.commentLength} · Видит только команда этого заведения.</Txt>
    <Callout>Сохранение отметит один завершённый визит. После этого гость сможет оставить отдельный отзыв заведению.</Callout>
    {validation || mutation.error ? <Txt accessibilityRole="alert" style={{ color: C.red, fontSize: 12, lineHeight: 21 }}>{validation || mutation.error}</Txt> : null}
    <Button label={attempt && !mutation.busy ? 'Проверить сохранение анкеты' : 'Сохранить визит и заметку'} icon="checkmark-outline" loading={mutation.busy} disabled={!experience} onPress={save} />
    {mutation.error && !mutation.busy && <Button label="Вернуться к карточке гостя" variant="ghost" onPress={onBack} />}
  </>;
}

export function GuestFeedbackCard({ feedback, onReply }: { feedback: GuestFeedback; onReply: () => void }) {
  const { db } = useStore();
  const guest = db.guests.find(item => item.id === feedback.guestId);
  return <View style={[s.card, { gap: 14 }]}><View style={[s.row, { gap: 10 }]}>{guest && <Avatar guest={guest} size={40} />}<View style={{ flex: 1, gap: 5 }}><Txt weight="bold">{guest?.name ?? 'Гость заведения'}</Txt><Txt style={s.caption}>{shortDate(feedback.createdAt)} · После визита</Txt></View></View>
    {feedbackQuestions.map(question => { const answer = feedback.answers[question.id]; return <View key={question.id} style={[s.row, { gap: 8 }]}><Icon name={answer === 'liked' ? 'thumbs-up-outline' : answer === 'disliked' ? 'thumbs-down-outline' : 'remove-outline'} size={17} color={answer === 'disliked' ? C.orange : C.pine} /><Txt style={{ flex: 1, fontSize: 12, lineHeight: 20 }}>{question.label}: {answer === 'liked' ? 'понравилось' : answer === 'disliked' ? 'не понравилось' : 'не оценено'}</Txt></View>; })}
    {feedback.comment && <Txt style={{ lineHeight: 23 }}>{feedback.comment}</Txt>}
    {feedback.response && <View style={{ backgroundColor: C.pale, padding: 13, borderRadius: 14, gap: 6 }}><Txt weight="bold" style={{ fontSize: 11 }}>Ответ команды</Txt><Txt style={{ fontSize: 13, lineHeight: 21 }}>{feedback.response}</Txt></View>}
    <Button label={feedback.response ? 'Изменить ответ гостю' : 'Ответить гостю'} icon="arrow-undo-outline" variant="ghost" onPress={onReply} />
  </View>;
}

export function StaffReplyForm({ venueId, feedbackId, onDone }: { venueId: string; feedbackId: string; onDone: () => void }) {
  const { db } = useStore();
  const feedback = (db.guestFeedback ?? []).find(item => item.id === feedbackId && item.venueId === venueId);
  const [response, setResponse] = useState(feedback?.response ?? ''); const mutation = useMutation();
  if (!feedback) return <Txt>Отзыв недоступен. Обновите данные.</Txt>;
  return <><Callout>Ответ увидит автор отзыва. Внутренние заметки о госте остаются у команды.</Callout>{feedback.comment && <View style={s.card}><Txt style={{ lineHeight: 23 }}>{feedback.comment}</Txt></View>}<Field label="Ответ гостю" value={response} onChangeText={setResponse} multiline maxLength={feedbackLimits.responseLength} editable={!mutation.busy} />{mutation.error ? <Txt accessibilityRole="alert" style={{ color: C.red, lineHeight: 21 }}>{mutation.error}</Txt> : null}<Button label="Сохранить ответ гостю" loading={mutation.busy} disabled={!response.trim()} onPress={() => void mutation.run({ type: 'replyGuestFeedback', venueId, feedbackId, response: response.trim() }, onDone)} /></>;
}
