/** Feedback-only product contract. Preferences and staff feedback are venue-private. */
export const feedbackQuestions = [
  { id: 'food', label: 'Еда' },
  { id: 'service', label: 'Обслуживание' },
  { id: 'atmosphere', label: 'Атмосфера' },
  { id: 'cleanliness', label: 'Чистота' },
  { id: 'value', label: 'Соотношение цены и качества' },
] as const;
export type FeedbackQuestion = typeof feedbackQuestions[number]['id'];
export type FeedbackAnswer = 'liked' | 'disliked' | 'not_used';
export type GuestFeedbackAnswers = Record<FeedbackQuestion, FeedbackAnswer>;
export const feedbackAnswerOptions: { value: FeedbackAnswer; label: string }[] = [
  { value: 'liked', label: 'Понравилось' },
  { value: 'disliked', label: 'Не понравилось' },
  { value: 'not_used', label: 'Не могу оценить' },
];
export type StaffExperience = 'pleasant' | 'neutral' | 'needs_attention';
export const staffExperienceOptions: { value: StaffExperience; label: string }[] = [
  { value: 'pleasant', label: 'Приятное общение' },
  { value: 'neutral', label: 'Всё спокойно' },
  { value: 'needs_attention', label: 'Потребовалось внимание' },
];
/** Only these neutral meal/service choices are accepted by the server. */
export const staffPreferenceOptions = ['Неострые блюда', 'Острые блюда', 'Без лука', 'Овощные блюда', 'Кофе без сахара', 'Тихое место', 'Быстрое обслуживание', 'Не торопить'] as const;
export const feedbackLimits = { preferences: 8, preferenceLength: 60, commentLength: 1000, responseLength: 1000 } as const;
export interface FeedbackVisit { id: string; venueId: string; guestId: string; createdAt: string; staffUserId?: number }
export interface StaffFeedback {
  id: string; visitId: string; venueId: string; guestId: string; staffUserId: number;
  preferences: string[]; experience: StaffExperience; comment: string; createdAt: string;
}
export interface GuestFeedback {
  id: string; visitId: string; venueId: string; guestId: string; answers: GuestFeedbackAnswers;
  comment: string; createdAt: string; response: string | null; respondedAt: string | null;
}
export interface RecordFeedbackVisitInput { type: 'recordFeedbackVisit'; venueId: string; guestId: string; preferences: string[]; experience: StaffExperience; comment: string; previousVisitId?: string | null }
export interface SubmitGuestFeedbackInput { type: 'submitGuestFeedback'; venueId: string; visitId: string; answers: GuestFeedbackAnswers; comment: string }
export interface ReplyGuestFeedbackInput { type: 'replyGuestFeedback'; venueId: string; feedbackId: string; response: string }
