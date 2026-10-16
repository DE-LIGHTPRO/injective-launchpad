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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { enrichLaunch } from './launchActivity.ts';
import { anyActivityUnread, type ActivityIndex, type LaunchRow } from './launchList.ts';
import { maskComments } from './testing/maskComments.ts';

const CURVE = 'inj1sfsycn5pak9t7ap0h97c25vumz6w0ewag2xc4x';
const HEIGHT = 144_034_181;

/**
 * Stand in for the LCD for one call, then put the real `fetch` back.
 *
 * The reply sees the URL, because the shape that caused the defect below answers the
 * two requests DIFFERENTLY: the count-only searches carry an action filter that matches
 * nothing and answer 200, while the unfiltered trade page has to reach the launch block
 * and answers 500. A stub that returns one body for every request cannot express it.
 */
async function withLcd<T>(reply: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(reply(String(typeof input === 'object' && 'url' in input ? input.url : input)))) as typeof fetch;
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

test('an unknown height leaves a traded launch\u2019s volume unknown', async () => {
  /*
   * The pre-existing guarantee, pinned here because the fix added a second path to
   * the same field. `null` must survive both reasons, and a later simplification that
   * collapsed them into one would otherwise only be caught in production.
   *
   * THE COUNT IS NON-ZERO ON PURPOSE. This fixture used to answer `total: '0'` with an
   * empty page, under the name "even with trades in hand" - which it never had. That
   * made it a launch whose lifetime count PROVES the volume is zero, so once the
   * derivation below existed the test was asserting unknown for a figure that is known,
   * and the height it was written to pin had stopped being the deciding input. A guard
   * whose fixture does not match its own name tests whichever path happens to answer
   * first.
   */
  const e = await withLcd(
    () => json({ txs: [], tx_responses: [], total: '5', pagination: { total: '5' } }),
    () => enrichLaunch(CURVE, null),
  );

  assert.notEqual(e.activity, null, 'the fixture must be a launch that HAS traded, or it proves nothing');
  assert.equal(e.volume24h, null, 'without a current block there is no 24h window to sum over');
});

test('a pruned page beside a measured zero count reports zero, not a dot', async () => {
  /*
   * THE LIVE SHAPE, measured against `testnet.sentry.lcd.injective.network` on
   * 16 Oct 2026 at height 144064392, lowest retained height 143964505:
   *
   *     inj1k2m8aa…  buys  AND wasm.action='buy'  ->  200  total 0
   *     inj1k2m8aa…  page  (no action filter)     ->  500  height 143426568 is not
   *                                                        available
   *
   * One curve, two answers, because only the page has to fetch a block that is gone.
   * The board rendered `Trades 0` beside `Vol 24h ·` for that launch, and the note
   * under the table says a dot means the figure could not be read. It had been read.
   *
   * The inference is sound because the tx INDEX outlives block retention: the same
   * probe against `inj19y7…` answered `height 143412910 is not available` to a COUNT
   * query, meaning the index found a matching tx 550k blocks below retention. So a
   * count of zero is zero over the curve's whole life, not zero over the retained
   * window - which matters here, because that window is about 14 hours and the volume
   * column claims 24.
   *
   * This is also the common case on a real board: most launches never trade, and the
   * page read is the half that ages out.
   */
  const e = await withLcd(
    (url) =>
      /wasm.action/.test(decodeURIComponent(url))
        ? json({ txs: [], tx_responses: [], total: '0', pagination: { total: '0' } })
        : json(
            { code: 13, message: `height ${HEIGHT - 600_000} is not available, lowest height is ${HEIGHT - 100_000}` },
            500,
          ),
    () => enrichLaunch(CURVE, HEIGHT),
  );

  assert.deepEqual(e.activity, { buys: 0, sells: 0, trades: 0 }, 'the counts answered, so they must be reported');
  assert.equal(
    e.volume24h,
    0n,
    'a launch with a measured zero lifetime trades moved zero quote in every window, so the board must not call it unread',
  );
  assert.equal(e.volumePartial, false, 'there is nothing a derived zero could understate');
  /*
   * The disclosure half of this file already asserts that `{trades: 0, volume24h: 0n}`
   * leaves the board with nothing to explain, so the two measured figures together
   * silence the note. Not repeated here, and deliberately not reaching for `boardRow`,
   * which is declared further down the file.
   */
});

