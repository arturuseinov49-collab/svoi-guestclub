import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { fullDate, uid, Venue } from './domain';
import { feedbackAnswerOptions, feedbackLimits, feedbackQuestions, FeedbackAnswer, FeedbackVisit, GuestFeedbackAnswers } from './feedback';
import { useStore } from './store';
import { effectiveGuestProfile } from './venue-profile';
import { C, Icon, Sheet, Txt, fx } from './ui';
import { EP } from './elpastor-club';

function palette(club: boolean) { return club ? { bg: EP.surface, text: EP.cream, muted: EP.muted, line: EP.border, accent: EP.gold, selected: '#5D2B32' } : { bg: C.card, text: C.ink, muted: C.muted, line: C.line, accent: C.pine, selected: C.pale }; }

export function GuestFeedbackPrompt({ count, club = false, onPress }: { count: number; club?: boolean; onPress: () => void }) {
  const p = palette(club);
  return <Pressable {...fx(club ? 'club-panel' : '')} accessibilityRole="button" accessibilityLabel="Оценить визит" onPress={onPress} style={{ padding: 19, borderWidth: 1, borderColor: p.line, borderRadius: 22, backgroundColor: p.bg, gap: 13 }}>
    <View style={{ flexDirection: 'row', gap: 11, alignItems: 'center' }}><Icon name="chatbubble-ellipses-outline" color={p.accent} /><Txt weight="bold" style={{ flex: 1, color: p.accent, fontSize: 10, letterSpacing: 1 }}>ВАШЕ МНЕНИЕ ИМЕЕТ ЗНАЧЕНИЕ</Txt></View>
    <Txt weight="extra" style={{ color: p.text, fontSize: 23, lineHeight: 29 }}>Как всё прошло?</Txt>
    <Txt style={{ color: p.muted, fontSize: 12, lineHeight: 20 }}>Пять коротких вопросов и всё, что хочется добавить от себя. {count > 1 ? `Ждут оценки: ${count}.` : 'Команда увидит вашу обратную связь.'}</Txt>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Txt weight="bold" style={{ color: p.accent, flex: 1, fontSize: 13 }}>Оценить визит</Txt><Icon name="arrow-forward" size={18} color={p.accent} /></View>
  </Pressable>;
}

