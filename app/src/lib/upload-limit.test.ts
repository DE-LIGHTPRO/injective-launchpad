import test from 'node:test';
import assert from 'node:assert/strict';

import { allowUpload, clientKey, resetUploadLimit, UPLOAD_LIMIT } from './uploadLimit.ts';

test('an address is refused after the window fills, and allowed again once it passes', () => {
  resetUploadLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < UPLOAD_LIMIT.maxPerWindow; i++) {
    assert.equal(allowUpload('1.2.3.4', t0 + i), true, `attempt ${i + 1} refused`);
  }
  assert.equal(allowUpload('1.2.3.4', t0 + 100), false, 'the limit did not engage');
  // Another client is unaffected.
  assert.equal(allowUpload('5.6.7.8', t0 + 100), true);
  // And the first recovers once its attempts age out.
  assert.equal(allowUpload('1.2.3.4', t0 + UPLOAD_LIMIT.windowMs + 50), true);
});

test('the client is the first forwarded hop, which Vercel sets itself rather than passing through', () => {
  const req = new Request('https://x.test', {
    headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' },
  });
  assert.equal(clientKey(req), '9.9.9.9');
  assert.equal(clientKey(new Request('https://x.test')), 'unknown');
});

import { allowUploadShared } from './uploadLimit.ts';

function fakeRedis(counts: number[] | 'down' | 'error') {
  let i = 0;
  const calls: unknown[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    if (counts === 'down') throw new Error('ECONNREFUSED');
    if (counts === 'error') return new Response('nope', { status: 500 });
    return new Response(JSON.stringify([{ result: 'OK' }, { result: counts[i++] }]));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('with Redis configured the shared count decides, and the window is set once', async () => {
  const r = fakeRedis([1, 10, 11]);
  const opts = { url: 'https://r.test/', token: 't', fetchImpl: r.impl };
  assert.equal(await allowUploadShared('a', opts), true);
  assert.equal(await allowUploadShared('a', opts), true);
  assert.equal(await allowUploadShared('a', opts), false, 'the 11th upload was allowed');
  assert.deepEqual((r.calls[0] as unknown[][])[0].slice(0, 5), ['SET', 'injpad:upload:a', '0', 'PX', '600000']);
  assert.equal((r.calls[0] as unknown[][])[0][5], 'NX');
});

test('a Redis outage falls back to the in-memory limit, not to unlimited', async () => {
  for (const mode of ['down', 'error'] as const) {
    resetUploadLimit();
    const r = fakeRedis(mode);
    const opts = { url: 'https://r.test', token: 't', fetchImpl: r.impl, now: 5_000_000 };
    for (let i = 0; i < UPLOAD_LIMIT.maxPerWindow; i++) {
      assert.equal(await allowUploadShared('b', opts), true);
    }
    assert.equal(await allowUploadShared('b', opts), false, `${mode}: no limit at all`);
  }
});
