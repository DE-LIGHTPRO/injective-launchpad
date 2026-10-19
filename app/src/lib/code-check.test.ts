import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assessCurveCode, blocksTrading, pinnedCodeIds, pinnedCodeHashes } from './codeCheck.ts';

/** The live curve on testnet, so these are the real strings and not invented shapes. */
const CURVE_HASH = '3196401753e1cdcc520d7a370966804680f1fcbb03ef77dd8f9557c19053d9db';

test('pinned ids parse from a comma list and ignore junk', () => {
  assert.deepEqual(pinnedCodeIds(' 41, 57 ,abc,,'), ['41', '57']);
  assert.deepEqual(pinnedCodeIds(undefined), []);
});

test('pinned hashes lowercase, and anything not 64 hex is dropped rather than kept', () => {
  // The LCD answers in upper case and `shasum` in lower; a pin copied from either must
  // compare equal, or the operator pins a hash that can never match and blocks every
  // launch with a card that reads like a compromised chain.
  assert.deepEqual(pinnedCodeHashes(` ${CURVE_HASH.toUpperCase()} `), [CURVE_HASH]);
  assert.deepEqual(pinnedCodeHashes(undefined), []);
  // A truncated or non-hex pin is not a pin. Keeping it would be the "can never match"
  // failure above; dropping it leaves the id list, or `unpinned`, which says so.
  assert.deepEqual(pinnedCodeHashes('3196401753e1cdcc, zzz, 0x' + CURVE_HASH), []);
});

test('a curve on pinned code with no admin is verified', () => {
  const s = assessCurveCode({ codeId: '57', admin: '' }, { ids: ['41', '57'], hashes: [] });
  assert.deepEqual(s, { kind: 'verified', codeId: '57', pin: 'code-id' });
  assert.equal(blocksTrading(s), false);
});

test('code the operator never pinned blocks trading', () => {
  const s = assessCurveCode({ codeId: '99', admin: '' }, { ids: ['57'], hashes: [] });
  assert.equal(s.kind, 'unexpected-code');
  assert.equal(blocksTrading(s), true);
});

test('an admin blocks trading even on pinned code, because the code can be replaced', () => {
  const s = assessCurveCode({ codeId: '57', admin: 'inj1someone' }, { ids: ['57'], hashes: [] });
  assert.equal(s.kind, 'has-admin');
  assert.equal(blocksTrading(s), true);
});

test('unread facts are unknown, never verified, and do not block on a flaky node', () => {
  const s = assessCurveCode(null, { ids: ['57'], hashes: [] });
  assert.equal(s.kind, 'unknown');
  assert.equal(blocksTrading(s), false);
});

test('a mint key held by anyone but the curve blocks trading', () => {
  const curve = 'inj1curve';
  const held = assessCurveCode({ codeId: '57', admin: '', denomAdmin: 'inj1creator' }, { ids: ['57'], hashes: [] }, curve);
  assert.deepEqual(held, { kind: 'mint-key-held', holder: 'inj1creator' });
  assert.equal(blocksTrading(held), true);
  // Renounced to nobody would also be safe, but the factory always hands it to the
  // curve, so anything else is unexpected and refused.
  const ok = assessCurveCode({ codeId: '57', admin: '', denomAdmin: curve }, { ids: ['57'], hashes: [] }, curve);
  assert.equal(ok.kind, 'verified');
  // Unread is not evidence.
  const unread = assessCurveCode({ codeId: '57', admin: '', denomAdmin: null }, { ids: ['57'], hashes: [] }, curve);
  assert.equal(unread.kind, 'verified');
});

test('nothing pinned is reported as such rather than as verified', () => {
  assert.equal(assessCurveCode({ codeId: '57', admin: '' }, { ids: [], hashes: [] }).kind, 'unpinned');
});

/*
 * THE HASH PIN. F-01 in the 19 Oct 2026 audit asks for client-side verification of the
 * code HASH rather than the code id, and the reason is not that an id can be forged - it
 * cannot, code ids are append-only on CosmWasm - but that an id is unverifiable. "39974"
 * is a pointer only the operator who uploaded it can vouch for. The hash can be rebuilt
 * from this repository, and on 19 Oct 2026 it was:
 *
 *     curl .../cosmwasm/wasm/v1/code/39974 | data_hash   3196401753e1…53d9db
 *     shasum -a 256 target/…/release/curve.wasm          3196401753e1…53d9db
 *
 * which is where CURVE_HASH above comes from.
 */

test('a matching hash verifies, and says it was the hash that matched', () => {
  const s = assessCurveCode(
    { codeId: '39974', codeHash: CURVE_HASH, admin: '' },
    { ids: [], hashes: [CURVE_HASH] },
  );
  // `pin` is the whole point: the copy says "byte for byte" only on this value, and a
  // bare `kind: 'verified'` would let the id check inherit that sentence.
  assert.deepEqual(s, { kind: 'verified', codeId: '39974', pin: 'hash' });
  assert.equal(blocksTrading(s), false);
});

