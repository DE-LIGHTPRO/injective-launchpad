import test from 'node:test';
import assert from 'node:assert/strict';
import { translateQueryError } from './chain.ts';

test('pruned history is not reported as a node outage', () => {
  /*
   * The public sentry node keeps a window of recent blocks and drops the rest, and
   * the refusal arrives as a 500 like any other. "Try again shortly" is wrong in a
   * way that costs somebody time: the data is gone, and retrying will not bring it
   * back. Measured on trades about 83,000 blocks old, roughly fifteen hours here.
   */
  const pruned = translateQueryError(
    500,
    '{"code":13,"message":"height 143082619 is not available, lowest height is 143165819"}',
  );
  assert.match(pruned.message, /older than the public node keeps|gone, not late/i);
  assert.ok(!/try again/i.test(pruned.message), 'it still tells the reader to retry');
});

test('a genuine node failure still says to retry', () => {
  // The distinction has to cut both ways, or the new branch swallows real outages.
  const down = translateQueryError(500, 'internal server error');
  assert.match(down.message, /try again/i);
});
