import test from 'node:test';
import assert from 'node:assert/strict';
import { translateQueryError } from './chain.ts';

test('pruned history is not reported as a node outage', () => {
  /*
   * The public sentry node keeps a window of recent blocks and drops the rest, and
   * the refusal arrives as a 500 like any other. Saying "the node is having trouble,
   * try again shortly" is wrong in a way that costs somebody time, because waiting
   * does not widen a retention window.
   */
  const pruned = translateQueryError(
    500,
    '{"code":13,"message":"height 143082619 is not available, lowest height is 143165819"}',
  );
  assert.match(pruned.message, /older than the node/i);
  assert.ok(
    !/having trouble/i.test(pruned.message),
    'pruned history is being reported as an outage, which sends the reader to wait for nothing',
  );

  /*
   * AND IT MUST NOT CLAIM THE DATA IS GONE. It said "The history is gone, not late",
   * which is a claim about the chain drawn from one node's refusal. The LCD hostname
   * balances across nodes pruned to different depths - probed ten times on 16 Oct 2026,
   * eight answered ~100,000 blocks back and two ~30,600 - so a query one node refuses
   * another serves, and this guard holds the copy to what a single 500 actually proves.
   */
  assert.ok(
    !/\bgone\b|\bno longer exists?\b|\bpermanently\b/i.test(pruned.message),
    'one node refusing a height does not establish that the history is gone',
  );
});

test('a genuine node failure still says to retry', () => {
  // The distinction has to cut both ways, or the new branch swallows real outages.
  const down = translateQueryError(500, 'internal server error');
  assert.match(down.message, /try again/i);
});
