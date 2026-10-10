/**
 * The ticker's merge, and the ways a partial feed lies quietly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksAgo } from './recentTrades.ts';

test('a height in the future has no age rather than a negative one', () => {
  /*
   * Reachable: the page renders at one height and the ticker's trades were read at
   * another, so a trade can be newer than the height the page is holding. A negative
   * would format as "-3s", and `Math.abs` would be worse, reporting a future trade as
   * a past one.
   */
  assert.equal(blocksAgo(1_000, 999), null);
  assert.equal(blocksAgo(1_000, null), null);
  assert.equal(blocksAgo(1_000, 1_000), '0s');
});

test('age reads in the largest unit that is still true', () => {
  // Injective targets sub-second blocks, so height is a usable clock over the minutes
  // a ticker covers.
  assert.equal(blocksAgo(1_000, 1_010), '8s');
  assert.equal(blocksAgo(1_000, 1_150), '2m');
  assert.equal(blocksAgo(1_000, 10_000), '2h');
});
