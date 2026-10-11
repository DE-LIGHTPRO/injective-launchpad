import test from 'node:test';
import assert from 'node:assert/strict';

import { assessCurveCode, blocksTrading, pinnedCodeIds } from './codeCheck.ts';

test('pinned ids parse from a comma list and ignore junk', () => {
  assert.deepEqual(pinnedCodeIds(' 41, 57 ,abc,,'), ['41', '57']);
  assert.deepEqual(pinnedCodeIds(undefined), []);
});

test('a curve on pinned code with no admin is verified', () => {
  const s = assessCurveCode({ codeId: '57', admin: '' }, ['41', '57']);
  assert.deepEqual(s, { kind: 'verified', codeId: '57' });
  assert.equal(blocksTrading(s), false);
});

test('code the operator never pinned blocks trading', () => {
  const s = assessCurveCode({ codeId: '99', admin: '' }, ['57']);
  assert.equal(s.kind, 'unexpected-code');
  assert.equal(blocksTrading(s), true);
});

test('an admin blocks trading even on pinned code, because the code can be replaced', () => {
  const s = assessCurveCode({ codeId: '57', admin: 'inj1someone' }, ['57']);
  assert.equal(s.kind, 'has-admin');
  assert.equal(blocksTrading(s), true);
});

test('unread facts are unknown, never verified, and do not block on a flaky node', () => {
  const s = assessCurveCode(null, ['57']);
  assert.equal(s.kind, 'unknown');
  assert.equal(blocksTrading(s), false);
});

test('a mint key held by anyone but the curve blocks trading', () => {
  const curve = 'inj1curve';
  const held = assessCurveCode({ codeId: '57', admin: '', denomAdmin: 'inj1creator' }, ['57'], curve);
  assert.deepEqual(held, { kind: 'mint-key-held', holder: 'inj1creator' });
  assert.equal(blocksTrading(held), true);
  // Renounced to nobody would also be safe, but the factory always hands it to the
  // curve, so anything else is unexpected and refused.
  const ok = assessCurveCode({ codeId: '57', admin: '', denomAdmin: curve }, ['57'], curve);
  assert.equal(ok.kind, 'verified');
  // Unread is not evidence.
  const unread = assessCurveCode({ codeId: '57', admin: '', denomAdmin: null }, ['57'], curve);
  assert.equal(unread.kind, 'verified');
});

test('nothing pinned is reported as such rather than as verified', () => {
  assert.equal(assessCurveCode({ codeId: '57', admin: '' }, []).kind, 'unpinned');
});
