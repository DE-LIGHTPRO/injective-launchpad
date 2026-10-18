/**
 * A BUY IS WORTH WHAT IT SPENT, AND EVERY READER OF THE FEED USED WHAT IT OFFERED.
 *
 * `exec_buy` takes the whole payment, quotes it against the curve, hands back what the
 * curve cannot absorb, and emits `inj_in` as the GROSS payment with `refund` as a
 * separate attribute. `tradeFromAttrs` never read that attribute, so `Trade.refund` did
 * not exist, so all four consumers of a trade's value computed
 * `kind === 'buy' ? injIn : injOut` and all four were wrong on the same trade:
 *
 *   priceSeries.fillPrice     the price each fill is plotted at
 *   priceSeries.buildSeries   the per-point quote the chart's volume bars read
 *   launchActivity.quoteOf    24h volume, under the docblock "Quote that moved in a
 *                             trade" over an expression that returns the quote offered
 *   recentTrades              the amount every ticker row shows
 *
 * Measured through the real code on the deployed shape, where a fresh curve absorbs
 * 2000.962001 quote before it graduates:
 *
 *      a buy the curve absorbs whole                       overstated 0.000%
 *      10% over capacity   2.751323e-6 vs 2.501203e-6        +10.000%
 *      2x  over capacity   5.002405e-6 vs 2.501203e-6       +100.000%
 *      50x over capacity   1.250601e-4 vs 2.501203e-6     +4,900.000%
 *                          volume counted 100048.100048 where 2000.962001 moved
 *
 * WHY THE WORST CASE IS THE ORDINARY ONE. A partial fill is not an edge: it is every
 * graduating buy, because graduation is defined as the buy that exhausts the curve. So
 * the inflated point is the FINAL point on every graduated launch's chart, and being a
 * multiple of its neighbours it also becomes the series high. The one candle a visitor
 * reads as "where this launch graduated" was the one most able to be wrong. 50x over is
 * reachable with the Max button on a large balance.
 *
 * WHY NOTHING CAUGHT IT. `Trade` had no `refund` field at all, so every fixture in the
 * suite described a buy that filled whole, where the two bases agree exactly. A field
 * the type does not carry cannot be got wrong by a test. That is the same structural
 * blindness recorded in `sell-fee-basis.test.ts` (a crate with one `fee_bps`) and
 * `early-fee-basis.test.ts` (vectors with no premium): the fixtures could not
 * discriminate, so the suite was green on a question it never asked.
 *
 * So this file is the fixture the suite did not have, and the fixture is DERIVED from
 * the real curve maths rather than invented - the refund below is the one the contract
 * would send, found by over-paying a fresh curve and reading what comes back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { quoteMoved, type Trade } from './chain.ts';
import { quoteBuy, type CurveConfig, type CurveState } from './curve.ts';
import { fixedCurveFor, DEFAULT_FEE_BPS } from './launchLimits.ts';
import { fillPrice, buildSeries } from './priceSeries.ts';
import { volumeWithin } from './launchActivity.ts';
import { recentTrades } from './recentTrades.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const CONTRACT = join(SRC, '..', '..', 'contracts', 'curve', 'src', 'contract.rs');

const ONE = 10n ** 18n;
const CURVE = 'inj1sfsycn5pak9t7ap0h97c25vumz6w0ewag2xc4x';

const CFG: CurveConfig = {
  ...fixedCurveFor(18),
  feeBps: BigInt(DEFAULT_FEE_BPS),
  feeSellBps: BigInt(DEFAULT_FEE_BPS),
};
const FRESH: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };

/**
 * The whole quote a fresh curve can absorb, read off a deliberate over-payment.
 *
 * Measured rather than restated from the config, so this file cannot disagree with the
 * curve maths the way a transcribed constant would.
 */
const CAPACITY = (() => {
  const huge = 10n ** 30n;
  return huge - quoteBuy(CFG, FRESH, huge).refund;
})();

/**
 * The graduating buy, exactly as the contract would emit it.
 *
 * 50x the curve's remaining capacity, which the Max button reaches on a large balance,
 * so ~98% of the payment comes straight back. Everything below is the real quote's own
 * figures: nothing here is chosen to make a number look bad.
 */
const PAID = CAPACITY * 50n;
const Q = quoteBuy(CFG, FRESH, PAID);
const SPENT = PAID - Q.refund;

const GRADUATING: Trade = {
  kind: 'buy',
  who: 'inj1buyer',
  injIn: PAID,
  injOut: null,
  refund: Q.refund,
  tokens: Q.tokensOut,
  fee: Q.fee,
  height: 1_000,
  time: 1_760_000_000,
  txHash: 'GRADUATED',
};

