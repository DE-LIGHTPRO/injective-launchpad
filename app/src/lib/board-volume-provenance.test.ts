/**
 * The board's 24h volume must not read zero for a launch it could not read.
 *
 * MEASURED ON THE LIVE TESTNET BOARD, 16 Oct 2026. Both E2EUSD launches rendered
 *
 *     Vol 24h  0.00 E2EUSD      Trades  trades unavailable
 *
 * in adjacent columns of one row. The LCD was answering the trade search with HTTP
 * 500 - `height N is not available, lowest height is M`, ordinary pruning on this
 * chain - and `enrichLaunch` caught that into `[]`, which is exactly what a launch
 * that has genuinely never traded returns. The lifetime count kept its `null` and
 * said so; the volume beside it asserted a number nobody had measured.
 *
 * EVERY PIECE WAS LOCALLY CORRECT, which is why no unit test saw it. `volumeWithin`
 * returns null rather than zero for an unknown height and its own comment says that
 * zero and unmeasured must not look alike. `LaunchList` renders a null volume as a
 * dim placeholder. `loadTradeView`, the launch page's reader of the same endpoint
 * through the same module, returns `kind: 'error'` and says in its docblock that an
 * unreachable node "is not evidence about whether it traded". The one line between
 * them threw the distinction away before any of that ran.
 *
 * SO THIS TEST IS BEHAVIOURAL, NOT A SOURCE READ. It drives `enrichLaunch` against a
 * stubbed LCD and asserts the two outcomes differ, because the defect was a caller
 * agreeing with every helper's signature while contradicting its purpose.
 *
 * The second test is the anti-vacuity half and is the one that would have failed on
 * the original code too - without it, a mutation making EVERYTHING null would pass.
 * A launch that really has no trades must still report 0, not unknown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichLaunch } from './launchActivity.ts';

const CURVE = 'inj1sfsycn5pak9t7ap0h97c25vumz6w0ewag2xc4x';
const HEIGHT = 144_034_181;

/** Stand in for the LCD for one call, then put the real `fetch` back. */
async function withLcd<T>(reply: () => Response, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(reply())) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('a pruned node leaves the 24h volume unknown, never zero', async () => {
  /*
   * The real body this chain returns. A 500 whose message is about retention rather
   * than an outage is the single most likely failure on the board, because trade
   * history ages out of a public node long before a launch stops being interesting.
   */
  const e = await withLcd(
    () =>
      json(
        { code: 13, message: `height ${HEIGHT - 400_000} is not available, lowest height is ${HEIGHT - 100_000}` },
        500,
      ),
    () => enrichLaunch(CURVE, HEIGHT),
  );

  assert.equal(
    e.volume24h,
    null,
    'a trade read that failed was turned into an empty page, so the board printed 0.00 volume for a launch it never measured',
  );
  assert.equal(e.activity, null, 'the lifetime count must also stay unknown');
  assert.equal(e.volumePartial, false, '"at least" qualifies a figure, and there is no figure');
});

test('a launch that genuinely has no trades reports zero volume, not unknown', async () => {
  /*
   * ANTI-VACUITY. Zero is a real and extremely common answer on a new board, so the
   * fix is only correct if it narrows to the failure. A guard that accepted null here
   * would pass with every volume on the board replaced by a placeholder.
   */
  const e = await withLcd(
    () => json({ txs: [], tx_responses: [], total: '0', pagination: { total: '0' } }),
    () => enrichLaunch(CURVE, HEIGHT),
  );

  assert.equal(e.volume24h, 0n, 'an empty but successful trade search is a measured zero');
  assert.equal(e.trades24h, 0);
  assert.deepEqual(e.series, []);
});

test('an unknown height leaves the volume unknown even with trades in hand', async () => {
  /*
   * The pre-existing guarantee, pinned here because the fix added a second path to
   * the same field. `null` must survive both reasons, and a later simplification that
   * collapsed them into one would otherwise only be caught in production.
   */
  const e = await withLcd(
    () => json({ txs: [], tx_responses: [], total: '0' }),
    () => enrichLaunch(CURVE, null),
  );

  assert.equal(e.volume24h, null, 'without a current block there is no 24h window to sum over');
});
