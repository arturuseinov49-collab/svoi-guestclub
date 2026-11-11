import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { guestInput, guestQrDrawing } from '../src/qr-code';

test('guest QR drawing independently decodes to its exact opaque payload', async () => {
  for (const token of ['A'.repeat(43), 'z_-9'.repeat(10) + 'aBC', randomBytes(32).toString('base64url')]) {
    const value = `svoi:guest:v1:${token}`;
    const drawing = guestQrDrawing(value);
    assert.ok(drawing);
    // Rasterize the same SVG geometry used by GuestQr, then use an independent decoder.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.size * 6}" height="${drawing.size * 6}" viewBox="0 0 ${drawing.size} ${drawing.size}"><rect width="${drawing.size}" height="${drawing.size}" fill="white"/><path d="${drawing.path}" fill="black"/></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    assert.equal(decoded?.data, value);
    assert.ok(drawing.runs.every(run => run.x >= 4 && run.y >= 4 && run.x + run.width <= drawing.size - 4 && run.y < drawing.size - 4));
  }
});

test('scanner accepts only exact guest QR payloads or an explicit short-code fallback', () => {
  const qr = `svoi:guest:v1:${'A'.repeat(43)}`;
  assert.deepEqual(guestInput(`  ${qr}\n`), { type: 'scanGuest', qr });
  assert.deepEqual(guestInput('abcd-2345', true), { type: 'addGuest', guestCode: 'ABCD2345' });
  for (const value of ['ABCD2345', 'https://example.com/', 'telegram:123456', `svoi:guest:v1:${'A'.repeat(42)}`, `svoi:guest:v1:${'A'.repeat(44)}`, `${qr}?admin=true`]) {
    assert.throws(() => guestInput(value));
    assert.equal(guestQrDrawing(value), null);
  }
  assert.throws(() => guestInput('00000000', true));
});