test('the chain answering in upper case still matches a lowercase pin', () => {
  const s = assessCurveCode(
    { codeId: '39974', codeHash: CURVE_HASH.toUpperCase(), admin: '' },
    { ids: [], hashes: [CURVE_HASH] },
  );
  assert.equal(s.kind, 'verified');
});

test('bytes that are not the published bytes block trading, under any code id', () => {
  const s = assessCurveCode(
    { codeId: '39974', codeHash: 'f'.repeat(64), admin: '' },
    // The id is pinned AND correct. Only the bytes differ, which is the case an id
    // check cannot see at all.
    { ids: ['39974'], hashes: [CURVE_HASH] },
  );
  assert.equal(s.kind, 'unexpected-hash');
  assert.equal(blocksTrading(s), true);
});

test('a pinned hash that matches wins over an id the operator did not pin', () => {
  /*
   * A re-upload of identical bytes gets a new code id. Blocking that would refuse the
   * launchpad's own published code because a number moved, so the hash is authoritative
   * where it is pinned and the id list is not consulted.
   */
  const s = assessCurveCode(
    { codeId: '40200', codeHash: CURVE_HASH, admin: '' },
    { ids: ['39974'], hashes: [CURVE_HASH] },
  );
  assert.deepEqual(s, { kind: 'verified', codeId: '40200', pin: 'hash' });
});

test('a pinned hash that could not be read is unknown, never verified and never a block', () => {
  /*
   * Both directions are defects and this is the only answer that is neither. Reporting
   * verified would claim a check that did not happen; reporting a mismatch would turn
   * somebody else's LCD outage into "this contract is not the published one" on every
   * launch at once.
   */
  for (const codeHash of [null, undefined, '']) {
    const s = assessCurveCode(
      { codeId: '39974', codeHash, admin: '' },
      { ids: ['39974'], hashes: [CURVE_HASH] },
    );
    assert.equal(s.kind, 'unknown', `codeHash ${String(codeHash)} must not resolve a verdict`);
    assert.equal(blocksTrading(s), false);
  }
});

test('the chain read actually carries the hash into the verdict', () => {
  /*
   * REGISTRATION IS NOT WIRING, and this is the shape that failure takes here:
   * `codeHashOf` would exist, pass its own tests, and never reach `assessCurveCode`.
   * Every launch under a hash pin would then resolve `unknown` - no badge, no claim, no
   * block - which is the silent half of the verdict and looks like a quiet LCD rather
   * than a check that was never run. Caught by mutation, not by a unit test: no unit
   * test can reach the network, so the wiring is asserted at the source.
   */
  const chain = readFileSync(join(import.meta.dirname, 'chain.ts'), 'utf8');
  assert.match(
    chain,
    /codeHash:\s*await codeHashOf\(codeId\)/,
    'contractFacts must read the code hash, or the hash pin can never be satisfied',
  );
  // And the read must stop short of the 400 KB wasm the same response carries.
  assert.match(
    chain,
    /reader\.cancel\(\)/,
    'codeHashOf must cancel the body: /code/{id} ships the whole module after the hash',
  );
});

test('the weaker pin does not borrow the stronger pin\u2019s wording', () => {
  /*
   * The whole point of `pin`. An id match means the id is one this build names; a hash
   * match means the running bytes are the released bytes. Rendering the second sentence
   * for the first is precisely what F-01 objects to, and it is a copy change away at
   * any time, so the two branches are pinned here rather than reviewed.
   */
  const copy = readFileSync(
    join(import.meta.dirname, '..', 'components', 'CodeCheck.tsx'),
    'utf8',
  );
  const idBranch = /:\s*`Runs code \$\{status\.codeId\}, the version this launchpad pins/;
  assert.match(copy, idBranch, 'the code-id branch must claim a pin, not a byte-level check');
  const hashBranch = /\?\s*`Runs this launchpad's published contract byte for byte/;
  assert.match(copy, hashBranch, 'the hash branch must say what it checked');
  // Exactly one claim of byte equality, on the branch that measured it.
  assert.equal(
    (copy.match(/byte for byte/g) ?? []).length,
    1,
    'only the hash branch may say "byte for byte"',
  );
});

test('the mint key and the upgrade key still outrank the hash', () => {
  // A hash match says the code is ours. It says nothing about who can replace it or who
  // can mint, so those two checks must stay above it.
  const admin = assessCurveCode(
    { codeId: '39974', codeHash: CURVE_HASH, admin: 'inj1someone' },
    { ids: [], hashes: [CURVE_HASH] },
  );
  assert.equal(admin.kind, 'has-admin');
  const minter = assessCurveCode(
    { codeId: '39974', codeHash: CURVE_HASH, admin: '', denomAdmin: 'inj1creator' },
    { ids: [], hashes: [CURVE_HASH] },
    'inj1curve',
  );
  assert.equal(minter.kind, 'mint-key-held');
});