export function GuestFeedbackHistory({ venue, mode, club, onReview }: { venue: Venue; mode: 'visits' | 'reviews'; club: boolean; onReview: (visit: FeedbackVisit) => void }) {
  const { db, guestId } = useStore();
  const p = palette(club);
  const visits = (db.feedbackVisits ?? []).filter(v => v.venueId === venue.id && v.guestId === guestId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reviews = (db.guestFeedback ?? []).filter(r => r.venueId === venue.id && r.guestId === guestId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const legacy = db.reviews.filter(r => r.venueId === venue.id && r.guestId === guestId);
  const archivedVisits = db.visits.filter(v => v.venueId === venue.id && v.guestId === guestId);
  const pending = visits.filter(v => !reviews.some(r => r.visitId === v.id));
  const enabled = effectiveGuestProfile(venue).feedbackEnabled;
  const ready = Array.isArray(db.feedbackVisits) && Array.isArray(db.guestFeedback);
  const card = { padding: 18, gap: 12, borderRadius: 22, backgroundColor: p.bg, borderWidth: 1, borderColor: p.line };
  return <View style={{ padding: 22, gap: 20 }}>
    <View style={{ gap: 8 }}><Txt weight="bold" style={{ color: p.accent, fontSize: 9, letterSpacing: 1.4 }}>{mode === 'visits' ? 'ВАШИ ВСТРЕЧИ' : 'ОБРАТНАЯ СВЯЗЬ'}</Txt><Txt weight="extra" style={{ color: p.text, fontSize: 30, lineHeight: 36 }}>{mode === 'visits' ? 'Мои визиты' : 'Мои отзывы'}</Txt><Txt style={{ color: p.muted, fontSize: 12, lineHeight: 20 }}>{mode === 'visits' ? 'После подтверждения визита сотрудником здесь появляется короткая анкета.' : 'Ваши ответы видны вам и команде этого заведения. Ответ команды появится здесь.'}</Txt></View>
    {ready && !enabled && <View style={card}><Txt style={{ color: p.text, lineHeight: 22 }}>Новые анкеты в этом заведении пока выключены. Сохранённые отзывы остаются в вашей истории.</Txt></View>}
    {!ready && <View style={card}><Txt style={{ color: p.text, lineHeight: 22 }}>Анкеты пока недоступны. Обновите приложение чуть позже.</Txt></View>}
    {ready && !visits.length && !reviews.length && <View style={card}><Icon name="chatbubbles-outline" size={30} color={p.accent} /><Txt weight="bold" style={{ color: p.text, fontSize: 18 }}>{legacy.length || archivedVisits.length ? 'Новые анкеты появятся здесь' : 'Начнём с первого визита'}</Txt><Txt style={{ color: p.muted, lineHeight: 22 }}>Покажите сотруднику свой QR. Когда он завершит визит, вы сможете рассказать, что понравилось и что стоит улучшить.</Txt></View>}
    {mode === 'reviews' && enabled && pending.length > 0 && <GuestFeedbackPrompt club={club} count={pending.length} onPress={() => onReview(pending[0])} />}
    {mode === 'visits' && visits.map(visit => {
      const complete = reviews.some(r => r.visitId === visit.id);
      return <View key={visit.id} style={card}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon name={complete ? 'checkmark-circle-outline' : 'chatbubble-outline'} color={p.accent} /><Txt weight="bold" style={{ color: p.text, flex: 1 }}>{fullDate(visit.createdAt)}</Txt></View><Txt style={{ color: p.muted, fontSize: 12, lineHeight: 20 }}>{complete ? 'Спасибо! Ваша анкета сохранена в разделе отзывов.' : enabled ? 'Визит подтверждён. Расскажите о впечатлениях.' : 'Визит подтверждён. Приём новых анкет пока выключен.'}</Txt>{!complete && enabled && <Pressable accessibilityRole="button" accessibilityLabel={`Оценить визит ${fullDate(visit.createdAt)}`} onPress={() => onReview(visit)} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 15, borderRadius: 15, backgroundColor: p.selected }}><Txt weight="bold" style={{ color: p.accent }}>Оценить визит →</Txt></Pressable>}</View>;
    })}
    {mode === 'reviews' && reviews.map(review => <View key={review.id} style={card}><View style={{ flexDirection: 'row', gap: 9, alignItems: 'center' }}><Icon name="checkmark-circle-outline" color={p.accent} /><Txt weight="bold" style={{ color: p.text, flex: 1 }}>{fullDate(visits.find(v => v.id === review.visitId)?.createdAt ?? review.createdAt)}</Txt></View>{feedbackQuestions.map(question => <View key={question.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}><Txt style={{ flex: 1, color: p.muted, fontSize: 11, lineHeight: 18 }}>{question.label}</Txt><Txt weight="semibold" style={{ flex: 1, textAlign: 'right', color: p.text, fontSize: 11, lineHeight: 18 }}>{feedbackAnswerOptions.find(a => a.value === review.answers[question.id])?.label ?? 'Не указано'}</Txt></View>)}{!!review.comment && <Txt style={{ color: p.text, lineHeight: 23 }}>{review.comment}</Txt>}{!!review.response && <View style={{ gap: 6, paddingTop: 13, borderTopWidth: 1, borderColor: p.line }}><Txt weight="bold" style={{ color: p.accent, fontSize: 11 }}>Ответ команды</Txt><Txt style={{ color: p.text, lineHeight: 22 }}>{review.response}</Txt></View>}</View>)}
    {mode === 'reviews' && ready && visits.length > 0 && !reviews.length && <Txt style={{ color: p.muted, fontSize: 12, lineHeight: 21 }}>Вы пока не отправляли анкеты. Можно начать с любого подтверждённого визита.</Txt>}
    {mode === 'reviews' && legacy.length > 0 && <View style={{ gap: 12 }}><Txt weight="bold" style={{ color: p.text, fontSize: 17 }}>Ранее оставленные отзывы</Txt>{legacy.map(review => <View key={review.id} style={card}><Txt style={{ color: p.muted, fontSize: 11 }}>{fullDate(review.createdAt)} · {review.rating} из 5</Txt><Txt style={{ color: p.text, lineHeight: 22 }}>{review.text}</Txt>{review.response && <View style={{ gap: 6 }}><Txt weight="bold" style={{ color: p.accent, fontSize: 11 }}>Ответ команды</Txt><Txt style={{ color: p.text, lineHeight: 22 }}>{review.response}</Txt></View>}</View>)}</View>}
    {mode === 'visits' && archivedVisits.length > 0 && <View style={{ gap: 12 }}><Txt weight="bold" style={{ color: p.text, fontSize: 17 }}>Ранее отмеченные визиты</Txt>{archivedVisits.map(visit => <View key={visit.id} style={card}><Txt style={{ color: p.text }}>{fullDate(visit.createdAt)}</Txt><Txt style={{ color: p.muted, fontSize: 11 }}>Сохранено из прежней версии</Txt></View>)}</View>}
  </View>;
}