/*
 * ------------------------------------------------------------------------------------
 * AND THE SECOND HALF: the board must say why a dot is there.
 *
 * The three tests above establish that an unmeasured volume stays unmeasured, which is
 * the honest value. It is not yet an honest screen. Measured on the live testnet board
 * on 16 Oct 2026, every one of the four launches answered the trade search with
 *
 *     500  height 143397562 is not available, lowest height is 143949156
 *
 * so `Vol 24h` was a dot on every row, with no note anywhere on the page. Two of those
 * rows showed `Trades 0` beside it - true, and corroborated against the chain, where
 * `tokens_sold` and every fee counter on both curves read 0 - which makes the pairing
 * read as "nothing has traded and we are declining to say the volume was zero" rather
 * than "that launch's history is older than the node keeps".
 *
 * `/analytics` writes the standard this is held to on its own missing columns: stated
 * rather than omitted, so a quiet launchpad and a page that is guessing stay
 * distinguishable. The board was the straggler, the same way the creator page was.
 * ------------------------------------------------------------------------------------
 */

const SRC = join(import.meta.dirname, '..');
const LIST = join(SRC, 'components', 'LaunchList.tsx');

const boardRow = (curve: string): LaunchRow =>
  ({ curveAddress: curve } as LaunchRow);

test('a landed activity read that came back unknown is disclosed', () => {
  const rows = [boardRow('inj1a'), boardRow('inj1b')];

  const unreadVolume: ActivityIndex = {
    inj1a: { trades: 3, volume24h: 100n },
    // The live shape: the lifetime count answered, the trade page did not.
    inj1b: { trades: 0, volume24h: null },
  };
  assert.equal(
    anyActivityUnread(rows, unreadVolume),
    true,
    'a null volume on a row whose counts have landed is an unread figure and the board must say so',
  );

  const unreadCount: ActivityIndex = {
    inj1a: { trades: null, volume24h: 100n },
    inj1b: { trades: 1, volume24h: 1n },
  };
  assert.equal(
    anyActivityUnread(rows, unreadCount),
    true,
    'the trade count has the same two failure modes as the volume and the same dot',
  );
});

test('a board that measured everything says nothing, and nor does one still loading', () => {
  /*
   * ANTI-VACUITY, both directions, because the two cheap mutations here are opposite.
   * Returning true always puts a permanent "could not be read" under a board where
   * every figure is present; returning true for an absent entry puts it under every
   * first paint, before the requests have even settled. The second is the subtler one
   * and is why the helper exists rather than being three lines in the component.
   */
  const rows = [boardRow('inj1a'), boardRow('inj1b')];

  assert.equal(
    anyActivityUnread(rows, {
      inj1a: { trades: 0, volume24h: 0n },
      inj1b: { trades: 12, volume24h: 5n },
    }),
    false,
    'a measured zero is a figure; a board of them has nothing to explain',
  );

  assert.equal(
    anyActivityUnread(rows, {}),
    false,
    'activity that has not arrived yet is not activity that failed, and the board must not claim it is',
  );

  assert.equal(anyActivityUnread([], {}), false, 'an empty board has no figures to qualify');
});

test('the board renders that disclosure, and says a dot is not a zero', () => {
  /*
   * Rule-52 reachability: the helper above is only worth having if the board calls it
   * and prints something. Source-read because this is JSX, and narrow for that reason -
   * it asserts the call, the gate and the one clause that carries the meaning.
   */
  const list = maskComments(readFileSync(LIST, 'utf8'));

  assert.match(
    list,
    /anyActivityUnread\(/,
    'the board no longer asks whether any figure on it failed to read',
  );
  assert.match(
    list,
    /\{anyUnread && \(/,
    'the note is no longer gated on a figure actually being unread, so it either never ' +
      'shows or always does',
  );
  assert.match(
    list,
    /could not be\s+read, never that it is zero/,
    'the note no longer says what the dot means. "Volume unavailable" alone leaves the ' +
      'reader with the same two readings they had before',
  );
});
