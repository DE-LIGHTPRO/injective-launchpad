/**
 * The broadcast route's input is validated before anything is sent.
 *
 * The browser signs, then posts the signed bytes to `/api/broadcast` to be forwarded to
 * the chain (see txBroadcast.ts for why the broadcast cannot run in the browser). This
 * covers the validation the route runs first: a body that is not a complete signed
 * transaction must be rejected, not passed on to be broadcast. The route itself is a
 * thin wrapper that returns 400 when this returns null; it imports through the `@/`
 * alias the test runner does not resolve, so the logic lives here and is tested here.
 * The happy path needs a chain and is covered on testnet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignedTxParts } from './txBroadcast.ts';

test('a complete signed transaction parses', () => {
  const parts = parseSignedTxParts({ bodyBytes: 'AA==', authInfoBytes: 'BB==', signatures: ['CC=='] });
  assert.deepEqual(parts, { bodyBytes: 'AA==', authInfoBytes: 'BB==', signatures: ['CC=='] });
});

test('incomplete or malformed bodies are rejected', () => {
  for (const bad of [
    null,
    'a string',
    {},
    { bodyBytes: 'AA==' }, // missing authInfoBytes + signatures
    { bodyBytes: 'AA==', authInfoBytes: 'BB==' }, // missing signatures
    { bodyBytes: 'AA==', authInfoBytes: 'BB==', signatures: [] }, // empty
    { bodyBytes: 'AA==', authInfoBytes: 'BB==', signatures: [1] }, // non-string sig
    { bodyBytes: 1, authInfoBytes: 'BB==', signatures: ['CC=='] }, // non-string field
  ]) {
    assert.equal(parseSignedTxParts(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});