function FeedbackFormButton({ label, onPress, disabled = false, secondary = false, busy, club }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; busy: boolean; club: boolean }) {
  const p = palette(club);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress} style={{ minHeight: 54, padding: 15, borderRadius: 17, backgroundColor: secondary ? p.bg : club ? EP.gold : C.pine, borderWidth: 1, borderColor: p.line, justifyContent: 'center', alignItems: 'center', opacity: disabled || busy ? .5 : 1 }}>{busy && !secondary ? <ActivityIndicator color={club ? EP.bg : '#fff'} /> : <Txt weight="bold" style={{ color: secondary ? p.text : club ? EP.bg : '#fff', textAlign: 'center' }}>{label}</Txt>}</Pressable>;
}

export function GuestFeedbackSheet({ venue, visit, club, onClose, onSaved }: { venue: Venue; visit: FeedbackVisit; club: boolean; onClose: () => void; onSaved: () => void }) {
  const { command, db, guestId } = useStore();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<GuestFeedbackAnswers>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ fingerprint: string; key: string } | null>(null);
  const submitting = useRef(false);
  const p = palette(club);
  const question = feedbackQuestions[step];
  const existing = (db.guestFeedback ?? []).some(r => r.visitId === visit.id && r.guestId === guestId);
  const complete = feedbackQuestions.every(q => answers[q.id]);

  const save = async () => {
    if (submitting.current || !complete || existing) return;
    submitting.current = true; setBusy(true); setError('');
    const input = { type: 'submitGuestFeedback', venueId: venue.id, visitId: visit.id, answers: answers as GuestFeedbackAnswers, comment: comment.trim() };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: uid() };
    try { await command(input, request.current.key); onSaved(); }
    catch (cause) {
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
      setUncertain(!status || status >= 500);
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить отзыв. Ваши ответы остались здесь — попробуйте ещё раз.');
    }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Sheet visible theme={club ? 'elpastor' : 'default'} title="Как прошёл визит?" subtitle={`${venue.name} · ${fullDate(visit.createdAt)}`} onClose={() => { if (!busy) onClose(); }}>
    {existing ? <><Txt style={{ color: p.text, lineHeight: 22 }}>Отзыв об этом визите уже сохранён. Он доступен в разделе «Мои отзывы».</Txt><FeedbackFormButton label="К моим отзывам" onPress={onSaved} busy={busy} club={club} /></> : <>
      <View style={{ gap: 9 }}><View style={{ flexDirection: 'row', gap: 5 }}>{[...feedbackQuestions, { id: 'comment' }].map((item, index) => <View key={item.id} style={{ flex: 1, height: 4, borderRadius: 3, backgroundColor: index <= step ? p.accent : p.line }} />)}</View><Txt style={{ color: p.muted, fontSize: 11 }}>{step < 5 ? `Вопрос ${step + 1} из 5` : 'Последний штрих'} · около минуты</Txt></View>
      {question ? <View style={{ gap: 13 }}><Txt weight="extra" style={{ color: p.text, fontSize: 25, lineHeight: 32 }}>{question.label}</Txt><Txt style={{ color: p.muted, fontSize: 12, lineHeight: 19 }}>Отметьте ваше впечатление.</Txt>{feedbackAnswerOptions.map(option => {
        const selected = answers[question.id] === option.value;
        return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={`${question.label}: ${option.label}`} aria-checked={selected} accessibilityState={{ checked: selected, disabled: busy }} disabled={busy} onPress={() => setAnswers(previous => ({ ...previous, [question.id]: option.value as FeedbackAnswer }))} style={{ minHeight: 59, padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center', borderRadius: 18, borderWidth: selected ? 2 : 1, borderColor: selected ? p.accent : p.line, backgroundColor: selected ? p.selected : p.bg }}><Icon name={option.value === 'liked' ? 'happy-outline' : option.value === 'disliked' ? 'sad-outline' : 'remove-circle-outline'} color={p.accent} size={23} /><Txt weight={selected ? 'bold' : 'medium'} style={{ color: p.text, flex: 1, fontSize: 13, lineHeight: 20 }}>{option.label}</Txt>{selected && <Icon name="checkmark" color={p.accent} size={18} />}</Pressable>;
      })}</View> : <View style={{ gap: 15 }}><Txt weight="extra" style={{ color: p.text, fontSize: 24 }}>Что хочется добавить?</Txt><Txt style={{ color: p.muted, fontSize: 12, lineHeight: 20 }}>Поблагодарите команду или расскажите, что можно улучшить. Комментарий можно пропустить.</Txt><TextInput accessibilityLabel="Комментарий к визиту" placeholder="Ваши впечатления, пожелания, детали…" placeholderTextColor={p.muted} multiline maxLength={feedbackLimits.commentLength} editable={!busy && !uncertain} value={comment} onChangeText={setComment} style={{ width: '100%', minWidth: 0, minHeight: 135, padding: 15, borderRadius: 17, borderWidth: 1, borderColor: p.line, backgroundColor: p.bg, color: p.text, fontFamily: 'Manrope_400Regular', fontSize: 15, lineHeight: 23, textAlignVertical: 'top' }} /><Txt style={{ color: p.muted, fontSize: 10, textAlign: 'right' }}>{comment.length} / {feedbackLimits.commentLength}</Txt><View style={{ gap: 10 }}>{feedbackQuestions.map((item, index) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Изменить ответ: ${item.label}`} onPress={() => setStep(index)} disabled={busy || uncertain} style={{ flexDirection: 'row', gap: 10, minHeight: 44, alignItems: 'center' }}><Txt style={{ color: p.muted, flex: 1, fontSize: 11, lineHeight: 17 }}>{item.label}</Txt><Txt style={{ color: p.text, flex: 1, textAlign: 'right', fontSize: 11, lineHeight: 17 }}>{feedbackAnswerOptions.find(a => a.value === answers[item.id])?.label}</Txt><Icon name="create-outline" size={15} color={p.accent} /></Pressable>)}</View></View>}
      {!!error && <Txt accessibilityRole="alert" style={{ color: club ? '#FFB7AE' : C.red, fontSize: 12, lineHeight: 20 }}>{error}</Txt>}
      {uncertain && <Txt style={{ color: p.muted, fontSize: 12, lineHeight: 20 }}>Ответ сервера не получен. Повторная отправка проверит сохранение тех же ответов и не создаст второй отзыв.</Txt>}
      <View style={{ gap: 10 }}>{question ? <FeedbackFormButton label={step === 4 ? 'К комментарию' : 'Далее'} onPress={() => setStep(step + 1)} disabled={!answers[question.id]} busy={busy} club={club} /> : <FeedbackFormButton label="Отправить отзыв" onPress={() => void save()} disabled={!complete} busy={busy} club={club} />}{step > 0 && <FeedbackFormButton label="Назад" onPress={() => setStep(step - 1)} secondary disabled={uncertain} busy={busy} club={club} />}</View>
      <View style={{ flexDirection: 'row', gap: 8 }}><Icon name="lock-closed-outline" color={p.muted} size={15} /><Txt style={{ flex: 1, color: p.muted, fontSize: 10, lineHeight: 17 }}>Ответы и комментарий увидите только вы и команда этого заведения.</Txt></View>
    </>}
  </Sheet>;
}
