import { createHmac, timingSafeEqual } from 'node:crypto';
export function validateInitData(raw, botToken, now = Math.floor(Date.now() / 1000), maxAge = 3600) {
  if (typeof raw !== 'string' || raw.length > 16384 || !raw) throw new Error('Missing initData');
  if (!botToken) throw new Error('Bot token is not configured');
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate initData fields');
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid hash');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', key).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new Error('Invalid signature');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > now + 30 || now - authDate > maxAge) throw new Error('Expired initData');
  let user;
  try { user = JSON.parse(params.get('user') ?? 'null'); } catch { throw new Error('Invalid user'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string') throw new Error('Invalid user');
  return { id: user.id, firstName: user.first_name, lastName: typeof user.last_name === 'string' ? user.last_name : '', username: typeof user.username === 'string' ? user.username : null };
}
