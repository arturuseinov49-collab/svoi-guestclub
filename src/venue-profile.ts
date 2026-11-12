export interface GuestVenueProfile {
  published: boolean;
  demo: boolean;
  theme: 'svoi' | 'elpastor';
  tagline: string;
  description: string;
  highlights: string[];
  terms: string;
  links: { menu?: string; booking?: string; telegram?: string; vk?: string; website?: string };
  features: { loyalty: boolean; visits: boolean; reviews: boolean };
  feedbackEnabled?: boolean;
}

export function defaultGuestProfile(): GuestVenueProfile {
  return { published: false, demo: false, theme: 'svoi', tagline: '', description: '', highlights: [], terms: '', links: {}, features: { loyalty: true, visits: true, reviews: true } };
}

// Older venues retain their existing rules, but are not published in the directory
// until the developer explicitly prepares and publishes their guest card.
export function effectiveGuestProfile(venue: { guestProfile?: GuestVenueProfile }): GuestVenueProfile {
  const p = venue.guestProfile;
  if (!p) return defaultGuestProfile();
  return {
    published: p.published === true, demo: p.demo === true, theme: p.theme === 'elpastor' ? 'elpastor' : 'svoi',
    tagline: p.tagline, description: p.description, highlights: [...p.highlights], terms: p.terms,
    links: Object.fromEntries(Object.entries(p.links).filter(([key]) => ['menu', 'booking', 'telegram', 'vk', 'website'].includes(key))),
    features: { loyalty: p.features.loyalty, visits: p.features.visits, reviews: p.features.reviews },
    feedbackEnabled: p.feedbackEnabled ?? p.published === true,
  };
}

function object(value: unknown, allowed: string[], required: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) throw new Error(`${label}: проверьте поля`);
  return record;
}
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new Error(`${label}: не более ${maximum} символов`);
  return value.trim();
}
function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}: выберите включено или выключено`);
  return value;
}
export function validateGuestProfile(input: unknown): GuestVenueProfile {
  const fields = ['published', 'demo', 'theme', 'tagline', 'description', 'highlights', 'terms', 'links', 'features'];
  const p = object(input, [...fields, 'feedbackEnabled'], fields, 'Карточка заведения');
  if (typeof p.theme !== 'string' || !['svoi', 'elpastor'].includes(p.theme)) throw new Error('Выберите оформление карточки');
  if (!Array.isArray(p.highlights) || p.highlights.length > 6) throw new Error('Особенности: не более 6 пунктов');
  const highlights = p.highlights.map(value => text(value, 60, 'Особенность'));
  if (highlights.some(value => !value)) throw new Error('Особенность не может быть пустой');
  const links = object(p.links, ['menu', 'booking', 'telegram', 'vk', 'website'], [], 'Ссылки');
  const cleanLinks: GuestVenueProfile['links'] = {};
  for (const [key, value] of Object.entries(links)) {
    const address = text(value, 600, 'Ссылка');
    if (!address) continue;
    let url: URL;
    try { url = new URL(address); } catch { throw new Error('Укажите полный HTTPS-адрес ссылки'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Для ссылок нужен HTTPS-адрес без логина и пароля');
    cleanLinks[key as keyof GuestVenueProfile['links']] = url.href;
  }
  const features = object(p.features, ['loyalty', 'visits', 'reviews'], ['loyalty', 'visits', 'reviews'], 'Доступные действия');
  return {
    published: flag(p.published, 'Публикация'), demo: flag(p.demo, 'Тестовая карточка'), theme: p.theme as GuestVenueProfile['theme'],
    tagline: text(p.tagline, 120, 'Короткое описание'), description: text(p.description, 1200, 'Описание'), highlights,
    terms: text(p.terms, 1500, 'Условия'), links: cleanLinks,
    features: { loyalty: flag(features.loyalty, 'Бонусы'), visits: flag(features.visits, 'Визиты'), reviews: flag(features.reviews, 'Отзывы') },
    ...(p.feedbackEnabled === undefined ? {} : { feedbackEnabled: flag(p.feedbackEnabled, 'Анкеты после визита') }),
  };
}