/** An ordinary buy the curve absorbs whole, where the two bases must agree. */
const WHOLE: Trade = (() => {
  const q = quoteBuy(CFG, FRESH, ONE);
  return {
    kind: 'buy',
    who: 'inj1someone',
    injIn: ONE,
    injOut: null,
    refund: q.refund,
    tokens: q.tokensOut,
    fee: q.fee,
    height: 998,
    time: 1_759_999_000,
    txHash: 'WHOLE',
  };
})();

test('the fixture discriminates: most of a graduating buy is handed back', () => {
  /*
   * ANTI-VACUITY, first, because every other assertion here is only worth as much as
   * this one. A fixture whose refund is zero, which is what every fixture in the suite
   * was before this field existed, cannot tell the two bases apart at all.
   */
  assert.ok(Q.graduates, 'the fixture no longer graduates, so it is not a partial fill');
  assert.ok(Q.refund > 0n, 'the fixture refunds nothing, so it cannot discriminate');
  assert.ok(
    (Q.refund * 100n) / PAID >= 90n,
    'the refund is under 90% of the payment, so the gap between the two bases is no longer decisive',
  );
  assert.equal(WHOLE.refund, 0n, 'the ordinary fixture must be a buy that filled whole');
});

test('the quote a buy moved is the payment less the refund', () => {
  assert.equal(quoteMoved(GRADUATING), SPENT, 'a buy is still valued at what it offered');
  assert.notEqual(quoteMoved(GRADUATING), PAID, 'the resolver still returns the gross payment');

  // And the absorbed amount is the curve's capacity, which is the arithmetic sanity
  // check on the whole fixture: a 50x over-payment moves exactly one curve's worth.
  assert.equal(SPENT, CAPACITY, 'the spend is not the capacity, so the fixture is not reachable');

  // A buy that filled whole is unchanged, which is the half that must not regress.
  assert.equal(quoteMoved(WHOLE), ONE);

  // A sell has no refund to subtract and must not acquire one.
  const sell: Trade = { ...WHOLE, kind: 'sell', injIn: null, injOut: 5n * ONE, refund: null };
  assert.equal(quoteMoved(sell), 5n * ONE);

  // Graduation is not a trade and carries no quote.
  assert.equal(quoteMoved({ ...WHOLE, kind: 'graduate' }), null);
});

test('a missing refund attribute prices the trade, it does not blank it', () => {
  /*
   * `null` means the event carried no `refund`, which this contract does not produce:
   * every handler that can refund emits it, a buy that filled whole emits 0, and a sell
   * has none. Treating the absent case as unpriceable would blank a chart over a
   * hypothetical, so it counts as zero - and that choice is pinned here because the
   * alternative is locally defensible and silently destructive.
   */
  assert.equal(quoteMoved({ ...WHOLE, refund: null }), ONE);

  /*
   * And the other direction, which the parser can hand over because an event log is
   * chain data and not a type: a refund larger than the payment is not something the
   * contract can emit, so it is not a trade either. Null, never a negative quote, which
   * would draw a point below the axis and subtract from a volume total.
   */
  assert.equal(quoteMoved({ ...WHOLE, refund: ONE * 2n }), null);
  assert.equal(quoteMoved({ ...WHOLE, refund: ONE }), null, 'a buy that moved nothing is not a fill');
});

test('the plotted fill price is what was paid per token, not what was offered', () => {
  const drawn = fillPrice(GRADUATING, 18);
  const truth = Number(SPENT) / 1e18 / (Number(Q.tokensOut) / 1e18);
  const asItShipped = Number(PAID) / 1e18 / (Number(Q.tokensOut) / 1e18);

  assert.ok(drawn !== null);
  assert.ok(Math.abs(drawn - truth) / truth < 1e-9, 'the fill price is no longer the quote that moved');

  /*
   * The magnitude, asserted rather than described, because "slightly wrong" and "a
   * multiple" are different defects and only the second makes the graduation candle the
   * series high. 50x over capacity is 49x too high.
   */
  assert.ok(
    asItShipped / truth > 40,
    `the old basis is only ${(asItShipped / truth).toFixed(1)}x out, so this fixture no longer measures the defect`,
  );
});

test('the graduation candle is no longer the highest fill on the chart', () => {
  /*
   * THE DEFECT AS A VISITOR MET IT. On a bonding curve every fill prices above the last,
   * so the graduating buy is legitimately the high - but by a step, not by a multiple.
   * The old basis put it 49x above its neighbour, and `series.high` is what the launch
   * page labels "Highest fill".
   */
  const s = buildSeries([WHOLE, GRADUATING], 18);
  assert.equal(s.points.length, 2, 'both fills must be priceable, or the high proves nothing');
  assert.equal(s.unpriceable, 0);

  const [first, last] = s.points;
  assert.equal(last.txHash, 'GRADUATED');
  assert.equal(s.high, last.price, 'the graduating buy is still the highest fill, as it should be');
  assert.ok(
    s.high / first.price < 10,
    `the high is ${(s.high / first.price).toFixed(1)}x the opening fill, which is the inflated basis, not the curve`,
  );

  /*
   * The per-point quote drives the volume bars and must be the same figure the price
   * was derived from. Two numbers for one fill is how a point's bar and its price end
   * up telling different stories.
   */
  assert.equal(last.quote, SPENT, 'the point\u2019s quote is not the quote that moved');
  assert.equal(first.quote, ONE);
});

