/**
 * Denom shortening, which is one decision about which end to cut.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shortDenom, symbolOf } from './chain.ts';

const DENOM = 'factory/inj1demo000000000000000000000000000000/NOCTIS';

test('the subdenom survives shortening, because it is the name', () => {
  /*
   * The whole point. A generic middle-ellipsis over the full string cuts out the
   * subdenom and leaves every row in a list reading
   * `factory/inj1de…00000x` with nothing to tell them apart, which is worse than not
   * shortening at all.
   */
  const out = shortDenom(DENOM);
  assert.ok(out.endsWith('/NOCTIS'), `subdenom was cut: ${out}`);
  assert.ok(out.startsWith('factory/'), `the prefix was cut: ${out}`);
  assert.ok(out.length < DENOM.length, 'nothing was shortened');
  assert.equal(symbolOf(out), symbolOf(DENOM), 'the symbol no longer reads the same');
});

test('a subdenom containing a slash is kept whole', () => {
  // The chain permits `/` inside a subdenom, so splitting and taking the last part
  // would silently drop everything before the final slash.
  const out = shortDenom('factory/inj1demo000000000000000000000000000000/a/b');
  assert.ok(out.endsWith('/a/b'), `a multi-part subdenom was truncated: ${out}`);
});

test('a denom that is not a factory denom is left recognisable', () => {
  // `inj` and `peggy0x…` are not factory denoms and have no creator to elide.
  assert.equal(shortDenom('inj'), 'inj');
  const peggy = shortDenom('peggy0xdAC17F958D2ee523a2206206994597C13D831ec7');
  assert.ok(peggy.startsWith('peggy0'), peggy);
});
