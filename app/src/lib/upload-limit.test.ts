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