test('24h volume counts what moved, not what was offered', () => {
  const vol = volumeWithin([WHOLE, GRADUATING], 1_000, 100);
  assert.equal(vol, ONE + SPENT, 'the volume total is still the gross payments');
  assert.notEqual(vol, ONE + PAID, 'the volume total is the gross payments');

  // The scale of it: the old total was ~50x the quote that actually moved.
  assert.ok(
    Number(ONE + PAID) / Number(ONE + SPENT) > 40,
    'the old basis no longer inflates the total, so this no longer measures it',
  );
});

test('the ticker reads the refund off the event log and shows what was spent', async () => {
  /*
   * BEHAVIOURAL, END TO END, because the root cause was a PARSER that dropped an
   * attribute the contract has always emitted. A fixture built in TypeScript cannot see
   * that: it would hand `tradeFromAttrs` a `Trade` that already had the field. So this
   * drives the real tx-search parse against the real event shape.
   */
  const attrs = [
    { key: '_contract_address', value: CURVE },
    { key: 'action', value: 'buy' },
    { key: 'buyer', value: 'inj1buyer' },
    { key: 'sender', value: 'inj1buyer' },
    { key: 'inj_in', value: PAID.toString() },
    { key: 'tokens_out', value: Q.tokensOut.toString() },
    { key: 'fee', value: Q.fee.toString() },
    { key: 'refund', value: Q.refund.toString() },
    { key: 'early_fee_premium', value: '0' },
    { key: 'graduated', value: 'true' },
  ];

  const real = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          tx_responses: [
            {
              txhash: 'GRADUATED',
              height: '1000',
              timestamp: '2026-10-11T21:15:30Z',
              code: 0,
              events: [{ type: 'wasm', attributes: attrs }],
            },
          ],
          pagination: { total: '1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )) as typeof fetch;

  try {
    const ticker = await recentTrades(
      [{ id: 1, curve: CURVE, denom: `factory/inj1x/TEST`, path: '/launch/1', quoteDecimals: 18, quoteLabel: 'INJ' }],
      5,
      8,
    );
    assert.equal(ticker.trades.length, 1, 'the graduating buy did not survive the parse');
    assert.equal(
      ticker.trades[0].quote,
      SPENT,
      'the ticker still crosses a graduating buy at the amount offered, up to 50x its real size',
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('the contract still emits the refund both consumers depend on', () => {
  /*
   * The cross-language half. `Trade.refund` is parsed from an attribute, so the
   * TypeScript side is only correct while the Rust side keeps emitting it - and
   * removing it is a one-line change over there that would silently restore the gross
   * basis everywhere here, since a missing attribute counts as zero.
   */
  const rs = maskComments(readFileSync(CONTRACT, 'utf8'));
  assert.match(
    rs,
    /\.add_attribute\("refund", total_refund\)/,
    'a curve buy no longer emits the refund it sent, so every reader is back on the gross payment',
  );
  assert.match(
    rs,
    /\.add_attribute\("refund", Uint128::zero\(\)\)/,
    'a pool buy no longer emits an explicit zero refund, so its events stop being self-describing',
  );
});

test('nothing outside the resolver prices a trade from its gross payment', () => {
  /*
   * Rule-52 reachability, inverted: the resolver is only worth having if nothing reads
   * the field it replaced. Four files priced or totalled a trade from `.injIn` when this
   * was written, each locally plausible, and a fifth consumer added later would reach
   * for the same obvious field. `chain.ts` is the one place allowed to, because that is
   * where the subtraction lives.
   */
  for (const rel of [
    ['lib', 'priceSeries.ts'],
    ['lib', 'launchActivity.ts'],
    ['lib', 'recentTrades.ts'],
    ['components', 'Trades.tsx'],
  ]) {
    const src = maskComments(readFileSync(join(SRC, ...rel), 'utf8'));
    assert.doesNotMatch(
      src,
      /\.injIn\b/,
      `${rel.join('/')} reads a trade\u2019s gross payment directly; it must go through quoteMoved`,
    );
    assert.match(
      src,
      /quoteMoved/,
      `${rel.join('/')} no longer resolves a trade\u2019s value through quoteMoved`,
    );
  }
});
