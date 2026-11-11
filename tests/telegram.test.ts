import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData } from '../server/telegram-auth.mjs';
const token = '12345:unit-test-token-not-a-real-secret';
const now = 2000000000;
function signed(extra: Record<string, string> = {}, authDate = now) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'unit-query', user: JSON.stringify({ id: 10001, first_name: 'Тест', username: 'demo' }), ...extra });
  const text = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', key).update(text).digest('hex')); return params.toString();
}
test('valid Telegram initData is verified server-side', () => { assert.equal(validateInitData(signed(), token, now).id, 10001); });
test('forged Telegram profile is rejected', () => { const p = new URLSearchParams(signed()); p.set('user', JSON.stringify({ id: 42, first_name: 'Fake' })); assert.throws(() => validateInitData(p.toString(), token, now), /signature/); });
test('expired or future Telegram initData is rejected', () => { assert.throws(() => validateInitData(signed({}, now - 3601), token, now), /Expired/); assert.throws(() => validateInitData(signed({}, now + 1000), token, now), /Expired/); });
test('duplicate fields, malformed hash and missing configuration are rejected', () => { assert.throws(() => validateInitData(signed() + '&auth_date=1', token, now), /Duplicate/); assert.throws(() => validateInitData('hash=oops', token, now)); assert.throws(() => validateInitData(signed(), '', now)); });
