import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server/application.mjs';

test('bundled venue JPEG is served as an image with exact bytes; HEAD has no body', async t => {
  const asset = new URL('../assets/venues/elpastor.jpg', import.meta.url);
  const original = await readFile(asset);
  assert.equal(original.readUInt16BE(0), 0xffd8, 'fixture is a real JPEG');
  const app = createApplication({ dataPath: ':memory:', root: fileURLToPath(new URL('../assets/venues/', import.meta.url)), rateLimits: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}/elpastor.jpg`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/jpeg');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
